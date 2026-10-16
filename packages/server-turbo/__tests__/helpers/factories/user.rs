use server_turbo::config::keys::KEYS;
use server_turbo::database::index::POOL;
use server_turbo::database::types::IUser;

use crate::helpers::supertest::Agent;

// Signs a cookie value the same way the cookie_parser of Cpeak does
pub fn sign_cookie(value: &str) -> String {
    // encodeURIComponent(), for the only character in here that needs it
    cpeak::sign_cookie(value, &KEYS.cookie_key).replace(':', "%3A")
}

// Logs the agent in as the user with this id. This is what the Google OAuth callback does at the end.
pub fn log_in(agent: &Agent, user_id: i32) {
    agent.set_cookie("uid", &sign_cookie(&user_id.to_string()));
}

// Adds a new user to the database and logs the agent in as that user
pub async fn create_user(agent: &Agent, email: impl Into<Option<&'static str>>) -> IUser {
    let email = email.into().unwrap_or("user@example.com");
    let user = sqlx::query_as::<_, IUser>(
        "INSERT INTO users(email, name, google_id) VALUES ($1, $2, $3) RETURNING *",
    )
    .bind(email)
    .bind("Test User")
    .bind(format!("google-{email}"))
    .fetch_one(&*POOL)
    .await
    .unwrap();

    log_in(agent, user.id);
    user
}
