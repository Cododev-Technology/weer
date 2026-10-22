import assert from "node:assert/strict";
import fs from "node:fs";
import request from "supertest";
import { describe, it } from "mocha";
import app from "./helpers/target.js";
import { DB, pool } from "../src/database/index.js";

// A destination on the domain allowlist, so the server never has to ask the Web Risk API about it
const URL = "https://github.com/agile8118/weer";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SLACK = "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)";

// The countries are only known with the DB-IP database (yarn geo in server-shared)
const hasGeoDatabase = fs.existsSync(
  new globalThis.URL("../../server-shared/geo/dbip-country-lite.mmdb", import.meta.url)
);

const createLink = async () => {
  const agent = request.agent(app);
  await agent.get("/auth/status");
  const { body } = await agent.post("/url").send({ url: URL, type: "classic" });
  const code = (await DB.find<{ code: string }>(
    "SELECT shortened_url_id AS code FROM urls WHERE id = $1",
    [body.URLId]
  ))!.code;
  return { agent, id: body.URLId as number, code };
};

interface View {
  ip?: string | null;
  ua?: string | null;
  referrer?: string;
  visitor?: number; // the hash is 32 bytes of this
  qr?: boolean;
  ago?: string; // how long before now it was opened, like '2 hours'
  at?: Date;
}

// Saves a view the way the janitor does
const addView = (urlId: number, view: View = {}) =>
  DB.query(
    `INSERT INTO views (url_id, ip_address, user_agent, referrer, visitor_hash, link_type, via_qr, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now() - $9::interval))`,
    [
      urlId,
      view.ip ?? null,
      view.ua === undefined ? MAC : view.ua,
      view.referrer ?? "",
      Buffer.alloc(32, view.visitor ?? 1),
      view.qr ? null : "classic",
      view.qr ?? false,
      view.at ?? null,
      view.ago ?? "1 minute",
    ]
  );

// The body of a download as text, whatever its type
const download = (agent: ReturnType<typeof request.agent>, path: string) =>
  agent
    .get(path)
    .buffer(true)
    .parse((res, callback) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => callback(null, text));
    });

// The bars of the timeline, like "2026-10-19T00:00", from SQL in the time zone
const barOf = async (sql: string, values: any[] = []) =>
  (await DB.find<{ bar: string }>(`SELECT to_char(${sql}, 'YYYY-MM-DD"T"HH24:MI') AS bar`, values))!.bar;

