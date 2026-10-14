/*
 * This code will run in a separate process to clean up expired codes and perform other maintenance tasks.
 * Our main app will run in cluster mode on many servers. But only one instance of janitor should be running at any time.
 */

use std::collections::HashMap;
use std::fmt::Debug;
use std::net::IpAddr;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use cpeak::CpeakError;
use sqlx::AssertSqlSafe;

use server_turbo::config::keys::KEYS;
use server_turbo::database::index::POOL;
use server_turbo::database::types::LinkType;
use server_turbo::redis::redis::REDIS;
use server_turbo::redis::views_stream::VIEWS_STREAM_KEY;

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
        LazyLock::force(&REDIS);
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
        run_drain_loop().await;
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
const BATCH_SIZE: u32 = 500;
static CONSECUTIVE_ERRORS: AtomicU32 = AtomicU32::new(0);

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
async fn create_views_group() {
    let created = redis::cmd("XGROUP")
        .arg(("CREATE", VIEWS_STREAM_KEY, GROUP_NAME, "0", "MKSTREAM"))
        .query_async::<String>(&mut REDIS.clone())
        .await;

    match created {
        Ok(_) => println!("[views-consumer] consumer group created"),
        Err(err) => {
            // BUSYGROUP means the group already exists which is fine
            if !err.to_string().contains("BUSYGROUP") {
                eprintln!("[views-consumer] failed to create consumer group: {err}");
            }
        }
    }
}

async fn drain_views_once() {
    let drained: Result<(), CpeakError> = async {
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
                VIEWS_STREAM_KEY,
                ">", // means give me the next messages that have never been delivered to any other consumer in this group
            ))
            .query_async(&mut REDIS.clone())
            .await?;

        let Some(results) = results.filter(|results| !results.is_empty()) else {
            return Ok(());
        };
        let entries = &results[0].1;
        if entries.is_empty() {
            return Ok(());
        }

        let ids: Vec<&str> = entries.iter().map(|(id, _)| id.as_str()).collect();

        #[allow(unused_variables)]
        let row_count = ids.len();

        const COLUMNS: [&str; 7] = [
            "url_id",
            "ip_address",
            "user_agent",
            "referrer",
            "link_type",
            "via_qr",
            "visitor_hash",
        ];

        // placeholders should look like ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12), ...
        let placeholders = (0..ids.len())
            .map(|i| {
                let offset = i * COLUMNS.len();
                let row: Vec<String> = (0..COLUMNS.len())
                    .map(|j| format!("${}", offset + j + 1))
                    .collect();
                format!("({})", row.join(", "))
            })
            .collect::<Vec<String>>()
            .join(", ");

        // (a query that we put together ourselves has to be marked as safe for sqlx to run it)
        let mut insert = sqlx::query(AssertSqlSafe(format!(
            "INSERT INTO views ({}) VALUES {placeholders}",
            COLUMNS.join(", ")
        )))
        // The query is another one for every number of views, so there's no use in sqlx keeping it
        .persistent(false);

        for (_, fields) in entries {
            let entry = parse_stream_fields(fields);
            insert = insert
                .bind(
                    entry
                        .get("url_id")
                        .and_then(|url_id| url_id.parse::<i32>().ok()),
                )
                .bind(
                    entry
                        .get("ip_address")
                        .and_then(|ip_address| ip_address.parse::<IpAddr>().ok()),
                )
                .bind(entry.get("user_agent").copied().unwrap_or(""))
                .bind(entry.get("referrer").copied().unwrap_or(""))
                .bind(
                    entry
                        .get("link_type")
                        .and_then(|link_type| LinkType::parse(link_type)),
                )
                .bind(entry.get("via_qr").copied() == Some("1"))
                .bind(entry.get("visitor_hash").copied());
        }

        insert.execute(&*POOL).await?;

        // This tells Redis that the janitor has successfully processed the messages
        redis::cmd("XACK")
            .arg((VIEWS_STREAM_KEY, GROUP_NAME, ids))
            .query_async::<u64>(&mut REDIS.clone())
            .await?;

        CONSECUTIVE_ERRORS.store(0, Ordering::Relaxed);
        // println!("[views-consumer] inserted {row_count} views");
        Ok(())
    }
    .await;

    if let Err(err) = drained {
        let consecutive_errors = CONSECUTIVE_ERRORS.fetch_add(1, Ordering::Relaxed) + 1;
        let delay = 1000_u64
            .saturating_mul(2_u64.saturating_pow(consecutive_errors))
            .min(30_000);
        eprintln!("[views-consumer] drain failed (retry in {delay}ms): {err}");
        cpeak::sleep(Duration::from_millis(delay)).await;
    }
}

async fn clear_pending_on_startup() {
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
                VIEWS_STREAM_KEY,
                "0",
            ))
            .query_async(&mut REDIS.clone())
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
            .arg((VIEWS_STREAM_KEY, GROUP_NAME, &ids))
            .query_async::<u64>(&mut REDIS.clone())
            .await
            .unwrap_or_else(|error| crash(&error));
        cleared += ids.len();
    }

    if cleared > 0 {
        eprintln!("[janitor] Discarded {cleared} pending records from previous run.");
    }
}

// Drain continuously when there's data; sleep briefly when idle to avoid busy-waiting
async fn run_drain_loop() {
    redis::cmd("CLIENT")
        .arg(("SETNAME", "janitor"))
        .query_async::<String>(&mut REDIS.clone())
        .await
        .unwrap_or_else(|error| crash(&error));
    create_views_group().await;

    // At this point we just get rid of the pending items. If we want 100% data integrity, we can implement a recovery mechanism that
    // fetches and processes the pending messages before starting the normal drain loop. In that case, we should handle the nil cases because of MAX_LEN.
    // We should also add a new column to the views table to store the Redis stream ID to avoid duplicates during recovery.
    clear_pending_on_startup().await;

    loop {
        drain_views_once().await;

        // We can sleep here to reduce the CPU load of this process when receiving lots of views.
        cpeak::sleep(Duration::from_millis(100)).await;
    }
}

// In the Node.js version, an error that nothing catches (an unhandled promise rejection)
// stops the program, and the process manager starts it again. This does the same.
fn crash(error: &dyn Debug) -> ! {
    eprintln!("{error:?}");
    std::process::exit(1);
}
