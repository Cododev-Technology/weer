use chrono::{DateTime, Utc};
use cpeak::{Value, json};

use server_turbo::database::index::POOL;
use server_turbo::database::types::{IUser, LinkType};

use crate::helpers::assert::{assert_iso_date, assert_made_of};
use crate::helpers::factories::url::{text, url_id};
use crate::helpers::factories::user::create_user;
use crate::helpers::supertest::{Agent, request};
use crate::helpers::target::app;
use crate::setup_each_test::test;

// A destination on the domain allowlist, so the server never has to ask the Web Risk API about it
const URL: &str = "https://github.com/agile8118/weer";

// Starts an anonymous session and creates a classic link with it
async fn create_anonymous_link() -> (Agent, Value) {
    let agent = request::agent(app());
    agent.get("/auth/status").await;
    let body = agent
        .post("/url")
        .send(json!({ "url": URL, "type": "classic" }))
        .await
        .body;
    (agent, body)
}

// Creates a user and a classic link that belongs to them
async fn create_user_link(email: impl Into<Option<&'static str>>) -> (Agent, IUser, Value) {
    let agent = request::agent(app());
    let user = create_user(&agent, email).await;
    let body = agent
        .post("/url")
        .send(json!({ "url": URL, "type": "classic" }))
        .await
        .body;
    (agent, user, body)
}

// The type and the code of a link, as they are in the database
async fn saved_link(link: &Value) -> Option<(LinkType, Option<String>)> {
    sqlx::query_as("SELECT link_type, shortened_url_id FROM urls WHERE id = $1")
        .bind(url_id(link))
        .fetch_optional(&*POOL)
        .await
        .unwrap()
}

mod changing_the_type_of_a_url {
    use super::*;

    #[test]
    fn should_change_a_classic_link_to_a_digit_link() {
        test(async {
            let (agent, link) = create_anonymous_link().await;

            let res = agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "digit" }))
                .await;

            assert_eq!(res.status_code, 200);
            assert_made_of(res.body["code"].as_str().unwrap(), 3, |c| {
                c.is_ascii_digit()
            });
            assert_iso_date(res.body["expiresAt"].as_str().unwrap());
            assert_eq!(
                res.text,
                json!({
                    "newType": "digit",
                    "expiresAt": res.body["expiresAt"],
                    "code": res.body["code"],
                })
                .to_string()
            );

