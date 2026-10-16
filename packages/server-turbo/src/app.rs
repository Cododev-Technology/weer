use std::sync::LazyLock;
use std::time::SystemTime;

use chrono::{DateTime, Utc};
use cpeak::{
    AuthOptions, CompressionOptions, CookieParserOptions, Cpeak, CpeakOptions, FindToken,
    LogOptions, LogOutput, RequestLogOptions, RevokeToken, SaveToken, TokenRecord, auth,
    cookie_parser, json, parse_json, serve_static,
};

use crate::config::keys::KEYS;
use crate::database::index::POOL;
use crate::database::types::{IToken, IUser};
use crate::redis::redis::check_connection;
use crate::router::api_router;

// The web and styles packages build into the public folder of the Node.js server, so both servers serve that one
const PUBLIC_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../server/public");

pub fn app() -> Cpeak {
    // In the Node.js version, the database and Redis connect as soon as their files are
    // imported. Importing a file doesn't run anything in Rust, so we get them going here, on
    // the event loop of Cpeak that keeps going between the requests.
    cpeak::spawn(async {
        LazyLock::force(&POOL);
        if KEYS.redis_enabled {
            check_connection().await;
        }
    });

    let mut app = Cpeak::new(CpeakOptions {
        // What app.beforeEach(compression()) is in the Node.js version
        compression: Some(CompressionOptions::default()),
        // A folder for each day in the logs folder: info.log and errors.log
        log: Some(LogOptions {
            output: LogOutput::File(
                concat!(env!("CARGO_MANIFEST_DIR"), "/logs/{day}/info.log").to_string(),
            ),
            errors: LogOutput::File(
                concat!(env!("CARGO_MANIFEST_DIR"), "/logs/{day}/errors.log").to_string(),
            ),
            ..Default::default()
        }),
        ..Default::default()
    });

    // For parsing JSON body
    app.before_each(parse_json(None));

    // app.before_each(helmet());

    app.before_each(serve_static(PUBLIC_PATH, None));

    // For sever side rendering
    // app.before_each(render());

    if KEYS.cookie_key.is_empty() || KEYS.cookie_key.chars().count() < 32 {
        println!(
            "You must set a cookie key in config/keys.rs file and it must be at least 32 characters long."
        );
        std::process::exit(1);
    }

    if KEYS.token_secret.is_empty() || KEYS.token_secret.chars().count() < 32 {
        println!(
            "You must set a token secret in config/keys.rs file and it must be at least 32 characters long."
        );
        std::process::exit(1);
    }

    // Cookie parsing with signed cookie support
    app.before_each(cookie_parser(CookieParserOptions {
        secret: Some(KEYS.cookie_key.clone()),
    }));

    // For authentication
    app.before_each(auth(AuthOptions {
        secret: KEYS.token_secret.clone(),
        token_expiry: 30 * 24 * 60 * 60 * 1000, // 30 days
        save_token: SaveToken::new(async |token_id, user_id, expires_at| {
            sqlx::query("INSERT INTO tokens (id, user_id, expires_at) VALUES ($1, $2, $3)")
                .bind(token_id)
                .bind(user_id.parse::<i32>().unwrap_or_default())
                .bind(DateTime::<Utc>::from(expires_at))
                .execute(&*POOL)
                .await?;
            Ok(())
        }),
        find_token: FindToken::new(async |token_id| {
            let row =
                sqlx::query_as::<_, IToken>("SELECT user_id, expires_at FROM tokens WHERE id = $1")
                    .bind(token_id)
                    .fetch_optional(&*POOL)
                    .await?;
            Ok(row.map(|row| TokenRecord {
                user_id: row.user_id.to_string(),
                expires_at: SystemTime::from(row.expires_at),
            }))
        }),
        revoke_token: Some(RevokeToken::new(async |token_id| {
            sqlx::query("DELETE FROM tokens WHERE id = $1")
                .bind(token_id)
                .execute(&*POOL)
                .await?;
            Ok(())
        })),
        ..Default::default()
    }));

    // Restore req.user from the signed uid cookie (Google OAuth), Falls back to
    // the email/password auth when uid isn't present
    app.before_each(async |req, _res, next| {
        let uid = req.signed_cookies.get("uid").cloned().flatten();
        if let Some(id) = uid.and_then(|uid| uid.parse().ok()) {
            req.set(
                "user",
                IUser {
                    id,
                    ..Default::default()
                },
            );
            return next();
        }

        let token = req
            .signed_cookies
            .get("token")
            .cloned()
            .flatten()
            .filter(|token| !token.is_empty());
        if let Some(token) = token
            && let Some(result) = req.verify_token(&token).await?
        {
            req.set(
                "user",
                IUser {
                    id: result.user_id.parse().unwrap_or_default(),
                    token_id: token.split('.').next().map(String::from),
                    ..Default::default()
                },
            );
        }

        next()
    });

    // Logging middleware (REQUEST_LOG=false turns it off, for the load tests)
    if KEYS.request_log {
        app.before_each(cpeak::log_requests(RequestLogOptions {
            format: "{date} -- {ip} -- {method} {url} {status} {status_message} -- response-time: {ms} ms".to_string(),
            ip_header: Some("x-forwarded-for".to_string()),
            ..Default::default()
        }));
    }

    // Show the home page
    app.route("get", "/", async |_req, res| {
        res.send_file(&format!("{PUBLIC_PATH}/index.html"), "text/html")
            .await
    });

    app.route("get", "/terms", async |_req, res| {
        res.send_file(&format!("{PUBLIC_PATH}/terms.html"), "text/html")
            .await
    });

    app.route("get", "/privacy", async |_req, res| {
        res.send_file(&format!("{PUBLIC_PATH}/privacy.html"), "text/html")
            .await
    });

    app.route("get", "/reset-password", async |_req, res| {
        res.send_file(&format!("{PUBLIC_PATH}/index.html"), "text/html")
            .await
    });

    // ------ API Routes ------ //
    api_router(&mut app);

    // Send 404 page for any route nothing else matched
    app.fallback(async |_req, res| {
        res.status(404)
            .send_file(&format!("{PUBLIC_PATH}/404.html"), "text/html")
            .await
    });

    // Handle all the errors that could happen in the routes
    app.handle_err(async |error, _req, res| {
        if let Some(status) = error.status.filter(|status| *status != 0) {
            res.status(status).json(json!({ "error": error.message }))
        } else {
            eprintln!("{error:?}");
            cpeak::log(&error);
            res.status(500).json(json!({
                "error": "Sorry, something unexpected happened from our side.",
            }))
        }
    });

    app
}
