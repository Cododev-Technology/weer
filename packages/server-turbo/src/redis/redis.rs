use std::sync::LazyLock;

use redis::aio::{ConnectionManager, ConnectionManagerConfig};

use crate::config::keys::KEYS;

// The client of the redis crate that connects again by itself when the connection is lost.
// It's only there when REDIS is true. A command is sent like this:
//   redis::cmd("XLEN").arg(key).query_async::<u64>(&mut REDIS.clone()).await
pub static REDIS: LazyLock<ConnectionManager> = LazyLock::new(|| {
    let client = redis::Client::open(KEYS.redis_url.as_str())
        .unwrap_or_else(|error| panic!("REDIS_URL is not the URL of a Redis server: {error}"));
    // A command can take as long as it needs, like XREADGROUP that waits for new messages
    let config = ConnectionManagerConfig::new().set_response_timeout(None);

    // The connection lives on the event loop that this runs on, so it has to be made in async
    // code (see app.rs)
    let redis = ConnectionManager::new_lazy_with_config(client, config)
        .unwrap_or_else(|error| panic!("Failed to set up Redis: {error}"));

    let mut connection = redis.clone();
    cpeak::spawn(async move {
        match redis::cmd("PING")
            .query_async::<String>(&mut connection)
            .await
        {
            Ok(_) => println!("[redis] connected successfully"),
            Err(err) => eprintln!("[redis] connection error: {err}"),
        }
    });

    redis
});
