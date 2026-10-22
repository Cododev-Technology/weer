import type { CpeakRequest as Request, CpeakResponse as Response } from "cpeak";
import type { API } from "@weer/common";
import { DB } from "../database/index.js";
import { countryOf } from "../lib/geo.js";
import {
  parseRange,
  parseTimeZone,
  isBotAgent,
  deviceOf,
  visitorIdOf,
  REFERRER_DOMAIN_SQL,
  VIEWS_IN_RANGE_SQL,
  HUMAN_VIEWS_SQL,
} from "../lib/analytics.js";

type Interval = API.Url.Analytics["interval"];

const DAY = 24 * 60 * 60 * 1000;

// The size of the bars of each range, and how far back the first bar is
const RANGE_STEPS: Record<Exclude<API.Url.AnalyticsRange, "all">, [Interval, string]> = {
  "24h": ["hour", "23 hours"],
  "7d": ["day", "6 days"],
  "30d": ["day", "29 days"],
  "90d": ["day", "89 days"],
};

// The start of a range (the start of its first bar, in the time zone) and the size of its bars
async function resolveRange(
  urlId: number,
  range: API.Url.AnalyticsRange,
  tz: string
): Promise<{ from: Date; interval: Interval }> {
  let interval: Interval;
  let back: string;
  let first: Date | null = null;

  if (range === "all") {
    const row = await DB.find<{ first: Date | null }>(
      `SELECT MIN(created_at) AS first FROM views WHERE url_id = $1`,
      [urlId]
    );
    first = row?.first ?? null;

    // About 100 bars at most
    const age = first ? Date.now() - first.getTime() : 0;
    interval = age <= 90 * DAY ? "day" : age <= 730 * DAY ? "week" : "month";

    // At least a week of days
    back = interval === "day" ? "6 days" : "0 days";
  } else {
    [interval, back] = RANGE_STEPS[range];
  }

  const row = await DB.find<{ from: Date }>(
    `SELECT LEAST(
      date_trunc($1, COALESCE($3::timestamptz, now()) AT TIME ZONE $2),
      date_trunc($1, now() AT TIME ZONE $2) - $4::interval
    ) AT TIME ZONE $2 AS "from"`,
    [interval, tz, first, back]
  );

  return { from: row!.from, interval };
}

