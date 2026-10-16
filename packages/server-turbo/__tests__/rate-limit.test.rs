use std::net::IpAddr;

use cpeak::json;

use server_turbo::database::index::POOL;
use server_turbo::database::types::LinkType;

use crate::helpers::factories::url::text;
use crate::helpers::factories::user::create_user;
use crate::helpers::supertest::{Agent, request};
use crate::helpers::target::app;
use crate::setup_each_test::test;

// A destination on the domain allowlist, so the server never has to ask the Web Risk API about it
const URL: &str = "https://github.com/agile8118/weer";

fn too_many_requests() -> String {
    json!({
        "error": "Too many requests. Please try again later.",
    })
    .to_string()
}

fn out_of_credits() -> String {
    json!({
        "error":
            "You've used all your credits. Please contact support to increase your limit for free.",
    })
    .to_string()
}

async fn anonymous() -> Agent {
    let agent = request::agent(app());
    agent.get("/auth/status").await;
    agent
}

// The IP addresses that are being counted, and how many requests each one has made
async fn rate_limits() -> Vec<(String, i32)> {
    sqlx::query_as::<_, (IpAddr, i32)>(
        "SELECT ip_address, burst_count FROM rate_limits ORDER BY ip_address",
    )
    .fetch_all(&*POOL)
    .await
    .unwrap()
    .into_iter()
    .map(|(ip_address, burst_count)| (ip_address.to_string(), burst_count))
    .collect()
}

mod rate_limiting {
    use super::*;

    #[test]
    fn should_let_an_anonymous_ip_address_create_10_links_in_10_minutes() {
        test(async {
            let agent = anonymous().await;

            for i in 1..=10 {
                let res = agent
                    .post("/url")
                    .set("X-Forwarded-For", "203.0.113.7")
                    .send(json!({ "url": URL, "type": "classic" }))
                    .await;
                assert_eq!(res.status_code, 200, "link {i}");
            }

            let res = agent
                .post("/url")
                .set("X-Forwarded-For", "203.0.113.7")
                .send(json!({ "url": URL, "type": "classic" }))
                .await;

            assert_eq!(res.status_code, 429);
            assert_eq!(res.text, too_many_requests());

            let urls = sqlx::query("SELECT id FROM urls")
                .fetch_all(&*POOL)
                .await
                .unwrap();
            assert_eq!(urls.len(), 10);

            assert_eq!(rate_limits().await, [("203.0.113.7".to_string(), 11)]);
        });
    }

    #[test]
    fn should_count_every_ip_address_on_its_own() {
        test(async {
            let agent = anonymous().await;

            // The first address of X-Forwarded-For is the one of the visitor
            for i in 1..=11 {
                let res = agent
                    .post("/url")
                    .set("X-Forwarded-For", " 203.0.113.7 , 10.0.0.1")
                    .send(json!({ "url": URL, "type": "classic" }))
                    .await;
                assert_eq!(res.status_code, if i <= 10 { 200 } else { 429 }, "link {i}");
            }

            let res = agent
                .post("/url")
                .set("X-Forwarded-For", "203.0.113.8, 203.0.113.7")
                .send(json!({ "url": URL, "type": "classic" }))
                .await;

            assert_eq!(res.status_code, 200);

            assert_eq!(
                rate_limits().await,
                [
                    ("203.0.113.7".to_string(), 11),
                    ("203.0.113.8".to_string(), 1),
                ]
            );
        });
    }

    #[test]
    fn should_count_the_visitors_without_x_forwarded_for_by_the_address_they_connect_from() {
        test(async {
            let agent = anonymous().await;

            let res = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await;
            assert_eq!(res.status_code, 200);

            // The tests connect over IPv4 to a server that listens over both IPv6 and IPv4
            assert_eq!(rate_limits().await, [("::ffff:127.0.0.1".to_string(), 1)]);
        });
    }

    #[test]
    fn should_start_counting_again_after_10_minutes() {
        test(async {
            let agent = anonymous().await;

            for _ in 1..=11 {
                agent
                    .post("/url")
                    .set("X-Forwarded-For", "203.0.113.7")
                    .send(json!({ "url": URL, "type": "classic" }))
                    .await;
            }
            sqlx::query("UPDATE rate_limits SET burst_reset_at = NOW() - INTERVAL '11 minutes'")
                .execute(&*POOL)
                .await
                .unwrap();

            let res = agent
                .post("/url")
                .set("X-Forwarded-For", "203.0.113.7")
                .send(json!({ "url": URL, "type": "classic" }))
                .await;

            assert_eq!(res.status_code, 200);

            let limits = sqlx::query_as::<_, (i32, bool)>(
                "SELECT burst_count, burst_reset_at > NOW() - INTERVAL '1 minute' AS reset_now FROM rate_limits",
            )
            .fetch_all(&*POOL)
            .await
            .unwrap();
            assert_eq!(limits, [(1, true)]);
        });
    }

