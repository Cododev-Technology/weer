use std::io::Cursor;
use std::net::IpAddr;

use chrono::{DateTime, Utc};
use cpeak::crypto::{hex_encode, sha256};
use cpeak::{CpeakError, CpeakRequest, CpeakResponse, Value, json};
use image::imageops::{self, FilterType};
use image::{ImageFormat, Luma};
use qrcode::bits::Bits;
use qrcode::render::svg;
use qrcode::{EcLevel, QrCode, Version};
use sqlx::{AssertSqlSafe, FromRow};
use url::form_urlencoded;

use crate::config::keys::KEYS;
use crate::database::index::POOL;
use crate::database::types::{ISession, IUrl, IUser, LinkType};
use crate::lib::domain_allowlist::is_allowlisted_domain;
use crate::lib::links::{
    ProcessedCode, generate_classic, generate_digit, generate_qr_code, generate_ultra,
    process_code, validate_affix_code, validate_custom_code,
};
use crate::lib::rate_limit::refund_user_credit;
use crate::lib::util::{self, to_iso_string};
use crate::middlewares::session_token;
use crate::redis::links_cache;
use crate::redis::views_stream::{IViewEvent, push as push_view};

// The web and styles packages build into the public folder of server-shared, so both servers serve that one
const PUBLIC_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../server-shared/public");

// Helper functions to check affix code availability
async fn is_affix_available(code: Option<&str>, user_id: Option<i32>) -> Result<bool, CpeakError> {
    let existing_code = sqlx::query_as::<_, IUrl>(
        "SELECT id FROM urls WHERE shortened_url_id=$1 AND link_type='affix' AND user_id = $2",
    )
    .bind(code)
    .bind(user_id)
    .fetch_optional(&*POOL)
    .await?;

    Ok(existing_code.is_none())
}

// Helper function to check custom code availability
async fn is_custom_available(code: Option<&str>) -> Result<bool, CpeakError> {
    let existing_code = sqlx::query_as::<_, IUrl>(
        "SELECT id FROM urls WHERE shortened_url_id=$1 AND link_type='custom'",
    )
    .bind(code)
    .fetch_optional(&*POOL)
    .await?;

    Ok(existing_code.is_none())
}

// Return the list of urls user has shortened
pub async fn get_urls(req: &mut CpeakRequest, res: &mut CpeakResponse) -> Result<(), CpeakError> {
    let where_clause;
    let query_params; // will be either user id or session id

    if let Some(user) = req.get::<IUser>("user") {
        where_clause = "urls.user_id = $1";
        query_params = user.id;
    } else if let Some(session_token) = session_token(req) {
        // ($1::bpchar: session_token is a CHAR column, and sqlx sends a String as text.
        // PostgreSQL can only use the index of the column for a value of its own type.)
        let session =
            sqlx::query_as::<_, ISession>("SELECT id FROM sessions WHERE session_token=$1::bpchar")
                .bind(session_token)
                .fetch_optional(&*POOL)
                .await?;

        let Some(session) = session.filter(|session| session.id != 0) else {
            return res.json(json!({ "urls": [], "domain": KEYS.domain }));
        };

        where_clause = "urls.session_id = $1";
        query_params = session.id;
    } else {
        // No user and no session token
        return res.json(json!({ "urls": [], "domain": KEYS.domain }));
    }

    #[derive(FromRow)]
    struct Row {
        id: i32,
        real_url: String,
        link_type: LinkType,
        code: Option<String>,
        assigned_at: Option<DateTime<Utc>>,
        expires_at: Option<DateTime<Utc>>,
    }

    // (a query that we put together ourselves has to be marked as safe for sqlx to run it)
    let data = sqlx::query_as::<_, Row>(AssertSqlSafe(format!(
        "
    SELECT
      urls.id,
      urls.real_url,
      urls.link_type,
      COALESCE(ultra_codes.code, urls.shortened_url_id, digit_codes.code) AS code,
      COALESCE(ultra_codes.assigned_at, digit_codes.assigned_at) AS assigned_at,
      COALESCE(ultra_codes.expires_at, digit_codes.expires_at) AS expires_at
    FROM urls
    LEFT JOIN ultra_codes
      ON urls.id = ultra_codes.url_id
      AND urls.link_type = 'ultra'
    LEFT JOIN digit_codes
      ON urls.id = digit_codes.url_id
      AND urls.link_type = 'digit'
    WHERE {where_clause}
    ORDER BY urls.created_at DESC;
  "
    )))
    .bind(query_params)
    .fetch_all(&*POOL)
    .await?;

    // The values that are null in the database are left out (DB.cleanResult in the Node.js version)
    let urls: Vec<Value> = data
        .into_iter()
        .map(|url| {
            let mut row = json!({
                "id": url.id,
                "real_url": url.real_url,
                "link_type": url.link_type.as_str(),
            });
            if let Some(code) = url.code {
                row["code"] = json!(code);
            }
            if let Some(assigned_at) = url.assigned_at {
                row["assigned_at"] = json!(to_iso_string(assigned_at));
            }
            if let Some(expires_at) = url.expires_at {
                row["expires_at"] = json!(to_iso_string(expires_at));
            }
            row
        })
        .collect();

    // 4. Return the result
    res.json(json!({
        "urls": urls,
        "domain": KEYS.domain,
    }))
}

