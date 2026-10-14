use cpeak::{CpeakError, CpeakRequest, CpeakResponse, Next};
use url::{Host, Url};

use crate::database::index::POOL;
use crate::database::types::{ISession, IUrl, IUser};
use crate::lib::domain_allowlist::is_allowlisted_domain;
use crate::lib::rate_limit::enforce_rate_limit;
use crate::lib::web_risk::is_url_malicious;

pub async fn is_valid_url(
    req: &mut CpeakRequest,
    _res: &mut CpeakResponse,
    next: Next,
) -> Result<(), CpeakError> {
    let body = &req.body;
    let url = &body["url"];

    if url.is_null() || url == "" {
        return Err(CpeakError::new(400, "Please first put your URL here."));
    }

    // Function to validate url
    let valid_url = |str: &str| -> bool {
        // No white space or control characters (the URL parser would skip some of them)
        if str.contains(|c: char| c.is_whitespace() || c.is_control()) {
            return false;
        }

        let Ok(url) = Url::parse(str) else {
            return false;
        };

        // http://, https:// or ftp:// at the start
        if !matches!(url.scheme(), "http" | "https" | "ftp")
            || !str[url.scheme().len()..].starts_with("://")
        {
            return false;
        }

        match url.host() {
            // An IP address, but not one of a private network or of this machine
            Some(Host::Ipv4(ip)) => {
                let [first, .., last] = ip.octets();

                (1..=223).contains(&first)
                    && (1..=254).contains(&last)
                    && !ip.is_private()
                    && !ip.is_loopback()
                    && !ip.is_link_local()
            }
            // A domain: letters, digits and hyphens between its dots, and a TLD at the end
            // (a TLD that is not in English is written as xn--..., like xn--p1ai for рф)
            Some(Host::Domain(domain)) => {
                let labels: Vec<&str> = domain.split('.').collect();
                let tld = labels[labels.len() - 1];

                labels.len() > 1
                    && labels.iter().all(|label| {
                        !label.is_empty()
                            && !label.starts_with('-')
                            && !label.ends_with('-')
                            && label
                                .bytes()
                                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                    })
                    && (tld.starts_with("xn--")
                        || (tld.len() > 1 && tld.bytes().all(|byte| byte.is_ascii_alphabetic())))
            }
            _ => false,
        }
    };

    // (only a string can be a URL)
    if url.as_str().is_some_and(valid_url) {
        next()
    } else {
        Err(CpeakError::new(400, "The URL you put is not valid."))
    }
}

pub async fn check_url_ownership(
    req: &mut CpeakRequest,
    _res: &mut CpeakResponse,
    next: Next,
) -> Result<(), CpeakError> {
    let url_id: i32 = req.params["id"].parse().unwrap_or(0);

    // Only digits, and not more than a PostgreSQL integer can hold
    if url_id == 0 || !req.params["id"].bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(CpeakError::new(400, "Invalid URL ID."));
    }

    let url = sqlx::query_as::<_, IUrl>("SELECT user_id, session_id FROM urls WHERE id=$1")
        .bind(url_id)
        .fetch_optional(&*POOL)
        .await?;

    match req.get::<IUser>("user") {
        None => {
            // ($1::bpchar: session_token is a CHAR column, and sqlx sends a String as text.
            // PostgreSQL can only use the index of the column for a value of its own type.)
            let session = sqlx::query_as::<_, ISession>(
                "SELECT id FROM sessions WHERE session_token=$1::bpchar",
            )
            .bind(session_token(req))
            .fetch_optional(&*POOL)
            .await?;

            // A link that has no session (it belongs to a user) is never the link of a visitor
            // without a session, even though both sides are "nothing" here
            if let (Some(url), Some(session)) = (&url, &session)
                && url.session_id == Some(session.id)
            {
                return next();
            }
        }
        Some(user) => {
            if let Some(url) = &url
                && url.user_id == Some(user.id)
            {
                return next();
            }
        }
    }

    Err(CpeakError::new(403, "Not allowed to access."))
}

pub async fn require_auth(
    req: &mut CpeakRequest,
    _res: &mut CpeakResponse,
    next: Next,
) -> Result<(), CpeakError> {
    if req.get::<IUser>("user").is_none() {
        return Err(CpeakError::new(401, "Unauthorized"));
    }
    next()
}

pub async fn check_url_safety(
    req: &mut CpeakRequest,
    _res: &mut CpeakResponse,
    next: Next,
) -> Result<(), CpeakError> {
    let url = req.body["url"].as_str().unwrap_or("");

    if !is_allowlisted_domain(url) && is_url_malicious(url).await {
        return Err(CpeakError::new(
            400,
            "This URL has been flagged as unsafe and cannot be shortened.",
        ));
    }

    next()
}

pub async fn rate_limit_url(
    req: &mut CpeakRequest,
    _res: &mut CpeakResponse,
    next: Next,
) -> Result<(), CpeakError> {
    enforce_rate_limit(req).await?;
    next()
}

// `req.signedCookies?.session_token || null`: the session token of the visitor, if the
// cookie is there and it's really one of ours
pub fn session_token(req: &CpeakRequest) -> Option<String> {
    req.signed_cookies
        .get("session_token")
        .cloned()
        .flatten()
        .filter(|session_token| !session_token.is_empty())
}
