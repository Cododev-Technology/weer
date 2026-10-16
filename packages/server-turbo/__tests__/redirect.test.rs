use std::fs;

use cpeak::crypto::{hex_encode, sha256};
use cpeak::{Value, json};

use server_turbo::config::keys::KEYS;
use server_turbo::database::index::POOL;
use server_turbo::database::types::{IView, LinkType};
use server_turbo::redis::redis::connection;

use crate::helpers::factories::url::url_id;
use crate::helpers::factories::user::create_user;
use crate::helpers::supertest::{Agent, request};
use crate::helpers::target::app;
use crate::helpers::views::{last_views, streams_length};
use crate::setup_each_test::test;

const PUBLIC_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../server-shared/public");

// A destination on the domain allowlist, and one that is not
const TRUSTED_URL: &str = "https://github.com/agile8118/weer";
const OTHER_URL: &str = "https://www.example.com/some/page?a=b";

// Creates a link of the given type for the agent
async fn create_link(agent: &Agent, r#type: &str, url: &str) -> Value {
    let body = agent
        .post("/url")
        .send(json!({ "url": TRUSTED_URL, "type": r#type }))
        .await
        .body;

    // Straight in the database, so the server doesn't have to ask the Web Risk API about the URL
    if url != TRUSTED_URL {
        sqlx::query("UPDATE urls SET real_url = $1 WHERE id = $2")
            .bind(url)
            .bind(url_id(&body))
            .execute(&*POOL)
            .await
            .unwrap();
    }
    body
}

async fn anonymous() -> Agent {
    let agent = request::agent(app());
    agent.get("/auth/status").await;
    agent
}

async fn qr_code_id(link: &Value) -> String {
    sqlx::query_scalar::<_, String>("SELECT qr_code_id FROM urls WHERE id = $1")
        .bind(url_id(link))
        .fetch_one(&*POOL)
        .await
        .unwrap()
}

// The view that the last redirect has saved, from Redis or from the database
async fn saved_view() -> Value {
    if KEYS.redis_enabled {
        let entries = last_views(1).await;
        let fields = &entries[0].1;
        let entry = |name: &str| {
            fields
                .chunks(2)
                .find(|field| field[0] == name)
                .map(|field| field[1].clone())
                .unwrap_or_default()
        };

        return json!({
            "url_id": entry("url_id").parse::<i32>().unwrap(),
            "user_agent": entry("user_agent"),
            "referrer": entry("referrer"),
            "link_type": Some(entry("link_type")).filter(|link_type| !link_type.is_empty()),
            "via_qr": entry("via_qr") == "1",
            "visitor_hash": entry("visitor_hash"),
        });
    }

    let view = sqlx::query_as::<_, IView>(
        "SELECT url_id, user_agent, referrer, link_type, via_qr, visitor_hash FROM views ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&*POOL)
    .await
    .unwrap();

    json!({
        "url_id": view.url_id,
        "user_agent": view.user_agent,
        "referrer": view.referrer,
        "link_type": view.link_type.map(LinkType::as_str),
        "via_qr": view.via_qr,
        "visitor_hash": view.visitor_hash,
    })
}

fn page(file: &str) -> String {
    fs::read_to_string(format!("{PUBLIC_PATH}{file}")).unwrap()
}

mod redirecting_to_the_real_url {
    use super::*;

    #[test]
    fn should_redirect_right_away_to_a_destination_that_we_trust() {
        test(async {
            let link = create_link(&anonymous().await, "classic", TRUSTED_URL).await;

            let res = request(app())
                .get(&format!("/{}", link["code"].as_str().unwrap()))
                .await;

            assert_eq!(res.status_code, 302);
            assert_eq!(res.header("location"), Some(TRUSTED_URL));
            assert_eq!(res.text, "");
        });
    }

    #[test]
    fn should_show_a_warning_first_for_any_other_destination() {
        test(async {
            let link = create_link(&anonymous().await, "classic", OTHER_URL).await;
            let code = link["code"].as_str().unwrap();

            let res = request(app()).get(&format!("/{code}")).await;

            assert_eq!(res.status_code, 302);
            assert_eq!(
                res.header("location"),
                Some(format!("/redirect-warning?type=classic&code={code}").as_str())
            );
        });
    }

    #[test]
    fn should_read_a_classic_code_in_any_letter_case_with_o_as_0_and_l_as_i() {
        test(async {
            let link = create_link(&anonymous().await, "classic", TRUSTED_URL).await;
            sqlx::query("UPDATE urls SET shortened_url_id = 'a0i1b2' WHERE id = $1")
                .bind(url_id(&link))
                .execute(&*POOL)
                .await
                .unwrap();

            for code in ["a0i1b2", "A0I1B2", "aoi1b2", "AOL1B2", "a0l1b2"] {
                let res = request(app()).get(&format!("/{code}")).await;

                assert_eq!(res.status_code, 302, "{code}");
                assert_eq!(res.header("location"), Some(TRUSTED_URL));
            }
        });
    }

    #[test]
    fn should_redirect_a_digit_link_with_o_as_0() {
        test(async {
            let link = create_link(&anonymous().await, "digit", TRUSTED_URL).await;
            sqlx::query("UPDATE digit_codes SET code = '1007' WHERE url_id = $1")
                .bind(url_id(&link))
                .execute(&*POOL)
                .await
                .unwrap();

            for code in ["1007", "1oO7"] {
                let res = request(app()).get(&format!("/{code}")).await;

                assert_eq!(res.status_code, 302, "{code}");
                assert_eq!(res.header("location"), Some(TRUSTED_URL));
            }
        });
    }

    #[test]
    fn should_redirect_an_ultra_link() {
        test(async {
            let agent = request::agent(app());
            create_user(&agent, None).await;
            let link = create_link(&agent, "ultra", OTHER_URL).await;
            sqlx::query("UPDATE ultra_codes SET url_id = NULL")
                .execute(&*POOL)
                .await
                .unwrap();
            sqlx::query("UPDATE ultra_codes SET url_id = $1 WHERE code = 'zi'")
                .bind(url_id(&link))
                .execute(&*POOL)
                .await
                .unwrap();

            for code in ["zi", "ZI", "zl", "Zl"] {
                let res = request(app()).get(&format!("/{code}")).await;

                assert_eq!(res.status_code, 302, "{code}");
                assert_eq!(
                    res.header("location"),
                    Some("/redirect-warning?type=ultra&code=zi")
                );
            }
        });
    }

    #[test]
    fn should_redirect_a_custom_link() {
        test(async {
            let agent = anonymous().await;
            let link = create_link(&agent, "classic", OTHER_URL).await;
            agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "custom", "code": "My-own-code_and-more" }))
                .await;

            let res = request(app()).get("/My-own-code_and-more").await;

            assert_eq!(res.status_code, 302);
            assert_eq!(
                res.header("location"),
                Some("/redirect-warning?type=custom&code=My-own-code_and-more")
            );
        });
    }

    #[test]
    fn should_redirect_an_affix_link_on_the_username_of_its_owner() {
        test(async {
            let agent = request::agent(app());
            create_user(&agent, None).await;
            agent
                .patch("/user/username")
                .send(json!({ "username": "joe" }))
                .await;
            let link = create_link(&agent, "classic", OTHER_URL).await;
            agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "affix", "code": "portfolio" }))
                .await;

            let res = request(app()).get("/joe/portfolio").await;

            assert_eq!(res.status_code, 302);
            assert_eq!(
                res.header("location"),
                Some("/redirect-warning?type=affix&code=portfolio&username=joe")
            );

            // Not on the username of someone else, and not without a username
            let other = request::agent(app());
            create_user(&other, "other@example.com").await;
            other
                .patch("/user/username")
                .send(json!({ "username": "other" }))
                .await;

            for path in ["/other/portfolio", "/nobody/portfolio"] {
                let not_found = request(app()).get(path).await;

                assert_eq!(not_found.status_code, 404, "{path}");
                assert_eq!(not_found.text, page("/404.html"));
            }
        });
    }

    #[test]
    fn should_redirect_a_qr_code_link() {
        test(async {
            let link = create_link(&anonymous().await, "classic", OTHER_URL).await;
            let qr_code_id = qr_code_id(&link).await;

            let res = request(app()).get(&format!("/q/{qr_code_id}")).await;

            assert_eq!(res.status_code, 302);
            assert_eq!(
                res.header("location"),
                Some(format!("/redirect-warning?type=qr&code={qr_code_id}").as_str())
            );
        });
    }

    #[test]
    fn should_show_the_404_page_for_a_code_that_does_not_exist() {
        test(async {
            create_link(&anonymous().await, "classic", TRUSTED_URL).await;

            for path in ["/nope12", "/zz", "/12345", "/not-a-code", "/q/nope", "/a$"] {
                let res = request(app()).get(path).await;

                assert_eq!(res.status_code, 404, "{path}");
                assert!(res.header("content-type").unwrap().starts_with("text/html"));
                assert_eq!(res.text, page("/404.html"));
            }
        });
    }

    #[test]
    fn should_save_a_view_of_the_link() {
        test(async {
            let link = create_link(&anonymous().await, "classic", TRUSTED_URL).await;

            let res = request(app())
                .get(&format!("/{}", link["code"].as_str().unwrap()))
                .set("X-Forwarded-For", "203.0.113.7, 10.0.0.1")
                .set("User-Agent", "Mozilla/5.0 (Test Browser)")
                .set("Accept-Language", "en-CA,en;q=0.9")
                .set("Referer", "https://www.google.com/search")
                .await;

            assert_eq!(res.status_code, 302);

            // The visitor is only known by a hash of their IP address, browser and languages
            let visitor_hash = hex_encode(sha256(
                "203.0.113.7::Mozilla/5.0 (Test Browser)::en-CA,en;q=0.9",
            ));

            assert_eq!(
                saved_view().await,
                json!({
                    "url_id": link["URLId"],
                    "user_agent": "Mozilla/5.0 (Test Browser)",
                    "referrer": "https://www.google.com/search",
                    "link_type": "classic",
                    "via_qr": false,
                    "visitor_hash": visitor_hash,
                })
            );
        });
    }

    #[test]
    fn should_save_a_view_that_came_from_the_qr_code() {
        test(async {
            let link = create_link(&anonymous().await, "digit", TRUSTED_URL).await;
            let qr_code_id = qr_code_id(&link).await;

            let res = request(app())
                .get(&format!("/q/{qr_code_id}"))
                .set("X-Forwarded-For", "203.0.113.7")
                .set("User-Agent", "")
                .set("Accept-Language", "fr")
                .await;

            assert_eq!(res.status_code, 302);

            let visitor_hash = hex_encode(sha256("203.0.113.7::::fr"));

            assert_eq!(
                saved_view().await,
                json!({
                    "url_id": link["URLId"],
                    "user_agent": "",
                    "referrer": "",
                    "link_type": null,
                    "via_qr": true,
                    "visitor_hash": visitor_hash,
                })
            );
        });
    }

    #[test]
    fn should_not_save_a_view_if_the_link_was_not_found() {
        test(async {
            let before = if KEYS.redis_enabled {
                streams_length().await
            } else {
                0
            };

            request(app()).get("/nope12").await;

            if KEYS.redis_enabled {
                assert_eq!(streams_length().await, before);
            } else {
                let views = sqlx::query("SELECT id FROM views")
                    .fetch_all(&*POOL)
                    .await
                    .unwrap();
                assert_eq!(views.len(), 0);
            }
        });
    }
}

