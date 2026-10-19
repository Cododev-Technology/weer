/**
 * The views in the Redis cluster (REDIS_CLUSTER=true) are spread over many streams. One thread
 * saves about 229,000 views/s, most of its time going to building the INSERTs, and the server makes
 * about twice that at its peak. So here the drain loops run on worker threads, like the ones of
 * server-turbo's janitor run on all the threads of its runtime. Each thread gets some of the
 * streams and its share of DB_POOL_SIZE, so the janitor still uses DB_POOL_SIZE connections in all.
 *
 * Each thread runs this file too, and drains the streams it got (at the bottom).
 */

import os from "node:os";
import { Worker, isMainThread, workerData } from "node:worker_threads";
import { VIEWS_STREAM_KEYS } from "../redis/views-stream.js";
import keys from "../config/keys.js";
import { runDrainLoop } from "./views.js";

export const startDrainThreads = () => {
  const threads = Math.max(
    1,
    Math.min(os.availableParallelism(), VIEWS_STREAM_KEYS.length, keys.dbPoolSize)
  );
  const poolSize = Math.max(1, Math.floor(keys.dbPoolSize / threads));

  // From the TypeScript (tsx, in development) a thread needs tsx-worker.mjs to load this file
  const start = import.meta.url.endsWith(".ts")
    ? new URL("./tsx-worker.mjs", import.meta.url)
    : new URL(import.meta.url);

  for (let thread = 0; thread < threads; thread++) {
    const streams = VIEWS_STREAM_KEYS.filter((_, i) => i % threads === thread);
    const worker = new Worker(start, {
      workerData: { streams, entry: import.meta.url },
      env: { ...process.env, DB_POOL_SIZE: String(poolSize) },
    });

    // An error that nothing catches stops the janitor, and the process manager starts it again
    worker.on("error", (err) => {
      console.error("[janitor] a drain thread failed:", err);
      process.exit(1);
    });
  }
  console.log(
    `[janitor] draining ${VIEWS_STREAM_KEYS.length} streams on ${threads} threads`
  );
};

// On a drain thread: one drain loop for each of the streams this thread got
if (!isMainThread) {
  for (const key of workerData.streams as string[]) runDrainLoop(key);
}
