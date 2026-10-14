use cpeak::json;

use server_turbo::database::index::POOL;
use server_turbo::database::types::{IUrl, LinkType};

use crate::helpers::factories::auth::sign_up_and_log_in;
use crate::helpers::factories::url::{create_classic_link, text, url_id};
use crate::helpers::supertest::request;
use crate::helpers::target::app;
use crate::setup_each_test::test;

mod url_endpoints {
    use super::*;

    #[test]
    fn should_create_a_new_classic_shortened_url() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;

            let res = agent
                .post("/url")
                .send(json!({
                    "url": "http://www.example.com",
                    "type": "classic",
                }))
                .await;

            assert_eq!(res.status_code, 200);
            assert!(res.body.get("code").is_some());
            assert_eq!(res.body["realURL"], "http://www.example.com");
        });
    }

    #[test]
    fn should_create_a_new_digit_shortened_url() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;

            let res = agent
                .post("/url")
                .send(json!({
                    "url": "http://www.example.com",
                    "type": "digit",
                }))
                .await;

            assert_eq!(res.status_code, 200);
            assert!(res.body.get("code").is_some());
            assert_eq!(res.body["realURL"], "http://www.example.com");
        });
    }

    #[test]
    fn should_not_create_a_new_classic_shortened_url_if_the_url_is_not_valid() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;

            let res = agent
                .post("/url")
                .send(json!({
                    "url": "random text",
                    "type": "classic",
                }))
                .await;

            assert_eq!(res.status_code, 400);
        });
    }

    #[test]
    fn does_not_change_a_urls_type_when_the_user_has_no_link_credits_left() {
        test(async {
            let agent = request::agent(app());
            let email = "no-credits-test@example.com";

            let user_id = sign_up_and_log_in(&agent, email).await;
            let created = create_classic_link(&agent, None).await;

            // Simulate credit balance of zero
            sqlx::query("UPDATE users SET link_credits = 0 WHERE id = $1")
                .bind(user_id)
                .execute(&*POOL)
                .await
                .unwrap();

            let res = agent
                .patch(&format!("/url/{}/type", created["URLId"]))
                .send(json!({ "type": "custom", "code": "brandNewCustomCode" }))
                .await;

            assert_eq!(res.status_code, 402);

            let url_row = sqlx::query_as::<_, IUrl>("SELECT * FROM urls WHERE id = $1")
                .bind(url_id(&created))
                .fetch_optional(&*POOL)
                .await
                .unwrap();
            assert_eq!(
                url_row.as_ref().map(|row| row.link_type),
                Some(LinkType::Classic)
            );
            assert_eq!(
                url_row.and_then(|row| row.shortened_url_id),
                text(&created["code"])
            );
        });
    }
}
