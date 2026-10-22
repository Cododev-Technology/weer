import crypto from "crypto";
import { isbot } from "isbot";
import type { API } from "@weer/common";
import keys from "../config/keys.js";

export type Device = keyof API.Url.Analytics["devices"];

const RANGES: API.Url.AnalyticsRange[] = ["24h", "7d", "30d", "90d", "all"];

export function parseRange(range: unknown): API.Url.AnalyticsRange {
  if (range === undefined || range === "") return "all";
  if (!RANGES.includes(range as API.Url.AnalyticsRange)) {
    throw { status: 400, message: "Invalid time range." };
  }
  return range as API.Url.AnalyticsRange;
}

// An IANA time zone, like "Europe/Berlin"
export function parseTimeZone(tz: unknown): string {
  if (tz === undefined || tz === "") return "UTC";

  const valid =
    typeof tz === "string" &&
    /^[A-Za-z0-9_+\-/]{1,64}$/.test(tz) &&
    (() => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    })();

  if (!valid) throw { status: 400, message: "Invalid time zone." };
  return tz;
}

// Bots and link previews (Slack, WhatsApp, iMessage...). Browsers always send a user agent.
export const isBotAgent = (userAgent: string | null | undefined): boolean =>
  !userAgent || isbot(userAgent);

// iPads since iPadOS 13 say they're a Mac, so they count as desktops
export function deviceOf(userAgent: string | null | undefined): Device {
  const ua = userAgent || "";
  if (/iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android|Windows Phone|BlackBerry|Opera Mini/i.test(ua)) return "mobile";
  return "desktop";
}

/**
 * The id of a visitor in the exports. The same visitor has the same id on one link, but another
 * one on every other link, and it can't be turned back into the hash (or the IP address and the
 * browser the hash comes from).
 */
export const visitorIdOf = (urlId: number, hash: Buffer | null | undefined): string | null =>
  hash
    ? crypto
        .createHmac("sha256", keys.tokenSecret)
        .update(`visitor-id:${urlId}:`)
        .update(hash)
        .digest("hex")
        .slice(0, 16)
    : null;

/**
 * The domain the visitor came from, like "google.com" for https://www.google.com/search?q=...
 * (without www., a port or a user name), or NULL. Apps on Android send their package name, like
 * android-app://com.google.android.gm (Gmail).
 */
export const REFERRER_DOMAIN_SQL = `NULLIF(regexp_replace(lower(substring(referrer from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]*)')), '^.*@|^www\\.|:[0-9]*$', '', 'g'), '')`;

// The views of a link in a range: $1 the link, $2 the start of the range
export const VIEWS_IN_RANGE_SQL = `url_id = $1 AND created_at >= $2`;

// ... and not of a bot: $3 the user agents of the bots
export const HUMAN_VIEWS_SQL = `${VIEWS_IN_RANGE_SQL} AND NOT (COALESCE(user_agent, '') = ANY($3::text[]))`;
