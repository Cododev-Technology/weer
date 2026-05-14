import assert from "node:assert/strict";
import request from "supertest";
import { describe, it } from "mocha";
import app from "../src/app.js";

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
});