mod the_redirect_warning_page {
    use super::*;

    #[test]
    fn should_show_the_warning_page() {
        test(async {
            let res = request(app())
                .get("/redirect-warning?type=classic&code=abc123")
                .await;

            assert_eq!(res.status_code, 200);
            assert!(res.header("content-type").unwrap().starts_with("text/html"));
            assert_eq!(res.text, page("/redirect-warning.html"));
        });
    }

    #[test]
    fn should_give_the_page_the_destination_of_a_link() {
        test(async {
            let link = create_link(&anonymous().await, "classic", OTHER_URL).await;

            let res = request(app())
                .get(&format!(
                    "/redirect-warning/data?type=classic&code={}",
                    link["code"].as_str().unwrap()
                ))
                .await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.text, json!({ "realUrl": OTHER_URL }).to_string());
        });
    }

    #[test]
    fn should_give_the_page_the_destination_of_an_affix_link_and_a_qr_code_link() {
        test(async {
            let agent = request::agent(app());
            create_user(&agent, None).await;
            agent
                .patch("/user/username")
                .send(json!({ "username": "joe" }))
                .await;
            let link = create_link(&agent, "classic", OTHER_URL).await;
            agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "affix", "code": "my-portfolio" }))
                .await;
            let qr_code_id = qr_code_id(&link).await;

            let affix = request(app())
                .get("/redirect-warning/data?type=affix&code=my-portfolio&username=joe")
                .await;
            assert_eq!(affix.text, json!({ "realUrl": OTHER_URL }).to_string());

            let qr = request(app())
                .get(&format!("/redirect-warning/data?type=qr&code={qr_code_id}"))
                .await;
            assert_eq!(qr.text, json!({ "realUrl": OTHER_URL }).to_string());

            // An affix link is nothing without its username
            let without_username = request(app())
                .get("/redirect-warning/data?type=affix&code=my-portfolio")
                .await;
            assert_eq!(
                without_username.text,
                json!({ "realUrl": null }).to_string()
            );
        });
    }

    #[test]
    fn should_give_the_page_nothing_for_a_link_that_does_not_exist() {
        test(async {
            let link = create_link(&anonymous().await, "classic", OTHER_URL).await;
            let code = link["code"].as_str().unwrap();

            let queries = [
                String::new(),
                "?type=classic".to_string(),
                format!("?code={code}"),
                "?type=classic&code=nope12".to_string(),
                format!("?type=digit&code={code}"),
                format!("?type=nope&code={code}"),
                format!("?type=&code={code}"),
            ];

            for query in queries {
                let res = request(app())
                    .get(&format!("/redirect-warning/data{query}"))
                    .await;

                assert_eq!(res.status_code, 200, "{query}");
                assert_eq!(res.text, json!({ "realUrl": null }).to_string(), "{query}");
            }
        });
    }
}

