use cpeak::CpeakError;

use super::redis::connection;
use crate::config::keys::KEYS;
use crate::database::index::POOL;
use crate::database::types::{IUrl, LinkType};

/*
 * Once a classic link (a 6 character code) is visited, we save it in Redis, so the redirects
 * after that don't have to ask the database. When the link changes or is deleted, it's removed,
 * and the next visit reads it from the database again.
 *
 * Get a saved link:
 * GET weer:link:abc123
 */

pub fn is_enabled() -> bool {
    KEYS.redis_enabled && KEYS.link_cache
}

fn key(code: &str) -> String {
    format!("weer:link:{code}")
}

// The link saved for this code, if there is one. If Redis can't be reached, we just ask the
// database.
pub async fn get(code: &str) -> Option<IUrl> {
    let saved = redis::cmd("GET")
        .arg(key(code))
        .query_async::<Option<String>>(&mut connection())
        .await;

    match saved {
        Ok(saved) => {
            // Saved as "{id} {link_type} {real_url}", see set()
            let saved = saved?;
            let mut parts = saved.splitn(3, ' ');
            Some(IUrl {
                id: parts.next()?.parse().ok()?,
                link_type: LinkType::parse(parts.next()?)?,
                real_url: parts.next()?.to_string(),
                ..Default::default()
            })
        }
        Err(err) => {
            eprintln!("[links-cache] GET failed: {err}");
            None
        }
    }
}

// Saves a link that was just read from the database. The redirect doesn't wait for it.
pub fn set(code: &str, url: &IUrl) {
    let key = key(code);
    let value = format!("{} {} {}", url.id, url.link_type.as_str(), url.real_url);

    cpeak::spawn_local(async move {
        let saved = redis::cmd("SET")
            .arg((key, value))
            .query_async::<()>(&mut connection())
            .await;

        if let Err(err) = saved {
            eprintln!("[links-cache] SET failed: {err}");
        }
    });
}

// The code the link with this id can be saved under. Get it before changing the link (the code
// might be gone after), and forget() it once the link is changed.
//
// (The classic lookup doesn't check the type of the link, so any link with a code can be saved,
// like an affix link with a 6 character code.)
pub async fn code_of(id: i32) -> Result<Option<String>, CpeakError> {
    if !is_enabled() {
        return Ok(None);
    }

    Ok(
        sqlx::query_scalar::<_, Option<String>>("SELECT shortened_url_id FROM urls WHERE id = $1")
            .bind(id)
            .fetch_optional(&*POOL)
            .await?
            .flatten(),
    )
}

// Removes a saved link. It waits for Redis, so that once it's done, no visit can find the old
// link anymore.
pub async fn forget(code: Option<String>) {
    let Some(code) = code else {
        return;
    };

    let removed = redis::cmd("DEL")
        .arg(key(&code))
        .query_async::<u64>(&mut connection())
        .await;

    if let Err(err) = removed {
        eprintln!("[links-cache] DEL failed: {err}");
    }
}
