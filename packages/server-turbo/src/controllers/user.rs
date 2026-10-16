use chrono::{TimeDelta, Utc};
use cpeak::{CpeakError, CpeakRequest, CpeakResponse, json};

use crate::database::index::POOL;
use crate::database::types::{IUser, IUsername};
use crate::lib::email::{Html, send_email};
use crate::lib::email_codes::{code_text, verify_email_code};
use crate::lib::link_definitions::RESERVED_ROUTE_SEGMENTS;
use crate::lib::rate_limit::{enforce_email_cooldown, enforce_ip_limit};
use crate::lib::util;
use crate::lib::validation::{is_valid_email, is_valid_password, is_valid_username};

const CODE_EXPIRY_MINUTES: i64 = 10;

pub fn is_valid_username_format(username: &str) -> bool {
    is_valid_username(username)
        && !RESERVED_ROUTE_SEGMENTS.contains(&username.to_lowercase().as_str())
}

pub async fn is_username_available(username: &str) -> Result<bool, CpeakError> {
    // We use EXISTS to optimize the query since we only care about existence
    let taken = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
      SELECT 1 FROM usernames WHERE username = $1
    ) as \"taken\"",
    )
    .bind(username.to_lowercase())
    .fetch_one(&*POOL)
    .await?;

    Ok(!taken)
}

// Checks if a username is available
pub async fn check_username_availability(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    let username = req.params.get("username").cloned().unwrap_or_default();

    if username.is_empty() || !is_valid_username_format(&username) {
        return res.status(200).json(json!({ "available": false }));
    }

    let available = is_username_available(&username).await?;

    res.status(200).json(json!({
        "available": available,
    }))
}

// Updates the user's username
pub async fn update_username(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    let user_id = user_id(req);
    let new_username = req.body["username"]
        .as_str()
        .unwrap_or_default()
        .to_string();

    if new_username.is_empty() || !is_valid_username_format(&new_username) {
        return res.status(400).json(json!({ "error": "Invalid username" }));
    }

    // Check if username is already taken
    let available = is_username_available(&new_username).await?;

    if !available {
        return res
            .status(409)
            .json(json!({ "error": "Username is already taken" }));
    }

    let mut tx = POOL.begin().await?;
    let updated: Result<(), sqlx::Error> = async {
        // Get all user's usernames. First record is the one that expires the soonest due to ORDER BY expires_at, and last
        // one is the active username (expires_at is NULL for active username)
        let username_records = sqlx::query_as::<_, IUsername>(
            "SELECT username, expires_at, active FROM usernames WHERE user_id = $1 ORDER BY expires_at ASC NULLS LAST",
        )
        .bind(user_id)
        .fetch_all(&mut *tx)
        .await?;

        // Find the user's active username
        let old_username = username_records
            .iter()
            .find(|r| r.active == Some(true))
            .map(|r| r.username.clone());

        // We only keep 3 inactive usernames per user. If the user already has 3 inactive usernames, delete
        // the one that is set to expire the soonest

        let inactive_usernames: Vec<&IUsername> = username_records
            .iter()
            .filter(|r| r.active != Some(true))
            .collect();

        if inactive_usernames.len() >= 3 {
            // Find the oldest inactive username
            let oldest = inactive_usernames[0];

            // Delete the oldest inactive username
            sqlx::query("DELETE FROM usernames WHERE user_id = $1 AND username = $2")
                .bind(user_id)
                .bind(&oldest.username)
                .execute(&mut *tx)
                .await?;
        }

        // Deactivate the existing username for the user and set expires_at one month from now
        sqlx::query(
            "UPDATE usernames SET active = false, expires_at = NOW() + INTERVAL '1 month' WHERE user_id = $1 AND username = $2",
        )
        .bind(user_id)
        .bind(old_username)
        .execute(&mut *tx)
        .await?;

        // Insert the new username
        sqlx::query("INSERT INTO usernames (user_id, username, active) VALUES ($1, $2, true)")
            .bind(user_id)
            .bind(new_username.to_lowercase())
            .execute(&mut *tx)
            .await?;

        Ok(())
    }
    .await;

    match updated {
        Ok(()) => {
            tx.commit().await?;
            res.status(200)
                .json(json!({ "message": "Username updated successfully" }))
        }
        Err(e) => {
            tx.rollback().await?;
            if e.as_database_error()
                .is_some_and(|e| e.is_unique_violation())
            {
                return res
                    .status(409)
                    .json(json!({ "error": "Username is already taken" }));
            }
            Err(e.into())
        }
    }
}

