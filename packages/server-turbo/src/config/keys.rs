use std::sync::LazyLock;

fn get_env(key: &str) -> String {
    let value = std::env::var(key).ok();
    if value.is_none() {
        eprintln!("Missing environment variable: {key}");
    }
    value.unwrap_or_default()
}

// For the settings that have a default, so leaving them out is fine
fn get_optional_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

pub struct Keys {
    pub domain: String,
    pub google_client_id: String,
    pub google_client_secret: String,
    pub cookie_key: String,
    pub token_secret: String,
    pub web_risk_api_key: String,
    pub ses_region: String,
    pub ses_from_email: String,
    // Postgres
    pub db_user: String,
    pub db_host: String,
    pub db_database: String,
    pub db_password: String,
    pub db_port: u16,
    pub db_pool_size: u32,
    // Redis
    pub redis_url: String,
    pub redis_enabled: bool,
    // Show the warning page before redirecting to a domain that isn't on the allowlist
    pub redirect_warning: bool,
    // Limit how many links, emails and logins a visitor or a user can make (see lib/rate-limit.rs)
    pub rate_limit: bool,
}

pub static KEYS: LazyLock<Keys> = LazyLock::new(|| Keys {
    domain: get_env("DOMAIN"),
    google_client_id: get_env("GOOGLE_CLIENT_ID"),
    google_client_secret: get_env("GOOGLE_CLIENT_SECRET"),
    cookie_key: get_env("COOKIE_KEY"),
    token_secret: get_env("TOKEN_SECRET"),
    web_risk_api_key: get_env("WEB_RISK_API_KEY"),
    ses_region: get_env("AWS_REGION"),
    ses_from_email: get_env("SES_FROM_EMAIL"),
    // Postgres
    db_user: get_env("DB_USER"),
    db_host: get_env("DB_HOST"),
    db_database: get_env("DB_DATABASE"),
    db_password: get_env("DB_PASSWORD"),
    db_port: get_env("DB_PORT").parse().unwrap_or_default(),
    db_pool_size: get_optional_env("DB_POOL_SIZE")
        .and_then(|size| size.parse().ok())
        .unwrap_or(10),
    // Redis
    redis_url: get_env("REDIS_URL"),
    redis_enabled: get_env("REDIS") == "true",
    redirect_warning: get_optional_env("REDIRECT_WARNING").as_deref() != Some("false"),
    rate_limit: get_optional_env("RATE_LIMIT").as_deref() != Some("false"),
});
