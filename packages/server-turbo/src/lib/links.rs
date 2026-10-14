/*
 * In this file, we have define all the link types and their properties to use universally
 * across the app.
 *
 * We also have all the validations, and generation logic based on these properties here.
 */

use chrono::{DateTime, SubsecRound, TimeDelta, Utc};
use cpeak::CpeakError;
use cpeak::crypto::random_bytes;

use super::link_definitions::LINKS;
use crate::database::index::POOL;
use crate::database::types::{IUltraCode, LinkType};

const MAX_ATTEMPTS: u32 = 10; // Max number of retries for generating unique IDs (QR Code and Shortened URL id)

// What the Node.js version does with a regex that it builds from the conversions: every
// character that has a conversion (the 'key') is replaced by what it converts to (the 'value')
fn convert(code: &str, conversions: &[(&str, &str)]) -> String {
    let mut converted = String::with_capacity(code.len());
    for character in code.chars() {
        match conversions
            .iter()
            .find(|(key, _)| key.chars().eq([character]))
        {
            Some((_, value)) => converted.push_str(value),
            None => converted.push(character),
        }
    }
    converted
}

// /^[a-z0-9]+$/
fn only_alphabets_and_digits(code: &str) -> bool {
    !code.is_empty()
        && code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

// /^[0-9o]+$/
fn only_digits_and_letter_o(code: &str) -> bool {
    !code.is_empty()
        && code
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'o')
}

pub struct ProcessedCode {
    pub r#type: LinkType,
    pub code: String,
}

/**
 * This function figures out the link type based on the code provided, and then
 * validates it and returns the clean up code.
 *
 * @param code
 * @returns object with type and cleaned code, or null if invalid
 */
pub fn process_code(
    code: &str,
    username: Option<&str>,
    url: Option<&str>,
) -> Option<ProcessedCode> {
    if username.is_some_and(|username| !username.is_empty()) && !code.is_empty() {
        /* @todo clean up & validate code */
        // Affix type
        return Some(ProcessedCode {
            r#type: LinkType::Affix,
            code: code.to_string(),
        });
    }

    if url.is_some_and(|url| url.starts_with("/q/")) {
        /* @todo clean up & validate code */
        // QR code type
        return Some(ProcessedCode {
            r#type: LinkType::Qr,
            code: code.to_string(),
        });
    }

    // We first check type, then clean up, then validate
    if is_ultra_code(code) {
        let cleaned_code = clean_ultra_code(code);
        if !validate_ultra_code(&cleaned_code) {
            return None;
        }
        Some(ProcessedCode {
            r#type: LinkType::Ultra,
            code: cleaned_code,
        })
    } else if is_classic_code(code) {
        let cleaned_code = clean_classic_code(code);
        if !validate_classic_code(&cleaned_code) {
            return None;
        }
        Some(ProcessedCode {
            r#type: LinkType::Classic,
            code: cleaned_code,
        })
    } else if is_digit_code(code) {
        let cleaned_code = clean_digit_code(code);
        if !validate_digit_code(&cleaned_code) {
            return None;
        }
        Some(ProcessedCode {
            r#type: LinkType::Digit,
            code: cleaned_code,
        })
    } else {
        /* @todo clean up & validate code */
        // Finally, default to custom type
        Some(ProcessedCode {
            r#type: LinkType::Custom,
            code: code.to_string(),
        })
    }
}

// Check if a shortened URL code is an ultra code (before cleaning up)
fn is_ultra_code(code: &str) -> bool {
    // Check length
    if code.chars().count() > LINKS.ultra.max_length
        || code.chars().count() < LINKS.ultra.min_length
    {
        return false;
    }

    true
}

// Clean ultra code (make lowercase & replace non-supported characters)
fn clean_ultra_code(code: &str) -> String {
    convert(&code.to_lowercase(), LINKS.ultra.conversions)
}

// Validate ultra code after running isUltraCode and cleanUltraCode
fn validate_ultra_code(code: &str) -> bool {
    // Check that it only contains alphabets and digits
    if !only_alphabets_and_digits(code) {
        return false;
    }

    true
}

// Check if a shortened URL code is a classic code
fn is_classic_code(code: &str) -> bool {
    code.chars().count() == 6
}

// Clean classic code (e.g. make lowercase)
fn clean_classic_code(code: &str) -> String {
    convert(&code.to_lowercase(), LINKS.classic.conversions)
}

