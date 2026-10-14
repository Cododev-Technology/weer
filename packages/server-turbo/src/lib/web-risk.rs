use std::time::Duration;

use cpeak::{CpeakError, Value};
use url::form_urlencoded;

use super::log::log;
use super::util::FETCH;
use crate::config::keys::KEYS;

const WEB_RISK_URL: &str = "https://webrisk.googleapis.com/v1/uris:search";
const THREAT_TYPES: [&str; 4] = [
    "MALWARE",
    "SOCIAL_ENGINEERING",
    "UNWANTED_SOFTWARE",
    "SOCIAL_ENGINEERING_EXTENDED_COVERAGE",
];

// What the API answers with: { threat?: { threatTypes?: string[] } }
type WebRiskResponse = Value;

pub async fn is_url_malicious(url: &str) -> bool {
    // If this is not set as an environment variable, skip this API altogether.
    if KEYS.web_risk_api_key.is_empty() {
        return false;
    }

    let timeout = Duration::from_millis(3000);

    let checked: Result<bool, reqwest::Error> = async {
        let mut params = form_urlencoded::Serializer::new(String::new());
        params
            .append_pair("key", &KEYS.web_risk_api_key)
            .append_pair("uri", url);
        for t in THREAT_TYPES {
            params.append_pair("threatTypes", t);
        }

        let res = FETCH
            .get(format!("{WEB_RISK_URL}?{}", params.finish()))
            .timeout(timeout)
            .send()
            .await?;

        let data: WebRiskResponse = res.json().await?;
        println!("[web-risk] response for {url} {data}");
        Ok(!data["threat"].is_null())
    }
    .await;

    match checked {
        Ok(malicious) => malicious,
        Err(error) => {
            // API failure: a Web Risk outage or timeout should not block link creation.
            log(&CpeakError::from(error));
            false
        }
    }
}
