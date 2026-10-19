// The views waiting in Redis for the janitor. In the cluster they're spread over
// keys.viewsStreamShards streams (see redis/views-stream.ts), so these look at all of them.

import { redis } from "../../src/redis/redis.js";
import { VIEWS_STREAM_KEYS } from "../../src/redis/views-stream.js";

// A view in a stream: its id, and its fields (name, value, name, value, ...)
export type StreamEntry = [string, string[]];

// How many views are waiting in the streams
export const streamsLength = async (): Promise<number> => {
  let length = 0;
  for (const key of VIEWS_STREAM_KEYS) length += await redis.xlen(key);
  return length;
};

// The last `count` views that were saved, the newest first
export const lastViews = async (count: number): Promise<StreamEntry[]> => {
  const entries: StreamEntry[] = [];
  for (const key of VIEWS_STREAM_KEYS) {
    entries.push(...(await redis.xrevrange(key, "+", "-", "COUNT", count)));
  }

  // An id is "{milliseconds}-{sequence}", the time Redis saved the view at
  const streamId = (id: string) => id.split("-").map(BigInt);
  entries.sort(([a], [b]) => {
    const [aTime, aSequence] = streamId(a);
    const [bTime, bSequence] = streamId(b);
    if (aTime !== bTime) return bTime > aTime ? 1 : -1;
    return bSequence > aSequence ? 1 : bSequence < aSequence ? -1 : 0;
  });
  return entries.slice(0, count);
};
