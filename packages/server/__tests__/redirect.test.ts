import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import request from "supertest";
import { describe, it } from "mocha";
import app from "./helpers/target.js";
import { DB } from "../src/database/index.js";
import { redis } from "../src/redis/redis.js";
import { VIEWS_STREAM_KEY } from "../src/redis/views-stream.js";
import keys from "../src/config/keys.js";
import { createUser } from "./helpers/factories/user.js";

const publicPath = new URL("../../server-shared/public", import.meta.url)
  .pathname;

// A destination on the domain allowlist, and one that is not
const TRUSTED_URL = "https://github.com/agile8118/weer";
const OTHER_URL = "https://www.example.com/some/page?a=b";

// Creates a link of the given type for the agent
const createLink = async (
  agent: ReturnType<typeof request.agent>,
  type = "classic",
  url = TRUSTED_URL
) => {
  const { body } = await agent.post("/url").send({ url: TRUSTED_URL, type });

  // Straight in the database, so the server doesn't have to ask the Web Risk API about the URL
  if (url !== TRUSTED_URL) {
    await DB.query("UPDATE urls SET real_url = $1 WHERE id = $2", [url, body.URLId]);
  }
  return body;
};

const anonymous = async () => {
  const agent = request.agent(app);
  await agent.get("/auth/status");
  return agent;
};

// The view that the last redirect has saved, from Redis or from the database
const savedView = async () => {
  if (keys.redisEnabled) {
    const [[, fields]] = await redis.xrevrange(VIEWS_STREAM_KEY, "+", "-", "COUNT", 1);
    const entry: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) entry[fields[i]] = fields[i + 1];

    return {
      url_id: Number(entry.url_id),
      user_agent: entry.user_agent,
      referrer: entry.referrer,
      link_type: entry.link_type || null,
      via_qr: entry.via_qr === "1",
      visitor_hash: entry.visitor_hash,
    };
  }

  const [view] = await DB.query(
    "SELECT url_id, user_agent, referrer, link_type, via_qr, visitor_hash FROM views ORDER BY id DESC LIMIT 1"
  );
  // The database has the hash's bytes; the stream (and these tests) have it in hex
  return { ...view, visitor_hash: view.visitor_hash.toString("hex") };
};

