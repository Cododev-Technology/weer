/*
 * This code will run in a separate process to clean up expired codes and perform other maintenance tasks.
 * Our main app will run in cluster mode on many servers. But only one instance of janitor should be running at any time.
 */

use std::collections::HashMap;
use std::fmt::{Debug, Write};
use std::net::IpAddr;
use std::sync::LazyLock;
use std::time::Duration;

use cpeak::CpeakError;
use redis::cluster_async::ClusterConnection;
use sqlx::postgres::PgPoolCopyExt;

use server_turbo::config::keys::KEYS;
use server_turbo::database::index::POOL;
use server_turbo::database::types::LinkType;
use server_turbo::redis::redis::{check_connection, connect};
use server_turbo::redis::views_stream::views_stream_key;

// What Redis sends back for XREADGROUP: for every stream, its entries (an id, and the fields of the entry)
type StreamEntries = Vec<(String, Vec<String>)>;
type Streams = Option<Vec<(String, StreamEntries)>>;

fn main() {
    // Set node process name to node-janitor for easier identification in logs and process managers
    // (a Rust program can't rename itself like that: it is called janitor, after this file)

    // Rust has no top-level await, so the janitor runs in cpeak::run()
    cpeak::run(janitor());
}

async fn janitor() {
    // In the Node.js version, the database and Redis connect as soon as their files are imported
    LazyLock::force(&POOL);
    if KEYS.redis_enabled {
        cpeak::spawn(check_connection());
    }

    cpeak::spawn(async {
        loop {
            cpeak::sleep(Duration::from_millis(5 * 60 * 1000)).await; // 5 minutes in milliseconds
            clean_up_expired_digit_code().await;
        }
    });

    // Initial cleanup on startup
    cpeak::spawn(clean_up_expired_digit_code());

    /* @todo handle expired usernames, run once per day */

    // What process.on("SIGTERM", ...) is in the Node.js version. Cpeak exits the program
    // once this is done.
    cpeak::on_shutdown(async || {
        // (the connection to Redis ends with the program)
        POOL.close().await;
    });

    if KEYS.redis_enabled {
        // One drain loop for each of the streams the views are spread over
        for shard in 0..KEYS.views_stream_shards {
            cpeak::spawn(run_drain_loop(shard));
        }
    }

    // Node.js keeps a program going for as long as it has a timer. Rust stops when main
    // returns, so we wait here forever.
    std::future::pending::<()>().await;
}

// ─── Expired digit codes clean up ─────────────────────────────────────────────

async fn clean_up_expired_digit_code() {
    let result = sqlx::query("DELETE FROM digit_codes WHERE expires_at < NOW();")
        .execute(&*POOL)
        .await
        .unwrap_or_else(|error| crash(&error));

    if result.rows_affected() > 0 {
        println!(
            "[janitor] cleaned up {} expired digit codes.",
            result.rows_affected()
        );
    }
}

// ─── Views consumer ───────────────────────────────────────────────────────────

const GROUP_NAME: &str = "views_consumer";
const CONSUMER_NAME: &str = "janitor";
// With COPY, 5,000 views at a time reach about 1M views/s (500 at a time only 790,000)
const BATCH_SIZE: u32 = 5000;

// COPY instead of INSERT: about 1M views/s instead of 760,000 (see views.sql)
const COPY_VIEWS: &str = "COPY views (url_id, ip_address, user_agent, referrer, link_type, via_qr, visitor_hash) FROM STDIN (FORMAT csv)";

