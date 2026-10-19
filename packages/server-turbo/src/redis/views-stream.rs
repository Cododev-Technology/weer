use std::cell::Cell;
use std::sync::LazyLock;

use super::redis::connection;
use crate::config::keys::KEYS;
use crate::database::types::LinkType;

pub struct IViewEvent {
    pub url_id: i32,
    pub ip_address: Option<String>,
    pub user_agent: String,
    pub referrer: String,
    pub link_type: Option<LinkType>,
    pub via_qr: bool,
    pub visitor_hash: String,
}

// The views are spread over KEYS.views_stream_shards streams. In a cluster a key lives on one
// node, so with one stream, every view would go to the same node.
pub fn views_stream_key(shard: u32) -> String {
    VIEWS_STREAM_KEYS[shard as usize].clone()
}

// How many slots a Redis cluster has
const SLOTS: u32 = 16384;

// The slot of a key, which decides its node: the CRC16 of the key (or of its hash tag, the part
// in {}), mod 16384
fn slot(key: &str) -> u32 {
    u32::from(crc16::State::<crc16::XMODEM>::calculate(key.as_bytes())) % SLOTS
}

/*
 * Every master owns an equal range of the slots (redis.sh), so each stream gets an equal share of
 * the slots too, and a hash tag whose slot is in the middle half of that share (so it's never on
 * the edge of a master's range): weer:stream:views:{10}, weer:stream:views:{18}, ...
 * With a number of streams that's a multiple of the masters, every master gets the same number of
 * them. (weer:stream:views:0 to weer:stream:views:47 gave the 12 masters 7 1 5 7 1 5 7 0 4 7 0 4.)
 */
static VIEWS_STREAM_KEYS: LazyLock<Vec<String>> = LazyLock::new(|| {
    let shards = KEYS.views_stream_shards;
    (0..shards)
        .map(|shard| {
            let start = shard * SLOTS / shards;
            let end = (shard + 1) * SLOTS / shards;
            let quarter = (end - start) / 4;
            let middle = (start + quarter)..(end - quarter);

            let tag = (0..)
                .find(|tag: &u32| middle.contains(&slot(&tag.to_string())))
                .unwrap_or_default();
            format!("weer:stream:views:{{{tag}}}")
        })
        .collect()
});

thread_local! {
    // The stream that the next view of this thread goes to. Each thread goes around all of them.
    static NEXT_SHARD: Cell<u32> = const { Cell::new(0) };
}

fn next_shard() -> u32 {
    NEXT_SHARD.with(|next| {
        let shard = next.get() % KEYS.views_stream_shards;
        next.set(shard + 1);
        shard
    })
}

// Cap the length of each stream. It leaves room for the views the janitor is behind on: 6.25M
// per stream, so 300M over all 48 streams, which is 5 minutes at 1M views/s (121 bytes a view,
// so about 36 GB of Redis). Past that, the oldest views are dropped, saved or not.
const MAX_LEN: u32 = 6_250_000;

pub fn push(event: IViewEvent) {
    let fields: Vec<String> = vec![
        "url_id".to_string(),
        event.url_id.to_string(),
        "ip_address".to_string(),
        event.ip_address.unwrap_or_default(),
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
     * Example redis-cli command: XADD stream:views MAXLEN ~ 100000 * url_id "123" ip_address "1.2.3.4" user_agent "Mozilla/5.0" referrer "google.com" via_qr "1" visitor_hash "abc-xyz" link_type "classic"
     *
     * This operation is Big O(1).
     * Trimming without the tilde (~) is O(n) and can cause latency spikes when the stream is long.
     *
     * Get the last entry in the first stream (with 48 streams, see VIEWS_STREAM_KEYS):
     * XREVRANGE weer:stream:views:{10} + - COUNT 1
     *
     *
     * XREAD STREAMS weer:stream:views:{10} 0
     *
     * XINFO STREAM weer:stream:views:{10}
     *
     * XINFO GROUPS weer:stream:views:{10}
     *
     * It runs on the worker thread that handled the redirect, with that thread's connection,
     * so the views of every worker don't have to go through one thread.
     */
    let key = views_stream_key(next_shard());
    cpeak::spawn_local(async move {
        let added = redis::cmd("XADD")
            // ~ means approximate max length. It's more efficient than exact max length and good enough for our use case.
            // * means that Redis will generate the ID based on the current timestamp.
            .arg((key, "MAXLEN", "~", MAX_LEN, "*", fields))
            .query_async::<String>(&mut connection())
            .await;

        if let Err(err) = added {
            eprintln!("[views-stream] XADD failed: {err}");
        }
    });
}