    #[test]
    fn should_count_the_changes_to_a_link_as_well() {
        test(async {
            let agent = anonymous().await;
            let body = agent
                .post("/url")
                .set("X-Forwarded-For", "203.0.113.7")
                .send(json!({ "url": URL, "type": "classic" }))
                .await
                .body;

            sqlx::query("UPDATE rate_limits SET burst_count = 9")
                .execute(&*POOL)
                .await
                .unwrap();

            let edited = agent
                .patch(&format!("/url/{}/real-url", body["URLId"]))
                .set("X-Forwarded-For", "203.0.113.7")
                .send(json!({ "url": format!("{URL}/pulls") }))
                .await;
            assert_eq!(edited.status_code, 200);

            let edited_again = agent
                .patch(&format!("/url/{}/real-url", body["URLId"]))
                .set("X-Forwarded-For", "203.0.113.7")
                .send(json!({ "url": format!("{URL}/issues") }))
                .await;
            assert_eq!(edited_again.status_code, 429);
            assert_eq!(edited_again.text, too_many_requests());

            let changed = agent
                .patch(&format!("/url/{}/type", body["URLId"]))
                .set("X-Forwarded-For", "203.0.113.7")
                .send(json!({ "type": "digit" }))
                .await;
            assert_eq!(changed.status_code, 429);
            assert_eq!(changed.text, too_many_requests());

            // Only the first change went through
            let urls = sqlx::query_as::<_, (String, LinkType, Option<String>)>(
                "SELECT real_url, link_type, shortened_url_id FROM urls",
            )
            .fetch_all(&*POOL)
            .await
            .unwrap();
            assert_eq!(
                urls,
                [(
                    format!("{URL}/pulls"),
                    LinkType::Classic,
                    text(&body["code"])
                )]
            );
        });
    }

    #[test]
    fn should_not_limit_a_logged_in_user_by_ip_address() {
        test(async {
            let agent = request::agent(app());
            let user = create_user(&agent, None).await;

            for i in 1..=12 {
                let res = agent
                    .post("/url")
                    .set("X-Forwarded-For", "203.0.113.7")
                    .send(json!({ "url": URL, "type": "classic" }))
                    .await;
                assert_eq!(res.status_code, 200, "link {i}");
            }

            // They pay with their credits instead
            let link_credits =
                sqlx::query_scalar::<_, i32>("SELECT link_credits FROM users WHERE id = $1")
                    .bind(user.id)
                    .fetch_one(&*POOL)
                    .await
                    .unwrap();
            assert_eq!(link_credits, 88);

            assert!(rate_limits().await.is_empty());
        });
    }

    #[test]
    fn should_not_let_a_user_without_credits_create_or_change_a_link() {
        test(async {
            let agent = request::agent(app());
            let user = create_user(&agent, None).await;
            let body = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await
                .body;

            sqlx::query("UPDATE users SET link_credits = 0 WHERE id = $1")
                .bind(user.id)
                .execute(&*POOL)
                .await
                .unwrap();

            let created = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await;
            assert_eq!(created.status_code, 402);
            assert_eq!(created.header("content-type"), Some("application/json"));
            assert_eq!(created.text, out_of_credits());

            let edited = agent
                .patch(&format!("/url/{}/real-url", body["URLId"]))
                .send(json!({ "url": format!("{URL}/pulls") }))
                .await;
            assert_eq!(edited.status_code, 402);
            assert_eq!(edited.text, out_of_credits());

            let urls = sqlx::query_scalar::<_, String>("SELECT real_url FROM urls")
                .fetch_all(&*POOL)
                .await
                .unwrap();
            assert_eq!(urls, [URL]);
        });
    }

    #[test]
    fn should_let_a_user_use_their_very_last_credit() {
        test(async {
            let agent = request::agent(app());
            let user = create_user(&agent, None).await;
            sqlx::query("UPDATE users SET link_credits = 1 WHERE id = $1")
                .bind(user.id)
                .execute(&*POOL)
                .await
                .unwrap();

            let last = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await;
            assert_eq!(last.status_code, 200);

            let next = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await;
            assert_eq!(next.status_code, 402);
        });
    }

    #[test]
    fn should_not_count_a_request_that_is_not_valid() {
        test(async {
            let agent = anonymous().await;

            for _ in 1..=12 {
                let res = agent
                    .post("/url")
                    .set("X-Forwarded-For", "203.0.113.7")
                    .send(json!({ "url": "not a url", "type": "classic" }))
                    .await;
                assert_eq!(res.status_code, 400);
            }

            assert!(rate_limits().await.is_empty());
        });
    }
}
