use cpeak::json;

use server_turbo::database::index::POOL;

use crate::helpers::supertest::Agent;

pub const DEFAULT_PASSWORD: &str = "TestPass123";

pub async fn get_email_code(email: &str) -> String {
    let code = sqlx::query_scalar::<_, i32>("SELECT code FROM email_codes WHERE email = $1")
        .bind(email)
        .fetch_optional(&*POOL)
        .await
        .unwrap();
    let Some(code) = code else {
        panic!("No email_codes row for {email}");
    };
    code.to_string()
}

// Signs a new user up with their email and password, which logs the agent in as that user
pub async fn sign_up_and_log_in(agent: &Agent, email: &str) -> i32 {
    let (name, password) = ("Test User", DEFAULT_PASSWORD);
    agent
        .post("/auth/send-code")
        .send(json!({ "name": name, "email": email, "password": password }))
        .await;
    let code = get_email_code(email).await;
    agent
        .post("/auth/register")
        .send(json!({ "name": name, "email": email, "password": password, "code": code }))
        .await;

    let user_id = sqlx::query_scalar::<_, i32>("SELECT id FROM users WHERE email = $1")
        .bind(email)
        .fetch_optional(&*POOL)
        .await
        .unwrap();
    let Some(user_id) = user_id else {
        panic!("No user row for {email}");
    };
    user_id
}
