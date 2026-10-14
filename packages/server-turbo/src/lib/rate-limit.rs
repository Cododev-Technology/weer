use std::net::IpAddr;

use cpeak::{CpeakError, CpeakRequest};

use super::util;
use crate::database::index::POOL;
use crate::database::types::IUser;

#[allow(dead_code)]
const USER_LIFETIME_LIMIT: i32 = 100;
const IP_BURST_LIMIT: i32 = 10; // per 10 minutes

async fn enforce_user_limit(user_id: i32) -> Result<(), CpeakError> {
    let link_credits = sqlx::query_scalar::<_, i32>(
        "UPDATE users SET link_credits = link_credits - 1 WHERE id = $1 RETURNING link_credits",
    )
    .bind(user_id)
    .fetch_optional(&*POOL)
    .await?;

    if link_credits.unwrap_or(0) < 0 {
        return Err(CpeakError::new(
            402,
            "You've used all your credits. Please contact support to increase your limit for free.",
        ));
    }
    Ok(())
}

async fn enforce_ip_limit(ip: &str) -> Result<(), CpeakError> {
    let burst_count = sqlx::query_scalar::<_, i32>(
        "
    INSERT INTO rate_limits (ip_address, burst_count, burst_reset_at)
    VALUES ($1, 1, now())
    ON CONFLICT (ip_address) DO UPDATE SET
      burst_count = CASE WHEN rate_limits.burst_reset_at < now() - interval '10 minutes' THEN 1 ELSE rate_limits.burst_count + 1 END,
      burst_reset_at = CASE WHEN rate_limits.burst_reset_at < now() - interval '10 minutes' THEN now() ELSE rate_limits.burst_reset_at END
    RETURNING burst_count
    ",
    )
    .bind(ip.parse::<IpAddr>()?)
    .fetch_optional(&*POOL)
    .await?;

    if burst_count.unwrap_or(0) > IP_BURST_LIMIT {
        return Err(CpeakError::new(
            429,
            "Too many requests. Please try again later.",
        ));
    }
    Ok(())
}

pub async fn enforce_rate_limit(req: &CpeakRequest) -> Result<(), CpeakError> {
    if let Some(user) = req.get::<IUser>("user") {
        return enforce_user_limit(user.id).await;
    }

    let ip = util::get_client_ip(req);
    let Some(ip) = ip else {
        return Ok(()); // no derivable IP (shouldn't happen for a real connection)
    };

    enforce_ip_limit(&ip).await
}
