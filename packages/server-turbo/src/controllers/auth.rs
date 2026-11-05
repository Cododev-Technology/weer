use chrono::{TimeDelta, Utc};
use cpeak::crypto::{hex_encode, random_bytes};
use cpeak::{CookieOptions, CpeakError, CpeakRequest, CpeakResponse, SameSite, Value, json};
use sqlx::FromRow;
use subtle::ConstantTimeEq;

use super::user::{is_username_available, is_valid_username_format};
use crate::config::keys::KEYS;
use crate::database::index::POOL;
use crate::database::types::{ISession, IUser};
use crate::lib::email::{Html, send_email};
use crate::lib::email_codes::{code_text, verify_email_code};
use crate::lib::google_oauth::exchange_code_for_profile;
use crate::lib::rate_limit::{enforce_email_cooldown, enforce_ip_limit};
use crate::lib::util;
use crate::lib::validation::{is_valid_email, is_valid_name, is_valid_password};
use crate::middlewares::session_token;

const COOKIE_MAX_AGE: i64 = 30 * 24 * 60 * 60 * 1000; // 30 days
const CODE_EXPIRY_MINUTES: i64 = 10;
const RESET_LINK_EXPIRY_HOURS: i64 = 2;

fn set_token_cookie(res: &mut CpeakResponse, token: &str) {
    res.cookie(
        "token",
        token,
        CookieOptions {
            signed: true,
            http_only: true,
            same_site: Some(SameSite::Lax),
            secure: std::env::var("NODE_ENV").as_deref() == Ok("production"),
            max_age: Some(COOKIE_MAX_AGE),
            ..Default::default()
        },
    );
}

// Migrates any urls created during an anonymous session to the now-authenticated user account
async fn claim_anonymous_session(req: &CpeakRequest, user_id: i32) -> Result<(), CpeakError> {
    let Some(session_token) = session_token(req) else {
        return Ok(());
    };

    // ($1::bpchar: session_token is a CHAR column, and sqlx sends a String as text.
    // PostgreSQL can only use the index of the column for a value of its own type.)
    let session =
        sqlx::query_as::<_, ISession>("SELECT id FROM sessions WHERE session_token = $1::bpchar")
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

    Ok(())
}

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
        // No Google-linked account yet. If a password account already exists for
        // this email, link Google to it instead of erroring on the unique constraint.
        let existing_by_email =
            sqlx::query_as::<_, IUser>("SELECT id, google_id FROM users WHERE email=$1")
                .bind(&profile.email)
                .fetch_optional(&*POOL)
                .await?;

        match existing_by_email {
            Some(existing_by_email) if existing_by_email.google_id.is_none() => {
                sqlx::query("UPDATE users SET google_id = $1, verified = true WHERE id = $2")
                    .bind(&profile.sub)
                    .bind(existing_by_email.id)
                    .execute(&*POOL)
                    .await?;
                db_user = Some(existing_by_email);
            }
            _ => {
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
        }
    }

    let Some(db_user) = db_user else {
        return res.redirect("/");
    };

    let user_id = db_user.id;

    claim_anonymous_session(req, user_id).await?;

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