// Validate classic code after running isClassicCode and cleanClassicCode
fn validate_classic_code(code: &str) -> bool {
    // Check length & that it only contains alphabets and digits
    if !only_alphabets_and_digits(code) {
        return false;
    }

    true
}

fn is_digit_code(code: &str) -> bool {
    // Check length
    if code.chars().count() > LINKS.digit.max_length
        || code.chars().count() < LINKS.digit.min_length
    {
        return false;
    }

    true
}

fn clean_digit_code(code: &str) -> String {
    convert(&code.to_lowercase(), LINKS.digit.conversions)
}

// Validate digit code after running isDigitCode and cleanDigitCode
fn validate_digit_code(code: &str) -> bool {
    // Check that it only contains digits and letter o
    if !only_digits_and_letter_o(code) {
        return false;
    }

    true
}

/**
 * Generates a unique "classic" type shortened URL ID for the given database URL ID.
 * The classic type is a 6-Character Code, only lowercase alphabets and digits, without o or l. In redirecting, o is treated as 0 and l as i.
 *
 * @param id The database URL ID to update with the generated shortened URL ID
 * @returns The generated shortened URL Code
 */
pub async fn generate_classic(id: i32) -> Result<String, CpeakError> {
    let mut attempts = 0;

    let possible_chars = LINKS.classic.characters.as_bytes();
    let code_length = LINKS.classic.max_length; // For now max and min are the same

    // We will retry updating the record just like before with the QR code id
    while attempts <= MAX_ATTEMPTS {
        // Generate a 6-character code to be used as url shortened id
        let bytes = random_bytes(code_length);
        let mut shortened_code = String::new();
        for i in 0..code_length {
            shortened_code
                .push(possible_chars[usize::from(bytes[i]) % possible_chars.len()] as char);
        }

        let updated =
            sqlx::query("UPDATE urls SET shortened_url_id = $1, link_type = $2 WHERE id = $3")
                .bind(&shortened_code)
                .bind(LinkType::Classic)
                .bind(id)
                .execute(&*POOL)
                .await;

        match updated {
            // If update is successful, the ID is unique
            Ok(_) => return Ok(shortened_code),
            Err(error) => {
                // The official PostgreSQL error code for unique violations
                if error
                    .as_database_error()
                    .is_some_and(|error| error.is_unique_violation())
                {
                    // If there's a duplicate key error, generate a new ID and retry
                    attempts += 1;
                } else {
                    return Err(error.into());
                }
            }
        }
    }

    // Max attempts reached
    Err(CpeakError::other(format!(
        "Could not generate a unique shortened URL ID after {MAX_ATTEMPTS} attempts"
    )))
}

// What generating an ultra or a digit code gives back
pub struct GeneratedCode {
    pub code: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub url_id: Option<i32>,
}

/**
 * Generates a unique "ultra" type shortened URL ID for the given database URL ID.
 * The ultra type is a 1 or 2 character code, only lowercase alphabets and digits.
 * Examples: a, b, z, 0, 5, az, 1z, z1, zl
 *
 * @param id The database URL ID to update with the generated shortened URL ID
 * @returns The generated shortened URL Code and its expiration date in an object in a promise
 */
