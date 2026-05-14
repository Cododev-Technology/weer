import { pool } from "../src/database/index.js";
import { redis } from "../src/redis/redis.js";
import { truncateAll } from "../src/database/schema.js";

beforeEach(async () => {
  await truncateAll(pool);
});

after(async () => {
  await Promise.all([pool.end(), redis.quit()]);
});