// The views waiting in Redis for the janitor. They're spread over KEYS.views_stream_shards
// streams (see redis/views-stream.rs), so these look at all of them.

use std::cmp::Reverse;

use server_turbo::config::keys::KEYS;
use server_turbo::redis::redis::connection;
use server_turbo::redis::views_stream::views_stream_key;

// A view in a stream: its id, and its fields (name, value, name, value, ...)
pub type StreamEntry = (String, Vec<String>);

// How many views are waiting in the streams
pub async fn streams_length() -> u64 {
    let mut length = 0;
    for shard in 0..KEYS.views_stream_shards {
        length += redis::cmd("XLEN")
            .arg(views_stream_key(shard))
            .query_async::<u64>(&mut connection())
            .await
            .unwrap();
    }
    length
}

// The last `count` views that were saved, the newest first
pub async fn last_views(count: usize) -> Vec<StreamEntry> {
    let mut entries = Vec::new();
    for shard in 0..KEYS.views_stream_shards {
        let shard_entries: Vec<StreamEntry> = redis::cmd("XREVRANGE")
            .arg((views_stream_key(shard), "+", "-", "COUNT", count))
            .query_async(&mut connection())
            .await
            .unwrap();
        entries.extend(shard_entries);
    }

    // An id is "{milliseconds}-{sequence}", the time Redis saved the view at
    entries.sort_by_key(|(id, _)| Reverse(stream_id(id)));
    entries.truncate(count);
    entries
}

fn stream_id(id: &str) -> (u64, u64) {
    let (milliseconds, sequence) = id.split_once('-').unwrap();
    (milliseconds.parse().unwrap(), sequence.parse().unwrap())
}
