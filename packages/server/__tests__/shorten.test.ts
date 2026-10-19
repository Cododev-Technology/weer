import assert from "node:assert/strict";
import request from "supertest";
import { describe, it } from "mocha";
import app from "./helpers/target.js";
import { DB } from "../src/database/index.js";
import type { IUrl, IUser } from "../src/database/types.js";
import { createUser } from "./helpers/factories/user.js";

// A destination on the domain allowlist, so the server never has to ask the Web Risk API about it
const URL = "https://github.com/agile8118/weer";

describe("Shortening a URL", () => {
  it("should return the new link as JSON", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");

    const res = await agent.post("/url").send({ url: URL, type: "classic" });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["content-type"], "application/json");
    assert.match(res.body.code, /^[a-kmnp-z0-9]{6}$/);
    assert.strictEqual(
      res.text,
      JSON.stringify({
        URLId: 1,
        realURL: URL,
        linkType: "classic",
        code: res.body.code,
        expiresAt: null,
      })
    );
  });

  it("should save a classic link for the anonymous session", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");

    const res = await agent.post("/url").send({ url: URL, type: "classic" });

    const urls = await DB.query(
      `SELECT urls.id, real_url, shortened_url_id, link_type, user_id, sessions.id IS NOT NULL AS has_session, qr_code_id
      FROM urls LEFT JOIN sessions ON sessions.id = urls.session_id`
    );
    assert.strictEqual(urls.length, 1);

    // The QR code id is 7 random bytes in base64url
    assert.match(urls[0].qr_code_id, /^[A-Za-z0-9_-]{10}$/);
    delete urls[0].qr_code_id;

    assert.deepStrictEqual(urls[0], {
      id: res.body.URLId,
      real_url: URL,
      shortened_url_id: res.body.code,
      link_type: "classic",
      user_id: null,
      has_session: true,
    });
  });

  it("should save the link for the user if logged in, and take one credit", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent);

    const res = await agent.post("/url").send({ url: URL, type: "classic" });

    assert.strictEqual(res.statusCode, 200);

    const url = await DB.find<IUrl>(
      "SELECT user_id, session_id FROM urls WHERE id = $1",
      [res.body.URLId]
    );
    assert.deepStrictEqual(url, { user_id: user.id, session_id: null });

    const { link_credits } = (await DB.find<IUser>(
      "SELECT link_credits FROM users WHERE id = $1",
      [user.id]
    ))!;
    assert.strictEqual(link_credits, 24);
  });

  it("should create a digit link that expires in 2 hours", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");

    const before = Date.now();
    const res = await agent.post("/url").send({ url: URL, type: "digit" });
    const after = Date.now();

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(Object.keys(res.body), [
      "URLId",
      "realURL",
      "linkType",
      "code",
      "expiresAt",
    ]);
    assert.strictEqual(res.body.linkType, "digit");
    assert.match(res.body.code, /^\d{3}$/);

    // A date the way JavaScript writes it in JSON, like 2026-01-15T10:20:30.123Z
    assert.match(res.body.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const expiresAt = new Date(res.body.expiresAt).getTime();
    const twoHours = 2 * 60 * 60 * 1000;
    assert.ok(expiresAt >= before + twoHours && expiresAt <= after + twoHours);

    // The code lives in its own table, and the link itself has no code
    const codes = await DB.query(
      `SELECT digit_codes.code, code_length, url_id, urls.link_type, urls.shortened_url_id,
        (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at,
        assigned_at > NOW() - INTERVAL '1 minute' AND assigned_at <= NOW() AS assigned_now
      FROM digit_codes JOIN urls ON urls.id = digit_codes.url_id`
    );
    assert.deepStrictEqual(codes, [
      {
        code: res.body.code,
        code_length: 3,
        url_id: res.body.URLId,
        link_type: "digit",
        shortened_url_id: null,
        expires_at: String(expiresAt),
        assigned_now: true,
      },
    ]);
  });

  it("should create an ultra link that expires in 30 minutes for a logged in user", async () => {
    const agent = request.agent(app);
    await createUser(agent);

    const before = Date.now();
    const first = await agent.post("/url").send({ url: URL, type: "ultra" });
    const second = await agent.post("/url").send({ url: URL, type: "ultra" });
    const after = Date.now();

    // The shortest codes that are free are handed out first
    assert.strictEqual(first.statusCode, 200);
    assert.strictEqual(first.body.linkType, "ultra");
    assert.strictEqual(first.body.code, "0");
    assert.strictEqual(second.body.code, "1");

    assert.match(first.body.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const expiresAt = new Date(first.body.expiresAt).getTime();
    const thirtyMinutes = 30 * 60 * 1000;
    assert.ok(
      expiresAt >= before + thirtyMinutes - 1000 &&
        expiresAt <= after + thirtyMinutes + 1000
    );

    const codes = await DB.query(
      `SELECT code, url_id, urls.link_type, urls.shortened_url_id
      FROM ultra_codes JOIN urls ON urls.id = ultra_codes.url_id ORDER BY ultra_codes.id`
    );
    assert.deepStrictEqual(codes, [
      { code: "0", url_id: first.body.URLId, link_type: "ultra", shortened_url_id: null },
      { code: "1", url_id: second.body.URLId, link_type: "ultra", shortened_url_id: null },
    ]);
  });

  it("should not create an ultra link for an anonymous visitor", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");

    const res = await agent.post("/url").send({ url: URL, type: "ultra" });

    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.text, JSON.stringify({ error: "Unauthorized" }));
  });

  it("should not create a link of a type that does not exist", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");

    for (const type of ["custom", "affix", "qr", "nope", "", undefined, 5]) {
      const res = await agent.post("/url").send({ url: URL, type });

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.text, JSON.stringify({ error: "Invalid type" }));
    }
  });

  it("should ask for a URL if there is none", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");

    for (const body of [{}, { type: "classic" }, { url: "", type: "classic" }, { url: null }]) {
      const res = await agent.post("/url").send(body);

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(
        res.text,
        JSON.stringify({ error: "Please first put your URL here." })
      );
    }

    const urls = await DB.findMany<IUrl>("SELECT id FROM urls");
    assert.strictEqual(urls.length, 0);
  });

  it("should not accept a body that is not valid JSON", async () => {
    const res = await request(app)
      .post("/url")
      .set("Content-Type", "application/json")
      .send('{ "url": "https://github.com", ');

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.text, JSON.stringify({ error: "Invalid JSON format" }));
  });

  it("should accept the URLs that are valid", async () => {
    const validUrls = [
      "http://github.com",
      "https://github.com/",
      "HTTPS://GITHUB.COM/Agile8118",
      "ftp://github.com/file.zip",
      "https://www.github.com/a/b/c?d=e&f=g#h",
      "https://user:password@github.com:8080/path",
      "http://github.com:1",
      "https://gist.github.com/some-user/0123456789abcdef",
      "https://github.com/search?q=url+shortener&type=repositories",
      "https://github.com/caf%C3%A9/über/日本語",
      "https://youtu.be/dQw4w9WgXcQ",
    ];

    for (const [i, url] of validUrls.entries()) {
      const res = await request(app)
        .post("/url")
        // Every anonymous IP address only gets to create a few links
        .set("X-Forwarded-For", `198.51.100.${i}`)
        .set("Cookie", await sessionCookie())
        .send({ url, type: "classic" });

      assert.strictEqual(res.statusCode, 200, url);
      assert.strictEqual(res.body.realURL, url);
    }
  });

  it("should not accept the URLs that are not valid", async () => {
    const invalidUrls = [
      "random text",
      "github.com",
      "www.github.com/path",
      "http://",
      "http://.",
      "http://..",
      "http://?",
      "http://#",
      "http:// github.com",
      "http://github",
      "http://github.c",
      "http://github.com.",
      "http://-github.com",
      "http://github.com:123456",
      "http://github.com/a b",
      "http://localhost",
      "http://localhost:2080/abc",
      "http://127.0.0.1",
      "http://10.1.1.1",
      "http://192.168.1.1",
      "http://172.16.0.1",
      "http://169.254.1.1",
      "http://0.0.0.0",
      "http://224.1.1.1",
      "http://1.1.1.1.1",
      // Other ways to write 127.0.0.1
      "http://2130706433",
      "http://0x7f.0.0.1",
      // The host is what comes before the first slash, whatever is after it
      "http://127.0.0.1/@github.com",
      "http://localhost/a@github.com",
      "//github.com",
      "mailto:someone@github.com",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "h ttp://github.com",
      " http://github.com",
      "http://github.com ",
      "http://github.com\n",
      "ht­tps://github.com",
    ];

    for (const url of invalidUrls) {
      const res = await request(app)
        .post("/url")
        .send({ url, type: "classic" });

      assert.strictEqual(res.statusCode, 400, url);
      assert.strictEqual(
        res.text,
        JSON.stringify({ error: "The URL you put is not valid." }),
        url
      );
    }

    const urls = await DB.findMany<IUrl>("SELECT id FROM urls");
    assert.strictEqual(urls.length, 0);
  });

  it("should not accept a URL that is something other than text", async () => {
    for (const url of [123, true, { href: URL }]) {
      const res = await request(app).post("/url").send({ url, type: "classic" });

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(
        res.text,
        JSON.stringify({ error: "The URL you put is not valid." })
      );
    }
  });
});

// Starts a new anonymous session and returns its cookie
async function sessionCookie(): Promise<string> {
  const res = await request(app).get("/auth/status");
  return res.headers["set-cookie"][0].split(";")[0];
}
