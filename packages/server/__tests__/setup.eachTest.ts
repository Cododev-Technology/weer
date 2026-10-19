import { pool } from "../src/database/index.js";
import { Cluster } from "ioredis";
import { redis } from "../src/redis/redis.js";
import { truncateAll } from "../src/database/schema.js";
import keys from "../src/config/keys.js";

beforeEach(async () => {
  await truncateAll(pool);

  // The links saved in Redis belong to the links that were just deleted, and a new link can
  // get the same code (and the same id)
  // (in the cluster every master has a part of the keys, so each of them)
  if (keys.redisEnabled) {
    const nodes = redis instanceof Cluster ? redis.nodes("master") : [redis];
    await Promise.all(nodes.map((node) => node.flushdb()));
  }
});

after(async () => {
  await Promise.all([pool.end(), redis.quit()]);
});