pub async fn generate_ultra(id: i32) -> Result<GeneratedCode, CpeakError> {
    /*
     * Clean up the ultra_code table first:
     * - Set url_id of all records that have expired to NULL.
     * - Set assigned_at and expires_at to NULL for all ultra codes that have url_id NULL (unassigned).
     *   This usually happens when a user deletes an ultra code link before it expires.
     */
    sqlx::query(
        "
      UPDATE ultra_codes
      SET
        url_id = CASE
          WHEN expires_at < NOW() THEN NULL
          ELSE url_id
        END,
        assigned_at = CASE
          WHEN (expires_at < NOW()) OR url_id IS NULL THEN NULL
          ELSE assigned_at
        END,
        expires_at = CASE
          WHEN (expires_at < NOW()) OR url_id IS NULL THEN NULL
          ELSE expires_at
        END;
  ",
    )
    .execute(&*POOL)
    .await?;

    /*
     * Find the first available ultra code. And then update that ultra code to be linked
     * to this url id.
     * We do this atomically to avoid race conditions when many people are hitting this route.
     *
     * 'for update' here means that we are locking the selected row until the transaction is committed.
     * This prevents other transactions from modifying or selecting these rows until we're done with them.
     */
    let generated: Result<Option<GeneratedCode>, sqlx::Error> = async {
        let row = sqlx::query_as::<_, IUltraCode>(
            "
        UPDATE ultra_codes
        SET url_id = $1,
            assigned_at = NOW(),
            expires_at = NOW() + ($2 * INTERVAL '1 millisecond')
        WHERE id = (
          SELECT id FROM ultra_codes
          WHERE url_id IS NULL
          ORDER BY length(code), code
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING url_id, code, expires_at;
      ",
        )
        .bind(id)
        .bind(LINKS.ultra.valid_for)
        .fetch_optional(&*POOL)
        .await?;

        // (every ultra code is taken at the moment)
        let Some(row) = row else {
            return Ok(None);
        };

        // Update the URL record to set its link_type
        sqlx::query("UPDATE urls SET link_type = $1 WHERE id = $2")
            .bind(LinkType::Ultra)
            .bind(row.url_id)
            .execute(&*POOL)
            .await?;

        Ok(Some(GeneratedCode {
            code: row.code,
            expires_at: row.expires_at,
            url_id: row.url_id,
        }))
    }
    .await;

    match generated {
        Ok(Some(generated)) => Ok(generated),
        Ok(None) => Err(CpeakError::other("No ultra code is available right now")),
        Err(error) => {
            if error
                .as_database_error()
                .is_some_and(|error| error.is_unique_violation())
            {
                // If there's a duplicate key error
                return Err(CpeakError::new(
                    400,
                    "You can't have two ultra codes for the same link.",
                ));
            }

            Err(error.into())
        }
    }
}

/**
 * Generates a random unique "digit" type shortened URL ID for the given database URL ID.
 * The digit type consists of only digits, with a length between 3 to 5 digits.
 *
 * @param id The database URL ID to update with the generated shortened URL ID (code)
 * @returns The generated shortened URL Code
 */
pub async fn generate_digit(id: i32) -> Result<GeneratedCode, CpeakError> {
    const ENTROPY_LEVEL: f64 = 0.3; // at least 30% of codes should be available to try generating new codes of that length

    // Gives None when no code of this length could be made, so the next length gets its turn
    async fn generate_and_insert_digit_code(
        id: i32,
        code_length: usize,
    ) -> Result<Option<GeneratedCode>, CpeakError> {
        /* X in the code below refers the codeLength (either 3, 4, or 5) */

        // Check entropy level for X digit codes
        let used_x_digits = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM digit_codes WHERE code_length = $1;",
        )
        .bind(code_length as i32)
        .fetch_one(&*POOL)
        .await?;
        let total_x_digits = 10_f64.powi(code_length as i32); // 10^X
        if used_x_digits as f64 / total_x_digits < 1.0 - ENTROPY_LEVEL {
            // Now we can generate a new random 3 digit code
            let mut attempts = 0;

            let possible_chars = LINKS.digit.characters.as_bytes();

            // We will retry updating the record just like before with the QR code id
            while attempts <= MAX_ATTEMPTS {
                // Generate a 3-digit code to be used as url shortened id
                let bytes = random_bytes(code_length);
                let mut new_code = String::new();
                for i in 0..code_length {
                    new_code
                        .push(possible_chars[usize::from(bytes[i]) % possible_chars.len()] as char);
                }

                // (to the millisecond, so the date we send back is exactly the one we save)
                let expires_at = Utc::now().trunc_subsecs(3)
                    + TimeDelta::milliseconds(LINKS.digit.valid_for.unwrap_or(0));

                let inserted = async {
                    sqlx::query(
                        "INSERT INTO digit_codes(url_id, code, code_length, expires_at, assigned_at) VALUES ($1, $2, $3, $4, $5)",
                    )
                    .bind(id)
                    .bind(&new_code)
                    .bind(code_length as i32)
                    .bind(expires_at)
                    .bind(Utc::now())
                    .execute(&*POOL)
                    .await?;

                    // Update the URL record to set its link_type
                    sqlx::query("UPDATE urls SET link_type = $1 WHERE id = $2")
                        .bind(LinkType::Digit)
                        .bind(id)
                        .execute(&*POOL)
                        .await
                }
                .await;

                match inserted {
                    // If insert is successful, the ID is unique
                    Ok(_) => {
                        return Ok(Some(GeneratedCode {
                            code: new_code,
                            expires_at: Some(expires_at),
                            url_id: Some(id),
                        }));
                    }
                    Err(error) => {
                        // The official PostgreSQL error code for unique violations
                        if error
                            .as_database_error()
                            .is_some_and(|error| error.is_unique_violation())
                        {
                            // If there's a duplicate key error, generate a new ID and retry
                            attempts += 1;
                        } else {
                            return Err(error.into());
                        }
                    }
                }
            }

            // Max attempts reached
            // Instead of throwing error here, we can return None to try next code length
            Ok(None)
        } else {
            // Entropy level not sufficient to try generating new codes of this length
            Ok(None)
        }
    }

    // For each code, we will only try to generate and insert a new record into the digit_codes table if we have at least 30%
    // of the codes available for that length.
    // For example, for 3 digit codes, there are 1000 combinations (000 to 999).
    // We will only try to generate and insert a new 3 digit code if there are at least 300 codes available (i.e. less than 700 used).
    // This is to avoid too many collisions and retries when the table is almost full for that length.

    // For creating a new digit code:
    // if select count(*) from digit_codes where code_length = 3 satisfies ENTROPY_LEVEL, then we attempt to create a new code.
    // else if select count(*) from digit_codes where code_length = 3 does not satisfy ENTROPY_LEVEL, then we move on to the next length.

    // ------ 1. Trying 3 digit codes first  ------
    let three_digit_result = generate_and_insert_digit_code(id, 3).await?;
    if let Some(three_digit_result) = three_digit_result {
        Ok(three_digit_result)
    } else {
        // ------ 2. Trying 4 digit codes next  ------
        let four_digit_result = generate_and_insert_digit_code(id, 4).await?;
        if let Some(four_digit_result) = four_digit_result {
            Ok(four_digit_result)
        } else {
            // ------ 3. Trying 5 digit codes finally  ------
            let five_digit_result = generate_and_insert_digit_code(id, 5).await?;
            if let Some(five_digit_result) = five_digit_result {
                Ok(five_digit_result)
            } else {
                Err(CpeakError::new(
                    503,
                    "No unique digit code is available now, please try again later.",
                ))
            }
        }
    }
}

