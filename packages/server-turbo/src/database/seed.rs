use std::fs;
use std::io;
use std::path::Path;

use cpeak::CpeakError;

use server_turbo::config::keys::KEYS;
use server_turbo::database::index::new_pool;
use server_turbo::database::schema::{Opts, apply_schema, create_database, seed_codes};
use server_turbo::redis::redis::connection;

const DATABASE_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/database");

fn main() {
    // Rust has no top-level await, so the seed runs in cpeak::run()
    if let Err(err) = cpeak::run(seed()) {
        eprintln!("{err:?}");
        std::process::exit(1);
    }
}

async fn seed() -> Result<(), CpeakError> {
    // Create the database if it doesn't exist
    create_database().await?;

    let pool = new_pool(
        &KEYS.db_database,
        std::env::var("NODE_ENV_DB").as_deref() == Ok("production"),
    );

    // Test the database connection
    match pool.acquire().await {
        Ok(client) => {
            println!("[postgres] connected to database: {}", KEYS.db_database);
            drop(client);
        }
        Err(err) => {
            eprintln!("[postgres] database connection failed: {err:?}");
            std::process::exit(1);
        }
    }

    // Create triggers and tables
    if let Err(err) = apply_schema(&pool, Opts { verbose: true }).await {
        eprintln!("{err:?}");
    }

    // ----------------------------------
    //     POPULATING ULTRA CODES TABLE
    // ----------------------------------
    seed_codes(&pool, Opts { verbose: true }).await?;

    // Now flush redis to clear any existing data in case the same database is being reused.
    // Only do this if Redis is enabled. (In a cluster, FLUSHDB goes to every master node.)
    let flushing = KEYS.redis_enabled.then(|| {
        cpeak::spawn(async {
            match redis::cmd("FLUSHDB")
                .query_async::<String>(&mut connection())
                .await
            {
                Ok(_) => {
                    println!("\n[redis] flushed the database.");
                    // (the redis connection ends with the program)
                }
                Err(err) => {
                    eprintln!("[redis] failed to flush the database: {err}");
                }
            }
        })
    });

    // Delete packages/stressor/codes.txt
    let stressor_codes_path = Path::new(DATABASE_PATH).join("../../../stressor/codes.txt");
    match fs::remove_file(&stressor_codes_path) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => {
            eprintln!("[stressor] failed to delete codes.txt. Please delete it manually. {err:?}");
        }
        _ => {
            println!("\n[stressor] deleted codes.txt.");
        }
    }

    // Node.js keeps a program going until everything it started is done. Rust stops when main
    // returns, so we wait for Redis here.
    if let Some(flushing) = flushing {
        let _ = flushing.await;
    }

    Ok(())
}

// -----------------------
//     ADDING USERS
// -----------------------

// (async () => {
//   // Password of all the users will be simply 'string'
//   const hashedPassword = await bcrypt.hash("string", 10);

//   console.log("\nAdding some users data...");

//   pool.query(
//     `
//   INSERT INTO users (name, username, email, password, verified)
//   VALUES
//   ('Joseph H.', 'joseph', 'agile.8272@gmail.com', '${hashedPassword}', true),
//   ('Rogers Brown', 'rgGamer', 'pokhraph@gmail.com', '${hashedPassword}', true),
//   ('David Miller', 'davidChef', 'antwonders@gmail.com', '${hashedPassword}', true)
//   `,
//     (err, res) => {
//       if (err) return console.log(err);
//       console.log(
//         "[postgres] 3 users were added to the database with the password 'string'."
//       );

//       // pool.end();
//     }
//   );
// })();
