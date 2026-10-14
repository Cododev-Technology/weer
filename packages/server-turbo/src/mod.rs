// Node.js finds the files of a project through their imports. Rust needs every folder and
// file to be listed as a module, and for this app that is all done here, so the files
// themselves can read like the ones of the Node.js version (packages/server).
//
// index.rs, janitor.rs, precompress.rs and database/seed.rs are not in this list. Those are the programs you
// run (the [[bin]]s in Cargo.toml), and they import everything else from here.
//
// There is no cluster.rs: Cpeak for Rust runs an event loop on every CPU core by itself.

pub mod app;
pub mod middlewares;
pub mod router;

pub mod config {
    pub mod keys;
}

pub mod controllers {
    pub mod auth;
    pub mod url;
    pub mod user;
}

pub mod database {
    pub mod index;
    pub mod schema;
    pub mod types;
}

pub mod lib {
    #[path = "domain-allowlist.rs"]
    pub mod domain_allowlist;
    #[path = "email/index.rs"]
    pub mod email;
    #[path = "email-codes.rs"]
    pub mod email_codes;
    #[path = "google-oauth.rs"]
    pub mod google_oauth;
    #[path = "link-definitions.rs"]
    pub mod link_definitions;
    pub mod links;
    pub mod log;
    #[path = "rate-limit.rs"]
    pub mod rate_limit;
    pub mod util;
    pub mod validation;
    #[path = "web-risk.rs"]
    pub mod web_risk;
}

pub mod redis {
    // (redis/redis.rs, like redis/redis.ts in the Node.js version)
    #[allow(clippy::module_inception)]
    pub mod redis;
    #[path = "views-stream.rs"]
    pub mod views_stream;
}
