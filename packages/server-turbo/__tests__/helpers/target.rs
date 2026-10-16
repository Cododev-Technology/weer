use std::sync::OnceLock;

// The tests run against the app of this process by default. To run the very same tests against
// a server that is already running (like the Node.js server), set TEST_BASE_URL to its address.
pub fn app() -> &'static str {
    static TARGET: OnceLock<String> = OnceLock::new();

    TARGET.get_or_init(|| match std::env::var("TEST_BASE_URL") {
        Ok(target) => target,
        Err(_) => {
            // Port 0 is any port that is free, which is what supertest listens on too
            let server = server_turbo::app::app().listen(0, || {});
            format!("http://127.0.0.1:{}", server.address().port())
        }
    })
}
