use std::sync::LazyLock;

use cpeak::{CpeakError, CpeakRequest, CpeakResponse, json};
use regex::Regex;

use crate::config::keys::KEYS;
use crate::database::index::POOL;
use crate::database::types::{IPayment, IUser};
use crate::lib::paddle::{
    PaddleAdjustment, PaddleTransaction, create_transaction, credits_of, get_adjustment,
    get_transaction, payments_enabled, price_id_of,
};

static TRANSACTION_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^txn_[a-z\d]{26}$").unwrap());
static ADJUSTMENT_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^adj_[a-z\d]{26}$").unwrap());

enum AddCredits {
    Added,
    Unpaid,
    // Not one of our packs
    Ignored,
}

// Adds the credits of a paid transaction to its user, once per transaction
async fn add_credits(transaction: &PaddleTransaction) -> Result<AddCredits, CpeakError> {
    if transaction.status != "paid" && transaction.status != "completed" {
        return Ok(AddCredits::Unpaid);
    }

    let credits = match transaction.items.as_slice() {
        [(price_id, 1)] => credits_of(price_id),
        _ => None,
    };

    let (Some(user_id), Some(credits)) = (transaction.user_id.filter(|id| *id != 0), credits)
    else {
        return Ok(AddCredits::Ignored);
    };

    let mut tx = POOL.begin().await?;
    let added: Result<(), sqlx::Error> = async {
        let payment = sqlx::query_scalar::<_, i32>(
            "INSERT INTO payments (paddle_id, transaction_id, user_id, credits, amount, currency)
      VALUES ($1, $1, $2, $3, $4, $5)
      ON CONFLICT (paddle_id) DO NOTHING
      RETURNING id",
        )
        .bind(&transaction.id)
        .bind(user_id)
        .bind(credits)
        .bind(transaction.grand_total)
        .bind(&transaction.currency_code)
        .fetch_optional(&mut *tx)
        .await?;

        // Accounts from before the credit check stopped at 0 can still be below it
        if payment.is_some() {
            sqlx::query(
                "UPDATE users SET link_credits = GREATEST(link_credits, 0) + $1 WHERE id = $2",
            )
            .bind(credits)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        }

        Ok(())
    }
    .await;

    match added {
        Ok(()) => tx.commit().await?,
        Err(e) => {
            tx.rollback().await?;
            return Err(e.into());
        }
    }

    Ok(AddCredits::Added)
}

// Takes back the refunded share of a purchase's credits, once per approved refund or chargeback
async fn take_back_credits(adjustment: &PaddleAdjustment) -> Result<(), CpeakError> {
    if adjustment.action != "refund" && adjustment.action != "chargeback" {
        return Ok(());
    }
    if adjustment.status != "approved" {
        return Ok(());
    }

    let purchase = sqlx::query_as::<_, IPayment>(
        "SELECT user_id, credits, amount, currency FROM payments WHERE paddle_id = $1",
    )
    .bind(&adjustment.transaction_id)
    .fetch_optional(&*POOL)
    .await?;

    let Some(purchase) = purchase.filter(|purchase| purchase.currency == adjustment.currency_code)
    else {
        return Ok(());
    };

    let credits = purchase.credits.min(
        ((i64::from(purchase.credits) * adjustment.total) as f64 / purchase.amount as f64).round()
            as i32,
    );

    let mut tx = POOL.begin().await?;
    let taken: Result<(), sqlx::Error> = async {
        let payment = sqlx::query_scalar::<_, i32>(
            "INSERT INTO payments (paddle_id, transaction_id, user_id, credits, amount, currency)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (paddle_id) DO NOTHING
      RETURNING id",
        )
        .bind(&adjustment.id)
        .bind(&adjustment.transaction_id)
        .bind(purchase.user_id)
        .bind(-credits)
        .bind(adjustment.total)
        .bind(&adjustment.currency_code)
        .fetch_optional(&mut *tx)
        .await?;

        if payment.is_some() {
            sqlx::query("UPDATE users SET link_credits = link_credits - $1 WHERE id = $2")
                .bind(credits)
                .bind(purchase.user_id)
                .execute(&mut *tx)
                .await?;
        }

        Ok(())
    }
    .await;

    match taken {
        Ok(()) => tx.commit().await?,
        Err(e) => {
            tx.rollback().await?;
            return Err(e.into());
        }
    }

    Ok(())
}

pub async fn get_status(
    _req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    res.json(json!({ "enabled": payments_enabled() }))
}

// Creates the Paddle transaction that the browser's checkout opens
pub async fn create_checkout(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    if !payments_enabled() {
        return res
            .status(503)
            .json(json!({ "error": "Buying credits isn't available yet." }));
    }

    let Some(price_id) = req.body["credits"]
        .as_i64()
        .and_then(|credits| i32::try_from(credits).ok())
        .and_then(price_id_of)
    else {
        return res
            .status(400)
            .json(json!({ "error": "Invalid credit pack." }));
    };

    let user_id = user_id(req);
    let transaction = create_transaction(price_id, user_id).await?;
    let email = sqlx::query_scalar::<_, Option<String>>("SELECT email FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&*POOL)
        .await?
        .flatten();

    res.status(201).json(json!({
        "transactionId": transaction.id,
        "clientToken": KEYS.paddle_client_token,
        "environment": KEYS.paddle_environment,
        "email": email,
    }))
}

// Called by the browser after a payment. The webhook adds the same credits if the browser never calls.
pub async fn confirm_checkout(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    let transaction_id = req.body["transactionId"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    if !TRANSACTION_ID.is_match(&transaction_id) {
        return res
            .status(400)
            .json(json!({ "error": "Invalid transaction." }));
    }

    let user_id = user_id(req);
    let transaction = if payments_enabled() {
        get_transaction(&transaction_id).await?
    } else {
        None
    };

    // Only the user who bought it can confirm it
    let Some(transaction) = transaction.filter(|transaction| transaction.user_id == Some(user_id))
    else {
        return res
            .status(404)
            .json(json!({ "error": "Transaction not found." }));
    };

    if let AddCredits::Unpaid = add_credits(&transaction).await? {
        return res
            .status(409)
            .json(json!({ "error": "This payment hasn't gone through yet." }));
    }

    let link_credits = sqlx::query_scalar::<_, i32>("SELECT link_credits FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&*POOL)
        .await?;

    res.json(json!({ "linkCredits": link_credits }))
}

// Only the id is taken from the request; the transaction or adjustment is fetched from Paddle's API
pub async fn handle_webhook(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    let event_type = req.body["event_type"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let id = req.body["data"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_string();

    if payments_enabled() {
        if matches!(
            event_type.as_str(),
            "transaction.paid" | "transaction.completed"
        ) && TRANSACTION_ID.is_match(&id)
            && let Some(transaction) = get_transaction(&id).await?
        {
            add_credits(&transaction).await?;
        }

        if matches!(
            event_type.as_str(),
            "adjustment.created" | "adjustment.updated"
        ) && ADJUSTMENT_ID.is_match(&id)
            && let Some(adjustment) = get_adjustment(&id).await?
        {
            take_back_credits(&adjustment).await?;
        }
    }

    // Other events are acknowledged too, or Paddle keeps resending them
    res.status(200).json(json!({ "received": true }))
}

fn user_id(req: &CpeakRequest) -> i32 {
    req.get::<IUser>("user")
        .map(|user| user.id)
        .unwrap_or_default()
}