describe("Getting the dashboard of a URL", () => {
  it("should return an empty dashboard for a link that nobody has opened yet", async () => {
    const { agent, id } = await createLink();

    const res = await agent.get(`/url/${id}/analytics?range=7d`);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.range, "7d");
    assert.strictEqual(res.body.interval, "day");
    assert.strictEqual(res.body.clicks, 0);
    assert.strictEqual(res.body.unique_visitors, 0);
    assert.strictEqual(res.body.qr_scans, 0);
    assert.strictEqual(res.body.bot_hits, 0);
    assert.strictEqual(res.body.last_clicked, null);
    assert.deepStrictEqual(res.body.countries, []);
    assert.deepStrictEqual(res.body.referrers, []);
    assert.deepStrictEqual(res.body.devices, { mobile: 0, tablet: 0, desktop: 0 });

    // A bar for each of the last 7 days, today last
    const today = await barOf("date_trunc('day', now() AT TIME ZONE 'UTC')");
    const firstDay = await barOf("date_trunc('day', now() AT TIME ZONE 'UTC') - interval '6 days'");
    assert.strictEqual(res.body.timeline.length, 7);
    assert.strictEqual(res.body.timeline[0].start, firstDay);
    assert.strictEqual(res.body.timeline[6].start, today);
    assert.ok(res.body.timeline.every((bar: any) => bar.clicks === 0));
  });

  it("should count the people, and the bots and link previews apart", async () => {
    const { agent, id } = await createLink();
    const other = await createLink();

    await addView(id, { ua: MAC, visitor: 1, referrer: "https://www.google.com/search?q=weer", ago: "1 hour" });
    await addView(id, { ua: MAC, visitor: 1, referrer: "https://Google.com:443/", ago: "2 hours" });
    await addView(id, { ua: IPHONE, visitor: 2, qr: true, ago: "1 day" });
    await addView(id, { ua: ANDROID_TABLET, visitor: 3, referrer: "android-app://com.google.android.gm", ago: "2 days" });
    await addView(id, { ua: SLACK, visitor: 4, ago: "3 hours" });
    await addView(id, { ua: "", visitor: 5, ago: "3 hours" });
    await addView(id, { ua: null, visitor: 6, ago: "3 hours" });

    // Before the range
    await addView(id, { ua: MAC, visitor: 7, ago: "10 days" });

    // The views of another link don't count
    await addView(other.id, { ua: MAC, visitor: 1, ago: "1 hour" });

    const res = await agent.get(`/url/${id}/analytics?range=7d`);
    const lastClicked = await DB.find<{ at: Date }>(
      "SELECT MAX(created_at) AS at FROM views WHERE url_id = $1",
      [id]
    );

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.clicks, 4);
    assert.strictEqual(res.body.unique_visitors, 3);
    assert.strictEqual(res.body.qr_scans, 1);
    assert.strictEqual(res.body.bot_hits, 3);
    assert.strictEqual(res.body.last_clicked, lastClicked!.at.toISOString());
    assert.deepStrictEqual(res.body.devices, { mobile: 1, tablet: 1, desktop: 2 });
    assert.deepStrictEqual(res.body.referrers, [
      { domain: "google.com", clicks: 2 },
      { domain: "com.google.android.gm", clicks: 1 },
      { domain: null, clicks: 1 },
    ]);
    assert.strictEqual(
      res.body.timeline.reduce((sum: number, bar: any) => sum + bar.clicks, 0),
      4
    );

    const all = await agent.get(`/url/${id}/analytics?range=all`);

    assert.strictEqual(all.statusCode, 200);
    assert.strictEqual(all.body.range, "all");
    assert.strictEqual(all.body.interval, "day");
    assert.strictEqual(all.body.clicks, 5);
    assert.strictEqual(all.body.unique_visitors, 4);
    // From the day of the first view to today
    assert.strictEqual(all.body.timeline.length, 11);
  });

  it("should find the countries of the visitors", async function () {
    if (!hasGeoDatabase) this.skip();

    const { agent, id } = await createLink();

    await addView(id, { ip: "8.8.8.8", visitor: 1 });
    await addView(id, { ip: "8.8.8.8", visitor: 1 });
    await addView(id, { ip: "81.2.69.142", visitor: 2 });
    await addView(id, { ip: "1.1.1.1", visitor: 3 });
    await addView(id, { ip: "2a00:1450:4001:82a::200e", visitor: 4 });
    // Not on the internet, and not known
    await addView(id, { ip: "10.1.2.3", visitor: 5 });
    await addView(id, { ip: null, visitor: 6 });
    // A bot doesn't count
    await addView(id, { ip: "81.2.69.142", ua: SLACK, visitor: 7 });

    const res = await agent.get(`/url/${id}/analytics?range=30d`);

    assert.strictEqual(res.statusCode, 200);
    // The most clicks first, then by code, and the unknown ones last
    assert.deepStrictEqual(res.body.countries, [
      { code: "US", clicks: 2 },
      { code: null, clicks: 2 },
      { code: "AU", clicks: 1 },
      { code: "DE", clicks: 1 },
      { code: "GB", clicks: 1 },
    ]);
  });

  it("should put the clicks into the days of the time zone", async () => {
    const { agent, id } = await createLink();

    // 10 minutes after midnight in India (UTC+5:30), which is the evening before in UTC
    const { at } = (await DB.find<{ at: Date }>(
      "SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '10 minutes') AT TIME ZONE 'Asia/Kolkata' AS at"
    ))!;
    await addView(id, { at });

    const india = await agent.get(`/url/${id}/analytics?range=7d&tz=Asia/Kolkata`);
    const utc = await agent.get(`/url/${id}/analytics?range=7d&tz=UTC`);

    assert.strictEqual(india.statusCode, 200);
    assert.strictEqual(india.body.timeline.length, 7);
    assert.deepStrictEqual(india.body.timeline[6], {
      start: await barOf("date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')"),
      clicks: 1,
    });

    const utcDay = await barOf("date_trunc('day', $1::timestamptz AT TIME ZONE 'UTC')", [at]);
    assert.deepStrictEqual(
      utc.body.timeline.filter((bar: any) => bar.clicks > 0),
      [{ start: utcDay, clicks: 1 }]
    );
  });

  it("should show the last 24 hours by the hour", async () => {
    const { agent, id } = await createLink();

    await addView(id, { ago: "30 minutes" });
    await addView(id, { ago: "5 hours" });
    await addView(id, { ago: "30 hours" });

    const res = await agent.get(`/url/${id}/analytics?range=24h`);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.interval, "hour");
    assert.strictEqual(res.body.timeline.length, 24);
    assert.strictEqual(res.body.timeline[23].start, await barOf("date_trunc('hour', now() AT TIME ZONE 'UTC')"));
    assert.strictEqual(res.body.clicks, 2);
  });

  it("should not take a range or a time zone it doesn't know", async () => {
    const { agent, id } = await createLink();

    const range = await agent.get(`/url/${id}/analytics?range=1y`);
    const tz = await agent.get(`/url/${id}/analytics?tz=Mars/Olympus`);
    const injected = await agent.get(`/url/${id}/analytics?tz=${encodeURIComponent("UTC'; DROP TABLE views; --")}`);

    assert.strictEqual(range.statusCode, 400);
    assert.strictEqual(range.text, JSON.stringify({ error: "Invalid time range." }));
    assert.strictEqual(tz.statusCode, 400);
    assert.strictEqual(tz.text, JSON.stringify({ error: "Invalid time zone." }));
    assert.strictEqual(injected.statusCode, 400);
  });

  it("should not return the dashboard of the link of someone else", async () => {
    const { id } = await createLink();

    const stranger = request.agent(app);
    await stranger.get("/auth/status");
    const res = await stranger.get(`/url/${id}/analytics`);

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.text, JSON.stringify({ error: "Not allowed to access." }));
  });
});