            // The classic code is gone
            assert_eq!(saved_link(&link).await, Some((LinkType::Digit, None)));
        });
    }

    #[test]
    fn should_change_a_digit_link_back_to_a_classic_link() {
        test(async {
            let (agent, link) = create_anonymous_link().await;
            agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "digit" }))
                .await;

            let res = agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "classic" }))
                .await;

            assert_eq!(res.status_code, 200);
            // (a classic code has no l and no o in it)
            assert_made_of(
                res.body["code"].as_str().unwrap(),
                6,
                |c| matches!(c, 'a'..='k' | 'm' | 'n' | 'p'..='z' | '0'..='9'),
            );
            assert_eq!(
                res.text,
                json!({ "newType": "classic", "expiresAt": null, "code": res.body["code"] })
                    .to_string()
            );

            // The digit code is gone
            assert_eq!(
                saved_link(&link).await,
                Some((LinkType::Classic, text(&res.body["code"])))
            );
            let codes = sqlx::query("SELECT id FROM digit_codes")
                .fetch_all(&*POOL)
                .await
                .unwrap();
            assert_eq!(codes.len(), 0);
        });
    }

    #[test]
    fn should_give_a_classic_link_a_new_classic_code() {
        test(async {
            let (agent, link) = create_anonymous_link().await;

            let res = agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "classic" }))
                .await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.body["newType"], "classic");
            assert_ne!(res.body["code"], link["code"]);
        });
    }

    #[test]
    fn should_change_a_link_to_a_custom_link() {
        test(async {
            let (agent, link) = create_anonymous_link().await;

            let res = agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "custom", "code": "my-own-code" }))
                .await;

            assert_eq!(res.status_code, 200);
            assert_eq!(
                res.text,
                json!({ "newType": "custom", "expiresAt": null, "code": "my-own-code" })
                    .to_string()
            );

            assert_eq!(
                saved_link(&link).await,
                Some((LinkType::Custom, Some("my-own-code".to_string())))
            );
        });
    }

    #[test]
    fn should_not_change_a_link_to_a_custom_code_that_is_taken() {
        test(async {
            let (other_agent, other_link) = create_anonymous_link().await;
            other_agent
                .patch(&format!("/url/{}/type", other_link["URLId"]))
                .send(json!({ "type": "custom", "code": "my-own-code" }))
                .await;

            let (agent, link) = create_anonymous_link().await;
            let res = agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "custom", "code": "my-own-code" }))
                .await;

            assert_eq!(res.status_code, 400);
            assert_eq!(
                res.text,
                json!({ "error": "Code is not available" }).to_string()
            );
        });
    }

    #[test]
    fn should_change_a_link_of_a_user_to_an_ultra_link() {
        test(async {
            let (agent, _user, link) = create_user_link(None).await;

            let res = agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "ultra" }))
                .await;

            assert_eq!(res.status_code, 200);
            assert_iso_date(res.body["expiresAt"].as_str().unwrap());
            assert_eq!(
                res.text,
                json!({ "newType": "ultra", "expiresAt": res.body["expiresAt"], "code": "0" })
                    .to_string()
            );

            assert_eq!(saved_link(&link).await, Some((LinkType::Ultra, None)));
        });
    }

    #[test]
    fn should_free_the_ultra_code_when_the_link_changes_to_another_type() {
        test(async {
            let (agent, _user, link) = create_user_link(None).await;
            agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "ultra" }))
                .await;

            let res = agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "digit" }))
                .await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.body["newType"], "digit");

            let codes =
                sqlx::query_as::<_, (Option<i32>, Option<DateTime<Utc>>, Option<DateTime<Utc>>)>(
                    "SELECT url_id, assigned_at, expires_at FROM ultra_codes WHERE code = '0'",
                )
                .fetch_all(&*POOL)
                .await
                .unwrap();
            assert_eq!(codes, [(None, None, None)]);
        });
    }

    #[test]
    fn should_change_a_link_of_a_user_to_an_affix_link() {
        test(async {
            let (agent, user, link) = create_user_link(None).await;

            let res = agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "affix", "code": "portfolio" }))
                .await;

            assert_eq!(res.status_code, 200);
            assert_eq!(
                res.text,
                json!({ "newType": "affix", "expiresAt": null, "code": "portfolio" }).to_string()
            );

            let url = sqlx::query_as::<_, (LinkType, Option<String>, Option<i32>)>(
                "SELECT link_type, shortened_url_id, user_id FROM urls WHERE id = $1",
            )
            .bind(url_id(&link))
            .fetch_optional(&*POOL)
            .await
            .unwrap();
            assert_eq!(
                url,
                Some((
                    LinkType::Affix,
                    Some("portfolio".to_string()),
                    Some(user.id)
                ))
            );
        });
    }

    #[test]
    fn should_let_two_users_have_the_same_affix_code_but_not_one_user_twice() {
        test(async {
            let (first_agent, _, first_link) = create_user_link("first@example.com").await;
            first_agent
                .patch(&format!("/url/{}/type", first_link["URLId"]))
                .send(json!({ "type": "affix", "code": "portfolio" }))
                .await;

            let (second_agent, _, second_link) = create_user_link("second@example.com").await;
            let res = second_agent
                .patch(&format!("/url/{}/type", second_link["URLId"]))
                .send(json!({ "type": "affix", "code": "portfolio" }))
                .await;
            assert_eq!(res.status_code, 200);

            let another = first_agent
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await;
            let taken = first_agent
                .patch(&format!("/url/{}/type", another.body["URLId"]))
                .send(json!({ "type": "affix", "code": "portfolio" }))
                .await;

            assert_eq!(taken.status_code, 400);
            assert_eq!(
                taken.text,
                json!({ "error": "Code is not available" }).to_string()
            );
        });
    }

    #[test]
    fn should_not_give_an_anonymous_visitor_an_ultra_or_an_affix_link() {
        test(async {
            for body in [
                json!({ "type": "ultra" }),
                json!({ "type": "affix", "code": "portfolio" }),
            ] {
                let (agent, link) = create_anonymous_link().await;

                let res = agent
                    .patch(&format!("/url/{}/type", link["URLId"]))
                    .send(body)
                    .await;

                assert_eq!(res.status_code, 401);
                assert_eq!(res.text, json!({ "error": "Unauthorized" }).to_string());
            }
        });
    }

    #[test]
    fn should_not_change_a_link_to_a_type_that_does_not_exist() {
        test(async {
            let (agent, link) = create_anonymous_link().await;

            let res = agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "qr" }))
                .await;

            assert_eq!(res.status_code, 400);
            assert_eq!(res.text, json!({ "error": "Invalid type" }).to_string());
        });
    }

    #[test]
    fn should_ask_for_the_new_type_if_there_is_none() {
        test(async {
            let (agent, link) = create_anonymous_link().await;

            for body in [json!({}), json!({ "type": "" }), json!({ "type": null })] {
                let res = agent
                    .patch(&format!("/url/{}/type", link["URLId"]))
                    .send(body)
                    .await;

                assert_eq!(res.status_code, 400);
                assert_eq!(
                    res.text,
                    json!({ "message": "Missing parameters" }).to_string()
                );
            }

            // Nothing has happened to the link
            assert_eq!(
                saved_link(&link).await,
                Some((LinkType::Classic, text(&link["code"])))
            );
        });
    }

    #[test]
    fn should_not_change_the_type_of_the_link_of_someone_else() {
        test(async {
            let (_owner_agent, owner_link) = create_anonymous_link().await;
            let (user_agent, _user, user_link) = create_user_link(None).await;

            let stranger = request::agent(app());
            stranger.get("/auth/status").await;

            for agent in [stranger.clone(), user_agent, request::agent(app())] {
                let res = agent
                    .patch(&format!("/url/{}/type", owner_link["URLId"]))
                    .send(json!({ "type": "digit" }))
                    .await;

                assert_eq!(res.status_code, 403);
                assert_eq!(
                    res.text,
                    json!({ "error": "Not allowed to access." }).to_string()
                );
            }

            // The same goes for the link of a user
            let res = stranger
                .patch(&format!("/url/{}/type", user_link["URLId"]))
                .send(json!({ "type": "digit" }))
                .await;
            assert_eq!(res.status_code, 403);

            let urls = sqlx::query_as::<_, (LinkType, Option<String>)>(
                "SELECT link_type, shortened_url_id FROM urls ORDER BY id",
            )
            .fetch_all(&*POOL)
            .await
            .unwrap();
            assert_eq!(
                urls,
                [
                    (LinkType::Classic, text(&owner_link["code"])),
                    (LinkType::Classic, text(&user_link["code"])),
                ]
            );
        });
    }

    #[test]
    fn should_take_one_credit_from_a_logged_in_user() {
        test(async {
            let (agent, user, link) = create_user_link(None).await;

            agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "digit" }))
                .await;

            // One for creating the link, and one for changing its type
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
    fn should_leave_the_link_alone_if_the_user_is_out_of_credits() {
        test(async {
            let (agent, user, link) = create_user_link(None).await;
            sqlx::query("UPDATE users SET link_credits = 0 WHERE id = $1")
                .bind(user.id)
                .execute(&*POOL)
                .await
                .unwrap();

            let res = agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "digit" }))
                .await;

            assert_eq!(res.status_code, 402);
            assert_eq!(
                res.text,
                json!({
                    "error":
                        "You've used all your credits. Please contact support to increase your limit for free.",
                })
                .to_string()
            );

            assert_eq!(
                saved_link(&link).await,
                Some((LinkType::Classic, text(&link["code"])))
            );
            let codes = sqlx::query("SELECT id FROM digit_codes")
                .fetch_all(&*POOL)
                .await
                .unwrap();
            assert_eq!(codes.len(), 0);
        });
    }
}

