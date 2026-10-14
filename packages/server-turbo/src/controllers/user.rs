use cpeak::{CpeakError, CpeakRequest, CpeakResponse, json};

use crate::database::index::POOL;
use crate::database::types::{IUser, IUsername};

async fn is_username_available(username: &str) -> Result<bool, CpeakError> {
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

    if username.is_empty() {
        return res
            .status(400)
            .json(json!({ "available": false, "error": "Invalid username" }));
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

    if new_username.is_empty() {
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

    // Get all user's usernames
    let username_records = sqlx::query_as::<_, IUsername>(
        "SELECT username, expires_at, active FROM usernames WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_all(&*POOL)
    .await?;

    // Check if the requested username exists and is inactive
    let target_record = username_records
        .iter()
        .find(|r| r.username == new_username && r.active != Some(true));

    if target_record.is_none() {
        return res.status(404).json(json!({
            "error": "The specified username does not exist or is already active",
        }));
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
        .execute(&*POOL)
        .await?;
    }

    // Activate the target username and clear expires_at
    sqlx::query(
        "UPDATE usernames SET active = true, expires_at = NULL WHERE user_id = $1 AND username = $2",
    )
    .bind(user_id)
    .bind(new_username)
    .execute(&*POOL)
    .await?;

    res.status(200)
        .json(json!({ "message": "Username switched successfully" }))
}

// req.user.id (these routes are only for logged in users, see middlewares.require_auth)
fn user_id(req: &CpeakRequest) -> Option<i32> {
    req.get::<IUser>("user").map(|user| user.id)
}
