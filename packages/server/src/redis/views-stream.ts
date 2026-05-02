import type { LinkType } from "@weer/common";
import { redis } from "./redis.js";

export interface IViewEvent {
  url_id: number;
  // For now, due to legal reasons, we won't save the ip address until we have a proper privacy policy in place.
  // ip_address?: string;
  user_agent: string;
  referrer: string;
  link_type?: LinkType;
  via_qr: boolean;
  visitor_hash: string;
}

export const VIEWS_STREAM_KEY = "weer:stream:views";

// Cap the stream length — janitor drains it every second, so this is just a safety net
const MAX_LEN = 100_000;

export function push(event: IViewEvent): void {
  const fields: (string | number)[] = [
    "url_id",
    event.url_id,
    // ip_address,
    // event.ip_address,
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
   * Example redis-cli command: XADD stream:views MAXLEN ~ 100000 * url_id "123" user_agent "Mozilla/5.0" referrer "google.com" via_qr "1" visitor_hash "abc-xyz" link_type "classic"
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
   */
  void (redis as any)
    // ~ means approximate max length. It's more efficient than exact max length and good enough for our use case.
    // * means that Redis will generate the ID based on the current timestamp.
    .xadd(VIEWS_STREAM_KEY, "MAXLEN", "~", MAX_LEN, "*", ...fields)
    .catch((err: Error) =>
      console.error("[views-stream] XADD failed:", err.message)
    );
}
