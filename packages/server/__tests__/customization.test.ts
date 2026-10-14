import assert from "node:assert/strict";
import request from "supertest";
import { describe, it } from "mocha";
import app from "./helpers/target.js";
import { DB } from "../src/database/index.js";
import type { IUrl } from "../src/database/types.js";
import { createUser } from "./helpers/factories/user.js";

// A destination on the domain allowlist, so the server never has to ask the Web Risk API about it
const URL = "https://github.com/agile8118/weer";

// Starts an anonymous session and creates a classic link with it
const createAnonymousLink = async () => {
  const agent = request.agent(app);
  await agent.get("/auth/status");
  const { body } = await agent.post("/url").send({ url: URL, type: "classic" });
  return { agent, link: body };
};

// Creates a user and a classic link that belongs to them
const createUserLink = async (email?: string) => {
  const agent = request.agent(app);
  const user = await createUser(agent, email);
  const { body } = await agent.post("/url").send({ url: URL, type: "classic" });
  return { agent, user, link: body };
};

describe("Changing the type of a URL", () => {
  it("should change a classic link to a digit link", async () => {
    const { agent, link } = await createAnonymousLink();

    const res = await agent.patch(`/url/${link.URLId}/type`).send({ type: "digit" });

    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body.code, /^\d{3}$/);
    assert.match(res.body.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.strictEqual(
      res.text,
      JSON.stringify({
        newType: "digit",
        expiresAt: res.body.expiresAt,
        code: res.body.code,
      })
    );

    // The classic code is gone
    const url = await DB.find<IUrl>(
      "SELECT link_type, shortened_url_id FROM urls WHERE id = $1",
      [link.URLId]
    );
    assert.deepStrictEqual(url, { link_type: "digit", shortened_url_id: null });
  });

  it("should change a digit link back to a classic link", async () => {
    const { agent, link } = await createAnonymousLink();
    await agent.patch(`/url/${link.URLId}/type`).send({ type: "digit" });

    const res = await agent.patch(`/url/${link.URLId}/type`).send({ type: "classic" });

    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body.code, /^[a-kmnp-z0-9]{6}$/);
    assert.strictEqual(
      res.text,
      JSON.stringify({ newType: "classic", expiresAt: null, code: res.body.code })
    );

    // The digit code is gone
    const url = await DB.find<IUrl>(
      "SELECT link_type, shortened_url_id FROM urls WHERE id = $1",
      [link.URLId]
    );
    assert.deepStrictEqual(url, {
      link_type: "classic",
      shortened_url_id: res.body.code,
    });
    const codes = await DB.query("SELECT id FROM digit_codes");
    assert.strictEqual(codes.length, 0);
  });

  it("should give a classic link a new classic code", async () => {
    const { agent, link } = await createAnonymousLink();

    const res = await agent.patch(`/url/${link.URLId}/type`).send({ type: "classic" });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.newType, "classic");
    assert.notStrictEqual(res.body.code, link.code);
  });

  it("should change a link to a custom link", async () => {
    const { agent, link } = await createAnonymousLink();

    const res = await agent
      .patch(`/url/${link.URLId}/type`)
      .send({ type: "custom", code: "my-own-code" });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(
      res.text,
      JSON.stringify({ newType: "custom", expiresAt: null, code: "my-own-code" })
    );

    const url = await DB.find<IUrl>(
      "SELECT link_type, shortened_url_id FROM urls WHERE id = $1",
      [link.URLId]
    );
    assert.deepStrictEqual(url, {
      link_type: "custom",
      shortened_url_id: "my-own-code",
    });
  });

  it("should not change a link to a custom code that is taken", async () => {
    const other = await createAnonymousLink();
    await other.agent
      .patch(`/url/${other.link.URLId}/type`)
      .send({ type: "custom", code: "my-own-code" });

    const { agent, link } = await createAnonymousLink();
    const res = await agent
      .patch(`/url/${link.URLId}/type`)
      .send({ type: "custom", code: "my-own-code" });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.text, JSON.stringify({ error: "Code is not available" }));
  });

  it("should change a link of a user to an ultra link", async () => {
    const { agent, link } = await createUserLink();

    const res = await agent.patch(`/url/${link.URLId}/type`).send({ type: "ultra" });

    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.strictEqual(
      res.text,
      JSON.stringify({ newType: "ultra", expiresAt: res.body.expiresAt, code: "0" })
    );

    const url = await DB.find<IUrl>(
      "SELECT link_type, shortened_url_id FROM urls WHERE id = $1",
      [link.URLId]
    );
    assert.deepStrictEqual(url, { link_type: "ultra", shortened_url_id: null });
  });

  it("should free the ultra code when the link changes to another type", async () => {
    const { agent, link } = await createUserLink();
    await agent.patch(`/url/${link.URLId}/type`).send({ type: "ultra" });

    const res = await agent.patch(`/url/${link.URLId}/type`).send({ type: "digit" });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.newType, "digit");

    const codes = await DB.query(
      "SELECT url_id, assigned_at, expires_at FROM ultra_codes WHERE code = '0'"
    );
    assert.deepStrictEqual(codes, [
      { url_id: null, assigned_at: null, expires_at: null },
    ]);
  });

  it("should change a link of a user to an affix link", async () => {
    const { agent, user, link } = await createUserLink();

    const res = await agent
      .patch(`/url/${link.URLId}/type`)
      .send({ type: "affix", code: "portfolio" });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(
      res.text,
      JSON.stringify({ newType: "affix", expiresAt: null, code: "portfolio" })
    );

    const url = await DB.find<IUrl>(
      "SELECT link_type, shortened_url_id, user_id FROM urls WHERE id = $1",
      [link.URLId]
    );
    assert.deepStrictEqual(url, {
      link_type: "affix",
      shortened_url_id: "portfolio",
      user_id: user.id,
    });
  });

  it("should let two users have the same affix code, but not one user twice", async () => {
    const first = await createUserLink("first@example.com");
    await first.agent
      .patch(`/url/${first.link.URLId}/type`)
      .send({ type: "affix", code: "portfolio" });

    const second = await createUserLink("second@example.com");
    const res = await second.agent
      .patch(`/url/${second.link.URLId}/type`)
      .send({ type: "affix", code: "portfolio" });
    assert.strictEqual(res.statusCode, 200);

    const another = await first.agent.post("/url").send({ url: URL, type: "classic" });
    const taken = await first.agent
      .patch(`/url/${another.body.URLId}/type`)
      .send({ type: "affix", code: "portfolio" });

    assert.strictEqual(taken.statusCode, 400);
    assert.strictEqual(taken.text, JSON.stringify({ error: "Code is not available" }));
  });

  it("should not give an anonymous visitor an ultra or an affix link", async () => {
    for (const body of [{ type: "ultra" }, { type: "affix", code: "portfolio" }]) {
      const { agent, link } = await createAnonymousLink();

      const res = await agent.patch(`/url/${link.URLId}/type`).send(body);

      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.text, JSON.stringify({ error: "Unauthorized" }));
    }
  });

  it("should not change a link to a type that does not exist", async () => {
    const { agent, link } = await createAnonymousLink();

    const res = await agent.patch(`/url/${link.URLId}/type`).send({ type: "qr" });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.text, JSON.stringify({ error: "Invalid type" }));
  });

  it("should ask for the new type if there is none", async () => {
    const { agent, link } = await createAnonymousLink();

    for (const body of [{}, { type: "" }, { type: null }]) {
      const res = await agent.patch(`/url/${link.URLId}/type`).send(body);

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.text, JSON.stringify({ message: "Missing parameters" }));
    }

    // Nothing has happened to the link
    const url = await DB.find<IUrl>(
      "SELECT link_type, shortened_url_id FROM urls WHERE id = $1",
      [link.URLId]
    );
    assert.deepStrictEqual(url, {
      link_type: "classic",
      shortened_url_id: link.code,
    });
  });

  it("should not change the type of the link of someone else", async () => {
    const owner = await createAnonymousLink();
    const user = await createUserLink();

    const stranger = request.agent(app);
    await stranger.get("/auth/status");

    for (const agent of [stranger, user.agent, request.agent(app)]) {
      const res = await agent
        .patch(`/url/${owner.link.URLId}/type`)
        .send({ type: "digit" });

      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.text, JSON.stringify({ error: "Not allowed to access." }));
    }

    // The same goes for the link of a user
    const res = await stranger
      .patch(`/url/${user.link.URLId}/type`)
      .send({ type: "digit" });
    assert.strictEqual(res.statusCode, 403);

    const urls = await DB.findMany<IUrl>(
      "SELECT link_type, shortened_url_id FROM urls ORDER BY id"
    );
    assert.deepStrictEqual(urls, [
      { link_type: "classic", shortened_url_id: owner.link.code },
      { link_type: "classic", shortened_url_id: user.link.code },
    ]);
  });

  it("should take one credit from a logged in user", async () => {
    const { agent, user, link } = await createUserLink();

    await agent.patch(`/url/${link.URLId}/type`).send({ type: "digit" });

    // One for creating the link, and one for changing its type
    const [{ link_credits }] = await DB.query(
      "SELECT link_credits FROM users WHERE id = $1",
      [user.id]
    );
    assert.strictEqual(link_credits, 98);
  });

  it("should leave the link alone if the user is out of credits", async () => {
    const { agent, user, link } = await createUserLink();
    await DB.query("UPDATE users SET link_credits = 0 WHERE id = $1", [user.id]);

    const res = await agent.patch(`/url/${link.URLId}/type`).send({ type: "digit" });

    assert.strictEqual(res.statusCode, 402);
    assert.strictEqual(
      res.text,
      JSON.stringify({
        error:
          "You've used all your credits. Please contact support to increase your limit for free.",
      })
    );

    const url = await DB.find<IUrl>(
      "SELECT link_type, shortened_url_id FROM urls WHERE id = $1",
      [link.URLId]
    );
    assert.deepStrictEqual(url, {
      link_type: "classic",
      shortened_url_id: link.code,
    });
    const codes = await DB.query("SELECT id FROM digit_codes");
    assert.strictEqual(codes.length, 0);
  });
});