// Get the url, shorten it and save to database
pub async fn shorten(req: &mut CpeakRequest, res: &mut CpeakResponse) -> Result<(), CpeakError> {
    // Get the user id if the user is logged in
    let user_id = req
        .get::<IUser>("user")
        .map(|user| user.id)
        .filter(|user_id| *user_id != 0);

    // Get the session token for when the user is not logged in
    let session_token = session_token(req);

    let real_url = req.body["url"].clone();

    /* ----------------------------------------------------------------------------------
         We will first insert the record and then generate a code for the QR code.
         Afterwards, we will update that record with the a requested generated code.
    -------------------------------------------------------------------------------- */

    let session_id = if user_id.is_none() {
        sqlx::query_as::<_, ISession>("SELECT id FROM sessions WHERE session_token=$1::bpchar")
            .bind(session_token)
            .fetch_optional(&*POOL)
            .await?
            .map(|session| session.id)
    } else {
        None
    };

    let inserted_url = sqlx::query_as::<_, IUrl>(
        "INSERT INTO urls(real_url, user_id, session_id) VALUES ($1, $2, $3) RETURNING *",
    )
    .bind(real_url.as_str())
    .bind(user_id)
    .bind(session_id)
    .fetch_one(&*POOL)
    .await?;
    let id = inserted_url.id;

    generate_qr_code(id).await?;

    /* ----------------------------------------------------------------------------------
         At this point we have inserted the record with a unique QR code id.
         Now we will generate a unique shortened URL id and update the record.
    -------------------------------------------------------------------------------- */

    let r#type = req.body["type"].clone();

    let shortened_code;
    let mut expires_at = None;
    let mut actual_type = r#type.clone();

    match r#type.as_str() {
        Some("classic") => match generate_classic(id).await {
            Ok(code) => shortened_code = code,
            Err(error) => {
                // Delete the inserted URL record and refund the spent credit if we could not generate a code
                sqlx::query("DELETE FROM urls WHERE id=$1")
                    .bind(inserted_url.id)
                    .execute(&*POOL)
                    .await?;
                if let Some(user_id) = user_id {
                    refund_user_credit(user_id).await?;
                }

                return Err(error);
            }
        },
        Some("ultra") => {
            let Some(user) = req.get::<IUser>("user") else {
                return Err(CpeakError::new(401, "Unauthorized"));
            };
            match generate_ultra(id).await {
                Ok(obj) => {
                    expires_at = obj.expires_at;
                    shortened_code = obj.code;
                }
                Err(error) => {
                    // Delete the inserted URL record and refund the spent credit if we could not generate a code
                    sqlx::query("DELETE FROM urls WHERE id=$1")
                        .bind(inserted_url.id)
                        .execute(&*POOL)
                        .await?;
                    refund_user_credit(user.id).await?;

                    return Err(error);
                }
            }
        }
        Some("digit") => match generate_digit(id).await {
            Ok(obj) => {
                expires_at = obj.expires_at;
                shortened_code = obj.code;
            }
            Err(error) => {
                if error.status == Some(503) {
                    // All digit codes exhausted — fall back to classic
                    shortened_code = generate_classic(id).await?;
                    actual_type = json!("classic");
                } else {
                    // Delete the inserted URL record and refund the spent credit if we could not generate a code
                    sqlx::query("DELETE FROM urls WHERE id=$1")
                        .bind(inserted_url.id)
                        .execute(&*POOL)
                        .await?;
                    if let Some(user_id) = user_id {
                        refund_user_credit(user_id).await?;
                    }

                    return Err(error);
                }
            }
        },

        _ => return Err(CpeakError::new(400, "Invalid type")),
    }

    res.json(json!({
        "URLId": inserted_url.id,
        "realURL": real_url,
        "linkType": actual_type,
        "code": shortened_code,
        "expiresAt": expires_at.map(to_iso_string),
    }))
}

