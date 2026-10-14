use std::sync::LazyLock;

fn get_env(key: &str) -> String {
    let value = std::env::var(key).ok();
    if value.is_none() {
        eprintln!("Missing environment variable: {key}");
    }
    value.unwrap_or_default()
}

pub struct Keys {
    pub domain: String,
    pub google_client_id: String,
    pub google_client_secret: String,
    pub cookie_key: String,
    pub web_risk_api_key: String,
    // Postgres
    pub db_user: String,
    pub db_host: String,
    pub db_database: String,
    pub db_password: String,
    pub db_port: u16,
    // Redis
    pub redis_url: String,
    pub redis_enabled: bool,
}

pub static KEYS: LazyLock<Keys> = LazyLock::new(|| Keys {
    domain: get_env("DOMAIN"),
    google_client_id: get_env("GOOGLE_CLIENT_ID"),
    google_client_secret: get_env("GOOGLE_CLIENT_SECRET"),
    cookie_key: get_env("COOKIE_KEY"),
    web_risk_api_key: get_env("WEB_RISK_API_KEY"),
    // Postgres
    db_user: get_env("DB_USER"),
    db_host: get_env("DB_HOST"),
    db_database: get_env("DB_DATABASE"),
    db_password: get_env("DB_PASSWORD"),
    db_port: get_env("DB_PORT").parse().unwrap_or_default(),
    // Redis
    redis_url: get_env("REDIS_URL"),
    redis_enabled: get_env("REDIS") == "true",
});
