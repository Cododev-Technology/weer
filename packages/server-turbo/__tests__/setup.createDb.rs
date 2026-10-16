use server_turbo::database::schema::create_database;

pub async fn create_db() {
    let db_name = std::env::var("DB_DATABASE").unwrap_or_default();

    if db_name != "weer_test" {
        eprintln!(
            "[setup] Tests must run with DB_DATABASE=weer_test (got: \"{db_name}\"). Use: yarn test"
        );
        std::process::exit(1);
    }

    create_database().await.unwrap();
}
