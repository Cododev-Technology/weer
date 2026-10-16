import assert from "node:assert/strict";
import fs from "node:fs";
import request from "supertest";
import { describe, it } from "mocha";
import app from "./helpers/target.js";

const publicPath = new URL("../../server-shared/public", import.meta.url)
  .pathname;

const read = (file: string) => fs.readFileSync(publicPath + file);

describe("Pages and static files", () => {
  it("should show the home page", async () => {
    const res = await request(app).get("/");

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["content-type"], "text/html");
    assert.strictEqual(res.text, read("/index.html").toString());
  });

  it("should show the terms and the privacy pages", async () => {
    for (const page of ["terms", "privacy"]) {
      const res = await request(app).get("/" + page);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers["content-type"], "text/html");
      assert.strictEqual(res.text, read(`/${page}.html`).toString());
    }
  });

  it("should serve the files of the public folder", async () => {
    const files: [string, string][] = [
      ["/index.html", "text/html"],
      ["/404.html", "text/html"],
      ["/logo.svg", "image/svg+xml"],
      ["/google-icon.svg", "image/svg+xml"],
      ["/favicons/favicon.ico", "image/x-icon"],
      ["/favicons/favicon-96x96.png", "image/png"],
      ["/favicons/site.webmanifest", "application/manifest+json"],
    ];

    for (const [file, mime] of files) {
      const res = await request(app).get(file + "?v=1").buffer(true).parse(binary);

      assert.strictEqual(res.statusCode, 200, file);
      assert.strictEqual(res.headers["content-type"], mime, file);
      assert.ok(read(file).equals(res.body), file);
    }
  });

  it("should compress the pages for the browsers that ask for it", async () => {
    const res = await request(app).get("/").set("Accept-Encoding", "gzip");

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["content-encoding"], "gzip");
    assert.strictEqual(res.headers["vary"], "Accept-Encoding");
    assert.strictEqual(res.text, read("/index.html").toString());

    const plain = await request(app).get("/").set("Accept-Encoding", "identity");

    assert.strictEqual(plain.headers["content-encoding"], undefined);
    assert.strictEqual(plain.text, read("/index.html").toString());
  });

  it("should show the 404 page for a path that does not exist", async () => {
    const responses = [
      await request(app).get("/this/does/not/exist"),
      await request(app).get("/scripts/nope.js"),
      await request(app).post("/this-is-not-a-route").send({ a: 1 }),
      await request(app).delete("/auth/status"),
    ];

    for (const res of responses) {
      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(res.headers["content-type"], "text/html");
      assert.strictEqual(res.text, read("/404.html").toString());
    }
  });
});

// Keeps the body of a response as it is, whatever its type
function binary(res: any, callback: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
}
