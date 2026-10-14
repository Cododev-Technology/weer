use std::fs;
use std::path::Path;

use cpeak::CpeakError;
use sqlx::{AssertSqlSafe, PgPool};

use super::index::new_pool;
use crate::config::keys::KEYS;
use crate::lib::link_definitions::LINKS;

const DATABASE_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/database");

fn read(relative: &str) -> Result<String, CpeakError> {
    fs::read_to_string(Path::new(DATABASE_PATH).join(relative))
        .map_err(|error| CpeakError::other(format!("{relative}: {error}")))
}

// Drop order matters: child tables (with FKs) must be dropped before parents
const DROP_ORDER: [&str; 9] = [
    "views",
    "digit_codes",
    "ultra_codes",
    "urls",
    "link_type_enum", // this is a TYPE, not a table
    "usernames",
    "sessions",
    "rate_limits",
    "users",
];

// Create order matters: parent tables must exist before children reference them
const CREATE_ORDER: [(&str, &str); 8] = [
    ("users", "tables/users.sql"),
    ("sessions", "tables/sessions.sql"),
    ("urls", "tables/urls.sql"),
    ("ultra_codes", "tables/ultra_codes.sql"),
    ("digit_codes", "tables/digit_codes.sql"),
    ("views", "tables/views.sql"),
    ("usernames", "tables/usernames.sql"),
    ("rate_limits", "tables/rate_limits.sql"),
];

#[derive(Debug, Clone, Copy, Default)]
pub struct Opts {
    pub verbose: bool,
}

// Create the database if it doesn't exist
pub async fn create_database() -> Result<(), CpeakError> {
    let admin_pool = new_pool(
        "postgres", // default DB
        std::env::var("NODE_ENV_DB").as_deref() == Ok("production"),
    );

    let result = sqlx::query(
        "
    SELECT 1 FROM pg_database WHERE datname = $1
  ",
    )
    .bind(&KEYS.db_database)
    .execute(&admin_pool)
    .await?;

    if result.rows_affected() == 0 {
        // (a query that we put together ourselves has to be marked as safe for sqlx to run it)
        sqlx::query(AssertSqlSafe(format!(
            "CREATE DATABASE {};",
            KEYS.db_database
        )))
        .execute(&admin_pool)
        .await?;
        println!("[postgres] created database: {}", KEYS.db_database);
    }

    admin_pool.close().await;
    Ok(())
}

// Drop all tables, recreate them, and set up triggers
pub async fn apply_schema(pool: &PgPool, opts: impl Into<Option<Opts>>) -> Result<(), CpeakError> {
    let opts = opts.into().unwrap_or_default();
    let log = |message: &str| {
        if opts.verbose {
            println!("{message}");
        }
    };

    log("\nDropping the tables...");
    for name in DROP_ORDER {
        if name == "link_type_enum" {
            sqlx::query("DROP TYPE IF EXISTS link_type_enum")
                .execute(pool)
                .await?;
        } else {
            sqlx::query(AssertSqlSafe(format!(
                "DROP TABLE IF EXISTS {name} CASCADE"
            )))
            .execute(pool)
            .await?;
        }
        log(&format!("[postgres] {name} was dropped."));
    }

    log("\nCreating the tables...");
    for (name, file) in CREATE_ORDER {
        // A file is more than one statement, and those go through raw_sql()
        sqlx::raw_sql(AssertSqlSafe(read(file)?))
            .execute(pool)
            .await?;
        log(&format!(
            "[postgres] {name} table was created successfully."
        ));
    }

    log("\nSetting up the triggers...");
    sqlx::raw_sql(AssertSqlSafe(read("triggers.sql")?))
        .execute(pool)
        .await?;
    log("[postgres] triggers were fired up successfully.");

    Ok(())
}

// ----------------------------------
//     POPULATING ULTRA CODES TABLE
// ----------------------------------

// Seed the ultra_codes table with all 1 and 2-character codes.
// Note: digit_codes are generated on-demand (not pre-seeded).
pub async fn seed_codes(pool: &PgPool, opts: impl Into<Option<Opts>>) -> Result<(), CpeakError> {
    let opts = opts.into().unwrap_or_default();
    let log = |message: &str| {
        if opts.verbose {
            println!("{message}");
        }
    };
    let letters = LINKS.ultra.characters;

    log("\nAdding ultra codes...");

    // Insert all 1-character codes
    sqlx::query(
        "
    INSERT INTO ultra_codes (code)
    SELECT substr($1, g, 1)
    FROM generate_series(1, length($1)) AS g;
  ",
    )
    .bind(letters)
    .execute(pool)
    .await?;

    // Insert all 2-character codes
    sqlx::query(
        "
    INSERT INTO ultra_codes (code)
    SELECT substr($1, g1, 1) || substr($1, g2, 1)
    FROM generate_series(1, length($1)) AS g1,
         generate_series(1, length($1)) AS g2;
  ",
    )
    .bind(letters)
    .execute(pool)
    .await?;

    log(&format!(
        "[postgres] {} records ({} one-character & {} two-character ultra codes) were added to the database.",
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM ultra_codes")
            .fetch_one(pool)
            .await?,
        letters.len(),
        letters.len() * letters.len()
    ));

    Ok(())
}

// Truncate all transactional tables and free any claimed ultra codes.
// Used in tests to reset state between runs.
// Note: digit_codes rows are simply removed (they're generated on-demand).
// Note: ultra_codes rows are preserved but freed (url_id reset to NULL).
pub async fn truncate_all(pool: &PgPool) -> Result<(), CpeakError> {
    sqlx::query(
        "TRUNCATE views, digit_codes, ultra_codes, urls, sessions, usernames, rate_limits, users RESTART IDENTITY",
    )
    .execute(pool)
    .await?;
    // ultra_codes is pre-seeded reference data — restore it after truncation
    seed_codes(pool, None).await
}
