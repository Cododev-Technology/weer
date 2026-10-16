import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import { describe, it } from "mocha";
import app from "./helpers/target.js";
import { logSize, waitForLog } from "./helpers/logs.js";

// A destination on the domain allowlist, so the server never has to ask the Web Risk API about it
const URL = "https://github.com/agile8118/weer";

// Something to tell our own request apart from all the other ones in the log file
const marker = () => "log=" + crypto.randomBytes(8).toString("hex");

// Finds the line of the request with this marker in info.log
const requestLine = async (id: string): Promise<string> => {
  const log = await waitForLog("info.log", id);
  return log.split("\n").find((line) => line.includes(id))!;
};

describe("Logs", () => {
  it("should log every request with its status and how long it took", async () => {
    const id = marker();

    await request(app).get("/auth/status?" + id);

    // Like: 2026-01-15 10:20:30 -- ::ffff:127.0.0.1 -- GET /auth/status?log=... 200 OK -- response-time: 3 ms
    assert.match(
      await requestLine(id),
      new RegExp(
        `^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} -- ::ffff:127\\.0\\.0\\.1 -- GET /auth/status\\?${id} 200 OK -- response-time: \\d+\\.\\d{2} ms$`
      )
    );
  });

  it("should log the date and time in UTC", async () => {
    const id = marker();

    const before = Date.now();
    await request(app).get("/auth/status?" + id);
    const after = Date.now();

    const line = await requestLine(id);
    const loggedAt = new Date(line.slice(0, 19).replace(" ", "T") + "Z").getTime();

    // The log only has the seconds
    assert.ok(loggedAt >= before - 1000 && loggedAt <= after);
  });

  it("should log the IP address that a proxy passes on", async () => {
    const id = marker();

    await request(app)
      .get("/auth/status?" + id)
      .set("X-Forwarded-For", "203.0.113.7, 10.0.0.1");

    assert.match(
      await requestLine(id),
      new RegExp(` -- 203\\.0\\.113\\.7, 10\\.0\\.0\\.1 -- GET /auth/status\\?${id} 200 OK -- `)
    );
  });

  it("should log the method, the URL as it came in and the status message", async () => {
    const requests: [string, string, string][] = [
      ["get", "/logout", "302 Found"],
      ["get", "/user/username-availability/joe", "200 OK"],
      ["post", "/url", "400 Bad Request"],
      ["delete", "/url/12345", "403 Forbidden"],
      ["get", "/nope/nope%20nope/nope", "404 Not Found"],
      ["get", "/abc/", "500 Internal Server Error"],
    ];

    for (const [method, path, status] of requests) {
      const id = marker();
      const url = `${path}?a=1&${id}&b=%20c`;

      await (request(app) as any)[method](url).send(method === "post" ? {} : undefined);

      assert.ok(
        (await requestLine(id)).includes(
          ` -- ${method.toUpperCase()} ${url} ${status} -- response-time: `
        ),
        `${method} ${path}`
      );
    }
  });
});

describe("Unexpected errors", () => {
  it("should answer with a 500 and keep the details to itself", async () => {
    // A link without a session to own it (the database refuses that one), and a URL
    // that ends up without a code
    const responses = [
      await request(app).post("/url").send({ url: URL, type: "classic" }),
      await request(app).get("/abc/"),
    ];

    for (const res of responses) {
      assert.strictEqual(res.statusCode, 500);
      assert.strictEqual(res.headers["content-type"], "application/json");
      assert.strictEqual(res.headers["connection"], "close");
      assert.strictEqual(
        res.text,
        JSON.stringify({
          error: "Sorry, something unexpected happened from our side.",
        })
      );
    }
  });

  it("should log the error of the database in errors.log", async () => {
    const from = logSize("errors.log");

    await request(app).post("/url").send({ url: URL, type: "classic" });

    const message = 'new row for relation "urls" violates check constraint "chk_owner"';
    const log = await waitForLog("errors.log", message, from);

    // After these lines comes the stack trace, up to the closing line of dashes
    assert.match(
      log,
      new RegExp(
        `^-{39}\\n\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\nError Name: (error\\nError Message: ${message}|Error\\nError Message: error returned from database: ${message}[^\\n]*)\\nError Stack:\\n[^]+\\n-{39}\\n$`
      )
    );
  });

  it("should log an error of our own in errors.log", async () => {
    const from = logSize("errors.log");

    await request(app).get("/abc/");

    const log = await waitForLog("errors.log", "No URL ID provided", from);

    assert.match(
      log,
      new RegExp(
        `^-{39}\\n\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\nError Name: Error\\nError Message: No URL ID provided\\nError Stack:\\n[^]+\\n-{39}\\n$`
      )
    );
  });

  it("should not log the errors that are sent to the client", async () => {
    const from = logSize("errors.log");

    const res = await request(app).delete("/url/12345");
    assert.strictEqual(res.statusCode, 403);

    // The request is in info.log by now, so the error would have been logged too
    const id = marker();
    await request(app).get("/auth/status?" + id);
    await requestLine(id);

    assert.strictEqual(logSize("errors.log"), from);
  });
});
