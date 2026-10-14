use chrono::Utc;
use cpeak::json;

use server_turbo::config::keys::KEYS;
use server_turbo::database::index::POOL;
use server_turbo::database::types::IUrl;

use crate::helpers::assert::{assert_iso_date, time};
use crate::helpers::factories::url::{text, url_id};
use crate::helpers::factories::user::create_user;
use crate::helpers::supertest::request;
use crate::helpers::target::app;
use crate::setup_each_test::test;

// A destination on the domain allowlist, so the server never has to ask the Web Risk API about it
const URL: &str = "https://github.com/agile8118/weer";

mod listing_the_urls {
    use super::*;

    #[test]
    fn should_return_nothing_for_a_visitor_without_a_session() {
        test(async {
            let res = request(app()).get("/url").await;

            assert_eq!(res.status_code, 200);
            assert_eq!(
                res.text,
                json!({ "urls": [], "domain": KEYS.domain }).to_string()
            );
        });
    }

    #[test]
    fn should_return_nothing_for_a_session_that_does_not_exist_anymore() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;
            sqlx::query("DELETE FROM sessions")
                .execute(&*POOL)
                .await
                .unwrap();

            let res = agent.get("/url").await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.body, json!({ "urls": [], "domain": KEYS.domain }));
        });
    }

    #[test]
    fn should_return_the_links_of_the_session_newest_first() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;

            let classic = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await;
            let digit = agent
                .post("/url")
                .send(json!({ "url": format!("{URL}/issues"), "type": "digit" }))
                .await;

            let res = agent.get("/url").await;

            assert_eq!(res.status_code, 200);

            // Digit codes come with the dates they were assigned and expire at
            let first = &res.body["urls"][0];
            assert_iso_date(first["assigned_at"].as_str().unwrap());
            assert!(
                (time(first["assigned_at"].as_str().unwrap()) - Utc::now().timestamp_millis())
                    .abs()
                    < 60_000
            );

            // The values that are null in the database are left out
            assert_eq!(
                res.text,
                json!({
                    "urls": [
                        {
                            "id": digit.body["URLId"],
                            "real_url": format!("{URL}/issues"),
                            "link_type": "digit",
                            "code": digit.body["code"],
                            "assigned_at": first["assigned_at"],
                            "expires_at": digit.body["expiresAt"],
                        },
                        {
                            "id": classic.body["URLId"],
                            "real_url": URL,
                            "link_type": "classic",
                            "code": classic.body["code"],
                        },
                    ],
                    "domain": KEYS.domain,
                })
                .to_string()
            );
        });
    }

    #[test]
    fn should_return_the_links_of_the_logged_in_user() {
        test(async {
            let agent = request::agent(app());
            create_user(&agent, None).await;

            let ultra = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "ultra" }))
                .await;

            let res = agent.get("/url").await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.body["urls"].as_array().unwrap().len(), 1);
            assert_eq!(
                res.body["urls"][0]
                    .as_object()
                    .unwrap()
                    .keys()
                    .collect::<Vec<_>>(),
                [
                    "id",
                    "real_url",
                    "link_type",
                    "code",
                    "assigned_at",
                    "expires_at",
                ]
            );
            assert_eq!(res.body["urls"][0]["code"], "0");
            assert_eq!(res.body["urls"][0]["link_type"], "ultra");
            assert_eq!(res.body["urls"][0]["expires_at"], ultra.body["expiresAt"]);
        });
    }

    #[test]
    fn should_not_return_the_links_of_someone_else() {
        test(async {
            let owner = request::agent(app());
            owner.get("/auth/status").await;
            owner
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await;

            let user = request::agent(app());
            create_user(&user, None).await;
            user.post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await;

            let stranger = request::agent(app());
            stranger.get("/auth/status").await;
            let res = stranger.get("/url").await;

            assert_eq!(res.body, json!({ "urls": [], "domain": KEYS.domain }));
        });
    }
}

mod deleting_a_url {
    use super::*;