pub async fn log_out(req: &mut CpeakRequest, res: &mut CpeakResponse) -> Result<(), CpeakError> {
    let token = req
        .signed_cookies
        .get("token")
        .cloned()
        .flatten()
        .filter(|token| !token.is_empty());
    if let Some(token) = token {
        req.logout(&token).await?;
        res.clear_cookie("token", None);
    }
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

// Sends a 5-digit code to the given email to verify ownership before creating an account
pub async fn send_code(req: &mut CpeakRequest, res: &mut CpeakResponse) -> Result<(), CpeakError> {
    let name = req.body["name"].as_str().unwrap_or_default();
    let email = req.body["email"].as_str().unwrap_or_default();
    let password = req.body["password"].as_str().unwrap_or_default();
    let username = req.body["username"]
        .as_str()
        .filter(|username| !username.is_empty());

    if !is_valid_name(name) {
        return Err(CpeakError::new(400, "Please enter a valid name."));
    }
    if !is_valid_email(email) {
        return Err(CpeakError::new(400, "Please enter a valid email address."));
    }
    if !is_valid_password(password) {
        return Err(CpeakError::new(
            400,
            "Password must be 8-30 characters and include an uppercase letter, a lowercase letter, and a number.",
        ));
    }

    let normalized_email = email.to_lowercase();

    let existing = sqlx::query_as::<_, IUser>("SELECT id, google_id FROM users WHERE email = $1")
        .bind(&normalized_email)
        .fetch_optional(&*POOL)
        .await?;

    if existing.is_some() {
        return Err(CpeakError::new(
            409,
            "You already have an account with us. Please login instead.",
        ));
    }

    if let Some(username) = username
        && (!is_valid_username_format(username) || !is_username_available(username).await?)
    {
        return Err(CpeakError::new(409, "Username is not available."));
    }

    enforce_email_cooldown(&normalized_email).await?;

    if let Some(ip) = util::get_client_ip(req) {
        enforce_ip_limit(&ip).await?;
    }

    let code: i32 = rand::random_range(10000..100000);

    sqlx::query("DELETE FROM email_codes WHERE email = $1")
        .bind(&normalized_email)
        .execute(&*POOL)
        .await?;
    sqlx::query("INSERT INTO email_codes (email, code, expires_at) VALUES ($1, $2, $3)")
        .bind(&normalized_email)
        .bind(code)
        .bind(Utc::now() + TimeDelta::minutes(CODE_EXPIRY_MINUTES))
        .execute(&*POOL)
        .await?;

    send_email(
        &normalized_email,
        "Verify your email address",
        Html::Template {
            html_file: "verify-email",
            template_data: json!({
                "title": "Verify your email address",
                "code": code,
                "expiresIn": format!("{CODE_EXPIRY_MINUTES} minutes"),
            }),
        },
    )
    .await?;

    res.status(200)
        .json(json!({ "message": "Verification code sent." }))
}

// Verifies the code and creates the account, then logs the user in
pub async fn register(req: &mut CpeakRequest, res: &mut CpeakResponse) -> Result<(), CpeakError> {
    let name = req.body["name"].as_str().unwrap_or_default().to_string();
    let email = req.body["email"].as_str().unwrap_or_default();
    let password = req.body["password"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let code = code_text(&req.body["code"]);
    let username = req.body["username"]
        .as_str()
        .filter(|username| !username.is_empty())
        .map(String::from);

    if !is_valid_name(&name) {
        return Err(CpeakError::new(400, "Please enter a valid name."));
    }
    if !is_valid_email(email) {
        return Err(CpeakError::new(400, "Please enter a valid email address."));
    }
    if !is_valid_password(&password) {
        return Err(CpeakError::new(
            400,
            "Password must be 8-30 characters and include an uppercase letter, a lowercase letter, and a number.",
        ));
    }

    let normalized_email = email.to_lowercase();

    let existing = sqlx::query_as::<_, IUser>("SELECT id, google_id FROM users WHERE email = $1")
        .bind(&normalized_email)
        .fetch_optional(&*POOL)
        .await?;

    if existing.is_some() {
        return Err(CpeakError::new(
            409,
            "You already have an account with us. Please login instead.",
        ));
    }

    if let Some(username) = &username
        && (!is_valid_username_format(username) || !is_username_available(username).await?)
    {
        return Err(CpeakError::new(409, "Username is not available."));
    }

    verify_email_code(&normalized_email, &code).await?;

    let hash = req.hash_password(&password).await?;

    let mut tx = POOL.begin().await?;
    let inserted: Result<IUser, sqlx::Error> = async {
        let user = sqlx::query_as::<_, IUser>(
            "INSERT INTO users(name, email, password, verified) VALUES ($1, $2, $3, true) RETURNING *",
        )
        .bind(&name)
        .bind(&normalized_email)
        .bind(&hash)
        .fetch_one(&mut *tx)
        .await?;

        if let Some(username) = &username {
            let inserted = sqlx::query(
                "INSERT INTO usernames (user_id, username, active) VALUES ($1, $2, true)",
            )
            .bind(user.id)
            .bind(username.to_lowercase())
            .execute(&mut *tx)
            .await;
            if let Err(e) = inserted
                && !e
                    .as_database_error()
                    .is_some_and(|e| e.is_unique_violation())
            {
                return Err(e);
            }
        }

        Ok(user)
    }
    .await;

    let user = match inserted {
        Ok(user) => {
            tx.commit().await?;
            user
        }
        Err(e) => {
            tx.rollback().await?;
            if e.as_database_error()
                .is_some_and(|e| e.is_unique_violation())
            {
                return Err(CpeakError::new(
                    409,
                    "You already have an account with us. Please login instead.",
                ));
            }
            return Err(e.into());
        }
    };

    claim_anonymous_session(req, user.id).await?;

    let token = req.login(&password, &hash, &user.id.to_string()).await?;

    let Some(token) = token else {
        return Err(CpeakError::new(
            500,
            "Something went wrong. Please try logging in.",
        ));
    };

    set_token_cookie(res, &token);

    res.status(201)
        .json(json!({ "message": "Account created." }))
}

// Logs a user in with email + password
pub async fn log_in(req: &mut CpeakRequest, res: &mut CpeakResponse) -> Result<(), CpeakError> {
    let email = req.body["email"].as_str().unwrap_or_default();
    let password = req.body["password"]
        .as_str()
        .unwrap_or_default()
        .to_string();

    if email.is_empty() || password.is_empty() {
        return Err(CpeakError::new(
            400,
            "Please enter your email and password.",
        ));
    }

    let normalized_email = email.to_lowercase();

    let user =
        sqlx::query_as::<_, IUser>("SELECT id, password, google_id FROM users WHERE email = $1")
            .bind(&normalized_email)
            .fetch_optional(&*POOL)
            .await?;

    let hashed_password = user
        .as_ref()
        .and_then(|user| user.password.clone())
        .filter(|password| !password.is_empty());

    let (Some(user), Some(hashed_password)) = (user.as_ref(), hashed_password) else {
        if user.is_some_and(|user| user.google_id.is_some()) {
            return Err(CpeakError::new(
                401,
                "This account uses Google Sign-In. Continue with Google, or add a password from your Account settings after signing in.",
            ));
        }
        return Err(CpeakError::new(401, "Incorrect email or password."));
    };

    let token = req
        .login(&password, &hashed_password, &user.id.to_string())
        .await?;

    let Some(token) = token else {
        return Err(CpeakError::new(401, "Incorrect email or password."));
    };

    claim_anonymous_session(req, user.id).await?;

    set_token_cookie(res, &token);

    res.json(json!({ "message": "Logged in." }))
}

// Sends a password reset link to the given email, whether the account already has a password or not
pub async fn forgot_password(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    let email = req.body["email"].as_str().unwrap_or_default();
    if email.is_empty() {
        return Err(CpeakError::new(400, "Please enter your email."));
    }

    let normalized_email = email.to_lowercase();

    let user = sqlx::query_as::<_, IUser>("SELECT id FROM users WHERE email = $1")
        .bind(&normalized_email)
        .fetch_optional(&*POOL)
        .await?;

    if let Some(user) = user {
        enforce_email_cooldown(&normalized_email).await?;

        if let Some(ip) = util::get_client_ip(req) {
            enforce_ip_limit(&ip).await?;
        }

        let token = hex_encode(random_bytes(32));
        let link = format!("{}/reset-password?t={token}&i={}", KEYS.domain, user.id);

        sqlx::query("UPDATE users SET token_code = $1, token_date = $2 WHERE id = $3")
            .bind(&token)
            .bind(Utc::now())
            .bind(user.id)
            .execute(&*POOL)
            .await?;

        send_email(
            &normalized_email,
            "Reset your password",
            Html::Template {
                html_file: "reset-password",
                template_data: json!({
                    "title": "Reset your password",
                    "link": link,
                    "expiresIn": format!("{RESET_LINK_EXPIRY_HOURS} hours"),
                }),
            },
        )
        .await?;
    }

    res.status(200).json(json!({
        "message": "If that email is registered, we've sent a reset link.",
    }))
}

// Uses the token from the emailed reset link to set a new password
pub async fn reset_password(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    // The link has the id as text (i=12), and the client can send it as text or as a number
    let user_id = match &req.body["userId"] {
        Value::Number(user_id) => user_id.as_i64().and_then(|id| i32::try_from(id).ok()),
        Value::String(user_id) => user_id.parse::<i32>().ok(),
        _ => None,
    };
    let token = req.body["token"].as_str().unwrap_or_default();
    let new_password = req.body["newPassword"].as_str().unwrap_or_default();

    let Some(user_id) = user_id.filter(|_| !token.is_empty() && is_valid_password(new_password))
    else {
        return Err(CpeakError::new(400, "Please provide a valid new password."));
    };

    let user = sqlx::query_as::<_, IUser>("SELECT token_code, token_date FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&*POOL)
        .await?;

    let Some((token_code, token_date)) = user.and_then(|user| {
        let token_code = user.token_code.filter(|token_code| !token_code.is_empty());
        token_code.zip(user.token_date)
    }) else {
        return Err(CpeakError::new(400, "Invalid or expired link."));
    };

    let expiry = token_date + TimeDelta::hours(RESET_LINK_EXPIRY_HOURS);
    if Utc::now() > expiry {
        return Err(CpeakError::new(400, "This reset link has expired."));
    }

    let (token, stored_token) = (token.as_bytes(), token_code.as_bytes());
    if token.len() != stored_token.len() || !bool::from(token.ct_eq(stored_token)) {
        return Err(CpeakError::new(400, "Invalid or expired link."));
    }

    let hash = req.hash_password(new_password).await?;

    sqlx::query(
        "UPDATE users SET password = $1, token_code = NULL, token_date = NULL WHERE id = $2",
    )
    .bind(hash)
    .bind(user_id)
    .execute(&*POOL)
    .await?;

    // Revoke any existing logged-in sessions, since the requester may not be authenticated as this user
    sqlx::query("DELETE FROM tokens WHERE user_id = $1")
        .bind(user_id)
        .execute(&*POOL)
        .await?;

    res.status(200)
        .json(json!({ "message": "Password updated. Please log in." }))
}
