use cpeak::{CpeakError, Value};
use url::form_urlencoded;

use super::util::FETCH;
use crate::config::keys::KEYS;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v3/userinfo";

pub fn build_auth_url() -> String {
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
    format!("{AUTH_URL}?{params}")
}

// Like in the Node.js version, nothing checks that Google really sent these
#[derive(Debug, Clone, Default)]
pub struct GoogleProfile {
    pub sub: Option<String>,
    pub name: Option<String>,
    pub email: Option<String>,
}

pub async fn exchange_code_for_profile(code: &str) -> Result<GoogleProfile, CpeakError> {
    let token_res = FETCH
        .post(TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(
            form_urlencoded::Serializer::new(String::new())
                .append_pair("code", code)
                .append_pair("client_id", &KEYS.google_client_id)
                .append_pair("client_secret", &KEYS.google_client_secret)
                .append_pair(
                    "redirect_uri",
                    &format!("{}/auth/google/callback", KEYS.domain),
                )
                .append_pair("grant_type", "authorization_code")
                .finish(),
        )
        .send()
        .await?;

    let tokens: Value = token_res.json().await?;
    if !tokens["error"].is_null() {
        let error = match &tokens["error"] {
            Value::String(error) => error.clone(),
            error => error.to_string(),
        };
        return Err(CpeakError::other(format!("Google token error: {error}")));
    }

    let user_res = FETCH
        .get(USERINFO_URL)
        .header(
            "Authorization",
            format!(
                "Bearer {}",
                tokens["access_token"].as_str().unwrap_or("undefined")
            ),
        )
        .send()
        .await?;

    let profile: Value = user_res.json().await?;
    Ok(GoogleProfile {
        sub: profile["sub"].as_str().map(String::from),
        name: profile["name"].as_str().map(String::from),
        email: profile["email"].as_str().map(String::from),
    })
}
