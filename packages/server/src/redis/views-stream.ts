import type { LinkType } from "@weer/common";
import calculateSlot from "cluster-key-slot";
import { redis } from "./redis.js";
import keys from "../config/keys.js";

export interface IViewEvent {
  url_id: number;
  ip_address?: string;
  user_agent: string;
  referrer: string;
  link_type?: LinkType;
  via_qr: boolean;
  visitor_hash: string;
}

// How many slots a Redis cluster has
const SLOTS = 16384;

/**
 * In a cluster a key lives on one node, so with one stream, every view would go to the same node.
 * There, the views are spread over keys.viewsStreamShards streams.
 *
 * A key's node is decided by its slot: the CRC16 of the key (or of its hash tag, the part in {}),
 * mod 16384. Every master owns an equal range of the slots (redis.sh), so each stream gets an
 * equal share of the slots too, and a hash tag whose slot is in the middle half of that share (so
 * it's never on the edge of a master's range): weer:stream:views:{10}, weer:stream:views:{18}, ...
 * With a number of streams that's a multiple of the masters, every master gets the same number of
 * them. server-turbo's streams have the same names (see its redis/views-stream.rs).
 */
const shardKeys = (shards: number): string[] =>
  Array.from({ length: shards }, (_, shard) => {
    const start = Math.floor((shard * SLOTS) / shards);
    const end = Math.floor(((shard + 1) * SLOTS) / shards);
    const quarter = Math.floor((end - start) / 4);

    const inTheMiddle = (tag: number) => {
      const slot = calculateSlot(String(tag));
      return slot >= start + quarter && slot < end - quarter;
    };

    let tag = 0;
    while (!inTheMiddle(tag)) tag++;
    return `weer:stream:views:{${tag}}`;
  });

export const VIEWS_STREAM_KEYS = keys.redisCluster
  ? shardKeys(keys.viewsStreamShards)
  : ["weer:stream:views"];

// The stream that the next view of this process goes to. Each process goes around all of them.
let nextShard = 0;

// Cap the length of each stream.
// The single Redis: the janitor drains it every second, so this is just a safety net.
// The cluster: it leaves room for the views the janitor is behind on, like server-turbo: 6.25M per
// stream, so 300M over all 48 streams, which is 5 minutes at 1M views/s (121 bytes a view, so
// about 36 GB of Redis). Past that, the oldest views are dropped, saved or not.
const MAX_LEN = keys.redisCluster ? 6_250_000 : 100_000;

export function push(event: IViewEvent): void {
  const fields: (string | number)[] = [
    "url_id",
    event.url_id,
    "ip_address",
    event.ip_address ?? "",
    "user_agent",
    event.user_agent,
    "referrer",
    event.referrer,
    "link_type",
    event.link_type ?? "",
    "via_qr",
    event.via_qr ? "1" : "0",
    "visitor_hash",
    event.visitor_hash,
  ];

  /**
   * Fire and forget — XADD is ~50µs and must not block the redirect response
   * Example redis-cli command: XADD stream:views MAXLEN ~ 100000 * url_id "123" ip_address "1.2.3.4" user_agent "Mozilla/5.0" referrer "google.com" via_qr "1" visitor_hash "abc-xyz" link_type "classic"
   *
   * This operation is Big O(1).
   * Trimming without the tilde (~) is O(n) and can cause latency spikes when the stream is long.
   *
   * Get the last entry in the stream:
   * XREVRANGE weer:stream:views + - COUNT 1
   *
   *
   * XREAD STREAMS weer:stream:views 0
   *
   * XINFO STREAM weer:stream:views
   *
   * XINFO GROUPS weer:stream:views
   *
   * (In the cluster, the same with weer:stream:views:{10} and the others, see VIEWS_STREAM_KEYS)
   */
  const key = VIEWS_STREAM_KEYS[nextShard];
  nextShard = (nextShard + 1) % VIEWS_STREAM_KEYS.length;

  void (redis as any)
    // ~ means approximate max length. It's more efficient than exact max length and good enough for our use case.
    // * means that Redis will generate the ID based on the current timestamp.
    .xadd(key, "MAXLEN", "~", MAX_LEN, "*", ...fields)
    .catch((err: Error) =>
      console.error("[views-stream] XADD failed:", err.message)
    );
}