// Change the type of a url (e.g. from classic to custom). User can do this from the customization modal
pub async fn change_url_type(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    let id: i32 = req.params["id"].parse().unwrap_or(0);
    let new_type = req.body["type"].clone();

    if id == 0 || new_type.is_null() || new_type == "" {
        return res
            .status(400)
            .json(json!({ "message": "Missing parameters" }));
    }

    let cached_code = links_cache::code_of(id).await?;
    let changed = change_url_type_internal(req, res, id, new_type).await;
    // The old code is gone (or, if this failed half way, might be), so it can't stay saved
    links_cache::forget(cached_code).await;

    match changed {
        Ok(()) => Ok(()),
        Err(error) => {
            // rate_limit_url already spent a credit for this, refund it on error
            if let Some(user) = req.get::<IUser>("user") {
                refund_user_credit(user.id).await?;
            }
            Err(error)
        }
    }
}

async fn change_url_type_internal(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
    id: i32,
    new_type: Value,
) -> Result<(), CpeakError> {
    // ------- 1. Clean up the old code ------- //

    // First find the current url type and release the current code
    let current_link = sqlx::query_as::<_, IUrl>("SELECT link_type FROM urls WHERE id=$1")
        .bind(id)
        .fetch_optional(&*POOL)
        .await?;

    let current_type = current_link.map(|link| link.link_type);

    if current_type == Some(LinkType::Ultra) {
        // set the old ultra code as unassigned
        sqlx::query(
            "UPDATE ultra_codes SET assigned_at = NULL, expires_at = NULL, url_id = NULL WHERE url_id = $1",
        )
        .bind(id)
        .execute(&*POOL)
        .await?;
    }

    if current_type == Some(LinkType::Digit) {
        // remove the old digit code from database
        sqlx::query("DELETE FROM digit_codes WHERE url_id = $1")
            .bind(id)
            .execute(&*POOL)
            .await?;
    }

    if (current_type == Some(LinkType::Classic) && new_type != "classic")
        || (current_type == Some(LinkType::Affix) && new_type != "affix")
        || (current_type == Some(LinkType::Custom) && new_type != "custom")
    {
        // set shortened_url_id to null
        sqlx::query("UPDATE urls SET shortened_url_id = NULL WHERE id = $1")
            .bind(id)
            .execute(&*POOL)
            .await?;
    }

    // ------- 2. Generate new code ------- //

    // None is for a code that wasn't in the request (undefined in JavaScript)
    let new_shortened_code: Option<String>;
    let mut expires_at = None;

    match new_type.as_str() {
        Some("classic") => {
            new_shortened_code = Some(generate_classic(id).await?);
        }

        Some("ultra") => {
            if req.get::<IUser>("user").is_none() {
                return Err(CpeakError::new(401, "Unauthorized"));
            }
            {
                let obj = generate_ultra(id).await?;
                expires_at = obj.expires_at;
                new_shortened_code = Some(obj.code);
            }
        }

        Some("digit") => {
            let obj = generate_digit(id).await?;
            expires_at = obj.expires_at;
            new_shortened_code = Some(obj.code);
        }

        Some("affix") => {
            let Some(user) = req.get::<IUser>("user") else {
                return Err(CpeakError::new(401, "Unauthorized"));
            };
            let affix_code = req.body["code"].as_str();

            let Some(code) = affix_code.filter(|code| !code.is_empty()) else {
                return Err(CpeakError::new(400, "No code provided"));
            };
            if !validate_affix_code(code) {
                return Err(CpeakError::new(
                    400,
                    "Affix code must be 1-80 characters and contain only letters, numbers, hyphens, and underscores.",
                ));
            }

            let available = is_affix_available(affix_code, Some(user.id)).await?;
            if !available {
                return Err(CpeakError::new(400, "Code is not available"));
            }

            // Update the url record with the affix code
            let updated =
                sqlx::query("UPDATE urls SET shortened_url_id = $1, link_type = $2 WHERE id = $3")
                    .bind(affix_code)
                    .bind(LinkType::Affix)
                    .bind(id)
                    .execute(&*POOL)
                    .await;
            if let Err(e) = updated {
                if e.as_database_error()
                    .is_some_and(|e| e.is_unique_violation())
                {
                    return Err(CpeakError::new(400, "Code is not available"));
                }
                return Err(e.into());
            }

            new_shortened_code = affix_code.map(String::from);
        }
        Some("custom") => {
            let custom_code = req.body["code"].as_str();

            let Some(code) = custom_code.filter(|code| !code.is_empty()) else {
                return Err(CpeakError::new(400, "No code provided"));
            };
            if !validate_custom_code(code) {
                return Err(CpeakError::new(
                    400,
                    "Custom code must be 7-80 characters, contain only letters, numbers, hyphens, and underscores, and cannot be a reserved word.",
                ));
            }

            let available = is_custom_available(custom_code).await?;
            if !available {
                return Err(CpeakError::new(400, "Code is not available"));
            }

            // Update the url record with the custom code
            let updated =
                sqlx::query("UPDATE urls SET shortened_url_id = $1, link_type = $2 WHERE id = $3")
                    .bind(custom_code)
                    .bind(LinkType::Custom)
                    .bind(id)
                    .execute(&*POOL)
                    .await;
            if let Err(e) = updated {
                if e.as_database_error()
                    .is_some_and(|e| e.is_unique_violation())
                {
                    return Err(CpeakError::new(400, "Code is not available"));
                }
                return Err(e.into());
            }

            new_shortened_code = custom_code.map(String::from);
        }

        _ => return Err(CpeakError::new(400, "Invalid type")),
    }

    let types_with_expires_at = ["ultra", "digit"];

    let mut body = json!({
        "newType": new_type,
        "expiresAt": if new_type
            .as_str()
            .is_some_and(|new_type| types_with_expires_at.contains(&new_type))
        {
            expires_at.map(to_iso_string)
        } else {
            None
        },
    });
    // (JSON has no undefined, so a code that isn't there is left out, like JSON.stringify() does)
    if let Some(new_shortened_code) = new_shortened_code {
        body["code"] = json!(new_shortened_code);
    }

    res.json(body)
}

