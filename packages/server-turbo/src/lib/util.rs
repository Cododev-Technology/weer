use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use cpeak::CpeakRequest;

pub fn is_valid_url_id(_id: &str) -> bool {
    /* @TODO make sure all code types are validated */
    true
}

pub fn get_client_ip(req: &CpeakRequest) -> Option<String> {
    let forwarded = req.headers.get("x-forwarded-for");
    let raw = forwarded;
    let ip = raw.map_or("", |raw| raw.split(',').next().unwrap_or("").trim());
    if !ip.is_empty() {
        return Some(ip.to_string());
    }
    Some(req.remote_address.ip().to_string())
}

// The two below are built into Node.js, so the Node.js version has nothing for them.

// fetch(). Every request goes out through this one client, so the connections to a server
// are kept and reused, like Node.js does it.
pub static FETCH: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);

// date.toISOString(), like 2026-01-15T10:20:30.123Z
pub fn to_iso_string(date: DateTime<Utc>) -> String {
    date.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}
