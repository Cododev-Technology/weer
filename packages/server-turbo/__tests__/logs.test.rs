use chrono::Utc;
use cpeak::crypto::{hex_encode, random_bytes};
use cpeak::json;

use crate::helpers::assert::time;
use crate::helpers::logs::{log_size, wait_for_log};
use crate::helpers::supertest::request;
use crate::helpers::target::app;
use crate::setup_each_test::test;

// A destination on the domain allowlist, so the server never has to ask the Web Risk API about it
const URL: &str = "https://github.com/agile8118/weer";

// Something to tell our own request apart from all the other ones in the log file
fn marker() -> String {
    format!("log={}", hex_encode(random_bytes(8)))
}

// The date and time the way the logs have it, like 2026-01-15 10:20:30
#[track_caller]
fn assert_log_date(date: &str) {
    let format = "%Y-%m-%d %H:%M:%S";
    assert_eq!(
        chrono::NaiveDateTime::parse_from_str(date, format)
            .unwrap_or_else(|error| panic!("{date:?} is not such a date: {error}"))
            .format(format)
            .to_string(),
        date
    );
}

// An error in errors.log: a line of dashes, the date, the name and the message of the error,
// and then its stack trace, up to the closing line of dashes
#[track_caller]
fn assert_logged_error(log: &str, name: &str, message: &str) {
    let dashes = "-".repeat(39);
    let stack = log
        .strip_prefix(&format!("{dashes}\n"))
        .and_then(|log| {
            assert_log_date(log.get(..19)?);
            log.get(19..)
        })
        .and_then(|log| {
            log.strip_prefix(&format!(
                "\nError Name: {name}\nError Message: {message}\nError Stack:\n"
            ))
        })
        .and_then(|log| log.strip_suffix(&format!("\n{dashes}\n")))
        .unwrap_or_else(|| panic!("not the error that was expected in errors.log:\n{log}"));

    assert!(!stack.is_empty());
}

// Finds the line of the request with this marker in info.log
async fn request_line(id: &str) -> String {
    let log = wait_for_log("info.log", id, 0).await;
    log.split('\n')
        .find(|line| line.contains(id))
        .unwrap()
        .to_string()
}

mod logs {
    use super::*;

    #[test]
    fn should_log_every_request_with_its_status_and_how_long_it_took() {
        test(async {
            let id = marker();

            request(app()).get(&format!("/auth/status?{id}")).await;

            // Like: 2026-01-15 10:20:30 -- ::ffff:127.0.0.1 -- GET /auth/status?log=... 200 OK -- response-time: 3 ms
            let line = request_line(&id).await;
            assert_log_date(&line[..19]);

            let response_time = line[19..]
                .strip_prefix(&format!(
                    " -- ::ffff:127.0.0.1 -- GET /auth/status?{id} 200 OK -- response-time: "
                ))
                .and_then(|line| line.strip_suffix(" ms"))
                .unwrap_or_else(|| panic!("{line:?} is not the line of the request"));
            assert!(!response_time.is_empty());
            // With two decimals
            let (whole, decimals) = response_time
                .split_once('.')
                .unwrap_or_else(|| panic!("{response_time:?} has no decimals"));
            assert!(!whole.is_empty() && whole.bytes().all(|byte| byte.is_ascii_digit()));
            assert!(decimals.len() == 2 && decimals.bytes().all(|byte| byte.is_ascii_digit()));
        });
    }

    #[test]
    fn should_log_the_date_and_time_in_utc() {
        test(async {
            let id = marker();

            let before = Utc::now().timestamp_millis();
            request(app()).get(&format!("/auth/status?{id}")).await;
            let after = Utc::now().timestamp_millis();

            let line = request_line(&id).await;
            let logged_at = time(&format!("{}Z", line[..19].replace(' ', "T")));

            // The log only has the seconds
            assert!(logged_at >= before - 1000 && logged_at <= after);
        });
    }

    #[test]
    fn should_log_the_ip_address_that_a_proxy_passes_on() {
        test(async {
            let id = marker();

            request(app())
                .get(&format!("/auth/status?{id}"))
                .set("X-Forwarded-For", "203.0.113.7, 10.0.0.1")
                .await;

            assert!(request_line(&id).await.contains(&format!(
                " -- 203.0.113.7, 10.0.0.1 -- GET /auth/status?{id} 200 OK -- "
            )));
        });
    }

    #[test]
    fn should_log_the_method_the_url_as_it_came_in_and_the_status_message() {
        test(async {
            let requests = [
                ("get", "/logout", "302 Found"),
                ("get", "/user/username-availability/joe", "200 OK"),
                ("post", "/url", "400 Bad Request"),
                ("delete", "/url/12345", "403 Forbidden"),
                ("get", "/nope/nope%20nope/nope", "404 Not Found"),
                ("get", "/abc/", "500 Internal Server Error"),
            ];

            for (method, path, status) in requests {
                let id = marker();
                let url = format!("{path}?a=1&{id}&b=%20c");

                match method {
                    "post" => request(app()).post(&url).send(json!({})).await,
                    "delete" => request(app()).delete(&url).await,
                    _ => request(app()).get(&url).await,
                };

                assert!(
                    request_line(&id).await.contains(&format!(
                        " -- {} {url} {status} -- response-time: ",
                        method.to_uppercase()
                    )),
                    "{method} {path}"
                );
            }
        });
    }
}

mod unexpected_errors {
    use super::*;

    #[test]
    fn should_answer_with_a_500_and_keep_the_details_to_itself() {
        test(async {
            // A link without a session to own it (the database refuses that one), and a URL
            // that ends up without a code
            let responses = [
                request(app())
                    .post("/url")
                    .send(json!({ "url": URL, "type": "classic" }))
                    .await,
                request(app()).get("/abc/").await,
            ];

            for res in responses {
                assert_eq!(res.status_code, 500);
                assert_eq!(res.header("content-type"), Some("application/json"));
                assert_eq!(res.header("connection"), Some("close"));
                assert_eq!(
                    res.text,
                    json!({
                        "error": "Sorry, something unexpected happened from our side.",
                    })
                    .to_string()
                );
            }
        });
    }

    #[test]
    fn should_log_the_error_of_the_database_in_errors_log() {
        test(async {
            let from = log_size("errors.log");

            request(app())
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await;

            let message = r#"new row for relation "urls" violates check constraint "chk_owner""#;
            let log = wait_for_log("errors.log", message, from).await;

            // pg (Node.js) calls it "error". sqlx (Rust) has no name for it, and puts more
            // around the message of PostgreSQL.
            if log.contains("\nError Name: error\n") {
                assert_logged_error(&log, "error", message);
            } else {
                assert!(log.contains(&format!(
                    "\nError Name: Error\nError Message: error returned from database: {message}"
                )));
            }
        });
    }

    #[test]
    fn should_log_an_error_of_our_own_in_errors_log() {
        test(async {
            let from = log_size("errors.log");

            request(app()).get("/abc/").await;

            let log = wait_for_log("errors.log", "No URL ID provided", from).await;

            assert_logged_error(&log, "Error", "No URL ID provided");
        });
    }

    #[test]
    fn should_not_log_the_errors_that_are_sent_to_the_client() {
        test(async {
            let from = log_size("errors.log");

            let res = request(app()).delete("/url/12345").await;
            assert_eq!(res.status_code, 403);

            // The request is in info.log by now, so the error would have been logged too
            let id = marker();
            request(app()).get(&format!("/auth/status?{id}")).await;
            request_line(&id).await;

            assert_eq!(log_size("errors.log"), from);
        });
    }
}
