use cpeak::crypto::{hex_encode, random_bytes};
use cpeak::{CookieOptions, CpeakError, CpeakRequest, CpeakResponse, SameSite, Value, json};
use sqlx::FromRow;

use crate::database::index::POOL;
use crate::database::types::{ISession, IUser};
use crate::lib::google_oauth::exchange_code_for_profile;
use crate::middlewares::session_token;

const COOKIE_MAX_AGE: i64 = 30 * 24 * 60 * 60 * 1000; // 30 days

pub async fn handle_oauth_callback(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    let code = req.query.get("code").cloned().unwrap_or_default();
    if code.is_empty() {
        return res.redirect("/");
    }

    let profile = exchange_code_for_profile(&code).await?;

    let mut db_user = sqlx::query_as::<_, IUser>("SELECT id FROM users WHERE google_id=$1")
        .bind(&profile.sub)
        .fetch_optional(&*POOL)
        .await?;

    if db_user.is_none() {
        db_user = Some(
            sqlx::query_as::<_, IUser>(
                "INSERT INTO users(email, name, google_id) VALUES ($1, $2, $3) RETURNING *",
            )
            .bind(&profile.email)
            .bind(&profile.name)
            .bind(&profile.sub)
            .fetch_one(&*POOL)
            .await?,
        );
    }

    let Some(db_user) = db_user else {
        return res.redirect("/");
    };

    let user_id = db_user.id;

    // ---- Migrate any urls created during the anonymous session to the user account ---- //
    let session_token = session_token(req);

    if let Some(session_token) = session_token {
        // ($1::bpchar: session_token is a CHAR column, and sqlx sends a String as text.
        // PostgreSQL can only use the index of the column for a value of its own type.)
        let session = sqlx::query_as::<_, ISession>(
            "SELECT id FROM sessions WHERE session_token = $1::bpchar",
        )
        .bind(session_token)
        .fetch_optional(&*POOL)
        .await?;

        if let Some(session) = session {
            sqlx::query("UPDATE urls SET user_id = $1, session_id = NULL WHERE session_id = $2")
                .bind(user_id)
                .bind(session.id)
                .execute(&*POOL)
                .await?;
        }
    }

    res.cookie(
        "uid",
        &user_id.to_string(),
        CookieOptions {
            signed: true,
            http_only: true,
            max_age: Some(COOKIE_MAX_AGE),
            same_site: Some(SameSite::Lax),
            ..Default::default()
        },
    );

    res.redirect("/")
}

pub async fn log_out(_req: &mut CpeakRequest, res: &mut CpeakResponse) -> Result<(), CpeakError> {
    res.clear_cookie("uid", None);
    res.redirect("/")
}

// If user is logged in, return their info (email, username) else return false
pub async fn check_auth_status(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    // The function will generate a new session token, save it to the database, and send it as a cookie to the client
    async fn generate_session_token(res: &mut CpeakResponse) -> Result<(), CpeakError> {
        let session_token = hex_encode(random_bytes(16)); // 128 bits

        sqlx::query("INSERT INTO sessions (session_token) VALUES ($1)")
            .bind(&session_token)
            .execute(&*POOL)
            .await?;

        res.cookie(
            "session_token",
            &session_token,
            CookieOptions {
                signed: true,
                http_only: true,
                max_age: Some(COOKIE_MAX_AGE),
                ..Default::default()
            },
        );
        Ok(())
    }

    if let Some(user) = req.get::<IUser>("user") {
        #[derive(FromRow)]
        struct UserWithUsernames {
            email: Option<String>,
            link_credits: i32,
            // { value: string; expires_at: Date | null; active: boolean }[]
            usernames: Value,
        }

        let user = sqlx::query_as::<_, UserWithUsernames>(
            "SELECT
        users.email,
        users.link_credits,
        COALESCE(
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'value', usernames.username,
            'expires_at', usernames.expires_at,
            'active', usernames.active
          )
          ORDER BY usernames.expires_at ASC NULLS LAST
        ) FILTER (WHERE usernames.username IS NOT NULL OR usernames.expires_at > NOW()), '[]') AS usernames
      FROM users
      LEFT JOIN usernames ON users.id = usernames.user_id
      WHERE users.id = $1
      GROUP BY users.id",
        )
        .bind(user.id)
        .fetch_optional(&*POOL)
        .await?;

        match user {
            Some(user) if user.email.as_deref().is_some_and(|email| !email.is_empty()) => {
                res.json(json!({
                    "isSignedIn": true,
                    "email": user.email,
                    "linkCredits": user.link_credits,
                    "usernames": user.usernames,
                }))
            }
            _ => {
                // Something went wrong, log the user out
                res.clear_cookie("uid", None);
                res.json(json!({ "isSignedIn": false }))
            }
        }
    } else {
        let session_token = session_token(req);

        // User doesn't have a session token
        if session_token.is_none() {
            generate_session_token(res).await?;
        } else {
            /* User do have a session token, but we don't know yet if it's valid or expired */

            // Check if the supplied session token exists and not expired
            let session = sqlx::query_as::<_, ISession>(
                "SELECT id FROM sessions WHERE session_token = $1::bpchar AND expires_at > NOW()",
            )
            .bind(&session_token)
            .fetch_optional(&*POOL)
            .await?;

            if session.is_some() {
                // If session exists and it valid, update last_active
                sqlx::query(
                    "UPDATE sessions SET last_active = NOW() WHERE session_token = $1::bpchar",
                )
                .bind(&session_token)
                .execute(&*POOL)
                .await?;
            } else {
                // If session doesn't exist, create a new one
                generate_session_token(res).await?;
            }
        }

        res.json(json!({ "isSignedIn": false }))
    }
}