// Resolve a processed code (+ username, for affix links) back to its urls record.
// Shared by redirect() and redirectWarningPage() so both use the exact same lookup.
async fn resolve_url_record(
    processed_code: &ProcessedCode,
    username: Option<&str>,
) -> Result<Option<IUrl>, CpeakError> {
    Ok(match processed_code.r#type {
        LinkType::Ultra => {
            sqlx::query_as::<_, IUrl>(
                "
        SELECT urls.real_url, urls.id, urls.link_type
        FROM urls
        JOIN ultra_codes
          ON urls.id = ultra_codes.url_id
        WHERE ultra_codes.code = $1
      ",
            )
            .bind(&processed_code.code)
            .fetch_optional(&*POOL)
            .await?
        }
        LinkType::Classic => {
            // Saved in Redis once it's been visited (see redis/links-cache.rs)
            if links_cache::is_enabled()
                && let Some(url) = links_cache::get(&processed_code.code).await
            {
                return Ok(Some(url));
            }

            let url = sqlx::query_as::<_, IUrl>(
                "SELECT real_url, id, link_type FROM urls WHERE shortened_url_id=$1",
            )
            .bind(&processed_code.code)
            .fetch_optional(&*POOL)
            .await?;

            if links_cache::is_enabled()
                && let Some(url) = &url
            {
                links_cache::set(&processed_code.code, url);
            }
            url
        }
        LinkType::Digit => {
            sqlx::query_as::<_, IUrl>(
                "
        SELECT urls.real_url, urls.id, urls.link_type
        FROM urls
        JOIN digit_codes
          ON urls.id = digit_codes.url_id
        WHERE digit_codes.code = $1
      ",
            )
            .bind(&processed_code.code)
            .fetch_optional(&*POOL)
            .await?
        }
        LinkType::Affix => {
            let Some(username) = username.filter(|username| !username.is_empty()) else {
                return Ok(None);
            };

            sqlx::query_as::<_, IUrl>(
                "
        SELECT urls.real_url, urls.id, urls.link_type
        FROM urls
        JOIN users
          ON urls.user_id = users.id
        JOIN usernames
          ON users.id = usernames.user_id
        WHERE urls.shortened_url_id = $1
          AND usernames.username = $2
      ",
            )
            .bind(&processed_code.code)
            .bind(username)
            .fetch_optional(&*POOL)
            .await?
        }
        LinkType::Qr => {
            sqlx::query_as::<_, IUrl>("SELECT real_url, id FROM urls WHERE qr_code_id=$1")
                .bind(&processed_code.code)
                .fetch_optional(&*POOL)
                .await?
        }
        LinkType::Custom => {
            sqlx::query_as::<_, IUrl>(
                "SELECT real_url, id, link_type FROM urls WHERE shortened_url_id=$1",
            )
            .bind(&processed_code.code)
            .fetch_optional(&*POOL)
            .await?
        }
    })
}

