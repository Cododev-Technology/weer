use std::fs;
use std::time::Duration;

// The logs folder of the server that the tests run against
fn logs_path() -> String {
    std::env::var("TEST_LOGS_DIR")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/logs").to_string())
}

// The path of a log file of today (the logs are in a folder for every day, in UTC)
fn log_file(name: &str) -> String {
    format!(
        "{}/{}/{name}",
        logs_path(),
        chrono::Utc::now().format("%Y-%m-%d")
    )
}

// How long a log file is right now, so we can tell later what was added to it
pub fn log_size(name: &str) -> usize {
    fs::metadata(log_file(name)).map_or(0, |file| file.len() as usize)
}

// Waits until some text shows up in a log file (after the given position), and returns
// everything that was added to the file by then. The server writes its logs in the background.
pub async fn wait_for_log(name: &str, text: &str, from: usize) -> String {
    let mut added = String::new();

    for _ in 0..100 {
        if let Ok(log) = fs::read(log_file(name)) {
            added = String::from_utf8_lossy(log.get(from..).unwrap_or_default()).into_owned();
        }

        if added.contains(text) {
            return added;
        }
        cpeak::sleep(Duration::from_millis(50)).await;
    }

    panic!("\"{text}\" never showed up in {}", log_file(name));
}
