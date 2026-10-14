import assert from "node:assert/strict";
import request from "supertest";
import { describe, it } from "mocha";
import app from "./helpers/target.js";
import { DB } from "../src/database/index.js";
import type { IUrl } from "../src/database/types.js";
import { signUpAndLogIn } from "./helpers/factories/auth.js";
import { createClassicLink } from "./helpers/factories/url.js";

describe("URL Endpoints", () => {
  it("should create a new classic shortened url", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");

    const res = await agent.post("/url").send({
      url: "http://www.example.com",
      type: "classic",
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(Object.prototype.hasOwnProperty.call(res.body, "code"));
    assert.strictEqual(res.body.realURL, "http://www.example.com");
  });

  it("should create a new digit shortened url", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");

    const res = await agent.post("/url").send({
      url: "http://www.example.com",
      type: "digit",
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(Object.prototype.hasOwnProperty.call(res.body, "code"));
    assert.strictEqual(res.body.realURL, "http://www.example.com");
  });

  it("should not create a new classic shortened url if the url is not valid", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");

    const res = await agent.post("/url").send({
      url: "random text",
      type: "classic",
    });

    assert.strictEqual(res.statusCode, 400);
  });

  it("does not change a url's type when the user has no link credits left", async () => {
    const agent = request.agent(app);
    const email = "no-credits-test@example.com";

    const userId = await signUpAndLogIn(agent, email);
    const created = await createClassicLink(agent);

    // Simulate credit balance of zero
    await DB.query("UPDATE users SET link_credits = 0 WHERE id = $1", [userId]);

    const res = await agent
      .patch(`/url/${created.URLId}/type`)
      .send({ type: "custom", code: "brandNewCustomCode" });

    assert.strictEqual(res.statusCode, 402);

    const urlRow = await DB.find<IUrl>("SELECT * FROM urls WHERE id = $1", [
      created.URLId,
    ]);
    assert.strictEqual(urlRow?.link_type, "classic");
    assert.strictEqual(urlRow?.shortened_url_id, created.code);
  });
});