// A text field in CSV: in quotes, with its quotes doubled (so an empty one is "", not NULL)
fn csv_text(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

// Parse the flat field-value array from a Redis stream entry into an object
fn parse_stream_fields(fields: &[String]) -> HashMap<&str, &str> {
    let mut obj = HashMap::new();
    for i in (0..fields.len()).step_by(2) {
        obj.insert(
            fields[i].as_str(),
            fields.get(i + 1).map_or("", String::as_str),
        );
    }
    obj
}

// Create the consumer group once on startup. MKSTREAM creates the stream if it doesn't exist yet
async fn create_views_group(redis: &mut ClusterConnection, key: &str) {
    let created = redis::cmd("XGROUP")
        .arg(("CREATE", key, GROUP_NAME, "0", "MKSTREAM"))
        .query_async::<String>(redis)
        .await;

    match created {
        Ok(_) => println!("[views-consumer] consumer group created for {key}"),
        Err(err) => {
            // BUSYGROUP means the group already exists which is fine
            if !err.to_string().contains("BUSYGROUP") {
                eprintln!("[views-consumer] failed to create consumer group: {err}");
            }
        }
    }
}

// Returns how many views it saved
async fn drain_views_once(
    redis: &mut ClusterConnection,
    key: &str,
    consecutive_errors: &mut u32,
) -> usize {
    let drained: Result<usize, CpeakError> = async {
        let results: Streams = redis::cmd("XREADGROUP")
            .arg((
                "GROUP",
                GROUP_NAME,
                CONSUMER_NAME,
                "COUNT",
                BATCH_SIZE,
                "BLOCK",
                0,
                "STREAMS",
                key,
                ">", // means give me the next messages that have never been delivered to any other consumer in this group
            ))
            .query_async(&mut *redis)
            .await?;

        let Some(results) = results.filter(|results| !results.is_empty()) else {
            return Ok(0);
        };
        let entries = &results[0].1;
        if entries.is_empty() {
            return Ok(0);
        }

        let ids: Vec<&str> = entries.iter().map(|(id, _)| id.as_str()).collect();

        let row_count = ids.len();

        // One line of CSV for every view, in the order of COPY_VIEWS. An empty field is NULL.
        let mut csv = String::with_capacity(entries.len() * 200);
        for (_, fields) in entries {
            let entry = parse_stream_fields(fields);
            let url_id = entry
                .get("url_id")
                .and_then(|url_id| url_id.parse::<i32>().ok());
            let ip_address = entry
                .get("ip_address")
                .and_then(|ip_address| ip_address.parse::<IpAddr>().ok());
            let link_type = entry
                .get("link_type")
                .and_then(|link_type| LinkType::parse(link_type));

            // (writing to a String can't fail)
            let _ = writeln!(
                csv,
                "{},{},{},{},{},{},{}",
                url_id.map(|url_id| url_id.to_string()).unwrap_or_default(),
                ip_address.map(|ip| ip.to_string()).unwrap_or_default(),
                csv_text(entry.get("user_agent").copied().unwrap_or("")),
                csv_text(entry.get("referrer").copied().unwrap_or("")),
                link_type.map_or("", LinkType::as_str),
                entry.get("via_qr").copied() == Some("1"),
                // The stream has the hash in hex; \x tells PostgreSQL to store it as bytes
                entry
                    .get("visitor_hash")
                    .map(|visitor_hash| format!("\\x{visitor_hash}"))
                    .unwrap_or_default(),
            );
        }

        let mut copy = POOL.copy_in_raw(COPY_VIEWS).await?;
        copy.send(csv.as_bytes()).await?;
        copy.finish().await?;

        // This tells Redis that the janitor has successfully processed the messages
        redis::cmd("XACK")
            .arg((key, GROUP_NAME, ids))
            .query_async::<u64>(&mut *redis)
            .await?;

        *consecutive_errors = 0;
        // println!("[views-consumer] inserted {row_count} views");
        Ok(row_count)
    }
    .await;

    match drained {
        Ok(saved) => saved,
        Err(err) => {
            *consecutive_errors += 1;
            let delay = 1000_u64
                .saturating_mul(2_u64.saturating_pow(*consecutive_errors))
                .min(30_000);
            eprintln!("[views-consumer] drain of {key} failed (retry in {delay}ms): {err}");
            cpeak::sleep(Duration::from_millis(delay)).await;
            0
        }
    }
}

async fn clear_pending_on_startup(redis: &mut ClusterConnection, key: &str) {
    let mut cleared = 0;
    loop {
        let results: Streams = redis::cmd("XREADGROUP")
            .arg((
                "GROUP",
                GROUP_NAME,
                CONSUMER_NAME,
                "COUNT",
                BATCH_SIZE,
                "STREAMS",
                key,
                "0",
            ))
            .query_async(&mut *redis)
            .await
            .unwrap_or_else(|error| crash(&error));

        let entries = results
            .and_then(|results| results.into_iter().next())
            .map(|(_, entries)| entries)
            .unwrap_or_default();
        if entries.is_empty() {
            break;
        }

        let ids: Vec<&str> = entries.iter().map(|(id, _)| id.as_str()).collect();
        redis::cmd("XACK")
            .arg((key, GROUP_NAME, &ids))
            .query_async::<u64>(&mut *redis)
            .await
            .unwrap_or_else(|error| crash(&error));
        cleared += ids.len();
    }

    if cleared > 0 {
        eprintln!("[janitor] Discarded {cleared} pending records of {key} from previous run.");
    }
}

// Drain continuously when there's data; sleep briefly when idle to avoid busy-waiting
async fn run_drain_loop(shard: u32) {
    let key = views_stream_key(shard);
    // A connection of its own: XREADGROUP with BLOCK holds the connection until new views come
    // in, so the loops of the other streams can't share it
    let mut redis = connect();

    redis::cmd("CLIENT")
        .arg(("SETNAME", "janitor"))
        .query_async::<String>(&mut redis)
        .await
        .unwrap_or_else(|error| crash(&error));
    create_views_group(&mut redis, &key).await;

    // At this point we just get rid of the pending items. If we want 100% data integrity, we can implement a recovery mechanism that
    // fetches and processes the pending messages before starting the normal drain loop. In that case, we should handle the nil cases because of MAX_LEN.
    // We should also add a new column to the views table to store the Redis stream ID to avoid duplicates during recovery.
    clear_pending_on_startup(&mut redis, &key).await;

    let mut consecutive_errors = 0;
    loop {
        let saved = drain_views_once(&mut redis, &key, &mut consecutive_errors).await;

        // We can sleep here to reduce the CPU load of this process when receiving lots of views.
        // But only when the batch wasn't full: a full one means more views are waiting.
        if saved < BATCH_SIZE as usize {
            cpeak::sleep(Duration::from_millis(100)).await;
        }
    }
}

// In the Node.js version, an error that nothing catches (an unhandled promise rejection)
// stops the program, and the process manager starts it again. This does the same.
fn crash(error: &dyn Debug) -> ! {
    eprintln!("{error:?}");
    std::process::exit(1);
}