/* @TODO FIX ERROR RETURN IN CPEAK SEND FILE */
// Redirect to the real url
pub async fn redirect(req: &mut CpeakRequest, res: &mut CpeakResponse) -> Result<(), CpeakError> {
    res.set_header("X-Robots-Tag", "noindex");

    let code = req.params.get("id").cloned().unwrap_or_default();

    if code.is_empty() {
        return Err(CpeakError::other("No URL ID provided"));
    }

    let username = req.params.get("username").cloned();
    let processed_code = process_code(&code, username.as_deref(), Some(&req.url));

    let Some(processed_code) = processed_code else {
        return res
            .status(404)
            .send_file(&format!("{PUBLIC_PATH}/404.html"), "text/html")
            .await;
    };

    let url = resolve_url_record(&processed_code, username.as_deref()).await?;

    let Some(url) = url else {
        return res
            .status(404)
            .send_file(&format!("{PUBLIC_PATH}/404.html"), "text/html")
            .await;
    };

    /* Handling the views logic */

    let ip = util::get_client_ip(req);
    let user_agent = req.headers.get("user-agent").cloned().unwrap_or_default();
    let accept_lang = req
        .headers
        .get("accept-language")
        .cloned()
        .unwrap_or_default();
    let referrer = req.headers.get("referer").cloned().unwrap_or_default();

    let fingerprint_source = format!(
        "{}::{user_agent}::{accept_lang}",
        ip.as_deref().unwrap_or("null")
    );
    let visitor_hash = sha256(fingerprint_source);

    let link_type = if processed_code.r#type != LinkType::Qr {
        Some(url.link_type)
    } else {
        None
    };
    let via_qr = processed_code.r#type == LinkType::Qr;

    if KEYS.redis_enabled {
        // Save the view with the hash to redis stream. The janitor will drain the stream every second and save to database in batches.
        // This is to handle high traffic and avoid database overload during peak times.
        push_view(IViewEvent {
            url_id: url.id,
            ip_address: ip,
            user_agent,
            referrer,
            link_type,
            via_qr,
            visitor_hash: hex_encode(visitor_hash),
        });
    } else {
        // We have this in case we want to run the server without Redis, but it should not be the default in production because it can cause performance issues.
        sqlx::query(
            "INSERT INTO views(url_id, ip_address, user_agent, referrer, link_type, via_qr, visitor_hash) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(url.id)
        .bind(ip.map(|ip| ip.parse::<IpAddr>()).transpose()?)
        .bind(user_agent)
        .bind(referrer)
        .bind(link_type)
        .bind(via_qr)
        .bind(visitor_hash.as_slice())
        .execute(&*POOL)
        .await?;
    }

    // REDIRECT_WARNING=false skips the warning page for every link (for the load tests)
    if !KEYS.redirect_warning || is_allowlisted_domain(&url.real_url) {
        res.redirect(&url.real_url)
    } else {
        let mut query_string = form_urlencoded::Serializer::new(String::new());
        query_string
            .append_pair("type", processed_code.r#type.as_str())
            .append_pair("code", &processed_code.code);
        if let Some(username) = username.filter(|username| !username.is_empty()) {
            query_string.append_pair("username", &username);
        }
        res.redirect(&format!("/redirect-warning?{}", query_string.finish()))
    }
}

// Shown before redirecting to a non-whitelisted destination, so visitors can see
// where they're actually being sent before continuing.
pub async fn redirect_warning_page(
    _req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    res.send_file(&format!("{PUBLIC_PATH}/redirect-warning.html"), "text/html")
        .await
}

// Called client-side by redirect-warning.html to fetch the destination it should show
pub async fn redirect_warning_data(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    let r#type = req.query.get("type").cloned().unwrap_or_default();
    let code = req.query.get("code").cloned().unwrap_or_default();
    let username = req.query.get("username").cloned();

    // (a type that isn't one of the link types has no record either)
    let url = match LinkType::parse(&r#type) {
        Some(r#type) if !code.is_empty() => {
            resolve_url_record(&ProcessedCode { r#type, code }, username.as_deref()).await?
        }
        _ => None,
    };

    res.json(json!({ "realUrl": url.map(|url| url.real_url) }))
}

// Delete a url record
pub async fn remove(req: &mut CpeakRequest, res: &mut CpeakResponse) -> Result<(), CpeakError> {
    let id = req.params["id"].parse::<i32>().unwrap_or(0);
    let cached_code = links_cache::code_of(id).await?;

    sqlx::query("DELETE FROM urls WHERE id=$1")
        .bind(id)
        .execute(&*POOL)
        .await?;
    // views has no foreign key to urls (see views.sql), so its views go here
    sqlx::query("DELETE FROM views WHERE url_id=$1")
        .bind(id)
        .execute(&*POOL)
        .await?;

    links_cache::forget(cached_code).await;
    res.json(json!({ "message": "deleted" }))
}

// Generates and sends a QR code
pub async fn send_qr_code(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    const QR_CODE_VERSION: Version = Version::Normal(4); // 33x33 matrix, 50 chars max
    const QR_CODE_ERROR_CORRECTION_LEVEL: EcLevel = EcLevel::H; // L, M, Q, H (L lowest, H highest)

    if req.params.get("id").is_none_or(String::is_empty) {
        return Err(CpeakError::new(400, "No URL ID provided"));
    }

    let download = req.query.get("download").map(String::as_str) == Some("true");
    let r#type = if req.query.get("type").map(String::as_str) == Some("png") {
        "png"
    } else {
        "svg"
    };
    let mut size: u32 = req
        .query
        .get("size")
        .and_then(|size| size.parse().ok())
        .unwrap_or(0); // only for png, valid options are: 256, 512, 1024, 2048

    // Validate size if type is png
    if r#type == "png" {
        let valid_sizes = [256, 512, 1024, 2048];
        if !valid_sizes.contains(&size) {
            size = 512; // default size
        }
    }

    let url = sqlx::query_as::<_, IUrl>("SELECT qr_code_id FROM urls WHERE id=$1")
        .bind(req.params["id"].parse::<i32>().unwrap_or(0))
        .fetch_optional(&*POOL)
        .await?;

    let Some(url) = url else {
        return Err(CpeakError::new(404, "URL not found"));
    };
    let qr_code_id = url.qr_code_id.as_deref().unwrap_or("null");

    let data = format!("{}/q/{qr_code_id}", KEYS.domain);

    // This header is needed to trigger a browser download
    if download {
        res.set_header(
            "Content-Disposition",
            format!("attachment; filename=\"{qr_code_id}.{}\"", r#type),
        );
    }

    // The link goes in as plain bytes, which is what the qrcode package of npm does with one too.
    // QrCode::with_version() packs it in its own way, and then our longest links don't fit.
    let mut bits = Bits::new(QR_CODE_VERSION);
    bits.push_byte_data(data.as_bytes())?;
    bits.push_terminator(QR_CODE_ERROR_CORRECTION_LEVEL)?;
    let code = QrCode::with_bits(bits, QR_CODE_ERROR_CORRECTION_LEVEL)?;

    if r#type == "svg" {
        // No white margin around the code. And bigger than the modal that shows it, so it fills
        // it (the front end only limits its width).
        let svg = code
            .render::<svg::Color>()
            .quiet_zone(false)
            .min_dimensions(2048, 2048)
            .build();

        // The compression middleware of the Node.js version compresses what res.end() sends.
        // Here that is res.compress(), which also sets the Content-Type.
        res.compress("image/svg+xml", svg, None).await
    } else {
        res.set_header("Content-Type", "image/png");

        // A pixel for every module (no white margin), stretched to the size that was asked for
        let image = code
            .render::<Luma<u8>>()
            .quiet_zone(false)
            .module_dimensions(1, 1)
            .build();
        let image = imageops::resize(&image, size, size, FilterType::Nearest);

        let mut png = Vec::new();
        image.write_to(&mut Cursor::new(&mut png), ImageFormat::Png)?;
        res.end(png)
    }
}

// Check to see if an affix code is available
pub async fn check_affix_availability(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    let code = req.params.get("code").cloned().unwrap_or_default();
    let user_id = req.get::<IUser>("user").map(|user| user.id);

    if code.is_empty() {
        return res
            .status(400)
            .json(json!({ "message": "No code provided" }));
    }

    // Check if user has already used this code, that's the only check required

    let available = is_affix_available(Some(&code), user_id).await?;
    res.json(json!({ "available": available }))
}

// Check to see if a custom  code is available
pub async fn check_custom_availability(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    let code = req.params.get("code").cloned().unwrap_or_default();

    if code.is_empty() {
        return res
            .status(400)
            .json(json!({ "message": "No code provided" }));
    }

    let available = is_custom_available(Some(&code)).await?;
    res.json(json!({ "available": available }))
}

// Update the destination URL of an existing shortened link
pub async fn update_real_url(
    req: &mut CpeakRequest,
    res: &mut CpeakResponse,
) -> Result<(), CpeakError> {
    let id: i32 = req.params["id"].parse().unwrap_or(0);
    let new_real_url = req.body["url"].clone();

    if id == 0 || new_real_url.is_null() || new_real_url == "" {
        return Err(CpeakError::new(400, "Missing parameters"));
    }

    let cached_code = links_cache::code_of(id).await?;

    sqlx::query("UPDATE urls SET real_url = $1 WHERE id = $2")
        .bind(new_real_url.as_str())
        .bind(id)
        .execute(&*POOL)
        .await?;

    links_cache::forget(cached_code).await;

    res.json(json!({ "realUrl": new_real_url }))
}

// Return stats for a single shortened link
pub async fn get_stats(req: &mut CpeakRequest, res: &mut CpeakResponse) -> Result<(), CpeakError> {
    let id: i32 = req.params["id"].parse().unwrap_or(0);

    if id == 0 {
        return Err(CpeakError::new(400, "Missing parameters"));
    }

    #[derive(Default, FromRow)]
    struct Row {
        total: i64,
        unique_visitors: i64,
        qr_clicks: i64,
        last_clicked: Option<DateTime<Utc>>,
    }

    let row = sqlx::query_as::<_, Row>(
        "SELECT
      COUNT(*) AS total,
      COUNT(DISTINCT visitor_hash) AS unique_visitors,
      COUNT(*) FILTER (WHERE via_qr = true) AS qr_clicks,
      MAX(created_at) AS last_clicked
    FROM views
    WHERE url_id = $1",
    )
    .bind(id)
    .fetch_optional(&*POOL)
    .await?
    .unwrap_or_default();

    // API.Url.Stats in @weer/common
    let stats = json!({
        "total": row.total,
        "unique_visitors": row.unique_visitors,
        "qr_clicks": row.qr_clicks,
        "last_clicked": row.last_clicked.map(to_iso_string),
    });

    res.json(stats)
}
