import { Redis } from "ioredis";
import keys from "../config/keys.js";

export const redis = new Redis(keys.redisUrl, {
  lazyConnect: false,
});

redis.on("connect", () => console.log("[redis] connected successfully"));
redis.on("error", (err: Error) =>
  console.error("[redis] connection error:", err.message)
);