describe("Redirecting to the real URL", () => {
  it("should redirect right away to a destination that we trust", async () => {
    const link = await createLink(await anonymous());

    const res = await request(app).get("/" + link.code);

    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers.location, TRUSTED_URL);
    assert.strictEqual(res.text, "");
  });

  it("should show a warning first for any other destination", async () => {
    const link = await createLink(await anonymous(), "classic", OTHER_URL);

    const res = await request(app).get("/" + link.code);

    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(
      res.headers.location,
      `/redirect-warning?type=classic&code=${link.code}`
    );
  });

  it("should read a classic code in any letter case, with o as 0 and l as i", async () => {
    const link = await createLink(await anonymous());
    await DB.query("UPDATE urls SET shortened_url_id = 'a0i1b2' WHERE id = $1", [
      link.URLId,
    ]);

    for (const code of ["a0i1b2", "A0I1B2", "aoi1b2", "AOL1B2", "a0l1b2"]) {
      const res = await request(app).get("/" + code);

      assert.strictEqual(res.statusCode, 302, code);
      assert.strictEqual(res.headers.location, TRUSTED_URL);
    }
  });

  it("should redirect a digit link, with o as 0", async () => {
    const link = await createLink(await anonymous(), "digit");
    await DB.query("UPDATE digit_codes SET code = '1007' WHERE url_id = $1", [
      link.URLId,
    ]);

    for (const code of ["1007", "1oO7"]) {
      const res = await request(app).get("/" + code);

      assert.strictEqual(res.statusCode, 302, code);
      assert.strictEqual(res.headers.location, TRUSTED_URL);
    }
  });

  it("should redirect an ultra link", async () => {
    const agent = request.agent(app);
    await createUser(agent);
    const link = await createLink(agent, "ultra", OTHER_URL);
    await DB.query("UPDATE ultra_codes SET url_id = NULL");
    await DB.query("UPDATE ultra_codes SET url_id = $1 WHERE code = 'zi'", [
      link.URLId,
    ]);

    for (const code of ["zi", "ZI", "zl", "Zl"]) {
      const res = await request(app).get("/" + code);

      assert.strictEqual(res.statusCode, 302, code);
      assert.strictEqual(res.headers.location, "/redirect-warning?type=ultra&code=zi");
    }
  });

  it("should redirect a custom link", async () => {
    const agent = await anonymous();
    const link = await createLink(agent, "classic", OTHER_URL);
    await agent
      .patch(`/url/${link.URLId}/type`)
      .send({ type: "custom", code: "My-own-code_and-more" });

    const res = await request(app).get("/My-own-code_and-more");

    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(
      res.headers.location,
      "/redirect-warning?type=custom&code=My-own-code_and-more"
    );
  });

  it("should redirect an affix link on the username of its owner", async () => {
    const agent = request.agent(app);
    await createUser(agent);
    await agent.patch("/user/username").send({ username: "joe" });
    const link = await createLink(agent, "classic", OTHER_URL);
    await agent
      .patch(`/url/${link.URLId}/type`)
      .send({ type: "affix", code: "portfolio" });

    const res = await request(app).get("/joe/portfolio");

    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(
      res.headers.location,
      "/redirect-warning?type=affix&code=portfolio&username=joe"
    );

    // Not on the username of someone else, and not without a username
    const other = request.agent(app);
    await createUser(other, "other@example.com");
    await other.patch("/user/username").send({ username: "other" });

    for (const path of ["/other/portfolio", "/nobody/portfolio"]) {
      const notFound = await request(app).get(path);

      assert.strictEqual(notFound.statusCode, 404, path);
      assert.strictEqual(
        notFound.text,
        fs.readFileSync(publicPath + "/404.html", "utf8")
      );
    }
  });

  it("should redirect a QR code link", async () => {
    const link = await createLink(await anonymous(), "classic", OTHER_URL);
    const [{ qr_code_id }] = await DB.query(
      "SELECT qr_code_id FROM urls WHERE id = $1",
      [link.URLId]
    );

    const res = await request(app).get("/q/" + qr_code_id);

    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(
      res.headers.location,
      `/redirect-warning?type=qr&code=${qr_code_id}`
    );
  });

  it("should show the 404 page for a code that does not exist", async () => {
    await createLink(await anonymous());

    for (const path of ["/nope12", "/zz", "/12345", "/not-a-code", "/q/nope", "/a$"]) {
      const res = await request(app).get(path);

      assert.strictEqual(res.statusCode, 404, path);
      assert.match(res.headers["content-type"], /^text\/html/);
      assert.strictEqual(
        res.text,
        fs.readFileSync(publicPath + "/404.html", "utf8")
      );
    }
  });

  it("should save a view of the link", async () => {
    const link = await createLink(await anonymous());

    const res = await request(app)
      .get("/" + link.code)
      .set("X-Forwarded-For", "203.0.113.7, 10.0.0.1")
      .set("User-Agent", "Mozilla/5.0 (Test Browser)")
      .set("Accept-Language", "en-CA,en;q=0.9")
      .set("Referer", "https://www.google.com/search");

    assert.strictEqual(res.statusCode, 302);

    // The visitor is only known by a hash of their IP address, browser and languages
    const visitorHash = crypto
      .createHash("sha256")
      .update("203.0.113.7::Mozilla/5.0 (Test Browser)::en-CA,en;q=0.9")
      .digest("hex");

    assert.deepStrictEqual(await savedView(), {
      url_id: link.URLId,
      user_agent: "Mozilla/5.0 (Test Browser)",
      referrer: "https://www.google.com/search",
      link_type: "classic",
      via_qr: false,
      visitor_hash: visitorHash,
    });
  });

  it("should save a view that came from the QR code", async () => {
    const link = await createLink(await anonymous(), "digit");
    const [{ qr_code_id }] = await DB.query(
      "SELECT qr_code_id FROM urls WHERE id = $1",
      [link.URLId]
    );

    const res = await request(app)
      .get("/q/" + qr_code_id)
      .set("X-Forwarded-For", "203.0.113.7")
      .set("User-Agent", "")
      .set("Accept-Language", "fr");

    assert.strictEqual(res.statusCode, 302);

    const visitorHash = crypto
      .createHash("sha256")
      .update("203.0.113.7::::fr")
      .digest("hex");

    assert.deepStrictEqual(await savedView(), {
      url_id: link.URLId,
      user_agent: "",
      referrer: "",
      link_type: null,
      via_qr: true,
      visitor_hash: visitorHash,
    });
  });

  it("should not save a view if the link was not found", async () => {
    const before = keys.redisEnabled ? await redis.xlen(VIEWS_STREAM_KEY) : 0;

    await request(app).get("/nope12");

    if (keys.redisEnabled) {
      assert.strictEqual(await redis.xlen(VIEWS_STREAM_KEY), before);
    } else {
      const views = await DB.query("SELECT id FROM views");
      assert.strictEqual(views.length, 0);
    }
  });
});