describe("Checking if a code is available", () => {
  it("should tell if a custom code is available", async () => {
    const res = await request(app).get("/url/custom-availability/my-own-code");

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.text, JSON.stringify({ available: true }));
  });

  it("should tell if a custom code is taken", async () => {
    const { agent, link } = await createAnonymousLink();
    await agent
      .patch(`/url/${link.URLId}/type`)
      .send({ type: "custom", code: "my-own-code" });

    const res = await request(app).get("/url/custom-availability/my-own-code");

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.text, JSON.stringify({ available: false }));
  });

  it("should tell if an affix code is available for the user", async () => {
    const first = await createUserLink("first@example.com");
    await first.agent
      .patch(`/url/${first.link.URLId}/type`)
      .send({ type: "affix", code: "portfolio" });

    const second = request.agent(app);
    await createUser(second, "second@example.com");

    const taken = await first.agent.get("/url/affix-availability/portfolio");
    assert.strictEqual(taken.statusCode, 200);
    assert.strictEqual(taken.text, JSON.stringify({ available: false }));

    // Affix codes are per user, so the same code is free for everyone else
    const free = await second.get("/url/affix-availability/portfolio");
    assert.strictEqual(free.text, JSON.stringify({ available: true }));

    const anonymous = await request(app).get("/url/affix-availability/portfolio");
    assert.strictEqual(anonymous.statusCode, 200);
    assert.strictEqual(anonymous.text, JSON.stringify({ available: true }));
  });

  it("should decode the code in the URL", async () => {
    const { agent, link } = await createAnonymousLink();
    await agent
      .patch(`/url/${link.URLId}/type`)
      .send({ type: "custom", code: "my code/é" });

    const res = await request(app).get(
      "/url/custom-availability/my%20code%2F%C3%A9"
    );

    assert.strictEqual(res.text, JSON.stringify({ available: false }));
  });
});