// A classic link that was visited is saved in Redis (see redis/links-cache.rs). These pass
// without Redis too: then they just check the database.
mod a_link_that_was_visited_before {
    use super::*;

    // Visits the link, and waits until Redis has it (the redirect doesn't wait for that)
    async fn visit(code: &str) {
        request(app()).get(&format!("/{code}")).await;

        if KEYS.redis_enabled && KEYS.link_cache {
            for _ in 0..100 {
                let saved: Option<String> = redis::cmd("GET")
                    .arg(format!("weer:link:{code}"))
                    .query_async(&mut connection())
                    .await
                    .unwrap();
                if saved.is_some() {
                    return;
                }
                cpeak::sleep(std::time::Duration::from_millis(10)).await;
            }
            panic!("the link was never saved in Redis");
        }
    }

    #[test]
    fn should_go_to_its_new_destination_once_it_changes() {
        test(async {
            let agent = anonymous().await;
            let link = create_link(&agent, "classic", TRUSTED_URL).await;
            let code = link["code"].as_str().unwrap();
            visit(code).await;

            let new_url = format!("{TRUSTED_URL}/pulls");
            let edited = agent
                .patch(&format!("/url/{}/real-url", link["URLId"]))
                .send(json!({ "url": new_url }))
                .await;
            assert_eq!(edited.status_code, 200);

            let res = request(app()).get(&format!("/{code}")).await;
            assert_eq!(res.header("location"), Some(new_url.as_str()));
        });
    }

