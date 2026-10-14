use chrono::Utc;
use cpeak::json;

use server_turbo::database::index::POOL;
use server_turbo::database::types::{IUrl, LinkType};

use crate::helpers::assert::{assert_iso_date, assert_made_of, time};
use crate::helpers::factories::url::{text, url_id};
use crate::helpers::factories::user::create_user;
use crate::helpers::supertest::request;
use crate::helpers::target::app;
use crate::setup_each_test::test;

// A destination on the domain allowlist, so the server never has to ask the Web Risk API about it
const URL: &str = "https://github.com/agile8118/weer";

// Starts a new anonymous session and returns its cookie
async fn session_cookie() -> String {
    let res = request(app()).get("/auth/status").await;
    res.set_cookie[0].split(';').next().unwrap().to_string()
}

mod shortening_a_url {
    use super::*;

    #[test]
    fn should_return_the_new_link_as_json() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;

            let res = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.header("content-type"), Some("application/json"));
            // (a classic code has no l and no o in it)
            assert_made_of(
                res.body["code"].as_str().unwrap(),
                6,
                |c| matches!(c, 'a'..='k' | 'm' | 'n' | 'p'..='z' | '0'..='9'),
            );
            assert_eq!(
                res.text,
                json!({
                    "URLId": 1,
                    "realURL": URL,
                    "linkType": "classic",
                    "code": res.body["code"],
                    "expiresAt": null,
                })
                .to_string()
            );
        });
    }

    #[test]
    fn should_save_a_classic_link_for_the_anonymous_session() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;

            let res = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await;

            let urls = sqlx::query_as::<_, (i32, String, Option<String>, LinkType, Option<i32>, bool, String)>(
                "SELECT urls.id, real_url, shortened_url_id, link_type, user_id, sessions.id IS NOT NULL AS has_session, qr_code_id
      FROM urls LEFT JOIN sessions ON sessions.id = urls.session_id",
            )
            .fetch_all(&*POOL)
            .await
            .unwrap();
            assert_eq!(urls.len(), 1);
            let (id, real_url, shortened_url_id, link_type, user_id, has_session, qr_code_id) =
                urls[0].clone();

            // The QR code id is 7 random bytes in base64url
            assert_made_of(&qr_code_id, 10, |c| {
                c.is_ascii_alphanumeric() || c == '_' || c == '-'
            });

            assert_eq!(
                (
                    id,
                    real_url.as_str(),
                    shortened_url_id,
                    link_type,
                    user_id,
                    has_session
                ),
                (
                    url_id(&res.body),
                    URL,
                    text(&res.body["code"]),
                    LinkType::Classic,
                    None,
                    true
                )
            );
        });
    }

    #[test]
    fn should_save_the_link_for_the_user_if_logged_in_and_take_one_credit() {
        test(async {
            let agent = request::agent(app());
            let user = create_user(&agent, None).await;

            let res = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await;

            assert_eq!(res.status_code, 200);

            let url = sqlx::query_as::<_, (Option<i32>, Option<i32>)>(
                "SELECT user_id, session_id FROM urls WHERE id = $1",
            )
            .bind(url_id(&res.body))
            .fetch_optional(&*POOL)
            .await
            .unwrap();
            assert_eq!(url, Some((Some(user.id), None)));

            let link_credits =
                sqlx::query_scalar::<_, i32>("SELECT link_credits FROM users WHERE id = $1")
                    .bind(user.id)
                    .fetch_one(&*POOL)
                    .await
                    .unwrap();
            assert_eq!(link_credits, 99);
        });
    }

    #[test]
    fn should_create_a_digit_link_that_expires_in_2_hours() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;

            let before = Utc::now().timestamp_millis();
            let res = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "digit" }))
                .await;
            let after = Utc::now().timestamp_millis();

            assert_eq!(res.status_code, 200);
            assert_eq!(
                res.body.as_object().unwrap().keys().collect::<Vec<_>>(),
                ["URLId", "realURL", "linkType", "code", "expiresAt"]
            );
            assert_eq!(res.body["linkType"], "digit");
            assert_made_of(res.body["code"].as_str().unwrap(), 3, |c| {
                c.is_ascii_digit()
            });

            // A date the way JavaScript writes it in JSON, like 2026-01-15T10:20:30.123Z
            assert_iso_date(res.body["expiresAt"].as_str().unwrap());
            let expires_at = time(res.body["expiresAt"].as_str().unwrap());
            let two_hours = 2 * 60 * 60 * 1000;
            assert!(expires_at >= before + two_hours && expires_at <= after + two_hours);

            // The code lives in its own table, and the link itself has no code
            let codes = sqlx::query_as::<_, (String, Option<i32>, Option<i32>, LinkType, Option<String>, i64, bool)>(
                "SELECT digit_codes.code, code_length, url_id, urls.link_type, urls.shortened_url_id,
        (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at,
        assigned_at > NOW() - INTERVAL '1 minute' AND assigned_at <= NOW() AS assigned_now
      FROM digit_codes JOIN urls ON urls.id = digit_codes.url_id",
            )
            .fetch_all(&*POOL)
            .await
            .unwrap();
            assert_eq!(
                codes,
                [(
                    res.body["code"].as_str().unwrap().to_string(),
                    Some(3),
                    Some(url_id(&res.body)),
                    LinkType::Digit,
                    None,
                    expires_at,
                    true
                )]
            );
        });
    }

    #[test]
    fn should_create_an_ultra_link_that_expires_in_30_minutes_for_a_logged_in_user() {
        test(async {
            let agent = request::agent(app());
            create_user(&agent, None).await;

            let before = Utc::now().timestamp_millis();
            let first = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "ultra" }))
                .await;
            let second = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "ultra" }))
                .await;
            let after = Utc::now().timestamp_millis();

            // The shortest codes that are free are handed out first
            assert_eq!(first.status_code, 200);
            assert_eq!(first.body["linkType"], "ultra");
            assert_eq!(first.body["code"], "0");
            assert_eq!(second.body["code"], "1");

            assert_iso_date(first.body["expiresAt"].as_str().unwrap());
            let expires_at = time(first.body["expiresAt"].as_str().unwrap());
            let thirty_minutes = 30 * 60 * 1000;
            assert!(
                expires_at >= before + thirty_minutes - 1000
                    && expires_at <= after + thirty_minutes + 1000
            );

            let codes = sqlx::query_as::<_, (String, Option<i32>, LinkType, Option<String>)>(
                "SELECT code, url_id, urls.link_type, urls.shortened_url_id
      FROM ultra_codes JOIN urls ON urls.id = ultra_codes.url_id ORDER BY ultra_codes.id",
            )
            .fetch_all(&*POOL)
            .await
            .unwrap();
            assert_eq!(
                codes,
                [
                    (
                        "0".to_string(),
                        Some(url_id(&first.body)),
                        LinkType::Ultra,
                        None
                    ),
                    (
                        "1".to_string(),
                        Some(url_id(&second.body)),
                        LinkType::Ultra,
                        None
                    ),
                ]
            );
        });
    }

    #[test]
    fn should_not_create_an_ultra_link_for_an_anonymous_visitor() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;

            let res = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "ultra" }))
                .await;

            assert_eq!(res.status_code, 401);
            assert_eq!(res.text, json!({ "error": "Unauthorized" }).to_string());
        });
    }

    #[test]
    fn should_not_create_a_link_of_a_type_that_does_not_exist() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;

            // (undefined in the Node.js version is a body without a type)
            let bodies = [
                json!({ "url": URL, "type": "custom" }),
                json!({ "url": URL, "type": "affix" }),
                json!({ "url": URL, "type": "qr" }),
                json!({ "url": URL, "type": "nope" }),
                json!({ "url": URL, "type": "" }),
                json!({ "url": URL }),
                json!({ "url": URL, "type": 5 }),
            ];

            for body in bodies {
                let res = agent.post("/url").send(body).await;

                assert_eq!(res.status_code, 400);
                assert_eq!(res.text, json!({ "error": "Invalid type" }).to_string());
            }
        });
    }

    #[test]
    fn should_ask_for_a_url_if_there_is_none() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;

            for body in [
                json!({}),
                json!({ "type": "classic" }),
                json!({ "url": "", "type": "classic" }),
                json!({ "url": null }),
            ] {
                let res = agent.post("/url").send(body).await;

                assert_eq!(res.status_code, 400);
                assert_eq!(
                    res.text,
                    json!({ "error": "Please first put your URL here." }).to_string()
                );
            }

            let urls = sqlx::query_as::<_, IUrl>("SELECT id FROM urls")
                .fetch_all(&*POOL)
                .await
                .unwrap();
            assert_eq!(urls.len(), 0);
        });
    }

    #[test]
    fn should_not_accept_a_body_that_is_not_valid_json() {
        test(async {
            let res = request(app())
                .post("/url")
                .set("Content-Type", "application/json")
                .send(r#"{ "url": "https://github.com", "#)
                .await;

            assert_eq!(res.status_code, 400);
            assert_eq!(
                res.text,
                json!({ "error": "Invalid JSON format" }).to_string()
            );
        });
    }

    #[test]
    fn should_accept_the_urls_that_are_valid() {
        test(async {
            let valid_urls = [
                "http://github.com",
                "https://github.com/",
                "HTTPS://GITHUB.COM/Agile8118",
                "ftp://github.com/file.zip",
                "https://www.github.com/a/b/c?d=e&f=g#h",
                "https://user:password@github.com:8080/path",
                "http://github.com:1",
                "https://gist.github.com/some-user/0123456789abcdef",
                "https://github.com/search?q=url+shortener&type=repositories",
                "https://github.com/caf%C3%A9/über/日本語",
                "https://youtu.be/dQw4w9WgXcQ",
            ];

            for (i, url) in valid_urls.into_iter().enumerate() {
                let res = request(app())
                    .post("/url")
                    // Every anonymous IP address only gets to create a few links
                    .set("X-Forwarded-For", &format!("198.51.100.{i}"))
                    .set("Cookie", &session_cookie().await)
                    .send(json!({ "url": url, "type": "classic" }))
                    .await;

                assert_eq!(res.status_code, 200, "{url}");
                assert_eq!(res.body["realURL"], url);
            }
        });
    }

    #[test]
    fn should_not_accept_the_urls_that_are_not_valid() {
        test(async {
            let invalid_urls = [
                "random text",
                "github.com",
                "www.github.com/path",
                "http://",
                "http://.",
                "http://..",
                "http://?",
                "http://#",
                "http:// github.com",
                "http://github",
                "http://github.c",
                "http://github.com.",
                "http://-github.com",
                "http://github.com:123456",
                "http://github.com/a b",
                "http://localhost",
                "http://localhost:2080/abc",
                "http://127.0.0.1",
                "http://10.1.1.1",
                "http://192.168.1.1",
                "http://172.16.0.1",
                "http://169.254.1.1",
                "http://0.0.0.0",
                "http://224.1.1.1",
                "http://1.1.1.1.1",
                // Other ways to write 127.0.0.1
                "http://2130706433",
                "http://0x7f.0.0.1",
                // The host is what comes before the first slash, whatever is after it
                "http://127.0.0.1/@github.com",
                "http://localhost/a@github.com",
                "//github.com",
                "mailto:someone@github.com",
                "javascript:alert(1)",
                "file:///etc/passwd",
                "h ttp://github.com",
                " http://github.com",
                "http://github.com ",
                "http://github.com\n",
                "ht\u{ad}tps://github.com",
            ];

            for url in invalid_urls {
                let res = request(app())
                    .post("/url")
                    .send(json!({ "url": url, "type": "classic" }))
                    .await;

                assert_eq!(res.status_code, 400, "{url}");
                assert_eq!(
                    res.text,
                    json!({ "error": "The URL you put is not valid." }).to_string(),
                    "{url}"
                );
            }

            let urls = sqlx::query_as::<_, IUrl>("SELECT id FROM urls")
                .fetch_all(&*POOL)
                .await
                .unwrap();
            assert_eq!(urls.len(), 0);
        });
    }

    #[test]
    fn should_not_accept_a_url_that_is_something_other_than_text() {
        test(async {
            for url in [json!(123), json!(true), json!({ "href": URL })] {
                let res = request(app())
                    .post("/url")
                    .send(json!({ "url": url, "type": "classic" }))
                    .await;

                assert_eq!(res.status_code, 400);
                assert_eq!(
                    res.text,
                    json!({ "error": "The URL you put is not valid." }).to_string()
                );
            }
        });
    }
}
