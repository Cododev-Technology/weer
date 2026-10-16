use cpeak::{CpeakError, Value};
use subtle::ConstantTimeEq;

use crate::database::index::POOL;
use crate::database::types::IEmailCode;

const MAX_ATTEMPTS: i32 = 5;

// The code of a request body, which the client can send as a string or as a number
pub fn code_text(code: &Value) -> String {
    match code {
        Value::String(code) => code.clone(),
        Value::Number(code) => code.to_string(),
        _ => String::new(),
    }
}

pub async fn verify_email_code(email: &str, code: &str) -> Result<(), CpeakError> {
    let code_row = sqlx::query_as::<_, IEmailCode>(
        "UPDATE email_codes SET attempts = attempts + 1 WHERE email = $1 AND expires_at > NOW() RETURNING code, attempts",
    )
    .bind(email)
    .fetch_optional(&*POOL)
    .await?;

    let Some(code_row) = code_row else {
        return Err(CpeakError::new(
            400,
            "This code has expired. Please request a new one.",
        ));
    };

    let submitted = code.as_bytes();
    let stored = code_row.code.to_string();
    let stored = stored.as_bytes();
    let matches = submitted.len() == stored.len() && bool::from(submitted.ct_eq(stored));

    if !matches {
        if code_row.attempts >= MAX_ATTEMPTS {
            sqlx::query("DELETE FROM email_codes WHERE email = $1")
                .bind(email)
                .execute(&*POOL)
                .await?;
            return Err(CpeakError::new(
                429,
                "Too many incorrect attempts. Please request a new code.",
            ));
        }
        return Err(CpeakError::new(
            400,
            "The code you entered is invalid. Please try again.",
        ));
    }

    let consumed = sqlx::query("DELETE FROM email_codes WHERE email = $1 AND code = $2")
        .bind(email)
        .bind(code_row.code)
        .execute(&*POOL)
        .await?
        .rows_affected();

    if consumed == 0 {
        return Err(CpeakError::new(
            400,
            "This code has already been used. Please request a new one.",
        ));
    }
    Ok(())
}