    #[test]
    fn should_be_gone_once_it_is_deleted() {
        test(async {
            let agent = anonymous().await;
            let link = create_link(&agent, "classic", TRUSTED_URL).await;
            let code = link["code"].as_str().unwrap();
            visit(code).await;

            let deleted = agent.delete(&format!("/url/{}", link["URLId"])).await;
            assert_eq!(deleted.status_code, 200);

            let res = request(app()).get(&format!("/{code}")).await;
            assert_eq!(res.text, page("/404.html"));
        });
    }

    #[test]
    fn should_not_be_found_on_its_old_code_once_it_gets_a_new_one() {
        test(async {
            let agent = anonymous().await;
            let link = create_link(&agent, "classic", TRUSTED_URL).await;
            let old_code = link["code"].as_str().unwrap();
            visit(old_code).await;

            let changed = agent
                .patch(&format!("/url/{}/type", link["URLId"]))
                .send(json!({ "type": "classic" }))
                .await;
            let new_code = changed.body["code"].as_str().unwrap();
            assert_ne!(new_code, old_code);

            let old = request(app()).get(&format!("/{old_code}")).await;
            assert_eq!(old.text, page("/404.html"));

            let new = request(app()).get(&format!("/{new_code}")).await;
            assert_eq!(new.header("location"), Some(TRUSTED_URL));
        });
    }
}