    #[test]
    fn should_delete_a_link_of_the_session() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;
            let body = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "digit" }))
                .await
                .body;

            let res = agent.delete(&format!("/url/{}", body["URLId"])).await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.text, json!({ "message": "deleted" }).to_string());

            // Its digit code goes with it
            let urls = sqlx::query_as::<_, IUrl>("SELECT id FROM urls")
                .fetch_all(&*POOL)
                .await
                .unwrap();
            let codes = sqlx::query("SELECT id FROM digit_codes")
                .fetch_all(&*POOL)
                .await
                .unwrap();
            assert_eq!(urls.len(), 0);
            assert_eq!(codes.len(), 0);
        });
    }

    #[test]
    fn should_free_the_ultra_code_of_a_deleted_link() {
        test(async {
            let agent = request::agent(app());
            create_user(&agent, None).await;
            let body = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "ultra" }))
                .await
                .body;

            let res = agent.delete(&format!("/url/{}", body["URLId"])).await;

            assert_eq!(res.status_code, 200);

            let taken = sqlx::query("SELECT code FROM ultra_codes WHERE url_id IS NOT NULL")
                .fetch_all(&*POOL)
                .await
                .unwrap();
            assert_eq!(taken.len(), 0);

            // The next ultra link gets the same code again
            let next = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "ultra" }))
                .await;
            assert_eq!(next.body["code"], body["code"]);
        });
    }

    #[test]
    fn should_not_delete_a_link_of_someone_else() {
        test(async {
            let owner = request::agent(app());
            owner.get("/auth/status").await;
            let body = owner
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await
                .body;

            let stranger = request::agent(app());
            stranger.get("/auth/status").await;
            let user = request::agent(app());
            create_user(&user, None).await;

            for agent in [stranger, user, request::agent(app())] {
                let res = agent.delete(&format!("/url/{}", body["URLId"])).await;

                assert_eq!(res.status_code, 403);
                assert_eq!(
                    res.text,
                    json!({ "error": "Not allowed to access." }).to_string()
                );
            }

            let urls = sqlx::query_as::<_, IUrl>("SELECT id FROM urls")
                .fetch_all(&*POOL)
                .await
                .unwrap();
            assert_eq!(urls.len(), 1);
        });
    }

    #[test]
    fn should_not_let_an_anonymous_visitor_delete_the_link_of_a_user() {
        test(async {
            let user = request::agent(app());
            create_user(&user, None).await;
            let body = user
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await
                .body;

            // With and without a session
            let stranger = request::agent(app());
            stranger.get("/auth/status").await;

            for agent in [stranger, request::agent(app())] {
                let res = agent.delete(&format!("/url/{}", body["URLId"])).await;
                assert_eq!(res.status_code, 403);
            }
        });
    }

    #[test]
    fn should_not_delete_a_link_that_does_not_exist() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;

            let res = agent.delete("/url/12345").await;

            assert_eq!(res.status_code, 403);
            assert_eq!(
                res.text,
                json!({ "error": "Not allowed to access." }).to_string()
            );
        });
    }

    #[test]
    fn should_not_accept_an_id_that_is_not_a_number() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;

            for id in ["abc", "0", "12abc", "NaN"] {
                let res = agent.delete(&format!("/url/{id}")).await;

                assert_eq!(res.status_code, 400, "{id}");
                assert_eq!(res.text, json!({ "error": "Invalid URL ID." }).to_string());
            }
        });
    }

    #[test]
    fn should_not_accept_a_number_that_cannot_be_an_id() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;

            // An id is only digits, and not more than the database can hold
            for id in [
                "12.5",
                "1e3",
                "-5",
                "+5",
                "0x10",
                "2147483648",
                "99999999999",
            ] {
                let res = agent.delete(&format!("/url/{id}")).await;

                assert_eq!(res.status_code, 400, "{id}");
                assert_eq!(res.text, json!({ "error": "Invalid URL ID." }).to_string());
            }

            // The biggest id there can be is fine, there just is no such link
            let res = agent.delete("/url/2147483647").await;
            assert_eq!(res.status_code, 403);
        });
    }
}

mod updating_the_destination_of_a_url {
    use super::*;

    #[test]
    fn should_update_the_destination_of_a_link() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;
            let body = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await
                .body;

            let res = agent
                .patch(&format!("/url/{}/real-url", body["URLId"]))
                .send(json!({ "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }))
                .await;

            assert_eq!(res.status_code, 200);
            assert_eq!(
                res.text,
                json!({ "realUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }).to_string()
            );

            let url = sqlx::query_as::<_, (String, Option<String>)>(
                "SELECT real_url, shortened_url_id FROM urls WHERE id = $1",
            )
            .bind(url_id(&body))
            .fetch_optional(&*POOL)
            .await
            .unwrap();
            assert_eq!(
                url,
                Some((
                    "https://www.youtube.com/watch?v=dQw4w9WgXcQ".to_string(),
                    text(&body["code"])
                ))
            );
        });
    }

    #[test]
    fn should_take_one_credit_from_a_logged_in_user() {
        test(async {
            let agent = request::agent(app());
            let user = create_user(&agent, None).await;
            let body = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await
                .body;

            agent
                .patch(&format!("/url/{}/real-url", body["URLId"]))
                .send(json!({ "url": format!("{URL}/pulls") }))
                .await;

            let link_credits =
                sqlx::query_scalar::<_, i32>("SELECT link_credits FROM users WHERE id = $1")
                    .bind(user.id)
                    .fetch_one(&*POOL)
                    .await
                    .unwrap();
            assert_eq!(link_credits, 98);
        });
    }

    #[test]
    fn should_not_update_the_destination_to_a_url_that_is_not_valid() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;
            let body = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await
                .body;

            let missing = agent
                .patch(&format!("/url/{}/real-url", body["URLId"]))
                .send(json!({}))
                .await;
            assert_eq!(missing.status_code, 400);
            assert_eq!(
                missing.text,
                json!({ "error": "Please first put your URL here." }).to_string()
            );

            let invalid = agent
                .patch(&format!("/url/{}/real-url", body["URLId"]))
                .send(json!({ "url": "not a url" }))
                .await;
            assert_eq!(invalid.status_code, 400);
            assert_eq!(
                invalid.text,
                json!({ "error": "The URL you put is not valid." }).to_string()
            );

            let url = sqlx::query_as::<_, IUrl>("SELECT real_url FROM urls")
                .fetch_optional(&*POOL)
                .await
                .unwrap();
            assert_eq!(url.unwrap().real_url, URL);
        });
    }

    #[test]
    fn should_not_update_the_destination_of_the_link_of_someone_else() {
        test(async {
            let owner = request::agent(app());
            owner.get("/auth/status").await;
            let body = owner
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await
                .body;

            let stranger = request::agent(app());
            stranger.get("/auth/status").await;

            let res = stranger
                .patch(&format!("/url/{}/real-url", body["URLId"]))
                .send(json!({ "url": format!("{URL}/pulls") }))
                .await;

            assert_eq!(res.status_code, 403);
            assert_eq!(
                res.text,
                json!({ "error": "Not allowed to access." }).to_string()
            );

            let url = sqlx::query_as::<_, IUrl>("SELECT real_url FROM urls")
                .fetch_optional(&*POOL)
                .await
                .unwrap();
            assert_eq!(url.unwrap().real_url, URL);
        });
    }
}