mod checking_if_a_code_is_available {
    use super::*;

    #[test]
    fn should_tell_if_a_custom_code_is_available() {
        test(async {
            let res = request(app())
                .get("/url/custom-availability/my-own-code")
                .await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.text, json!({ "available": true }).to_string());
        });
    }

    #[test]
    fn should_tell_if_a_custom_code_is_taken() {
        test(async {
            let (agent, link) = create_anonymous_link().await;
            agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "custom", "code": "my-own-code" }))
                .await;

            let res = request(app())
                .get("/url/custom-availability/my-own-code")
                .await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.text, json!({ "available": false }).to_string());
        });
    }

    #[test]
    fn should_tell_if_an_affix_code_is_available_for_the_user() {
        test(async {
            let (first_agent, _, first_link) = create_user_link("first@example.com").await;
            first_agent
                .patch(&format!("/url/{}/type", first_link["URLId"]))
                .send(json!({ "type": "affix", "code": "portfolio" }))
                .await;

            let second = request::agent(app());
            create_user(&second, "second@example.com").await;

            let taken = first_agent.get("/url/affix-availability/portfolio").await;
            assert_eq!(taken.status_code, 200);
            assert_eq!(taken.text, json!({ "available": false }).to_string());

            // Affix codes are per user, so the same code is free for everyone else
            let free = second.get("/url/affix-availability/portfolio").await;
            assert_eq!(free.text, json!({ "available": true }).to_string());

            let anonymous = request(app())
                .get("/url/affix-availability/portfolio")
                .await;
            assert_eq!(anonymous.status_code, 200);
            assert_eq!(anonymous.text, json!({ "available": true }).to_string());
        });
    }

    #[test]
    fn should_decode_the_code_in_the_url() {
        test(async {
            let (agent, link) = create_anonymous_link().await;
            agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "custom", "code": "my code/é" }))
                .await;

            let res = request(app())
                .get("/url/custom-availability/my%20code%2F%C3%A9")
                .await;

            assert_eq!(res.text, json!({ "available": false }).to_string());
        });
    }
}
