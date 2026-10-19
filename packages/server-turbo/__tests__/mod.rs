// The tests of the app. This file is to cargo what .mocharc.cjs is to mocha in the Node.js
// version: it lists the test files, and the setup files that run before them.
//
// Run all of them with `yarn test`, or the ones of a single file with `yarn test url_test`.

mod helpers {
    pub mod factories {
        pub mod auth;
        pub mod url;
        pub mod user;
    }
    pub mod assert;
    pub mod logs;
    pub mod paddle;
    pub mod supertest;
    pub mod target;
    pub mod views;
}

#[path = "setup.createDb.rs"]
mod setup_create_db;
#[path = "setup.eachTest.rs"]
mod setup_each_test;
#[path = "setup.root.rs"]
mod setup_root;

#[path = "auth.test.rs"]
mod auth_test;
#[path = "customization.test.rs"]
mod customization_test;
#[path = "logs.test.rs"]
mod logs_test;
#[path = "middleware.test.rs"]
mod middleware_test;
#[path = "pages.test.rs"]
mod pages_test;
#[path = "payments.test.rs"]
mod payments_test;
#[path = "qr.test.rs"]
mod qr_test;
#[path = "rate-limit.test.rs"]
mod rate_limit_test;
#[path = "redirect.test.rs"]
mod redirect_test;
#[path = "shorten.test.rs"]
mod shorten_test;
#[path = "stats.test.rs"]
mod stats_test;
#[path = "url.test.rs"]
mod url_test;
#[path = "urls.test.rs"]
mod urls_test;
#[path = "user.test.rs"]
mod user_test;
