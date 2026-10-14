use super::redis::REDIS;
use crate::database::types::LinkType;

pub struct IViewEvent {
    pub url_id: i32,
    // For now, due to legal reasons, we won't save the ip address until we have a proper privacy policy in place.
    // pub ip_address: Option<String>,
    pub user_agent: String,
    pub referrer: String,
    pub link_type: Option<LinkType>,
    pub via_qr: bool,
    pub visitor_hash: String,
}

pub const VIEWS_STREAM_KEY: &str = "weer:stream:views";

// Cap the stream length — janitor drains it every second, so this is just a safety net
const MAX_LEN: u32 = 100_000;

pub fn push(event: IViewEvent) {
    let fields: Vec<String> = vec![
        "url_id".to_string(),
        event.url_id.to_string(),
        // ip_address,
        // event.ip_address,
        "user_agent".to_string(),
        event.user_agent,
        "referrer".to_string(),
        event.referrer,
        "link_type".to_string(),
        event.link_type.map_or("", LinkType::as_str).to_string(),
        "via_qr".to_string(),
        if event.via_qr { "1" } else { "0" }.to_string(),
        "visitor_hash".to_string(),
        event.visitor_hash,
    ];

    /*
     * Fire and forget — XADD is ~50µs and must not block the redirect response
     * Example redis-cli command: XADD stream:views MAXLEN ~ 100000 * url_id "123" user_agent "Mozilla/5.0" referrer "google.com" via_qr "1" visitor_hash "abc-xyz" link_type "classic"
     *
     * This operation is Big O(1).
     * Trimming without the tilde (~) is O(n) and can cause latency spikes when the stream is long.
     *
     * Get the last entry in the stream:
     * XREVRANGE weer:stream:views + - COUNT 1
     *
     *
     * XREAD STREAMS weer:stream:views 0
     *
     * XINFO STREAM weer:stream:views
     *
     * XINFO GROUPS weer:stream:views
     */
    cpeak::spawn(async move {
        let added = redis::cmd("XADD")
            // ~ means approximate max length. It's more efficient than exact max length and good enough for our use case.
            // * means that Redis will generate the ID based on the current timestamp.
            .arg((VIEWS_STREAM_KEY, "MAXLEN", "~", MAX_LEN, "*", fields))
            .query_async::<String>(&mut REDIS.clone())
            .await;

        if let Err(err) = added {
            eprintln!("[views-stream] XADD failed: {err}");
        }
    });
}
