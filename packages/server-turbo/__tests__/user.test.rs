use chrono::{DateTime, Utc};
use cpeak::json;

use server_turbo::database::index::POOL;
use server_turbo::database::types::{IUser, IUsername};

use crate::helpers::factories::auth::{get_email_code, sign_up_and_log_in};
use crate::helpers::factories::user::{create_user, log_in};
use crate::helpers::supertest::request;
use crate::helpers::target::app;
use crate::setup_each_test::test;

mod user_endpoints {
    use super::*;

    #[test]
    fn should_not_let_anonymous_visitors_set_or_switch_a_username() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;

            // Checking if a username is available doesn't need an account
            let availability = agent.get("/user/username-availability/joe").await;
            assert_eq!(availability.status_code, 200);

            let responses = [
                agent
                    .patch("/user/username")
                    .send(json!({ "username": "joe" }))
                    .await,
                agent
                    .patch("/user/username/switch")
                    .send(json!({ "username": "joe" }))
                    .await,
            ];

            for res in responses {
                assert_eq!(res.status_code, 401);
                assert_eq!(res.text, json!({ "error": "Unauthorized" }).to_string());
            }
        });
    }

    #[test]
    fn should_tell_if_a_username_is_available() {
        test(async {
            let agent = request::agent(app());
            create_user(&agent, None).await;

            let res = agent.get("/user/username-availability/joe").await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.text, json!({ "available": true }).to_string());
        });
    }

    #[test]
    fn should_tell_if_a_username_is_taken_whatever_the_letter_case() {
        test(async {
            let owner = request::agent(app());
            create_user(&owner, "owner@example.com").await;
            owner
                .patch("/user/username")
                .send(json!({ "username": "Joe" }))
                .await;

            let agent = request::agent(app());
            create_user(&agent, None).await;

            for username in ["joe", "JOE", "Joe"] {
                let res = agent
                    .get(&format!("/user/username-availability/{username}"))
                    .await;

                assert_eq!(res.status_code, 200);
                assert_eq!(res.body, json!({ "available": false }));
            }
        });
    }

    #[test]
    fn should_set_the_first_username_of_a_user() {
        test(async {
            let agent = request::agent(app());
            let user = create_user(&agent, None).await;

            let res = agent
                .patch("/user/username")
                .send(json!({ "username": "Joe" }))
                .await;

            assert_eq!(res.status_code, 200);
            assert_eq!(
                res.text,
                json!({ "message": "Username updated successfully" }).to_string()
            );

            // Usernames are saved in lower case
            let usernames = sqlx::query_as::<_, (String, Option<bool>, Option<DateTime<Utc>>)>(
                "SELECT username, active, expires_at FROM usernames WHERE user_id = $1",
            )
            .bind(user.id)
            .fetch_all(&*POOL)
            .await
            .unwrap();
            assert_eq!(usernames, [("joe".to_string(), Some(true), None)]);
        });
    }

    #[test]
    fn should_not_update_the_username_if_it_is_not_valid() {
        test(async {
            let agent = request::agent(app());
            create_user(&agent, None).await;

            for body in [
                json!({}),
                json!({ "username": "" }),
                json!({ "username": 123 }),
            ] {
                let res = agent.patch("/user/username").send(body).await;

                assert_eq!(res.status_code, 400);
                assert_eq!(res.text, json!({ "error": "Invalid username" }).to_string());
            }
        });
    }

    #[test]
    fn should_not_update_the_username_if_it_is_already_taken() {
        test(async {
            let owner = request::agent(app());
            create_user(&owner, "owner@example.com").await;
            owner
                .patch("/user/username")
                .send(json!({ "username": "joe" }))
                .await;

            let agent = request::agent(app());
            create_user(&agent, None).await;

            let res = agent
                .patch("/user/username")
                .send(json!({ "username": "JOE" }))
                .await;

            assert_eq!(res.status_code, 409);
            assert_eq!(
                res.text,
                json!({ "error": "Username is already taken" }).to_string()
            );
        });
    }

    #[test]
    fn should_keep_the_old_username_for_a_month_after_changing_it() {
        test(async {
            let agent = request::agent(app());
            let user = create_user(&agent, None).await;

            agent
                .patch("/user/username")
                .send(json!({ "username": "first" }))
                .await;
            let res = agent
                .patch("/user/username")
                .send(json!({ "username": "second" }))
                .await;

            assert_eq!(res.status_code, 200);

            let usernames = sqlx::query_as::<_, (String, Option<bool>, Option<bool>)>(
                "SELECT
        username,
        active,
        expires_at > NOW() + INTERVAL '27 days' AND expires_at < NOW() + INTERVAL '32 days' AS expires_in_a_month
      FROM usernames WHERE user_id = $1 ORDER BY id",
            )
            .bind(user.id)
            .fetch_all(&*POOL)
            .await
            .unwrap();
            assert_eq!(
                usernames,
                [
                    ("first".to_string(), Some(false), Some(true)),
                    ("second".to_string(), Some(true), None),
                ]
            );
        });
    }

    #[test]
    fn should_only_keep_3_old_usernames() {
        test(async {
            let agent = request::agent(app());
            let user = create_user(&agent, None).await;

            for username in ["one", "two", "three", "four", "five"] {
                let res = agent
                    .patch("/user/username")
                    .send(json!({ "username": username }))
                    .await;
                assert_eq!(res.status_code, 200);
            }

            // "one" was the old username that expired the soonest, so it had to go
            let usernames = sqlx::query_as::<_, IUsername>(
                "SELECT username, active FROM usernames WHERE user_id = $1 ORDER BY id",
            )
            .bind(user.id)
            .fetch_all(&*POOL)
            .await
            .unwrap();
            assert_eq!(
                usernames
                    .iter()
                    .map(|u| (u.username.as_str(), u.active))
                    .collect::<Vec<_>>(),
                [
                    ("two", Some(false)),
                    ("three", Some(false)),
                    ("four", Some(false)),
                    ("five", Some(true)),
                ]
            );

            // The one that was dropped is free to take again
            let res = agent.get("/user/username-availability/one").await;
            assert_eq!(res.body, json!({ "available": true }));
        });
    }

    #[test]
    fn should_switch_back_to_an_old_username() {
        test(async {
            let agent = request::agent(app());
            let user = create_user(&agent, None).await;

            agent
                .patch("/user/username")
                .send(json!({ "username": "first" }))
                .await;
            agent
                .patch("/user/username")
                .send(json!({ "username": "second" }))
                .await;

            let res = agent
                .patch("/user/username/switch")
                .send(json!({ "username": "first" }))
                .await;

            assert_eq!(res.status_code, 200);
            assert_eq!(
                res.text,
                json!({ "message": "Username switched successfully" }).to_string()
            );

            let usernames = sqlx::query_as::<_, (String, Option<bool>, bool)>(
                "SELECT username, active, expires_at IS NULL AS never_expires FROM usernames WHERE user_id = $1 ORDER BY id",
            )
            .bind(user.id)
            .fetch_all(&*POOL)
            .await
            .unwrap();
            assert_eq!(
                usernames,
                [
                    ("first".to_string(), Some(true), true),
                    ("second".to_string(), Some(false), false),
                ]
            );
        });
    }

    #[test]
    fn should_not_switch_to_a_username_that_is_not_one_of_the_old_ones() {
        test(async {
            let other = request::agent(app());
            create_user(&other, "other@example.com").await;
            other
                .patch("/user/username")
                .send(json!({ "username": "taken" }))
                .await;
            other
                .patch("/user/username")
                .send(json!({ "username": "other" }))
                .await;

            let agent = request::agent(app());
            create_user(&agent, None).await;
            agent
                .patch("/user/username")
                .send(json!({ "username": "current" }))
                .await;

            // Someone else's old username, the active one, and one that doesn't exist
            for username in ["taken", "current", "nobody"] {
                let res = agent
                    .patch("/user/username/switch")
                    .send(json!({ "username": username }))
                    .await;

                assert_eq!(res.status_code, 404);
                assert_eq!(
                    res.text,
                    json!({
                        "error": "The specified username does not exist or is already active",
                    })
                    .to_string()
                );
            }
        });
    }

    #[test]
    fn should_not_switch_the_username_if_it_is_not_valid() {
        test(async {
            let agent = request::agent(app());
            create_user(&agent, None).await;

            for body in [
                json!({}),
                json!({ "username": "" }),
                json!({ "username": ["joe"] }),
            ] {
                let res = agent.patch("/user/username/switch").send(body).await;

                assert_eq!(res.status_code, 400);
                assert_eq!(res.text, json!({ "error": "Invalid username" }).to_string());
            }
        });
    }

    #[test]
    fn changes_a_users_email_after_confirming_the_code_sent_to_the_new_address() {
        test(async {
            let agent = request::agent(app());
            let email = "change-email-test@example.com";
            let new_email = "change-email-test-new@example.com";
            sign_up_and_log_in(&agent, email).await;

            let send_res = agent
                .post("/user/email/send-code")
                .send(json!({ "newEmail": new_email }))
                .await;
            assert_eq!(send_res.status_code, 200);

            let code = get_email_code(new_email).await;

            let confirm_res = agent
                .patch("/user/email/confirm")
                .send(json!({ "newEmail": new_email, "code": code }))
                .await;
            assert_eq!(confirm_res.status_code, 200);

            let status_res = agent.get("/auth/status").await;
            assert_eq!(status_res.body["email"], new_email);
        });
    }

    #[test]
    fn rejects_a_change_email_request_for_an_email_already_in_use() {
        test(async {
            let agent = request::agent(app());
            sign_up_and_log_in(&agent, "owner@example.com").await;
            sign_up_and_log_in(&request::agent(app()), "taken@example.com").await;

            let res = agent
                .post("/user/email/send-code")
                .send(json!({ "newEmail": "taken@example.com" }))
                .await;
            assert_eq!(res.status_code, 409);
        });
    }

    #[test]
    fn changes_a_password_for_an_already_logged_in_user() {
        test(async {
            let agent = request::agent(app());
            let email = "change-password-test@example.com";
            sign_up_and_log_in(&agent, email).await;

            let res = agent
                .patch("/user/password")
                .send(json!({ "newPassword": "NewPassword456" }))
                .await;
            assert_eq!(res.status_code, 200);

            let login_res = request(app())
                .post("/auth/login")
                .send(json!({ "email": email, "password": "NewPassword456" }))
                .await;
            assert_eq!(login_res.status_code, 200);
        });
    }

    #[test]
    fn allows_setting_a_first_password_on_a_google_only_account() {
        test(async {
            let email = "google-only@example.com";
            let user = sqlx::query_as::<_, IUser>(
                "INSERT INTO users(email, name, google_id) VALUES ($1, $2, $3) RETURNING id",
            )
            .bind(email)
            .bind("Google Only")
            .bind("fake-sub-9")
            .fetch_one(&*POOL)
            .await
            .unwrap();

            // What the Google OAuth callback does at the end. (The Node.js version goes through
            // the callback, with a fake fetch() for Google's API.)
            let agent = request::agent(app());
            log_in(&agent, user.id);

            let res = agent
                .patch("/user/password")
                .send(json!({ "newPassword": "FirstPassword789" }))
                .await;
            assert_eq!(res.status_code, 200);

            let login_res = request(app())
                .post("/auth/login")
                .send(json!({ "email": email, "password": "FirstPassword789" }))
                .await;
            assert_eq!(login_res.status_code, 200);
        });
    }
}
