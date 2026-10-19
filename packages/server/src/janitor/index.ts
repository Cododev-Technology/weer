/**
 * This code will run in a separate process to clean up expired codes and perform other maintenance tasks.
 * Our main app will run in cluster mode on many servers. But only one instance of janitor should be running at any time.
 */

import { DB, pool } from "../database/index.js";
import { redis } from "../redis/redis.js";
import { VIEWS_STREAM_KEYS } from "../redis/views-stream.js";
import keys from "../config/keys.js";
import { runDrainLoop } from "./views.js";

// Set node process name to node-janitor for easier identification in logs and process managers
process.title = "node-janitor";

// ─── Expired digit codes clean up ─────────────────────────────────────────────

const cleanUpExpiredDigitCode = async () => {
  const result = await pool.query(
    `DELETE FROM digit_codes WHERE expires_at < NOW();`
  );

  if (result.rowCount)
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

// ─── Views consumer (see views.ts) ────────────────────────────────────────────

process.on("SIGTERM", async () => {
  await pool.end();
  if (keys.redisEnabled) await redis.quit();
  process.exit(0);
});

if (keys.redisEnabled) {
  if (keys.redisCluster) {
    // Many streams, drained on worker threads (see cluster.ts)
    const { startDrainThreads } = await import("./cluster.js");
    startDrainThreads();
  } else {
    // The single Redis has one stream
    runDrainLoop(VIEWS_STREAM_KEYS[0]);
  }
}
