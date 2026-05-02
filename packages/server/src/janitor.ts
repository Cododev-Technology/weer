/**
 * This code will run in a separate process to clean up expired codes and perform other maintenance tasks.
 * Our main app will run in cluster mode on many servers. But only one instance of janitor should be running at any time.
 */

import { DB, pool } from "./database/index.js";
import { redis } from "./redis/redis.js";
import { VIEWS_STREAM_KEY } from "./redis/views-stream.js";
import keys from "./config/keys.js";

// Set node process name to node-janitor for easier identification in logs and process managers
process.title = "node-janitor";

// ─── Expired digit codes clean up ─────────────────────────────────────────────

const cleanUpExpiredDigitCode = async () => {
  const result = await DB.query(
    `DELETE FROM digit_codes WHERE expires_at < NOW();`
  );

  if (result.rowCount > 0)
    console.log(`[janitor] cleaned up ${result.rowCount} expired digit codes.`);
};

setInterval(
  () => {
    cleanUpExpiredDigitCode();
  },
  5 * 60 * 1000
); // 5 minutes in milliseconds

// Initial cleanup on startup
cleanUpExpiredDigitCode();

/** @todo handle expired usernames, run once per day */

// ─── Views consumer ───────────────────────────────────────────────────────────

const GROUP_NAME = "views_consumer";
const CONSUMER_NAME = "janitor";
const BATCH_SIZE = 500;
let consecutiveErrors = 0;

// Parse the flat field-value array from a Redis stream entry into an object
const parseStreamFields = (fields: string[]): Record<string, string> => {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
};

// Create the consumer group once on startup. MKSTREAM creates the stream if it doesn't exist yet
const createViewsGroup = async () => {
  try {
    await redis.xgroup("CREATE", VIEWS_STREAM_KEY, GROUP_NAME, "0", "MKSTREAM");
    console.log("[views-consumer] consumer group created");
  } catch (err: any) {
    // BUSYGROUP means the group already exists which is fine
    if (!err.message?.includes("BUSYGROUP")) {
      console.error(
        "[views-consumer] failed to create consumer group:",
        err.message
      );
    }
  }
};

const drainViewsOnce = async (): Promise<void> => {
  try {
    const results = (await (redis as any).xreadgroup(
      "GROUP",
      GROUP_NAME,
      CONSUMER_NAME,
      "COUNT",
      BATCH_SIZE,
      "BLOCK",
      0,
      "STREAMS",
      VIEWS_STREAM_KEY,
      ">" // means give me the next messages that have never been delivered to any other consumer in this group
    )) as Array<[string, Array<[string, string[]]>]> | null;

    if (!results || !results.length) return;
    const entries = results?.[0]?.[1];
    if (!entries || !entries.length) return;

    const ids: string[] = [];
    const values: (string | number | boolean | null)[] = [];

    for (const [id, fields] of entries) {
      ids.push(id);
      const entry = parseStreamFields(fields);
      values.push(
        Number(entry.url_id),
        entry.user_agent ?? "",
        entry.referrer ?? "",
        entry.link_type || null,
        entry.via_qr === "1",
        entry.visitor_hash
      );
    }

    const rowCount = ids.length;

    const COLUMNS = [
      "url_id",
      "user_agent",
      "referrer",
      "link_type",
      "via_qr",
      "visitor_hash",
    ];

    // placeholders should look like ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12), ...
    const placeholders = Array.from({ length: ids.length }, (_, i) => {
      const offset = i * COLUMNS.length;
      const row = COLUMNS.map((_, j) => `$${offset + j + 1}`);
      return `(${row.join(", ")})`;
    }).join(", ");

    await pool.query(
      `INSERT INTO views (${COLUMNS.join(", ")}) VALUES ${placeholders}`,
      values
    );

    // This tells Redis that the janitor has successfully processed the messages
    await redis.xack(VIEWS_STREAM_KEY, GROUP_NAME, ...ids);

    consecutiveErrors = 0;
    // console.log(`[views-consumer] inserted ${rowCount} views`);
  } catch (err: any) {
    consecutiveErrors++;
    const delay = Math.min(1000 * 2 ** consecutiveErrors, 30_000);
    console.error(
      `[views-consumer] drain failed (retry in ${delay}ms):`,
      err.message
    );
    await new Promise((res) => setTimeout(res, delay));
  }
};

const clearPendingOnStartup = async () => {
  let cleared = 0;
  while (true) {
    const results = (await (redis as any).xreadgroup(
      "GROUP",
      GROUP_NAME,
      CONSUMER_NAME,
      "COUNT",
      BATCH_SIZE,
      "STREAMS",
      VIEWS_STREAM_KEY,
      "0"
    )) as Array<[string, Array<[string, string[]]>]> | null;

    const entries = results?.[0]?.[1];
    if (!entries?.length) break;

    const ids = entries.map(([id]) => id);
    await redis.xack(VIEWS_STREAM_KEY, GROUP_NAME, ...ids);
    cleared += ids.length;
  }

  if (cleared > 0)
    console.warn(
      `[janitor] Discarded ${cleared} pending records from previous run.`
    );
};

// Drain continuously when there's data; sleep briefly when idle to avoid busy-waiting
const runDrainLoop = async () => {
  await redis.client("SETNAME", "janitor");
  await createViewsGroup();

  // At this point we just get rid of the pending items. If we want 100% data integrity, we can implement a recovery mechanism that
  // fetches and processes the pending messages before starting the normal drain loop. In that case, we should handle the nil cases because of MAX_LEN.
  // We should also add a new column to the views table to store the Redis stream ID to avoid duplicates during recovery.
  await clearPendingOnStartup();

  while (true) {
    await drainViewsOnce();

    // We can sleep here to reduce the CPU load of this process when receiving lots of views.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

process.on("SIGTERM", async () => {
  await pool.end();
  if (keys.redisEnabled) await redis.quit();
  process.exit(0);
});

if (keys.redisEnabled) {
  runDrainLoop();
}
