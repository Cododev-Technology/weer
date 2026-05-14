import { createDatabase } from "../src/database/schema.js";

const DB_NAME = process.env.DB_DATABASE;

if (!DB_NAME || DB_NAME !== "weer_test") {
  console.error(
    `[setup] Tests must run with DB_DATABASE=weer_test (got: "${DB_NAME}"). ` +
    `Use: yarn test`
  );
  process.exit(1);
}

await createDatabase();