use server_turbo::database::index::POOL;
use server_turbo::database::schema::{apply_schema, seed_codes};

pub async fn root() {
    apply_schema(&POOL, None).await.unwrap();
    seed_codes(&POOL, None).await.unwrap();
}