// Return the dashboard of a link (see API.Url.Analytics)
const getAnalytics = async (
  req: Request<unknown, API.Url.AnalyticsQuery>,
  res: Response
) => {
  const urlId = Number(req.params?.id);
  const range = parseRange(req.query?.range);
  const tz = parseTimeZone(req.query?.tz);

  const { from, interval } = await resolveRange(urlId, range, tz);

  // Bots are known by their user agent, and a link has a lot fewer of those than views
  const agents = await DB.findMany<{ user_agent: string | null; hits: number }>(
    `SELECT user_agent, COUNT(*)::int AS hits FROM views WHERE ${VIEWS_IN_RANGE_SQL} GROUP BY user_agent`,
    [urlId, from]
  );

  // (no user agent at all is a bot too)
  const bots: string[] = [""];
  let botHits = 0;
  const devices: API.Url.Analytics["devices"] = { mobile: 0, tablet: 0, desktop: 0 };

  for (const { user_agent, hits } of agents) {
    if (isBotAgent(user_agent)) {
      if (user_agent) bots.push(user_agent);
      botHits += hits;
    } else {
      devices[deviceOf(user_agent)] += hits;
    }
  }

  const values = [urlId, from, bots];

  const [totals, timeline, ips, referrers] = await Promise.all([
    DB.find<{
      clicks: number;
      unique_visitors: number;
      qr_scans: number;
      last_clicked: Date | null;
    }>(
      `SELECT
        COUNT(*)::int AS clicks,
        COUNT(DISTINCT visitor_hash)::int AS unique_visitors,
        (COUNT(*) FILTER (WHERE via_qr = true))::int AS qr_scans,
        MAX(created_at) AS last_clicked
      FROM views
      WHERE ${HUMAN_VIEWS_SQL}`,
      values
    ),

    // Every bar of the range, the ones without clicks too
    DB.findMany<{ start: string; clicks: number }>(
      `SELECT to_char(bar, 'YYYY-MM-DD"T"HH24:MI') AS start, COALESCE(clicks, 0)::int AS clicks
      FROM generate_series(
        date_trunc($4, $2::timestamptz AT TIME ZONE $5),
        date_trunc($4, now() AT TIME ZONE $5),
        ('1 ' || $4::text)::interval
      ) AS bar
      LEFT JOIN (
        SELECT date_trunc($4, created_at AT TIME ZONE $5) AS bar, COUNT(*) AS clicks
        FROM views
        WHERE ${HUMAN_VIEWS_SQL}
        GROUP BY 1
      ) AS counts USING (bar)
      ORDER BY bar`,
      [...values, interval, tz]
    ),

    // The countries come from the IP addresses (see lib/geo.ts)
    DB.findMany<{ ip: string | null; clicks: number }>(
      `SELECT host(ip_address) AS ip, COUNT(*)::int AS clicks
      FROM views
      WHERE ${HUMAN_VIEWS_SQL}
      GROUP BY ip_address`,
      values
    ),

    DB.findMany<{ domain: string | null; clicks: number }>(
      `SELECT ${REFERRER_DOMAIN_SQL} AS domain, COUNT(*)::int AS clicks
      FROM views
      WHERE ${HUMAN_VIEWS_SQL}
      GROUP BY 1
      ORDER BY clicks DESC, domain
      LIMIT 10`,
      values
    ),
  ]);

  const byCountry = new Map<string | null, number>();
  for (const { ip, clicks } of ips) {
    const code = countryOf(ip);
    byCountry.set(code, (byCountry.get(code) ?? 0) + clicks);
  }

  // The most clicks first, then by code, and the unknown ones last
  const countries = [...byCountry]
    .map(([code, clicks]) => ({ code, clicks }))
    .sort(
      (a, b) =>
        b.clicks - a.clicks ||
        (a.code === null ? 1 : b.code === null ? -1 : a.code.localeCompare(b.code))
    )
    .slice(0, 10);

  const analytics: API.Url.Analytics = {
    range,
    interval,
    clicks: totals?.clicks ?? 0,
    unique_visitors: totals?.unique_visitors ?? 0,
    qr_scans: totals?.qr_scans ?? 0,
    bot_hits: botHits,
    last_clicked: totals?.last_clicked?.toISOString() ?? null,
    timeline,
    countries,
    referrers,
    devices,
  };

  return res.json(analytics);
};

// ─── Export ───────────────────────────────────────────────────────────────────

type ExportFormat = NonNullable<API.Url.ExportQuery["format"]>;

const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
  sql: "application/sql; charset=utf-8",
};

/**
 * The columns of an export, and what each one holds. The IP addresses, the visitor hashes and
 * the full referrers (their paths can have private data, like a search) stay with us.
 */
const COLUMNS = {
  clicked_at: "When the link was opened, in UTC (ISO 8601)",
  source: "link if the short link was opened, qr if the QR code was scanned",
  link_type: "The type the link had then: classic, custom, affix, ultra or digit (empty for the QR code)",
  country: "The country of the visitor as an ISO 3166-1 alpha-2 code (like DE), from the IP address. Empty if unknown",
  device: "mobile, tablet or desktop, from the user agent",
  is_bot: "true for bots and link previews (like Slack, WhatsApp and iMessage), from the user agent",
  referrer_domain: "The domain of the page the visitor came from. Empty if the browser didn't send it",
  user_agent: "The user agent of the browser or the bot",
  visitor_id: "The same visitor (IP address, browser and language) has the same id on this link, and other ids on other links",
};

type Column = keyof typeof COLUMNS;
type ExportRow = Record<Column, string | boolean | null>;

const COLUMN_NAMES = Object.keys(COLUMNS) as Column[];

