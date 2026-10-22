import type { LinkType } from "../types";

export namespace Url {
  export interface ShortenBody {
    url: string;
    type: LinkType;
  }

  export interface ChangeTypeBody {
    type: LinkType;
    code?: string;
  }

  export interface UpdateRealUrlBody {
    url: string;
  }

  export interface Stats {
    total: number;
    unique_visitors: number;
    qr_clicks: number;
    last_clicked: string | null;
  }

  // The time ranges of the dashboard and the export
  export type AnalyticsRange = "24h" | "7d" | "30d" | "90d" | "all";

  // The query of GET /url/:id/analytics. tz is an IANA time zone, like "Europe/Berlin" (UTC by default)
  export interface AnalyticsQuery {
    range?: AnalyticsRange;
    tz?: string;
  }

  // The query of GET /url/:id/views/export
  export interface ExportQuery extends AnalyticsQuery {
    format?: "csv" | "json" | "sql";
  }

  // The dashboard of a link. Every number is of the people who opened it in the range: bot_hits
  // are the bots and link previews (Slack, WhatsApp, iMessage...), which are left out of the rest.
  export interface Analytics {
    range: AnalyticsRange;
    // The size of each bar of the timeline
    interval: "hour" | "day" | "week" | "month";
    clicks: number;
    unique_visitors: number;
    qr_scans: number;
    bot_hits: number;
    last_clicked: string | null;
    // start: the beginning of the bar in the time zone of the query, like "2026-10-19T00:00"
    timeline: { start: string; clicks: number }[];
    // The top 10. code: ISO 3166-1 alpha-2 (like "DE"), null if unknown
    countries: { code: string | null; clicks: number }[];
    // The top 10. domain: null if the browser didn't say where the visitor came from
    referrers: { domain: string | null; clicks: number }[];
    devices: { mobile: number; tablet: number; desktop: number };
  }
}
