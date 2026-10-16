use std::future::Future;
use std::sync::Mutex;

use server_turbo::config::keys::KEYS;
use server_turbo::database::index::POOL;
use server_turbo::database::schema::truncate_all;
use server_turbo::redis::redis::connection;

async fn before_each() {
    truncate_all(&POOL).await.unwrap();

    // The links saved in Redis belong to the links that were just deleted, and a new link can
    // get the same code (and the same id)
    if KEYS.redis_enabled {
        redis::cmd("FLUSHDB")
            .query_async::<String>(&mut connection())
            .await
            .unwrap();
    }
}

// (the `after` hook of the Node.js version closes the pool and Redis so mocha can stop. cargo
// stops the tests by itself once they are done.)

// What `it("...", async () => { ... })` is in the Node.js version. mocha runs the tests one
// after the other, with the hooks around them. cargo runs them all at once, so each test
// waits here for its turn, and gets the same hooks: the setup files once, and beforeEach.
pub fn test(test: impl Future<Output = ()>) {
    // (what it holds: whether the setup files have run)
    static ONE_AT_A_TIME: Mutex<bool> = Mutex::new(false);

    // A test that failed before this one is no reason for this one to fail too
    let mut set_up = ONE_AT_A_TIME
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    cpeak::run(async {
        if !*set_up {
            crate::setup_create_db::create_db().await;
            crate::setup_root::root().await;
            *set_up = true;
        }

        before_each().await;
        test.await;
    });
}
