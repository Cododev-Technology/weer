import { Redis, Cluster } from "ioredis";
import keys from "../config/keys.js";

// The cluster sends every command to the node that has its key, so the rest of the code uses
// both the same way
export const redis: Redis | Cluster = keys.redisCluster
  ? new Cluster(
      (keys.redisClusterNodes ?? "").split(",").map((node) => node.trim()),
      { lazyConnect: true }
    )
  : new Redis(keys.redisUrl, {
      lazyConnect: true,
    });

if (keys.redisEnabled) {
  void redis.connect();
}

redis.on("connect", () => console.log("[redis] connected successfully"));
redis.on("error", (err: Error) =>
  console.error("[redis] connection error:", err.message)
);