/**
 * Generates a unique QR Code ID for the given database URL ID.
 * @param id The database URL ID to update with the generated shortened URL ID
 * @returns a promise
 */
pub async fn generate_qr_code(id: i32) -> Result<(), CpeakError> {
    /*                                FOR QR CODE ID:
      7 bytes (56 bits) gives 2^56 = 72,057,594,037,927,936 combination.
      The base65url encoding safely converts binary data into a URL valid string without losing entropy.

      Based on the Birthday Paradox, after generating around 1 billion random codes, there is roughly a 0.999 (99.9%) probability
      that at least one collision will occur somewhere in that entire set.

      This means that out of 1 billion inserts, we should expect only
      a handful of duplicates (about 7 on average) due to random chance. There is a per-insert
      collision probability of about 7×10⁻⁹ (0.0000007%).

      This is trivial though but we must still handle collisions in the database (we'll retry on unique constraint violation of Postgres).
    */

    let mut updated = false;
    let mut attempts = 0; // to avoid infinite loops, we will try only 10 times

    while !updated && attempts < MAX_ATTEMPTS {
        attempts += 1;
        let qr_code_id = (LINKS.qr.character_encoding)(random_bytes(LINKS.qr.size)); // base64url encoding

        let result = sqlx::query("UPDATE urls SET qr_code_id = $1 WHERE id = $2")
            .bind(&qr_code_id)
            .bind(id)
            .execute(&*POOL)
            .await;

        match result {
            Ok(_) => updated = true, // If update is successful. The ID is unique
            Err(error) => {
                // The official PostgreSQL error code for unique violations
                if error
                    .as_database_error()
                    .is_some_and(|error| error.is_unique_violation())
                {
                    // If there's a duplicate key error, generate a new ID and retry
                    updated = false;
                } else {
                    return Err(error.into());
                }
            }
        }
    }

    // Max attempts reached
    if !updated {
        return Err(CpeakError::other(format!(
            "Could not generate a unique QR code ID after {MAX_ATTEMPTS} attempts"
        )));
    }

    Ok(())
}
