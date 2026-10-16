import assert from "node:assert/strict";
import request from "supertest";
import { describe, it } from "mocha";
import app from "./helpers/target.js";
import { DB } from "../src/database/index.js";
import type { IView } from "../src/database/types.js";
import { redis } from "../src/redis/redis.js";
import { VIEWS_STREAM_KEY } from "../src/redis/views-stream.js";
import keys from "../src/config/keys.js";

// A destination on the domain allowlist, so the server never has to ask the Web Risk API about it
const URL = "https://github.com/agile8118/weer";

const createLink = async () => {
  const agent = request.agent(app);
  await agent.get("/auth/status");
  const { body } = await agent.post("/url").send({ url: URL, type: "classic" });
  return { agent, id: body.URLId };
};

describe("Getting the stats of a URL", () => {
  it("should return zeros for a link that nobody has opened yet", async () => {
    const { agent, id } = await createLink();

    const res = await agent.get(`/url/${id}/stats`);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(
      res.text,
      JSON.stringify({
        total: 0,
        unique_visitors: 0,
        qr_clicks: 0,
        last_clicked: null,
      })
    );
  });

  it("should count the views, the visitors and the QR code scans", async () => {
    const { agent, id } = await createLink();
    const other = await createLink();

    const visitor1 = "1".repeat(64);
    const visitor2 = "2".repeat(64);

    await DB.insert<IView>("views", { url_id: id, visitor_hash: visitor1, via_qr: false, link_type: "classic" });
    await DB.insert<IView>("views", { url_id: id, visitor_hash: visitor1, via_qr: true });
    await DB.insert<IView>("views", { url_id: id, visitor_hash: visitor2, via_qr: false, link_type: "classic" });
    await DB.insert<IView>("views", { url_id: id, visitor_hash: visitor2, via_qr: true });
    await DB.insert<IView>("views", { url_id: id, visitor_hash: visitor2, via_qr: false, link_type: "digit" });

    // The views of another link don't count
    await DB.insert<IView>("views", { url_id: other.id, visitor_hash: "3".repeat(64), via_qr: true });

    await DB.query(
      "UPDATE views SET created_at = '2030-03-04T05:06:07.891234Z'::timestamptz - (id * INTERVAL '24 hours') WHERE url_id = $1",
      [id]
    );

    const res = await agent.get(`/url/${id}/stats`);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(
      res.text,
      JSON.stringify({
        total: 5,
        unique_visitors: 2,
        qr_clicks: 2,
        last_clicked: "2030-03-03T05:06:07.891Z",
      })
    );
  });

  it("should count the views that came in through the links", async () => {
    const { agent, id } = await createLink();
    const [{ shortened_url_id, qr_code_id }] = await DB.query(
      "SELECT shortened_url_id, qr_code_id FROM urls WHERE id = $1",
      [id]
    );

    await request(app).get("/" + shortened_url_id).set("User-Agent", "Browser A");
    await request(app).get("/" + shortened_url_id).set("User-Agent", "Browser A");
    await request(app).get("/q/" + qr_code_id).set("User-Agent", "Browser B");

    // With Redis, the views wait in a stream for the janitor to save them (see janitor.ts)
    if (keys.redisEnabled) {
      const entries = await redis.xrevrange(VIEWS_STREAM_KEY, "+", "-", "COUNT", 3);
      const views = entries.map(([, fields]) => fields.join(" "));

      assert.strictEqual(views.length, 3);
      for (const view of views) assert.ok(view.startsWith(`url_id ${id} user_agent Browser `));
      assert.deepStrictEqual(
        views.map((view) => /via_qr (\d)/.exec(view)![1]),
        ["1", "0", "0"]
      );
      assert.strictEqual(new Set(views.map((view) => view.slice(-64))).size, 2);
      return;
    }

    const res = await agent.get(`/url/${id}/stats`);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.total, 3);
    assert.strictEqual(res.body.unique_visitors, 2);
    assert.strictEqual(res.body.qr_clicks, 1);
    assert.match(res.body.last_clicked, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("should not return the stats of the link of someone else", async () => {
    const { id } = await createLink();

    const stranger = request.agent(app);
    await stranger.get("/auth/status");
    const res = await stranger.get(`/url/${id}/stats`);

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(
      res.text,
      JSON.stringify({ error: "Not allowed to access." })
    );
  });
});