describe("The redirect warning page", () => {
  it("should show the warning page", async () => {
    const res = await request(app).get("/redirect-warning?type=classic&code=abc123");

    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers["content-type"], /^text\/html/);
    assert.strictEqual(
      res.text,
      fs.readFileSync(publicPath + "/redirect-warning.html", "utf8")
    );
  });

  it("should give the page the destination of a link", async () => {
    const link = await createLink(await anonymous(), "classic", OTHER_URL);

    const res = await request(app).get(
      `/redirect-warning/data?type=classic&code=${link.code}`
    );

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.text, JSON.stringify({ realUrl: OTHER_URL }));
  });

  it("should give the page the destination of an affix link and a QR code link", async () => {
    const agent = request.agent(app);
    await createUser(agent);
    await agent.patch("/user/username").send({ username: "joe" });
    const link = await createLink(agent, "classic", OTHER_URL);
    await agent
      .patch(`/url/${link.URLId}/type`)
      .send({ type: "affix", code: "my-portfolio" });
    const [{ qr_code_id }] = await DB.query(
      "SELECT qr_code_id FROM urls WHERE id = $1",
      [link.URLId]
    );

    const affix = await request(app).get(
      "/redirect-warning/data?type=affix&code=my-portfolio&username=joe"
    );
    assert.strictEqual(affix.text, JSON.stringify({ realUrl: OTHER_URL }));

    const qr = await request(app).get(
      `/redirect-warning/data?type=qr&code=${qr_code_id}`
    );
    assert.strictEqual(qr.text, JSON.stringify({ realUrl: OTHER_URL }));

    // An affix link is nothing without its username
    const withoutUsername = await request(app).get(
      "/redirect-warning/data?type=affix&code=my-portfolio"
    );
    assert.strictEqual(withoutUsername.text, JSON.stringify({ realUrl: null }));
  });

  it("should give the page nothing for a link that does not exist", async () => {
    const link = await createLink(await anonymous(), "classic", OTHER_URL);

    const queries = [
      "",
      "?type=classic",
      `?code=${link.code}`,
      "?type=classic&code=nope12",
      `?type=digit&code=${link.code}`,
      `?type=nope&code=${link.code}`,
      `?type=&code=${link.code}`,
    ];

    for (const query of queries) {
      const res = await request(app).get("/redirect-warning/data" + query);

      assert.strictEqual(res.statusCode, 200, query);
      assert.strictEqual(res.text, JSON.stringify({ realUrl: null }), query);
    }
  });
});
