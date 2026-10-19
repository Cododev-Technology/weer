// ─── Views consumer ───────────────────────────────────────────────────────────

import { pool } from "../database/index.js";
import { redis } from "../redis/redis.js";

const GROUP_NAME = "views_consumer";
const CONSUMER_NAME = "janitor";
const BATCH_SIZE = 5000;

// Every drain loop has a connection of its own (see runDrainLoop)
type Connection = typeof redis;

// Parse the flat field-value array from a Redis stream entry into an object
const parseStreamFields = (fields: string[]): Record<string, string> => {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
};

// Create the consumer group once on startup. MKSTREAM creates the stream if it doesn't exist yet
const createViewsGroup = async (connection: Connection, key: string) => {
  try {
    await connection.xgroup("CREATE", key, GROUP_NAME, "0", "MKSTREAM");
    console.log(`[views-consumer] consumer group created for ${key}`);
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

const drainViewsOnce = async (
  connection: Connection,
  key: string,
  state: { consecutiveErrors: number }
): Promise<void> => {
  try {
    const results = (await (connection as any).xreadgroup(
      "GROUP",
      GROUP_NAME,
      CONSUMER_NAME,
      "COUNT",
      BATCH_SIZE,
      "BLOCK",
      0,
      "STREAMS",
      key,
      ">" // means give me the next messages that have never been delivered to any other consumer in this group
    )) as Array<[string, Array<[string, string[]]>]> | null;

    if (!results || !results.length) return;
    const entries = results?.[0]?.[1];
    if (!entries || !entries.length) return;

    const ids: string[] = [];
    const values: (string | number | boolean | Buffer | null)[] = [];

    for (const [id, fields] of entries) {
      ids.push(id);
      const entry = parseStreamFields(fields);
      values.push(
        Number(entry.url_id),
        entry.ip_address || null,
        entry.user_agent ?? "",
        entry.referrer ?? "",
        entry.link_type || null,
        entry.via_qr === "1",
        // The stream has the hash in hex; the database stores its 32 bytes
        Buffer.from(entry.visitor_hash, "hex")
      );
    }

    const rowCount = ids.length;

    const COLUMNS = [
      "url_id",
      "ip_address",
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
    await connection.xack(key, GROUP_NAME, ...ids);

    state.consecutiveErrors = 0;
    // console.log(`[views-consumer] inserted ${rowCount} views`);
  } catch (err: any) {
    state.consecutiveErrors++;
    const delay = Math.min(1000 * 2 ** state.consecutiveErrors, 30_000);
    console.error(
      `[views-consumer] drain of ${key} failed (retry in ${delay}ms):`,
      err.message
    );
    await new Promise((res) => setTimeout(res, delay));
  }
};

const clearPendingOnStartup = async (connection: Connection, key: string) => {
  let cleared = 0;
  while (true) {
    const results = (await (connection as any).xreadgroup(
      "GROUP",
      GROUP_NAME,
      CONSUMER_NAME,
      "COUNT",
      BATCH_SIZE,
      "STREAMS",
      key,
      "0"
    )) as Array<[string, Array<[string, string[]]>]> | null;

    const entries = results?.[0]?.[1];
    if (!entries?.length) break;

    const ids = entries.map(([id]) => id);
    await connection.xack(key, GROUP_NAME, ...ids);
    cleared += ids.length;
  }

  if (cleared > 0)
    console.warn(
      `[janitor] Discarded ${cleared} pending records of ${key} from previous run.`
    );
};

// Drain continuously when there's data; sleep briefly when idle to avoid busy-waiting
export const runDrainLoop = async (key: string) => {
  // A connection of its own: XREADGROUP with BLOCK holds the connection until new views come
  // in, so the loops of the other streams can't share it
  const connection = redis.duplicate();

  await connection.client("SETNAME", "janitor");
  await createViewsGroup(connection, key);

  // At this point we just get rid of the pending items. If we want 100% data integrity, we can implement a recovery mechanism that
  // fetches and processes the pending messages before starting the normal drain loop. In that case, we should handle the nil cases because of MAX_LEN.
  // We should also add a new column to the views table to store the Redis stream ID to avoid duplicates during recovery.
  await clearPendingOnStartup(connection, key);

  const state = { consecutiveErrors: 0 };
  while (true) {
    await drainViewsOnce(connection, key, state);

    // We can sleep here to reduce the CPU load of this process when receiving lots of views.
    // await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