// One cell of a CSV file
const csvCell = (value: string | boolean | null): string => {
  if (value === null) return "";
  let text = String(value);

  // Spreadsheets run a cell that starts with one of these as a formula
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;

  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// A value of an INSERT, for PostgreSQL and SQLite
const sqlValue = (value: string | boolean | null): string => {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${value.replace(/'/g, "''")}'`;
};

interface ExportInfo {
  urlId: number;
  code: string | null;
  destination: string;
  range: API.Url.AnalyticsRange;
  exportedAt: string;
}

// How each format starts, writes a batch of rows (first: the first batch) and ends
const FORMATS: Record<
  ExportFormat,
  {
    start: (info: ExportInfo) => string;
    batch: (rows: ExportRow[], first: boolean) => string;
    end: string;
  }
> = {
  csv: {
    start: () => COLUMN_NAMES.join(",") + "\r\n",
    batch: (rows) =>
      rows.map((row) => COLUMN_NAMES.map((name) => csvCell(row[name])).join(",") + "\r\n").join(""),
    end: "",
  },

  json: {
    start: (info) =>
      "{\n" +
      `  "link": ${JSON.stringify({ id: info.urlId, code: info.code, destination: info.destination })},\n` +
      `  "range": ${JSON.stringify(info.range)},\n` +
      `  "exported_at": ${JSON.stringify(info.exportedAt)},\n` +
      `  "columns": ${JSON.stringify(COLUMNS, null, 2).replace(/\n/g, "\n  ")},\n` +
      `  "views": [`,
    batch: (rows, first) =>
      rows.map((row, i) => (first && i === 0 ? "" : ",") + "\n    " + JSON.stringify(row)).join(""),
    end: "\n  ]\n}\n",
  },

  sql: {
    start: (info) =>
      `-- The views of the Weer link ${info.code ?? info.urlId} (to ${info.destination.replace(/[\r\n]/g, "")})\n` +
      `-- Range: ${info.range}, exported at ${info.exportedAt}\n` +
      "-- For PostgreSQL and SQLite. MySQL reads the backslashes in strings differently, use the CSV file there.\n" +
      "--\n" +
      COLUMN_NAMES.map((name) => `-- ${name}: ${COLUMNS[name]}\n`).join("") +
      "\n" +
      "CREATE TABLE IF NOT EXISTS weer_views (\n" +
      "  clicked_at TIMESTAMP NOT NULL,\n" +
      "  source TEXT NOT NULL,\n" +
      "  link_type TEXT,\n" +
      "  country TEXT,\n" +
      "  device TEXT NOT NULL,\n" +
      "  is_bot BOOLEAN NOT NULL,\n" +
      "  referrer_domain TEXT,\n" +
      "  user_agent TEXT,\n" +
      "  visitor_id TEXT\n" +
      ");\n\n",
    batch: (rows) =>
      rows.length
        ? `INSERT INTO weer_views (${COLUMN_NAMES.join(", ")}) VALUES\n` +
          rows
            .map((row) => {
              const values = COLUMN_NAMES.map((name) =>
                // TIMESTAMP wants 2026-10-19 12:34:56.789, without the T and the Z
                name === "clicked_at"
                  ? sqlValue((row[name] as string).replace("T", " ").replace("Z", ""))
                  : sqlValue(row[name])
              );
              return `(${values.join(", ")})`;
            })
            .join(",\n") +
          ";\n\n"
        : "",
    end: "",
  },
};

// How many views are read from the database at once
const BATCH_SIZE = 2000;

// Every export holds a database connection until it's done, so a process runs only a few at once
const MAX_EXPORTS = 2;
let runningExports = 0;

// Download the views of a link as a CSV, JSON or SQL file
const exportViews = async (
  req: Request<unknown, API.Url.ExportQuery>,
  res: Response
) => {
  const urlId = Number(req.params?.id);
  const format = (req.query?.format || "csv") as ExportFormat;
  const range = parseRange(req.query?.range);
  const tz = parseTimeZone(req.query?.tz);

  if (typeof format !== "string" || !Object.hasOwn(FORMATS, format)) {
    throw { status: 400, message: "Invalid export format." };
  }

  if (runningExports >= MAX_EXPORTS) {
    throw { status: 429, message: "Too many exports at once. Please try again in a minute." };
  }

  runningExports++;
  let client: Awaited<ReturnType<typeof DB.beginTransaction>> | null = null;

  try {
    const link = await DB.find<{ code: string | null; real_url: string }>(
      `SELECT COALESCE(ultra_codes.code, urls.shortened_url_id, digit_codes.code) AS code, urls.real_url
      FROM urls
      LEFT JOIN ultra_codes
        ON urls.id = ultra_codes.url_id
        AND urls.link_type = 'ultra'
      LEFT JOIN digit_codes
        ON urls.id = digit_codes.url_id
        AND urls.link_type = 'digit'
      WHERE urls.id = $1`,
      [urlId]
    );

    const { from } = await resolveRange(urlId, range, tz);

    const info: ExportInfo = {
      urlId,
      code: link?.code ?? null,
      destination: link?.real_url ?? "",
      range,
      exportedAt: new Date().toISOString(),
    };

    // A cursor, so a link with millions of views goes out a batch at a time
    client = await DB.beginTransaction();
    await client.query(
      `DECLARE views_export NO SCROLL CURSOR FOR
      SELECT created_at, via_qr, link_type, host(ip_address) AS ip, user_agent,
        ${REFERRER_DOMAIN_SQL} AS referrer_domain, visitor_hash
      FROM views
      WHERE ${VIEWS_IN_RANGE_SQL}
      ORDER BY created_at`,
      [urlId, from]
    );

    const fileName = `weer-${(info.code ?? String(urlId)).replace(/[^A-Za-z0-9_-]/g, "") || urlId}-views.${format}`;
    res.setHeader("Content-Type", CONTENT_TYPES[format]);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.attachment(fileName);

    let closed = false;
    res.on("close", () => (closed = true));

    // Wait for the visitor to take what was sent before sending more
    const write = (chunk: string) =>
      new Promise<void>((resolve) => {
        if (!chunk || res.write(chunk)) return resolve();
        const done = () => {
          res.off("drain", done);
          res.off("close", done);
          resolve();
        };
        res.on("drain", done);
        res.on("close", done);
      });

    const output = FORMATS[format];
    await write(output.start(info));

    let first = true;
    while (!closed) {
      const { rows } = await client.query<{
        created_at: Date;
        via_qr: boolean | null;
        link_type: string | null;
        ip: string | null;
        user_agent: string | null;
        referrer_domain: string | null;
        visitor_hash: Buffer | null;
      }>(`FETCH ${BATCH_SIZE} FROM views_export`);

      if (!rows.length) break;

      const batch: ExportRow[] = rows.map((view) => ({
        clicked_at: view.created_at.toISOString(),
        source: view.via_qr ? "qr" : "link",
        link_type: view.link_type,
        country: countryOf(view.ip),
        device: deviceOf(view.user_agent),
        is_bot: isBotAgent(view.user_agent),
        referrer_domain: view.referrer_domain,
        user_agent: view.user_agent || null,
        visitor_id: visitorIdOf(urlId, view.visitor_hash),
      }));

      await write(output.batch(batch, first));
      first = false;
    }

    await DB.commit(client);
    client = null;

    if (!closed) res.end(output.end);
  } catch (err) {
    if (client) {
      // (a connection that broke goes back to the pool to be thrown away)
      await client.query("ROLLBACK").then(
        () => client!.release(),
        (rollbackErr: Error) => client!.release(rollbackErr)
      );
    }

    // Once the file started, the visitor can't get an error message anymore
    if (!res.headersSent) {
      res.removeHeader("Content-Disposition");
      throw err;
    }
    console.error("[export] failed:", err);
    res.destroy();
  } finally {
    runningExports--;
  }
};

export default {
  getAnalytics,
  exportViews,
};