describe("Exporting the views of a URL", () => {
  const HEADER = "clicked_at,source,link_type,country,device,is_bot,referrer_domain,user_agent,visitor_id";

  it("should export the views as CSV, without the IP addresses", async () => {
    const { agent, id, code } = await createLink();

    await addView(id, { ip: "8.8.8.8", ua: MAC, visitor: 1, referrer: "https://www.google.com/search?q=private", ago: "2 hours" });
    await addView(id, { ip: "8.8.8.8", ua: IPHONE, visitor: 1, qr: true, ago: "1 hour" });
    await addView(id, { ip: "81.2.69.142", ua: SLACK, visitor: 2, ago: "30 minutes" });

    const res = await download(agent, `/url/${id}/views/export?format=csv`);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["content-type"], "text/csv; charset=utf-8");
    assert.strictEqual(res.headers["content-disposition"], `attachment; filename="weer-${code}-views.csv"`);

    const lines = (res.body as string).split("\r\n");
    assert.strictEqual(lines[0], HEADER);
    assert.strictEqual(lines.length, 5); // the header, 3 views and the end of the last line
    assert.strictEqual(lines[4], "");

    const rows = lines.slice(1, 4).map((line) => line.split(","));
    assert.match(rows[0][0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(rows[0][0] < rows[1][0] && rows[1][0] < rows[2][0]);
    assert.deepStrictEqual(rows.map((row) => row.slice(1, 7)), [
      ["link", "classic", hasGeoDatabase ? "US" : "", "desktop", "false", "google.com"],
      ["qr", "", hasGeoDatabase ? "US" : "", "mobile", "false", ""],
      ["link", "classic", hasGeoDatabase ? "GB" : "", "desktop", "true", ""],
    ]);

    // The same visitor has the same id
    const ids = rows.map((row) => row[row.length - 1]);
    assert.match(ids[0], /^[0-9a-f]{16}$/);
    assert.strictEqual(ids[0], ids[1]);
    assert.notStrictEqual(ids[0], ids[2]);

    // Nothing that points back to a person
    const body = res.body as string;
    assert.ok(!body.includes("8.8.8.8"));
    assert.ok(!body.includes("81.2.69.142"));
    assert.ok(!body.includes("private"));
    assert.ok(!body.includes(Buffer.alloc(32, 1).toString("hex")));
  });

  it("should give a visitor another id on another link", async () => {
    const first = await createLink();
    const second = await createLink();

    await addView(first.id, { visitor: 1 });
    await addView(second.id, { visitor: 1 });

    const a = await download(first.agent, `/url/${first.id}/views/export?format=json`);
    const b = await download(second.agent, `/url/${second.id}/views/export?format=json`);

    const idA = JSON.parse(a.body).views[0].visitor_id;
    const idB = JSON.parse(b.body).views[0].visitor_id;
    assert.match(idA, /^[0-9a-f]{16}$/);
    assert.match(idB, /^[0-9a-f]{16}$/);
    assert.notStrictEqual(idA, idB);
  });

  it("should keep the cells that spreadsheets would run as formulas as text", async () => {
    const { agent, id } = await createLink();

    await addView(id, { ua: '=HYPERLINK("https://evil.example","Click me")', ago: "2 minutes" });
    await addView(id, { ua: "-2+3, the end", ago: "1 minute" });

    const res = await download(agent, `/url/${id}/views/export?format=csv`);
    const lines = (res.body as string).split("\r\n");

    assert.ok(lines[1].includes(`,"'=HYPERLINK(""https://evil.example"",""Click me"")",`));
    assert.ok(lines[2].includes(`,"'-2+3, the end",`));
  });

  it("should export the views as JSON, with what every column means", async () => {
    const { agent, id, code } = await createLink();

    await addView(id, { ua: MAC, referrer: "https://news.ycombinator.com/item?id=1", ago: "2 hours" });
    await addView(id, { ua: IPHONE, qr: true, ago: "1 hour" });

    const res = await download(agent, `/url/${id}/views/export?format=json&range=7d`);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["content-type"], "application/json; charset=utf-8");
    assert.strictEqual(res.headers["content-disposition"], `attachment; filename="weer-${code}-views.json"`);

    const data = JSON.parse(res.body);
    assert.deepStrictEqual(data.link, { id, code, destination: URL });
    assert.strictEqual(data.range, "7d");
    assert.match(data.exported_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepStrictEqual(Object.keys(data.columns), HEADER.split(","));
    assert.strictEqual(data.views.length, 2);
    assert.deepStrictEqual(Object.keys(data.views[0]), HEADER.split(","));
    assert.strictEqual(data.views[0].referrer_domain, "news.ycombinator.com");
    assert.strictEqual(data.views[0].is_bot, false);
    assert.strictEqual(data.views[1].source, "qr");
    assert.strictEqual(data.views[1].link_type, null);
    assert.strictEqual(data.views[1].device, "mobile");
  });

  it("should export the views as SQL that PostgreSQL can run", async () => {
    const { agent, id, code } = await createLink();

    const tricky = `O'Reilly \\'); DROP TABLE urls; -- \\`;
    await addView(id, { ua: MAC, ago: "2 hours" });
    await addView(id, { ua: tricky, ago: "1 hour" });

    const res = await download(agent, `/url/${id}/views/export?format=sql`);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["content-type"], "application/sql; charset=utf-8");
    assert.strictEqual(res.headers["content-disposition"], `attachment; filename="weer-${code}-views.sql"`);

    // Run it, and undo it after
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(res.body as string);
      const { rows } = await client.query(
        "SELECT clicked_at, source, device, is_bot, user_agent FROM weer_views ORDER BY clicked_at"
      );

      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].source, "link");
      assert.strictEqual(rows[0].device, "desktop");
      assert.strictEqual(rows[0].is_bot, false);
      assert.strictEqual(rows[1].user_agent, tricky);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("should export only the views of the range", async () => {
    const { agent, id } = await createLink();

    await addView(id, { ago: "1 hour" });
    await addView(id, { ago: "40 days" });

    const recent = await download(agent, `/url/${id}/views/export?format=json&range=30d`);
    const all = await download(agent, `/url/${id}/views/export?format=json`);

    assert.strictEqual(JSON.parse(recent.body).views.length, 1);
    assert.strictEqual(JSON.parse(all.body).views.length, 2);
  });

  it("should export an empty file for a link that nobody has opened yet", async () => {
    const { agent, id } = await createLink();

    const csv = await download(agent, `/url/${id}/views/export?format=csv`);
    const json = await download(agent, `/url/${id}/views/export?format=json`);

    assert.strictEqual(csv.body, HEADER + "\r\n");
    assert.deepStrictEqual(JSON.parse(json.body).views, []);
  });

  it("should not take a format it doesn't know", async () => {
    const { agent, id } = await createLink();

    const res = await agent.get(`/url/${id}/views/export?format=xlsx`);
    const proto = await agent.get(`/url/${id}/views/export?format=__proto__`);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.text, JSON.stringify({ error: "Invalid export format." }));
    assert.strictEqual(proto.statusCode, 400);
  });

  it("should not export the views of the link of someone else", async () => {
    const { id } = await createLink();

    const stranger = request.agent(app);
    await stranger.get("/auth/status");
    const res = await stranger.get(`/url/${id}/views/export`);

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.text, JSON.stringify({ error: "Not allowed to access." }));
  });
});
