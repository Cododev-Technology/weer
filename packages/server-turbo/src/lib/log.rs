use std::fs;
use std::io::{self, BufWriter, Write};
use std::path::Path;
use std::sync::LazyLock;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use chrono::{Datelike, Timelike, Utc};
use cpeak::CpeakError;

/*
  if the message parameter is an error we log error and if it's string we log info
*/

// Base log directory — ensure it exists once at startup
const BASE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/logs");

// Persistent write stream for info logs — rotates automatically at day rollover
struct Logs {
    current_day: String,
    info_stream: Option<BufWriter<fs::File>>,
}

impl Logs {
    fn ensure_stream(&mut self, dir: &str) {
        if dir == self.current_day {
            return;
        }

        // Close the old stream before rotating to the new day's file
        self.info_stream = None;

        // Create the new day directory and open a fresh stream
        let stream = fs::create_dir_all(dir).and_then(|()| {
            fs::OpenOptions::new()
                .append(true)
                .create(true)
                .open(format!("{dir}/info.log"))
        });
        match stream {
            Ok(stream) => {
                self.info_stream = Some(BufWriter::new(stream));
                self.current_day = dir.to_string();
            }
            Err(err) => self.on_error(err),
        }
    }

    // If the logs dir gets deleted mid-run, reset so the next write triggers re-creation
    fn on_error(&mut self, err: io::Error) {
        eprintln!("Error writing to log stream: {err:?}");
        if err.kind() == io::ErrorKind::NotFound {
            self.current_day = String::new();
            self.info_stream = None;
        } else {
            eprintln!("{err:?}");
        }
    }
}

// What a call to log() hands over to the thread that writes the logs
enum Entry {
    Info { dir: String, msg: String },
    Error { dir: String, msg: String },
}

// In the Node.js version, a write stream takes the log lines and writes them out in the
// background. Here a thread of its own does that, so a request never waits for the disk.
static WRITER: LazyLock<Sender<Entry>> = LazyLock::new(|| {
    if !Path::new(BASE_DIR).exists() {
        let _ = fs::create_dir(BASE_DIR);
    }

    let (sender, receiver) = mpsc::channel();
    std::thread::Builder::new()
        .name("weer-logs".to_string())
        .spawn(move || write_logs(receiver))
        .unwrap_or_else(|error| panic!("Failed to start the thread that writes the logs: {error}"));
    sender
});

fn write_logs(entries: Receiver<Entry>) {
    let mut logs = Logs {
        current_day: String::new(),
        info_stream: None,
    };
    let mut last_check = Instant::now();

    loop {
        let until_next_check = Duration::from_millis(5000).saturating_sub(last_check.elapsed());
        let mut entry = match entries.recv_timeout(until_next_check) {
            Ok(entry) => Some(entry),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => return,
        };

        // Write everything that is waiting, and then send it to the disk in one go
        while let Some(next) = entry {
            match next {
                Entry::Info { dir, msg } => {
                    // Write to the persistent stream — rotates automatically when the day changes
                    logs.ensure_stream(&dir);

                    if let Some(info_stream) = &mut logs.info_stream
                        && let Err(err) = info_stream.write_all(msg.as_bytes())
                    {
                        logs.on_error(err);
                    }
                }
                // Add the log message to errors.log file in the right directory
                Entry::Error { dir, msg } => {
                    if let Err(err) = append_file(&format!("{dir}/errors.log"), &msg) {
                        if err.kind() == io::ErrorKind::NotFound {
                            let _ = fs::create_dir_all(&dir);
                            if let Err(err2) = append_file(&format!("{dir}/errors.log"), &msg) {
                                eprintln!("{err2:?}");
                            }
                        } else {
                            eprintln!("{err:?}");
                        }
                    }
                }
            }
            entry = entries.try_recv().ok();
        }
        if let Some(info_stream) = &mut logs.info_stream
            && let Err(err) = info_stream.flush()
        {
            logs.on_error(err);
        }

        // Detect if the log file is deleted mid-run. On Unix, open file descriptors stay valid
        // after unlink so write errors never fire. We poll instead to catch this case.
        if last_check.elapsed() >= Duration::from_millis(5000) {
            last_check = Instant::now();
            if logs.current_day.is_empty() {
                continue;
            }
            if !Path::new(&format!("{}/info.log", logs.current_day)).exists() {
                eprintln!("[!] Log file missing, resetting stream...");
                logs.info_stream = None;
                logs.current_day = String::new();
            }
        }
    }
}

fn append_file(path: &str, data: &str) -> io::Result<()> {
    fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)?
        .write_all(data.as_bytes())
}

// What can be logged: a string (info) or an error
pub enum Message {
    Info(String),
    Error {
        name: String,
        message: String,
        stack: String,
    },
}

impl From<&str> for Message {
    fn from(message: &str) -> Self {
        Message::Info(message.to_string())
    }
}

impl From<String> for Message {
    fn from(message: String) -> Self {
        Message::Info(message)
    }
}

impl From<&CpeakError> for Message {
    fn from(error: &CpeakError) -> Self {
        // An error that PostgreSQL sent back is called "error" and has the message of
        // PostgreSQL (like in pg), and anything else is an "Error" (like `new Error(...)`
        // in JavaScript)
        let from_postgres = error
            .source()
            .and_then(|source| source.downcast_ref::<sqlx::Error>())
            .and_then(|error| error.as_database_error());
        let (name, message) = match from_postgres {
            Some(from_postgres) => ("error", from_postgres.message()),
            None => ("Error", error.message.as_str()),
        };

        Message::Error {
            name: name.to_string(),
            message: message.to_string(),
            // Rust has no stack trace for an error, so this is everything the error knows
            stack: format!("{name}: {message}\n    {error:?}"),
        }
    }
}

pub fn log(message: impl Into<Message>) {
    // Format the current date to use for each log
    let d = Utc::now();
    let date_string = format!(
        "{}-{:02}-{:02} {:02}:{:02}:{:02}",
        d.year(),
        d.month(),
        d.day(),
        d.hour(),
        d.minute(),
        d.second()
    );

    // Create folders in log folder for better log organization based on each day
    let dir = format!("{BASE_DIR}/{}-{:02}-{:02}", d.year(), d.month(), d.day());

    match message.into() {
        // If we pass an error to the function
        Message::Error {
            name,
            message,
            stack,
        } => {
            let err_stack = if stack.is_empty() {
                String::new()
            } else {
                format!("\nError Stack:\n{stack}")
            };
            let err_message = if message.is_empty() {
                String::new()
            } else {
                format!("\nError Message: {message}")
            };
            let err_name = if name.is_empty() {
                String::new()
            } else {
                format!("\nError Name: {name}")
            };

            // Prepare the message to be logged
            let msg = format!(
                "---------------------------------------\n{date_string}{err_name}{err_message}{err_stack}\n---------------------------------------\n"
            );
            let _ = WRITER.send(Entry::Error { dir, msg });
        }

        // If we pass a string to the function
        Message::Info(message) => {
            // Prepare the message to be logged
            let msg = format!("{date_string} -- {message}\n");
            let _ = WRITER.send(Entry::Info { dir, msg });
        }
    }
}