pub async fn switch_username(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    let user_id = user_id(req);
    let new_username = req.body["username"]
        .as_str()
        .unwrap_or_default()
        .to_string();

    if new_username.is_empty() {
        return res.status(400).json(json!({ "error": "Invalid username" }));
    }

    let mut tx = POOL.begin().await?;
    // Some(false): the username isn't one of the old ones of the user
    let switched: Result<bool, sqlx::Error> = async {
        // Get all user's usernames
        let username_records = sqlx::query_as::<_, IUsername>(
            "SELECT username, expires_at, active FROM usernames WHERE user_id = $1 FOR UPDATE",
        )
        .bind(user_id)
        .fetch_all(&mut *tx)
        .await?;

        // Check if the requested username exists and is inactive
        let target_record = username_records
            .iter()
            .find(|r| r.username == new_username && r.active != Some(true));

        if target_record.is_none() {
            return Ok(false);
        }

        // Find the user's current active username
        let current_active_record = username_records.iter().find(|r| r.active == Some(true));

        // Deactivate the current active username and set expires_at one month from now
        if let Some(current_active_record) = current_active_record {
            sqlx::query(
                "UPDATE usernames SET active = false, expires_at = NOW() + INTERVAL '1 month' WHERE user_id = $1 AND username = $2",
            )
            .bind(user_id)
            .bind(&current_active_record.username)
            .execute(&mut *tx)
            .await?;
        }

        // Activate the target username and clear expires_at
        sqlx::query(
            "UPDATE usernames SET active = true, expires_at = NULL WHERE user_id = $1 AND username = $2",
        )
        .bind(user_id)
        .bind(&new_username)
        .execute(&mut *tx)
        .await?;

        Ok(true)
    }
    .await;

    match switched {
        Ok(true) => {
            tx.commit().await?;
            res.status(200)
                .json(json!({ "message": "Username switched successfully" }))
        }
        Ok(false) => {
            tx.rollback().await?;
            res.status(404).json(json!({
                "error": "The specified username does not exist or is already active",
            }))
        }
        Err(e) => {
            tx.rollback().await?;
            if e.as_database_error()
                .is_some_and(|e| e.is_unique_violation())
            {
                return res.status(409).json(json!({
                    "error": "Could not switch usernames. Please refresh and try again.",
                }));
            }
            Err(e.into())
        }
    }
}

// Sends a 5-digit code to a new email address to confirm the user owns it before changing to it
pub async fn send_email_change_code(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    let new_email = req.body["newEmail"].as_str().unwrap_or_default();

    if !is_valid_email(new_email) {
        return Err(CpeakError::new(400, "Please enter a valid email address."));
    }

    let normalized_email = new_email.to_lowercase();

    let existing = sqlx::query_as::<_, IUser>("SELECT id FROM users WHERE email = $1 AND id != $2")
        .bind(&normalized_email)
        .bind(user_id(req))
        .fetch_optional(&*POOL)
        .await?;

    if existing.is_some() {
        return Err(CpeakError::new(409, "This email is already in use."));
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
        "Confirm your new email address",
        Html::Template {
            html_file: "change-email",
            template_data: json!({
                "title": "Confirm your new email address",
                "code": code,
                "expiresIn": format!("{CODE_EXPIRY_MINUTES} minutes"),
            }),
        },
    )
    .await?;

    res.status(200)
        .json(json!({ "message": "Verification code sent." }))
}

// Confirms the code sent to the new email address and applies the change
pub async fn confirm_email_change(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    let new_email = req.body["newEmail"].as_str().unwrap_or_default();
    let code = code_text(&req.body["code"]);

    if !is_valid_email(new_email) {
        return Err(CpeakError::new(400, "Please enter a valid email address."));
    }

    let normalized_email = new_email.to_lowercase();

    verify_email_code(&normalized_email, &code).await?;

    let old_user = sqlx::query_as::<_, IUser>("SELECT email FROM users WHERE id = $1")
        .bind(user_id(req))
        .fetch_optional(&*POOL)
        .await?;

    let updated = sqlx::query("UPDATE users SET email = $1 WHERE id = $2")
        .bind(&normalized_email)
        .bind(user_id(req))
        .execute(&*POOL)
        .await;
    if let Err(e) = updated {
        if e.as_database_error()
            .is_some_and(|e| e.is_unique_violation())
        {
            return Err(CpeakError::new(409, "This email is already in use."));
        }
        return Err(e.into());
    }

    if let Some(old_email) = old_user.and_then(|user| user.email) {
        // Best-effort notice to the old address, don't fail the request if this errors
        let sent = send_email(
            &old_email,
            "Your email address was changed",
            Html::Template {
                html_file: "email-changed-notice",
                template_data: json!({
                    "title": "Your email address was changed",
                    "newEmail": normalized_email,
                }),
            },
        )
        .await;
        if let Err(e) = sent {
            eprintln!("{e:?}");
        }
    }

    revoke_other_tokens(req).await?;

    res.status(200).json(json!({
        "message": "Email updated successfully.",
        "email": normalized_email,
    }))
}

pub async fn change_password(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    let new_password = req.body["newPassword"].as_str().unwrap_or_default();

    if !is_valid_password(new_password) {
        return Err(CpeakError::new(
            400,
            "Password must be 8-30 characters and include an uppercase letter, a lowercase letter, and a number.",
        ));
    }

    let hash = req.hash_password(new_password).await?;

    sqlx::query("UPDATE users SET password = $1 WHERE id = $2")
        .bind(hash)
        .bind(user_id(req))
        .execute(&*POOL)
        .await?;

    revoke_other_tokens(req).await?;

    res.status(200)
        .json(json!({ "message": "Password updated successfully." }))
}

// Logs the user out everywhere but here: deletes all their tokens but the one of this request
async fn revoke_other_tokens(req: &CpeakRequest) -> Result<(), CpeakError> {
    let token_id = req
        .get::<IUser>("user")
        .and_then(|user| user.token_id.clone());

    if let Some(token_id) = token_id {
        sqlx::query("DELETE FROM tokens WHERE user_id = $1 AND id != $2")
            .bind(user_id(req))
            .bind(token_id)
            .execute(&*POOL)
            .await?;
    } else {
        sqlx::query("DELETE FROM tokens WHERE user_id = $1")
            .bind(user_id(req))
            .execute(&*POOL)
            .await?;
    }
    Ok(())
}

// req.user.id (these routes are only for logged in users, see middlewares.require_auth)
fn user_id(req: &CpeakRequest) -> Option<i32> {
    req.get::<IUser>("user").map(|user| user.id)
}
