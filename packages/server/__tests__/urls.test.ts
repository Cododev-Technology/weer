import assert from "node:assert/strict";
import request from "supertest";
import { describe, it } from "mocha";
import app from "./helpers/target.js";
import { DB } from "../src/database/index.js";
import type { IUrl } from "../src/database/types.js";
import keys from "../src/config/keys.js";
import { createUser } from "./helpers/factories/user.js";

// A destination on the domain allowlist, so the server never has to ask the Web Risk API about it
const URL = "https://github.com/agile8118/weer";

describe("Listing the URLs", () => {
  it("should return nothing for a visitor without a session", async () => {
    const res = await request(app).get("/url");

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(
      res.text,
      JSON.stringify({ urls: [], domain: keys.domain })
    );
  });

  it("should return nothing for a session that does not exist anymore", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");
    await DB.query("DELETE FROM sessions");

    const res = await agent.get("/url");

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { urls: [], domain: keys.domain });
  });

  it("should return the links of the session, newest first", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");

    const classic = await agent.post("/url").send({ url: URL, type: "classic" });
    const digit = await agent.post("/url").send({ url: URL + "/issues", type: "digit" });

    const res = await agent.get("/url");

    assert.strictEqual(res.statusCode, 200);

    // Digit codes come with the dates they were assigned and expire at
    const [first] = res.body.urls;
    assert.match(first.assigned_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Math.abs(new Date(first.assigned_at).getTime() - Date.now()) < 60_000);

    // The values that are null in the database are left out
    assert.strictEqual(
      res.text,
      JSON.stringify({
        urls: [
          {
            id: digit.body.URLId,
            real_url: URL + "/issues",
            link_type: "digit",
            code: digit.body.code,
            assigned_at: first.assigned_at,
            expires_at: digit.body.expiresAt,
          },
          {
            id: classic.body.URLId,
            real_url: URL,
            link_type: "classic",
            code: classic.body.code,
          },
        ],
        domain: keys.domain,
      })
    );
  });

  it("should return the links of the logged in user", async () => {
    const agent = request.agent(app);
    await createUser(agent);

    const ultra = await agent.post("/url").send({ url: URL, type: "ultra" });

    const res = await agent.get("/url");

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.urls.length, 1);
    assert.deepStrictEqual(Object.keys(res.body.urls[0]), [
      "id",
      "real_url",
      "link_type",
      "code",
      "assigned_at",
      "expires_at",
    ]);
    assert.strictEqual(res.body.urls[0].code, "0");
    assert.strictEqual(res.body.urls[0].link_type, "ultra");
    assert.strictEqual(res.body.urls[0].expires_at, ultra.body.expiresAt);
  });

  it("should not return the links of someone else", async () => {
    const owner = request.agent(app);
    await owner.get("/auth/status");
    await owner.post("/url").send({ url: URL, type: "classic" });

    const user = request.agent(app);
    await createUser(user);
    await user.post("/url").send({ url: URL, type: "classic" });

    const stranger = request.agent(app);
    await stranger.get("/auth/status");
    const res = await stranger.get("/url");

    assert.deepStrictEqual(res.body, { urls: [], domain: keys.domain });
  });
});

