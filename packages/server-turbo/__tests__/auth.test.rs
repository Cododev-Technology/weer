use cpeak::{Value, json};
use url::form_urlencoded;

use server_turbo::config::keys::KEYS;
use server_turbo::database::index::POOL;
use server_turbo::database::types::{ISession, IUser};

use crate::helpers::assert::{assert_made_of, time};
use crate::helpers::factories::user::{create_user, log_in, sign_cookie};
use crate::helpers::supertest::request;
use crate::helpers::target::app;
use crate::setup_each_test::test;

// What the server sends to remove the uid cookie
const CLEARED_UID_COOKIE: &str = "uid=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";

mod auth_endpoints {
    use super::*;

    #[test]
    fn should_start_an_anonymous_session_for_a_new_visitor() {
        test(async {
            let res = request(app()).get("/auth/status").await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.header("content-type"), Some("application/json"));
            assert_eq!(res.text, json!({ "isSignedIn": false }).to_string());

            // The session token is 16 random bytes in hex, in a signed cookie that lasts for 30 days
            let cookies = &res.set_cookie;
            assert_eq!(cookies.len(), 1);
            let (token, signature) = cookies[0]
                .strip_prefix("session_token=s%3A")
                .and_then(|cookie| cookie.strip_suffix("; Path=/; Max-Age=2592000; HttpOnly"))
                .and_then(|value| value.split_once('.'))
                .unwrap_or_else(|| panic!("{:?} is not the session cookie", cookies[0]));
            assert_made_of(token, 32, |c| matches!(c, '0'..='9' | 'a'..='f'));
            assert_made_of(signature, 43, |c| {
                c.is_ascii_alphanumeric() || c == '_' || c == '-'
            });

            let sessions = sqlx::query_as::<_, ISession>("SELECT session_token FROM sessions")
                .fetch_all(&*POOL)
                .await
                .unwrap();
            assert_eq!(sessions.len(), 1);
            assert!(cookies[0].contains(&sessions[0].session_token));
        });
    }

    #[test]
    fn should_keep_the_same_session_on_the_next_visits() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;

            sqlx::query("UPDATE sessions SET last_active = NOW() - INTERVAL '1 hour'")
                .execute(&*POOL)
                .await
                .unwrap();

            let res = agent.get("/auth/status").await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.body, json!({ "isSignedIn": false }));
            assert!(res.set_cookie.is_empty());

            // Still the one session, and it was marked as active again
            let sessions = sqlx::query_scalar::<_, bool>(
                "SELECT last_active > NOW() - INTERVAL '1 minute' AS active FROM sessions",
            )
            .fetch_all(&*POOL)
            .await
            .unwrap();
            assert_eq!(sessions, [true]);
        });
    }

    #[test]
    fn should_start_a_new_session_if_the_session_cookie_was_tampered_with() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;

            let session = sqlx::query_as::<_, ISession>("SELECT session_token FROM sessions")
                .fetch_one(&*POOL)
                .await
                .unwrap();

            let res = request(app())
                .get("/auth/status")
                .set(
                    "Cookie",
                    &format!(
                        "session_token=s%3A{}.not-the-right-signature",
                        session.session_token
                    ),
                )
                .await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.body, json!({ "isSignedIn": false }));
            assert_eq!(res.set_cookie.len(), 1);
            assert!(!res.set_cookie[0].contains(&session.session_token));
        });
    }

    #[test]
    fn should_start_a_new_session_if_the_session_has_expired() {
        test(async {
            let agent = request::agent(app());
            agent.get("/auth/status").await;

            sqlx::query("UPDATE sessions SET expires_at = NOW() - INTERVAL '1 day'")
                .execute(&*POOL)
                .await
                .unwrap();

            let res = agent.get("/auth/status").await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.body, json!({ "isSignedIn": false }));
            assert_eq!(res.set_cookie.len(), 1);

            let sessions = sqlx::query_as::<_, ISession>("SELECT id FROM sessions")
                .fetch_all(&*POOL)
                .await
                .unwrap();
            assert_eq!(sessions.len(), 2);
        });
    }

    #[test]
    fn should_return_the_info_of_a_logged_in_user() {
        test(async {
            let agent = request::agent(app());
            let user = create_user(&agent, "joe@example.com").await;

            let res = agent.get("/auth/status").await;

            assert_eq!(res.status_code, 200);
            assert_eq!(
                res.text,
                json!({
                    "isSignedIn": true,
                    "email": "joe@example.com",
                    "linkCredits": 100,
                    "usernames": [],
                })
                .to_string()
            );

            // A logged in user doesn't get an anonymous session
            assert!(res.set_cookie.is_empty());
            assert_eq!(user.link_credits, Some(100));
        });
    }

    #[test]
    fn should_return_the_usernames_of_a_logged_in_user() {
        test(async {
            let agent = request::agent(app());
            let user = create_user(&agent, None).await;

            sqlx::query(
                "INSERT INTO usernames (user_id, username, active, expires_at) VALUES
        ($1, 'current', true, NULL),
        ($1, 'older', false, '2040-01-15T10:20:30.123456Z'),
        ($1, 'oldest', false, '2040-01-10T10:20:30Z')",
            )
            .bind(user.id)
            .execute(&*POOL)
            .await
            .unwrap();

            let res = agent.get("/auth/status").await;

            assert_eq!(res.status_code, 200);

            // The ones that expire the soonest come first, and the active one (that never expires) comes last
            let usernames = res.body["usernames"].as_array().unwrap();
            assert_eq!(
                usernames
                    .iter()
                    .map(|u| json!([u["value"], u["active"]]))
                    .collect::<Vec<Value>>(),
                [
                    json!(["oldest", false]),
                    json!(["older", false]),
                    json!(["current", true]),
                ]
            );
            assert_eq!(
                usernames[0].as_object().unwrap().keys().collect::<Vec<_>>(),
                ["value", "expires_at", "active"]
            );

            // The dates come straight from PostgreSQL (as JSON), in the time zone of the database
            // session: like 2040-01-15T05:20:30.123456-05:00
            let expires_at = usernames[1]["expires_at"].as_str().unwrap();
            let format = "%Y-%m-%dT%H:%M:%S.123456%:z";
            assert_eq!(
                chrono::DateTime::parse_from_str(expires_at, format)
                    .unwrap_or_else(|error| panic!("{expires_at:?} is not such a date: {error}"))
                    .format(format)
                    .to_string(),
                expires_at
            );
            assert_eq!(
                time(usernames[1]["expires_at"].as_str().unwrap()),
                time("2040-01-15T10:20:30.123456Z")
            );
            assert_eq!(
                time(usernames[0]["expires_at"].as_str().unwrap()),
                time("2040-01-10T10:20:30.000Z")
            );
            assert_eq!(usernames[2]["expires_at"], Value::Null);
        });
    }

    #[test]
    fn should_log_out_a_user_whose_account_does_not_exist_anymore() {
        test(async {
            let agent = request::agent(app());
            log_in(&agent, 12345);

            let res = agent.get("/auth/status").await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.body, json!({ "isSignedIn": false }));
            assert_eq!(res.set_cookie, [CLEARED_UID_COOKIE]);
        });
    }

    #[test]
    fn should_not_log_a_user_in_with_a_uid_cookie_that_is_not_signed_by_us() {
        test(async {
            let user =
                sqlx::query_as::<_, IUser>("INSERT INTO users(email) VALUES ($1) RETURNING *")
                    .bind("joe@example.com")
                    .fetch_one(&*POOL)
                    .await
                    .unwrap();

            // The signature of another value, and no signature at all
            let forged = sign_cookie("999").replace("999", &user.id.to_string());
            let unsigned = user.id.to_string();

            for uid in [forged, unsigned] {
                let res = request(app())
                    .get("/auth/status")
                    .set("Cookie", &format!("uid={uid}"))
                    .await;

                assert_eq!(res.status_code, 200);
                assert_eq!(res.body, json!({ "isSignedIn": false }));
            }
        });
    }

    #[test]
    fn should_log_the_user_out() {
        test(async {
            let agent = request::agent(app());
            create_user(&agent, None).await;

            let res = agent.get("/logout").await;

            assert_eq!(res.status_code, 302);
            assert_eq!(res.header("location"), Some("/"));
            assert_eq!(res.set_cookie, [CLEARED_UID_COOKIE]);

            // The agent has dropped the cookie, so it is an anonymous visitor again
            let status = agent.get("/auth/status").await;
            assert_eq!(status.body, json!({ "isSignedIn": false }));
        });
    }

    #[test]
    fn should_send_the_user_to_google_to_log_in() {
        test(async {
            let res = request(app()).get("/auth/google").await;

            let params = form_urlencoded::Serializer::new(String::new())
                .append_pair("client_id", &KEYS.google_client_id)
                .append_pair(
                    "redirect_uri",
                    &format!("{}/auth/google/callback", KEYS.domain),
                )
                .append_pair("response_type", "code")
                .append_pair("scope", "profile email")
                .append_pair("access_type", "online")
                .finish();

            assert_eq!(res.status_code, 302);
            assert_eq!(
                res.header("location"),
                Some(format!("https://accounts.google.com/o/oauth2/v2/auth?{params}").as_str())
            );
            assert!(
                res.header("location")
                    .unwrap()
                    .contains("&scope=profile+email&")
            );
        });
    }

    #[test]
    fn should_go_back_to_the_home_page_if_google_did_not_send_a_code() {
        test(async {
            let res = request(app()).get("/auth/google/callback").await;

            assert_eq!(res.status_code, 302);
            assert_eq!(res.header("location"), Some("/"));
            assert!(res.set_cookie.is_empty());
        });
    }
}
