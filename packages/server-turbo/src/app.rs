use std::sync::LazyLock;
use std::time::Instant;

use cpeak::{
    CompressionOptions, CookieParserOptions, Cpeak, CpeakOptions, cookie_parser, json, parse_json,
    serve_static,
};

use crate::config::keys::KEYS;
use crate::database::index::POOL;
use crate::database::types::IUser;
use crate::lib::log::log;
use crate::redis::redis::REDIS;
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
            LazyLock::force(&REDIS);
        }
    });

    let mut app = Cpeak::new(CpeakOptions {
        // What app.beforeEach(compression()) is in the Node.js version
        compression: Some(CompressionOptions::default()),
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

    // Cookie parsing with signed cookie support
    app.before_each(cookie_parser(CookieParserOptions {
        secret: Some(KEYS.cookie_key.clone()),
    }));

    // Restore req.user from signed uid cookie on every request
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
        }
        next()
    });

    // Logging middleware
    app.before_each(async |req, res, next| {
        let request_start = Instant::now();
        // Grab requester ip address
        let ip = match req.headers.get("x-forwarded-for") {
            Some(forwarded) if !forwarded.is_empty() => forwarded.clone(),
            _ => req.remote_address.ip().to_string(),
        };
        let method = req.method.clone();
        let url = req.url.clone();

        // Once the request is finished
        res.on_finish(move |res| {
            // Get req status code and message
            let (status_code, status_message) = (res.status_code, res.status_message);
            // Calculate how much it took the request to finish
            let processing_time = request_start.elapsed().as_millis();

            // Format the log message and send it to log function
            log(format!(
                "{ip} -- {method} {url} {status_code} {status_message} -- response-time: {processing_time} ms"
            ));
        });
        next()
    });

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

    // ------ API Routes ------ //
    api_router(&mut app);

    // Send 404 page for any route nothing else matched
    app.fallback(async |_req, res| {
        res.send_file(&format!("{PUBLIC_PATH}/404.html"), "text/html")
            .await
    });

    // Handle all the errors that could happen in the routes
    app.handle_err(async |error, _req, res| {
        if let Some(status) = error.status.filter(|status| *status != 0) {
            res.status(status).json(json!({ "error": error.message }))
        } else {
            eprintln!("{error:?}");
            log(&error);
            res.status(500).json(json!({
                "error": "Sorry, something unexpected happened from our side.",
            }))
        }
    });

    app
}