describe("Deleting a URL", () => {
  it("should delete a link of the session", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");
    const { body } = await agent.post("/url").send({ url: URL, type: "digit" });

    const res = await agent.delete("/url/" + body.URLId);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.text, JSON.stringify({ message: "deleted" }));

    // Its digit code goes with it
    const urls = await DB.findMany<IUrl>("SELECT id FROM urls");
    const codes = await DB.query("SELECT id FROM digit_codes");
    assert.strictEqual(urls.length, 0);
    assert.strictEqual(codes.length, 0);
  });

  it("should free the ultra code of a deleted link", async () => {
    const agent = request.agent(app);
    await createUser(agent);
    const { body } = await agent.post("/url").send({ url: URL, type: "ultra" });

    const res = await agent.delete("/url/" + body.URLId);

    assert.strictEqual(res.statusCode, 200);

    const taken = await DB.query(
      "SELECT code FROM ultra_codes WHERE url_id IS NOT NULL"
    );
    assert.strictEqual(taken.length, 0);

    // The next ultra link gets the same code again
    const next = await agent.post("/url").send({ url: URL, type: "ultra" });
    assert.strictEqual(next.body.code, body.code);
  });

  it("should not delete a link of someone else", async () => {
    const owner = request.agent(app);
    await owner.get("/auth/status");
    const { body } = await owner.post("/url").send({ url: URL, type: "classic" });

    const stranger = request.agent(app);
    await stranger.get("/auth/status");
    const user = request.agent(app);
    await createUser(user);

    for (const agent of [stranger, user, request.agent(app)]) {
      const res = await agent.delete("/url/" + body.URLId);

      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(
        res.text,
        JSON.stringify({ error: "Not allowed to access." })
      );
    }

    const urls = await DB.findMany<IUrl>("SELECT id FROM urls");
    assert.strictEqual(urls.length, 1);
  });

  it("should not let an anonymous visitor delete the link of a user", async () => {
    const user = request.agent(app);
    await createUser(user);
    const { body } = await user.post("/url").send({ url: URL, type: "classic" });

    // With and without a session
    const stranger = request.agent(app);
    await stranger.get("/auth/status");

    for (const agent of [stranger, request.agent(app)]) {
      const res = await agent.delete("/url/" + body.URLId);
      assert.strictEqual(res.statusCode, 403);
    }
  });

  it("should not delete a link that does not exist", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");

    const res = await agent.delete("/url/12345");

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(
      res.text,
      JSON.stringify({ error: "Not allowed to access." })
    );
  });

  it("should not accept an id that is not a number", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");

    for (const id of ["abc", "0", "12abc", "NaN"]) {
      const res = await agent.delete("/url/" + id);

      assert.strictEqual(res.statusCode, 400, id);
      assert.strictEqual(res.text, JSON.stringify({ error: "Invalid URL ID." }));
    }
  });

  it("should not accept a number that cannot be an id", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");

    // An id is only digits, and not more than the database can hold
    for (const id of ["12.5", "1e3", "-5", "+5", "0x10", "2147483648", "99999999999"]) {
      const res = await agent.delete("/url/" + id);

      assert.strictEqual(res.statusCode, 400, id);
      assert.strictEqual(res.text, JSON.stringify({ error: "Invalid URL ID." }));
    }

    // The biggest id there can be is fine, there just is no such link
    const res = await agent.delete("/url/2147483647");
    assert.strictEqual(res.statusCode, 403);
  });
});

describe("Updating the destination of a URL", () => {
  it("should update the destination of a link", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");
    const { body } = await agent.post("/url").send({ url: URL, type: "classic" });

    const res = await agent
      .patch(`/url/${body.URLId}/real-url`)
      .send({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(
      res.text,
      JSON.stringify({ realUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })
    );

    const url = await DB.find<IUrl>(
      "SELECT real_url, shortened_url_id FROM urls WHERE id = $1",
      [body.URLId]
    );
    assert.deepStrictEqual(url, {
      real_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      shortened_url_id: body.code,
    });
  });

  it("should take one credit from a logged in user", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent);
    const { body } = await agent.post("/url").send({ url: URL, type: "classic" });

    await agent.patch(`/url/${body.URLId}/real-url`).send({ url: URL + "/pulls" });

    const [{ link_credits }] = await DB.query(
      "SELECT link_credits FROM users WHERE id = $1",
      [user.id]
    );
    assert.strictEqual(link_credits, 98);
  });

  it("should not update the destination to a URL that is not valid", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");
    const { body } = await agent.post("/url").send({ url: URL, type: "classic" });

    const missing = await agent.patch(`/url/${body.URLId}/real-url`).send({});
    assert.strictEqual(missing.statusCode, 400);
    assert.strictEqual(
      missing.text,
      JSON.stringify({ error: "Please first put your URL here." })
    );

    const invalid = await agent
      .patch(`/url/${body.URLId}/real-url`)
      .send({ url: "not a url" });
    assert.strictEqual(invalid.statusCode, 400);
    assert.strictEqual(
      invalid.text,
      JSON.stringify({ error: "The URL you put is not valid." })
    );

    const url = await DB.find<IUrl>("SELECT real_url FROM urls");
    assert.strictEqual(url!.real_url, URL);
  });

  it("should not update the destination of the link of someone else", async () => {
    const owner = request.agent(app);
    await owner.get("/auth/status");
    const { body } = await owner.post("/url").send({ url: URL, type: "classic" });

    const stranger = request.agent(app);
    await stranger.get("/auth/status");

    const res = await stranger
      .patch(`/url/${body.URLId}/real-url`)
      .send({ url: URL + "/pulls" });

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(
      res.text,
      JSON.stringify({ error: "Not allowed to access." })
    );

    const url = await DB.find<IUrl>("SELECT real_url FROM urls");
    assert.strictEqual(url!.real_url, URL);
  });
});
