use std::sync::LazyLock;
use std::time::Duration;

use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgSslMode};

use crate::config::keys::KEYS;

/*
 * @important Run the seed file first to get our tables and triggers
 */

// Connect to the postgres database
pub static POOL: LazyLock<PgPool> = LazyLock::new(|| {
    let pool = new_pool(
        &KEYS.db_database,
        std::env::var("NODE_ENV").as_deref() == Ok("production"),
    );

    cpeak::spawn(async {
        match sqlx::query("SELECT NOW()").execute(&*POOL).await {
            Err(err) => {
                eprintln!("[postgres] connection failed.");
                eprintln!("Error details:\n {err:?}");
                std::process::exit(1);
            }
            Ok(_) => {
                println!("[postgres] connected successfully to {}", KEYS.db_database);
            }
        }
    });

    pool
});

/* Uncomment for debugging connection pool stats:
// Log database pool stats every 5 seconds for monitoring
cpeak::spawn(async {
    loop {
        cpeak::sleep(std::time::Duration::from_millis(5000)).await;
        println!(
            "[Process {}] DB Stats: {}",
            std::process::id(),
            json!({
                "total": POOL.size(), // total connections existing in this pool
                "idle": POOL.num_idle(), // connections waiting for work
            })
        );
    }
});
*/

// new pg.Pool({ ... }), with the pool of sqlx. With ssl, the connection is encrypted and any
// certificate of the server is accepted (rejectUnauthorized: false).
//
// sqlx starts closing the idle connections right away, so a pool has to be made in async code.
pub fn new_pool(database: &str, ssl: bool) -> PgPool {
    let options = PgConnectOptions::new()
        .username(&KEYS.db_user)
        .host(&KEYS.db_host)
        .database(database)
        .password(&KEYS.db_password)
        .port(KEYS.db_port)
        .ssl_mode(if ssl {
            PgSslMode::Require
        } else {
            PgSslMode::Disable
        });

    PgPoolOptions::new()
        .max_connections(KEYS.db_pool_size) // this means how many concurrent connections to the database this process can have (DB_POOL_SIZE, 10 by default)
        .idle_timeout(Duration::from_millis(10000)) // close idle clients after 10 seconds
        // Without this, sqlx asks PostgreSQL if a connection still works every time before using it
        .test_before_acquire(false)
        .connect_lazy_with(options)
}
