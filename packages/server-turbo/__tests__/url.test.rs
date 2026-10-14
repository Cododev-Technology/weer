use cpeak::json;

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
}
