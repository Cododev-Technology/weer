use std::collections::HashSet;

use cpeak::json;

use server_turbo::config::keys::KEYS;
use server_turbo::database::index::POOL;
use server_turbo::database::types::LinkType;

use crate::helpers::assert::assert_iso_date;
use crate::helpers::factories::url::url_id;
use crate::helpers::supertest::{Agent, request};
use crate::helpers::target::app;
use crate::helpers::views::last_views;
use crate::setup_each_test::test;

// A destination on the domain allowlist, so the server never has to ask the Web Risk API about it
const URL: &str = "https://github.com/agile8118/weer";

async fn create_link() -> (Agent, i32) {
    let agent = request::agent(app());
    agent.get("/auth/status").await;
    let body = agent
        .post("/url")
        .send(json!({ "url": URL, "type": "classic" }))
        .await
        .body;
    (agent, url_id(&body))
}

mod getting_the_stats_of_a_url {
    use super::*;

    #[test]
    fn should_return_zeros_for_a_link_that_nobody_has_opened_yet() {
        test(async {
            let (agent, id) = create_link().await;

            let res = agent.get(&format!("/url/{id}/stats")).await;

            assert_eq!(res.status_code, 200);
            assert_eq!(
                res.text,
                json!({
                    "total": 0,
                    "unique_visitors": 0,
                    "qr_clicks": 0,
                    "last_clicked": null,
                })
                .to_string()
            );
        });
    }

    #[test]
    fn should_count_the_views_the_visitors_and_the_qr_code_scans() {
        test(async {
            let (agent, id) = create_link().await;
            let (_, other_id) = create_link().await;

            let visitor1 = "1".repeat(64);
            let visitor2 = "2".repeat(64);
            let visitor3 = "3".repeat(64);

            // url_id, visitor_hash, via_qr, link_type
            let views = [
                (id, &visitor1, false, Some(LinkType::Classic)),
                (id, &visitor1, true, None),
                (id, &visitor2, false, Some(LinkType::Classic)),
                (id, &visitor2, true, None),
                (id, &visitor2, false, Some(LinkType::Digit)),
                // The views of another link don't count
                (other_id, &visitor3, true, None),
            ];
            for (url_id, visitor_hash, via_qr, link_type) in views {
                sqlx::query(
                    "INSERT INTO views(url_id, visitor_hash, via_qr, link_type) VALUES ($1, $2, $3, $4)",
                )
                .bind(url_id)
                .bind(visitor_hash)
                .bind(via_qr)
                .bind(link_type)
                .execute(&*POOL)
                .await
                .unwrap();
            }

            sqlx::query(
                "UPDATE views SET created_at = '2030-03-04T05:06:07.891234Z'::timestamptz - (id * INTERVAL '24 hours') WHERE url_id = $1",
            )
            .bind(id)
            .execute(&*POOL)
            .await
            .unwrap();

            let res = agent.get(&format!("/url/{id}/stats")).await;

            assert_eq!(res.status_code, 200);
            assert_eq!(
                res.text,
                json!({
                    "total": 5,
                    "unique_visitors": 2,
                    "qr_clicks": 2,
                    "last_clicked": "2030-03-03T05:06:07.891Z",
                })
                .to_string()
            );
        });
    }

    #[test]
    fn should_count_the_views_that_came_in_through_the_links() {
        test(async {
            let (agent, id) = create_link().await;
            let (shortened_url_id, qr_code_id) = sqlx::query_as::<_, (String, String)>(
                "SELECT shortened_url_id, qr_code_id FROM urls WHERE id = $1",
            )
            .bind(id)
            .fetch_one(&*POOL)
            .await
            .unwrap();

            request(app())
                .get(&format!("/{shortened_url_id}"))
                .set("User-Agent", "Browser A")
                .await;
            request(app())
                .get(&format!("/{shortened_url_id}"))
                .set("User-Agent", "Browser A")
                .await;
            request(app())
                .get(&format!("/q/{qr_code_id}"))
                .set("User-Agent", "Browser B")
                .await;

            // With Redis, the views wait in a stream for the janitor to save them (see janitor.rs)
            if KEYS.redis_enabled {
                let entries = last_views(3).await;
                let views: Vec<String> =
                    entries.iter().map(|(_, fields)| fields.join(" ")).collect();

                assert_eq!(views.len(), 3);
                for view in &views {
                    assert!(view.starts_with(&format!("url_id {id} user_agent Browser ")));
                }
                assert_eq!(
                    views
                        .iter()
                        .map(|view| &view[view.find("via_qr ").unwrap() + 7..][..1])
                        .collect::<Vec<_>>(),
                    ["1", "0", "0"]
                );
                let visitors: HashSet<&str> =
                    views.iter().map(|view| &view[view.len() - 64..]).collect();
                assert_eq!(visitors.len(), 2);
                return;
            }

            let res = agent.get(&format!("/url/{id}/stats")).await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.body["total"], 3);
            assert_eq!(res.body["unique_visitors"], 2);
            assert_eq!(res.body["qr_clicks"], 1);
            assert_iso_date(res.body["last_clicked"].as_str().unwrap());
        });
    }

    #[test]
    fn should_not_return_the_stats_of_the_link_of_someone_else() {
        test(async {
            let (_, id) = create_link().await;

            let stranger = request::agent(app());
            stranger.get("/auth/status").await;
            let res = stranger.get(&format!("/url/{id}/stats")).await;

            assert_eq!(res.status_code, 403);
            assert_eq!(
                res.text,
                json!({ "error": "Not allowed to access." }).to_string()
            );
        });
    }
}
