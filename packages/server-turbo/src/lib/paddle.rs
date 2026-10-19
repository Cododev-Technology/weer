use cpeak::{CpeakError, Value, json};
use reqwest::Method;
use url::form_urlencoded::byte_serialize;

use super::util::FETCH;
use crate::config::keys::KEYS;

pub struct CreditPack {
    pub credits: i32,
    // USD, before tax
    pub price: &'static str,
    pub links_per_dollar: i32,
    pub featured: bool,
    // The Paddle price ids
    pub paddle_sandbox: &'static str,
    pub paddle_production: &'static str,
}

impl CreditPack {
    pub fn paddle_price_id(&self) -> &'static str {
        if KEYS.paddle_environment == "production" {
            self.paddle_production
        } else {
            self.paddle_sandbox
        }
    }
}

// (CREDIT_PACKS, from packages/common/config/credit-packs.json5, written by build.rs)
include!(concat!(env!("OUT_DIR"), "/credit_packs.rs"));

#[derive(Debug, Clone, Default)]
pub struct PaddleTransaction {
    pub id: String,
    // draft, ready, billed, paid, completed, canceled or past_due
    pub status: String,
    // custom_data.user_id
    pub user_id: Option<i32>,
    pub currency_code: String,
    // The price id and quantity of each item
    pub items: Vec<(String, i64)>,
    // details.totals.grand_total, in cents
    pub grand_total: i64,
}

#[derive(Debug, Clone, Default)]
pub struct PaddleAdjustment {
    pub id: String,
    // refund, chargeback, credit, ...
    pub action: String,
    // pending_approval, approved, rejected or reversed
    pub status: String,
    pub transaction_id: String,
    pub currency_code: String,
    // totals.total, in cents
    pub total: i64,
}

fn string(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_string()
}

// Paddle's amounts are strings, like "499"
fn amount(value: &Value) -> i64 {
    value
        .as_str()
        .and_then(|text| text.parse().ok())
        .unwrap_or_default()
}

impl PaddleTransaction {
    fn from_value(data: &Value) -> Self {
        PaddleTransaction {
            id: string(&data["id"]),
            status: string(&data["status"]),
            user_id: data["custom_data"]["user_id"]
                .as_i64()
                .and_then(|id| i32::try_from(id).ok()),
            currency_code: string(&data["currency_code"]),
            items: data["items"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .map(|item| {
                            (
                                string(&item["price"]["id"]),
                                item["quantity"].as_i64().unwrap_or_default(),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default(),
            grand_total: amount(&data["details"]["totals"]["grand_total"]),
        }
    }
}

impl PaddleAdjustment {
    fn from_value(data: &Value) -> Self {
        PaddleAdjustment {
            id: string(&data["id"]),
            action: string(&data["action"]),
            status: string(&data["status"]),
            transaction_id: string(&data["transaction_id"]),
            currency_code: string(&data["currency_code"]),
            total: amount(&data["totals"]["total"]),
        }
    }
}

fn api_url() -> &'static str {
    KEYS.paddle_api_url
        .as_deref()
        .unwrap_or(if KEYS.paddle_environment == "production" {
            "https://api.paddle.com"
        } else {
            "https://sandbox-api.paddle.com"
        })
}

pub fn payments_enabled() -> bool {
    KEYS.paddle_api_key.is_some()
}

pub fn price_id_of(credits: i32) -> Option<&'static str> {
    CREDIT_PACKS
        .iter()
        .find(|pack| pack.credits == credits)
        .map(CreditPack::paddle_price_id)
        .filter(|id| !id.is_empty())
}

pub fn credits_of(price_id: &str) -> Option<i32> {
    CREDIT_PACKS
        .iter()
        .find(|pack| pack.paddle_price_id() == price_id)
        .map(|pack| pack.credits)
}

// Returns the data of Paddle's response, or None on a 404
async fn request(
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Option<Value>, CpeakError> {
    let mut request = FETCH
        .request(method.clone(), format!("{}{path}", api_url()))
        .header(
            "Authorization",
            format!(
                "Bearer {}",
                KEYS.paddle_api_key.as_deref().unwrap_or_default()
            ),
        );
    if let Some(body) = body {
        request = request.json(&body);
    }

    let res = request.send().await?;
    let status = res.status();

    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }

    let mut json: Value = res.json().await?;
    if !status.is_success() {
        return Err(CpeakError::other(format!(
            "Paddle {method} {path}: {} {} {}",
            status.as_u16(),
            json["error"]["code"].as_str().unwrap_or_default(),
            json["error"]["detail"].as_str().unwrap_or_default(),
        )));
    }

    Ok(Some(json["data"].take()))
}

fn encode(id: &str) -> String {
    byte_serialize(id.as_bytes()).collect()
}

// The user id is set here, never by the browser
pub async fn create_transaction(
    price_id: &str,
    user_id: i32,
) -> Result<PaddleTransaction, CpeakError> {
    let data = request(
        Method::POST,
        "/transactions",
        Some(json!({
            "items": [{ "price_id": price_id, "quantity": 1 }],
            "custom_data": { "user_id": user_id },
        })),
    )
    .await?
    .ok_or_else(|| CpeakError::other("Paddle POST /transactions: 404"))?;

    Ok(PaddleTransaction::from_value(&data))
}

pub async fn get_transaction(id: &str) -> Result<Option<PaddleTransaction>, CpeakError> {
    let data = request(Method::GET, &format!("/transactions/{}", encode(id)), None).await?;
    Ok(data.map(|data| PaddleTransaction::from_value(&data)))
}

pub async fn get_adjustment(id: &str) -> Result<Option<PaddleAdjustment>, CpeakError> {
    let data = request(
        Method::GET,
        &format!("/adjustments?id={}", encode(id)),
        None,
    )
    .await?;
    Ok(data
        .as_ref()
        .and_then(|data| data.get(0))
        .map(PaddleAdjustment::from_value))
}
