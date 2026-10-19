use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, Once};

use cpeak::crypto::{hex_encode, random_bytes};
use cpeak::{Cpeak, CpeakOptions, Value, json, parse_json};

use server_turbo::config::keys::KEYS;
use server_turbo::lib::paddle::CREDIT_PACKS;

// A fake of Paddle's API on PADDLE_API_URL, so the tests never call Paddle. It runs in the test
// process, which also works when the tests run against a server elsewhere (TEST_BASE_URL).
const PORT: u16 = 2090;

// The Paddle price id of a pack, smallest first
pub fn price_id(pack: usize) -> &'static str {
    CREDIT_PACKS[pack].paddle_price_id()
}

// What a price costs, in cents
fn price(price_id: &str) -> String {
    CREDIT_PACKS
        .iter()
        .find(|pack| pack.paddle_price_id() == price_id)
        .map(|pack| {
            (pack.price.parse::<f64>().unwrap() * 100.0)
                .round()
                .to_string()
        })
        .unwrap_or_else(|| "0".to_string())
}

static TRANSACTIONS: LazyLock<Mutex<HashMap<String, Value>>> = LazyLock::new(Default::default);
static ADJUSTMENTS: LazyLock<Mutex<HashMap<String, Value>>> = LazyLock::new(Default::default);

// Like Paddle's ids: a prefix and 26 letters and digits
fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", hex_encode(random_bytes(13)))
}

fn transaction(id: &str, price_id: &str, user_id: Option<i64>, status: &str) -> Value {
    json!({
        "id": id,
        "status": status,
        "custom_data": user_id.map(|user_id| json!({ "user_id": user_id })),
        "currency_code": "USD",
        "items": [{ "price": { "id": price_id }, "quantity": 1 }],
        "details": { "totals": { "grand_total": price(price_id) } },
    })
}

// Starts the fake the first time, and forgets the transactions and adjustments of the last test
pub fn reset() {
    static START: Once = Once::new();
    START.call_once(start);

    TRANSACTIONS.lock().unwrap().clear();
    ADJUSTMENTS.lock().unwrap().clear();
}

// What the checkout does once the buyer pays
pub fn pay(id: &str) {
    TRANSACTIONS.lock().unwrap().get_mut(id).unwrap()["status"] = json!("completed");
}

pub fn get_transaction(id: &str) -> Option<Value> {
    TRANSACTIONS.lock().unwrap().get(id).cloned()
}

pub fn transaction_count() -> usize {
    TRANSACTIONS.lock().unwrap().len()
}

pub fn add_transaction(user_id: i32, price_id: &str, status: &str) -> String {
    let id = new_id("txn");
    TRANSACTIONS.lock().unwrap().insert(
        id.clone(),
        transaction(&id, price_id, Some(i64::from(user_id)), status),
    );
    id
}

pub fn add_adjustment(transaction_id: &str, total: &str, action: &str, status: &str) -> String {
    let id = new_id("adj");
    ADJUSTMENTS.lock().unwrap().insert(
        id.clone(),
        json!({
            "id": id,
            "action": action,
            "status": status,
            "transaction_id": transaction_id,
            "currency_code": "USD",
            "totals": { "total": total },
        }),
    );
    id
}

pub fn set_adjustment_status(id: &str, status: &str) {
    ADJUSTMENTS.lock().unwrap().get_mut(id).unwrap()["status"] = json!(status);
}

fn start() {
    let mut app = Cpeak::new(CpeakOptions::default());
    app.before_each(parse_json(None));

    app.before_each(async |req, res, next| {
        let api_key = KEYS.paddle_api_key.as_deref().unwrap_or_default();
        if req.headers.get("authorization").map(String::as_str)
            != Some(&format!("Bearer {api_key}"))
        {
            return res.status(403).json(json!({
                "error": { "code": "forbidden", "detail": "Wrong API key" },
            }));
        }
        next()
    });

    app.route("post", "/transactions", async |req, res| {
        let id = new_id("txn");
        let transaction = transaction(
            &id,
            req.body["items"][0]["price_id"]
                .as_str()
                .unwrap_or_default(),
            req.body["custom_data"]["user_id"].as_i64(),
            "draft",
        );
        TRANSACTIONS.lock().unwrap().insert(id, transaction.clone());
        res.status(201).json(json!({ "data": transaction }))
    });

    app.route("get", "/transactions/:id", async |req, res| {
        let id = req.params.get("id").cloned().unwrap_or_default();
        match get_transaction(&id) {
            Some(transaction) => res.json(json!({ "data": transaction })),
            None => res.status(404).json(json!({
                "error": { "code": "entity_not_found", "detail": "Not found" },
            })),
        }
    });

    app.route("get", "/adjustments", async |req, res| {
        let id = req.query.get("id").cloned().unwrap_or_default();
        let found = ADJUSTMENTS.lock().unwrap().get(&id).cloned();
        res.json(json!({ "data": found.into_iter().collect::<Vec<_>>() }))
    });

    let _ = app.listen(PORT, || {});
}
