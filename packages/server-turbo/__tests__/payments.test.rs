use cpeak::json;

use server_turbo::config::keys::KEYS;
use server_turbo::database::index::POOL;
use server_turbo::database::types::IPayment;

use crate::helpers::factories::user::create_user;
use crate::helpers::paddle;
use crate::helpers::supertest::{Agent, Response, request};
use crate::helpers::target::app;
use crate::setup_each_test::test;

async fn credits(user_id: i32) -> i32 {
    sqlx::query_scalar::<_, i32>("SELECT link_credits FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&*POOL)
        .await
        .unwrap()
}

async fn payments(user_id: i32) -> Vec<IPayment> {
    sqlx::query_as::<_, IPayment>(
        "SELECT paddle_id, transaction_id, credits, amount, currency FROM payments WHERE user_id = $1 ORDER BY id",
    )
    .bind(user_id)
    .fetch_all(&*POOL)
    .await
    .unwrap()
}

async fn webhook(agent: &Agent, event_type: &str, id: &str) -> Response {
    agent
        .post("/payments/webhook")
        .send(json!({ "event_type": event_type, "data": { "id": id } }))
        .await
}

mod payment_endpoints {
    use super::*;

    #[test]
    fn should_tell_that_credits_can_be_bought() {
        test(async {
            paddle::reset();
            let res = request::agent(app()).get("/payments/status").await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.text, json!({ "enabled": true }).to_string());
        });
    }

    #[test]
    fn should_not_let_anonymous_visitors_buy_credits() {
        test(async {
            paddle::reset();
            let agent = request::agent(app());

            let responses = [
                agent
                    .post("/payments/checkout")
                    .send(json!({ "credits": 200 }))
                    .await,
                agent
                    .post("/payments/confirm")
                    .send(json!({ "transactionId": format!("txn_{}", "a".repeat(26)) }))
                    .await,
            ];

            for res in responses {
                assert_eq!(res.status_code, 401);
                assert_eq!(res.text, json!({ "error": "Unauthorized" }).to_string());
            }
            assert_eq!(paddle::transaction_count(), 0);
        });
    }

    #[test]
    fn should_create_the_paddle_transaction_of_a_pack_for_the_user() {
        test(async {
            paddle::reset();
            let agent = request::agent(app());
            let user = create_user(&agent, None).await;

            let res = agent
                .post("/payments/checkout")
                .send(json!({ "credits": 5000 }))
                .await;

            assert_eq!(res.status_code, 201);
            let mut keys: Vec<_> = res.body.as_object().unwrap().keys().cloned().collect();
            keys.sort();
            assert_eq!(
                keys,
                ["clientToken", "email", "environment", "transactionId"]
            );
            assert_eq!(res.body["clientToken"], json!(KEYS.paddle_client_token));
            assert_eq!(res.body["environment"], KEYS.paddle_environment);
            assert_eq!(res.body["email"], "user@example.com");

            let transaction =
                paddle::get_transaction(res.body["transactionId"].as_str().unwrap()).unwrap();
            assert_eq!(transaction["custom_data"], json!({ "user_id": user.id }));
            assert_eq!(
                transaction["items"],
                json!([{ "price": { "id": paddle::price_id(1) }, "quantity": 1 }])
            );
        });
    }

    #[test]
    fn should_not_create_a_transaction_for_a_pack_that_doesnt_exist() {
        test(async {
            paddle::reset();
            let agent = request::agent(app());
            create_user(&agent, None).await;

            for body in [
                json!({ "credits": 123 }),
                json!({ "credits": "lots" }),
                json!({}),
            ] {
                let res = agent.post("/payments/checkout").send(body).await;

                assert_eq!(res.status_code, 400);
                assert_eq!(
                    res.text,
                    json!({ "error": "Invalid credit pack." }).to_string()
                );
            }
            assert_eq!(paddle::transaction_count(), 0);
        });
    }

    #[test]
    fn should_add_the_credits_of_a_paid_checkout_only_once() {
        test(async {
            paddle::reset();
            let agent = request::agent(app());
            let user = create_user(&agent, None).await;

            let checkout = agent
                .post("/payments/checkout")
                .send(json!({ "credits": 200 }))
                .await;
            let transaction_id = checkout.body["transactionId"].as_str().unwrap().to_string();
            paddle::pay(&transaction_id);

            for _ in 0..2 {
                let res = agent
                    .post("/payments/confirm")
                    .send(json!({ "transactionId": transaction_id }))
                    .await;

                assert_eq!(res.status_code, 200);
                assert_eq!(res.text, json!({ "linkCredits": 225 }).to_string());
            }

            assert_eq!(credits(user.id).await, 225);
            let payments = payments(user.id).await;
            assert_eq!(payments.len(), 1);
            assert_eq!(payments[0].paddle_id, transaction_id);
            assert_eq!(payments[0].transaction_id, transaction_id);
            assert_eq!(payments[0].credits, 200);
            assert_eq!(payments[0].amount, 499);
            assert_eq!(payments[0].currency, "USD");
        });
    }

    #[test]
    fn should_not_add_credits_before_the_payment_goes_through() {
        test(async {
            paddle::reset();
            let agent = request::agent(app());
            let user = create_user(&agent, None).await;

            let checkout = agent
                .post("/payments/checkout")
                .send(json!({ "credits": 200 }))
                .await;
            let res = agent
                .post("/payments/confirm")
                .send(json!({ "transactionId": checkout.body["transactionId"] }))
                .await;

            assert_eq!(res.status_code, 409);
            assert_eq!(
                res.text,
                json!({ "error": "This payment hasn't gone through yet." }).to_string()
            );
            assert_eq!(credits(user.id).await, 25);
        });
    }

    #[test]
    fn should_not_let_a_user_confirm_a_transaction_that_isnt_theirs() {
        test(async {
            paddle::reset();
            let owner = request::agent(app());
            let owner_user = create_user(&owner, "owner@example.com").await;
            let transaction_id =
                paddle::add_transaction(owner_user.id, paddle::price_id(0), "completed");

            let agent = request::agent(app());
            let user = create_user(&agent, None).await;

            for id in [transaction_id, format!("txn_{}", "b".repeat(26))] {
                let res = agent
                    .post("/payments/confirm")
                    .send(json!({ "transactionId": id }))
                    .await;

                assert_eq!(res.status_code, 404);
                assert_eq!(
                    res.text,
                    json!({ "error": "Transaction not found." }).to_string()
                );
            }

            for id in [json!("abc"), json!("txn_../../customers"), json!(12)] {
                let res = agent
                    .post("/payments/confirm")
                    .send(json!({ "transactionId": id }))
                    .await;

                assert_eq!(res.status_code, 400);
                assert_eq!(
                    res.text,
                    json!({ "error": "Invalid transaction." }).to_string()
                );
            }

            assert_eq!(credits(user.id).await, 25);
            assert_eq!(credits(owner_user.id).await, 25);
        });
    }

    #[test]
    fn should_give_all_the_credits_of_a_pack_to_a_user_who_went_below_0() {
        test(async {
            paddle::reset();
            let agent = request::agent(app());
            let user = create_user(&agent, None).await;
            sqlx::query("UPDATE users SET link_credits = -5 WHERE id = $1")
                .bind(user.id)
                .execute(&*POOL)
                .await
                .unwrap();

            let transaction_id = paddle::add_transaction(user.id, paddle::price_id(0), "completed");
            let res = agent
                .post("/payments/confirm")
                .send(json!({ "transactionId": transaction_id }))
                .await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.text, json!({ "linkCredits": 200 }).to_string());
        });
    }

    #[test]
    fn should_add_the_credits_from_paddles_webhook_only_once() {
        test(async {
            paddle::reset();
            let agent = request::agent(app());
            let user = create_user(&agent, None).await;
            let transaction_id = paddle::add_transaction(user.id, paddle::price_id(2), "completed");

            for event_type in ["transaction.paid", "transaction.completed"] {
                let res = webhook(&request::agent(app()), event_type, &transaction_id).await;

                assert_eq!(res.status_code, 200);
                assert_eq!(res.text, json!({ "received": true }).to_string());
            }

            // And the browser confirming it after the webhook
            let res = agent
                .post("/payments/confirm")
                .send(json!({ "transactionId": transaction_id }))
                .await;
            assert_eq!(res.text, json!({ "linkCredits": 25025 }).to_string());

            assert_eq!(credits(user.id).await, 25025);
            assert_eq!(payments(user.id).await.len(), 1);
        });
    }

    #[test]
    fn should_only_add_credits_for_what_paddles_api_says_was_paid() {
        test(async {
            paddle::reset();
            let agent = request::agent(app());
            let user = create_user(&agent, None).await;
            let draft = paddle::add_transaction(user.id, paddle::price_id(0), "draft");
            let other_product = paddle::add_transaction(user.id, "pri_somethingelse", "completed");

            for id in [
                draft,
                other_product,
                format!("txn_{}", "c".repeat(26)),
                "not-an-id".to_string(),
            ] {
                let res = webhook(&request::agent(app()), "transaction.completed", &id).await;

                assert_eq!(res.status_code, 200);
                assert_eq!(res.text, json!({ "received": true }).to_string());
            }

            assert_eq!(credits(user.id).await, 25);
            assert_eq!(payments(user.id).await.len(), 0);
        });
    }

    #[test]
    fn should_take_back_the_refunded_share_of_the_credits_only_once() {
        test(async {
            paddle::reset();
            let agent = request::agent(app());
            let user = create_user(&agent, None).await;
            let transaction_id = paddle::add_transaction(user.id, paddle::price_id(0), "completed");
            webhook(&agent, "transaction.completed", &transaction_id).await;

            // $2.00 of $4.99 is 80 of the 200 credits
            let pending =
                paddle::add_adjustment(&transaction_id, "200", "refund", "pending_approval");
            webhook(&agent, "adjustment.created", &pending).await;
            assert_eq!(credits(user.id).await, 225);

            paddle::set_adjustment_status(&pending, "approved");
            for _ in 0..2 {
                let res = webhook(&agent, "adjustment.updated", &pending).await;

                assert_eq!(res.status_code, 200);
                assert_eq!(res.text, json!({ "received": true }).to_string());
            }
            assert_eq!(credits(user.id).await, 145);

            // And a chargeback of the rest
            let chargeback =
                paddle::add_adjustment(&transaction_id, "299", "chargeback", "approved");
            webhook(&agent, "adjustment.created", &chargeback).await;

            assert_eq!(credits(user.id).await, 25);
            let rows: Vec<_> = payments(user.id)
                .await
                .into_iter()
                .map(|payment| (payment.paddle_id, payment.credits, payment.amount))
                .collect();
            assert_eq!(
                rows,
                [
                    (transaction_id, 200, 499),
                    (pending, -80, 200),
                    (chargeback, -120, 299),
                ]
            );
        });
    }

    #[test]
    fn should_acknowledge_the_events_it_doesnt_use() {
        test(async {
            paddle::reset();
            let agent = request::agent(app());
            let user = create_user(&agent, None).await;
            let transaction_id = paddle::add_transaction(user.id, paddle::price_id(0), "completed");
            let credit = paddle::add_adjustment(&transaction_id, "499", "credit", "approved");

            for (event_type, id) in [
                ("customer.created", format!("ctm_{}", "d".repeat(26))),
                ("transaction.created", transaction_id),
                ("adjustment.created", credit),
            ] {
                let res = webhook(&agent, event_type, &id).await;

                assert_eq!(res.status_code, 200);
                assert_eq!(res.text, json!({ "received": true }).to_string());
            }

            let res = agent.post("/payments/webhook").send(json!({})).await;
            assert_eq!(res.status_code, 200);

            assert_eq!(credits(user.id).await, 25);
        });
    }
}
