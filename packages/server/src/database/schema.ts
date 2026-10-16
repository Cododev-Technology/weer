import fs from "fs";
import path from "path";
import pkg from "pg";
import type { Pool } from "pg";
import keys from "../config/keys.js";
import { LINKS } from "@weer/common";

const databasePath = new URL(
  "../../../server-shared/database/",
  import.meta.url
).pathname;

const read = (relative: string) =>
  fs.readFileSync(path.join(databasePath, relative)).toString();

const TABLES: { drop: string[]; create: string[] } = JSON.parse(
  read("tables.json")
);

// Drop order matters: child tables (with FKs) must be dropped before parents
const DROP_ORDER = TABLES.drop;

// Create order matters: parent tables must exist before children reference them
const CREATE_ORDER = TABLES.create;

// Create the database if it doesn't exist
export async function createDatabase() {
  const adminPool = new pkg.Pool({
    user: keys.dbUser,
    host: keys.dbHost,
    database: "postgres", // default DB
    password: keys.dbPassword,
    port: keys.dbPort,
    ssl:
      process.env.NODE_ENV_DB === "production"
        ? {
            rejectUnauthorized: false,
          }
        : false,
  });

  const result = await adminPool.query(
    `
    SELECT 1 FROM pg_database WHERE datname = $1
  `,
    [keys.dbDatabase],
  );

  if (result.rowCount === 0) {
    await adminPool.query(`CREATE DATABASE ${keys.dbDatabase};`);
    console.log(`[postgres] created database: ${keys.dbDatabase}`);
  }

  await adminPool.end();
}

// Drop all tables, recreate them, and set up triggers
export async function applySchema(
  pool: Pool,
  opts: { verbose?: boolean } = {},
) {
  const log = opts.verbose ? console.log : () => {};

  log("\nDropping the tables...");
  for (const name of DROP_ORDER) {
    if (name === "link_type_enum") {
      // this is a TYPE, not a table
      await pool.query(`DROP TYPE IF EXISTS link_type_enum`);
    } else {
      await pool.query(`DROP TABLE IF EXISTS ${name} CASCADE`);
    }
    log(`[postgres] ${name} was dropped.`);
  }

  log("\nCreating the tables...");
  for (const name of CREATE_ORDER) {
    await pool.query(read(`tables/${name}.sql`));
    log(`[postgres] ${name} table was created successfully.`);
  }

  log("\nSetting up the triggers...");
  await pool.query(read("triggers.sql"));
  log("[postgres] triggers were fired up successfully.");
}

// ----------------------------------
//     POPULATING ULTRA CODES TABLE
// ----------------------------------

// Seed the ultra_codes table with all 1 and 2-character codes.
// Note: digit_codes are generated on-demand (not pre-seeded).
export async function seedCodes(pool: Pool, opts: { verbose?: boolean } = {}) {
  const log = opts.verbose ? console.log : () => {};
  const letters = LINKS.ultra.characters;

  log("\nAdding ultra codes...");

  // Insert all 1-character codes
  await pool.query(
    `
    INSERT INTO ultra_codes (code)
    SELECT substr($1, g, 1)
    FROM generate_series(1, length($1)) AS g;
  `,
    [letters],
  );

  // Insert all 2-character codes
  await pool.query(
    `
    INSERT INTO ultra_codes (code)
    SELECT substr($1, g1, 1) || substr($1, g2, 1)
    FROM generate_series(1, length($1)) AS g1,
         generate_series(1, length($1)) AS g2;
  `,
    [letters],
  );

  log(
    `[postgres] ${
      (await pool.query("SELECT COUNT(*) FROM ultra_codes")).rows[0].count
    } records (${letters.length} one-character & ${
      letters.length * letters.length
    } two-character ultra codes) were added to the database.`,
  );
}

// Truncate all transactional tables and free any claimed ultra codes.
// Used in tests to reset state between runs.
// Note: digit_codes rows are simply removed (they're generated on-demand).
// Note: ultra_codes rows are preserved but freed (url_id reset to NULL).
export async function truncateAll(pool: Pool) {
  await pool.query(
    `TRUNCATE views, digit_codes, ultra_codes, urls, sessions, usernames, rate_limits, email_rate_limits, login_rate_limits, email_codes, tokens, users RESTART IDENTITY`,
  );
  // ultra_codes is pre-seeded reference data — restore it after truncation
  await seedCodes(pool);
}