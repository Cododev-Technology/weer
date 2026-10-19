import assert from "node:assert/strict";
import request from "supertest";
import { describe, it } from "mocha";
import app from "./helpers/target.js";
import { DB } from "../src/database/index.js";
import { createUser } from "./helpers/factories/user.js";

// A destination on the domain allowlist, so the server never has to ask the Web Risk API about it
const URL = "https://github.com/agile8118/weer";

const TOO_MANY_REQUESTS = JSON.stringify({
  error: "Too many requests. Please try again later.",
});
const OUT_OF_CREDITS = JSON.stringify({
  error:
    "You've used all your credits. You can buy more from the Credits menu.",
});

const anonymous = async () => {
  const agent = request.agent(app);
  await agent.get("/auth/status");
  return agent;
};

describe("Rate limiting", () => {
  it("should let an anonymous IP address create 10 links in 10 minutes", async () => {
    const agent = await anonymous();

    for (let i = 1; i <= 10; i++) {
      const res = await agent
        .post("/url")
        .set("X-Forwarded-For", "203.0.113.7")
        .send({ url: URL, type: "classic" });
      assert.strictEqual(res.statusCode, 200, `link ${i}`);
    }

    const res = await agent
      .post("/url")
      .set("X-Forwarded-For", "203.0.113.7")
      .send({ url: URL, type: "classic" });

    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.text, TOO_MANY_REQUESTS);

    const urls = await DB.query("SELECT id FROM urls");
    assert.strictEqual(urls.length, 10);

    const limits = await DB.query("SELECT ip_address, burst_count FROM rate_limits");
    assert.deepStrictEqual(limits, [
      { ip_address: "203.0.113.7", burst_count: 11 },
    ]);
  });

  it("should count every IP address on its own", async () => {
    const agent = await anonymous();

    // The first address of X-Forwarded-For is the one of the visitor
    for (let i = 1; i <= 11; i++) {
      const res = await agent
        .post("/url")
        .set("X-Forwarded-For", " 203.0.113.7 , 10.0.0.1")
        .send({ url: URL, type: "classic" });
      assert.strictEqual(res.statusCode, i <= 10 ? 200 : 429, `link ${i}`);
    }

    const res = await agent
      .post("/url")
      .set("X-Forwarded-For", "203.0.113.8, 203.0.113.7")
      .send({ url: URL, type: "classic" });

    assert.strictEqual(res.statusCode, 200);

    const limits = await DB.query(
      "SELECT ip_address, burst_count FROM rate_limits ORDER BY ip_address"
    );
    assert.deepStrictEqual(limits, [
      { ip_address: "203.0.113.7", burst_count: 11 },
      { ip_address: "203.0.113.8", burst_count: 1 },
    ]);
  });

  it("should count the visitors without X-Forwarded-For by the address they connect from", async () => {
    const agent = await anonymous();

    const res = await agent.post("/url").send({ url: URL, type: "classic" });
    assert.strictEqual(res.statusCode, 200);

    // The tests connect over IPv4 to a server that listens over both IPv6 and IPv4
    const limits = await DB.query("SELECT ip_address, burst_count FROM rate_limits");
    assert.deepStrictEqual(limits, [
      { ip_address: "::ffff:127.0.0.1", burst_count: 1 },
    ]);
  });

  it("should start counting again after 10 minutes", async () => {
    const agent = await anonymous();

    for (let i = 1; i <= 11; i++) {
      await agent
        .post("/url")
        .set("X-Forwarded-For", "203.0.113.7")
        .send({ url: URL, type: "classic" });
    }
    await DB.query(
      "UPDATE rate_limits SET burst_reset_at = NOW() - INTERVAL '11 minutes'"
    );

    const res = await agent
      .post("/url")
      .set("X-Forwarded-For", "203.0.113.7")
      .send({ url: URL, type: "classic" });

    assert.strictEqual(res.statusCode, 200);

    const limits = await DB.query(
      "SELECT burst_count, burst_reset_at > NOW() - INTERVAL '1 minute' AS reset_now FROM rate_limits"
    );
    assert.deepStrictEqual(limits, [{ burst_count: 1, reset_now: true }]);
  });

  it("should count the changes to a link as well", async () => {
    const agent = await anonymous();
    const { body } = await agent
      .post("/url")
      .set("X-Forwarded-For", "203.0.113.7")
      .send({ url: URL, type: "classic" });

    await DB.query("UPDATE rate_limits SET burst_count = 9");

    const edited = await agent
      .patch(`/url/${body.URLId}/real-url`)
      .set("X-Forwarded-For", "203.0.113.7")
      .send({ url: URL + "/pulls" });
    assert.strictEqual(edited.statusCode, 200);

    const editedAgain = await agent
      .patch(`/url/${body.URLId}/real-url`)
      .set("X-Forwarded-For", "203.0.113.7")
      .send({ url: URL + "/issues" });
    assert.strictEqual(editedAgain.statusCode, 429);
    assert.strictEqual(editedAgain.text, TOO_MANY_REQUESTS);

    const changed = await agent
      .patch(`/url/${body.URLId}/type`)
      .set("X-Forwarded-For", "203.0.113.7")
      .send({ type: "digit" });
    assert.strictEqual(changed.statusCode, 429);
    assert.strictEqual(changed.text, TOO_MANY_REQUESTS);

    // Only the first change went through
    const urls = await DB.query("SELECT real_url, link_type, shortened_url_id FROM urls");
    assert.deepStrictEqual(urls, [
      { real_url: URL + "/pulls", link_type: "classic", shortened_url_id: body.code },
    ]);
  });

  it("should not limit a logged in user by IP address", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent);

    for (let i = 1; i <= 12; i++) {
      const res = await agent
        .post("/url")
        .set("X-Forwarded-For", "203.0.113.7")
        .send({ url: URL, type: "classic" });
      assert.strictEqual(res.statusCode, 200, `link ${i}`);
    }

    // They pay with their credits instead
    const [{ link_credits }] = await DB.query(
      "SELECT link_credits FROM users WHERE id = $1",
      [user.id]
    );
    assert.strictEqual(link_credits, 13);

    const limits = await DB.query("SELECT ip_address FROM rate_limits");
    assert.strictEqual(limits.length, 0);
  });

  it("should not let a user without credits create or change a link", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent);
    const { body } = await agent.post("/url").send({ url: URL, type: "classic" });

    await DB.query("UPDATE users SET link_credits = 0 WHERE id = $1", [user.id]);

    const created = await agent.post("/url").send({ url: URL, type: "classic" });
    assert.strictEqual(created.statusCode, 402);
    assert.strictEqual(created.headers["content-type"], "application/json");
    assert.strictEqual(created.text, OUT_OF_CREDITS);

    const edited = await agent
      .patch(`/url/${body.URLId}/real-url`)
      .send({ url: URL + "/pulls" });
    assert.strictEqual(edited.statusCode, 402);
    assert.strictEqual(edited.text, OUT_OF_CREDITS);

    const urls = await DB.query("SELECT real_url FROM urls");
    assert.deepStrictEqual(urls, [{ real_url: URL }]);

    // The refused attempts don't take the credits below 0
    const [{ link_credits }] = await DB.query(
      "SELECT link_credits FROM users WHERE id = $1",
      [user.id]
    );
    assert.strictEqual(link_credits, 0);
  });

  it("should let a user use their very last credit", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent);
    await DB.query("UPDATE users SET link_credits = 1 WHERE id = $1", [user.id]);

    const last = await agent.post("/url").send({ url: URL, type: "classic" });
    assert.strictEqual(last.statusCode, 200);

    const next = await agent.post("/url").send({ url: URL, type: "classic" });
    assert.strictEqual(next.statusCode, 402);
  });

  it("should not count a request that is not valid", async () => {
    const agent = await anonymous();

    for (let i = 1; i <= 12; i++) {
      const res = await agent
        .post("/url")
        .set("X-Forwarded-For", "203.0.113.7")
        .send({ url: "not a url", type: "classic" });
      assert.strictEqual(res.statusCode, 400);
    }

    const limits = await DB.query("SELECT ip_address FROM rate_limits");
    assert.strictEqual(limits.length, 0);
  });
});
