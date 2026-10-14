import assert from "node:assert/strict";
import request from "supertest";
import { describe, it } from "mocha";
import app from "./helpers/target.js";
import { DB } from "../src/database/index.js";
import { createUser } from "./helpers/factories/user.js";

// A destination on the domain allowlist, so the server never has to ask the Web Risk API about it
const URL = "https://github.com/agile8118/weer";

// Creates a link for a new anonymous session, and returns its QR code id as well
const createLink = async () => {
  const agent = request.agent(app);
  await agent.get("/auth/status");
  const { body } = await agent.post("/url").send({ url: URL, type: "classic" });
  const [{ qr_code_id }] = await DB.query(
    "SELECT qr_code_id FROM urls WHERE id = $1",
    [body.URLId]
  );
  return { agent, id: body.URLId, qrCodeId: qr_code_id };
};

// The width and height of a PNG image are in its first chunk (IHDR)
const pngSize = (png: Buffer) => {
  assert.strictEqual(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.strictEqual(png.subarray(12, 16).toString("latin1"), "IHDR");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
};

describe("QR Codes", () => {
  it("should send the QR code of a link as an SVG", async () => {
    const { agent, id } = await createLink();

    const res = await agent.get(`/qr/${id}`);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["content-type"], "image/svg+xml");
    assert.strictEqual(res.headers["content-disposition"], undefined);

    // How the code is drawn is up to the package that draws it, so only the SVG around it is checked
    const svg = res.body.toString();
    assert.match(
      svg,
      /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]* viewBox="0 0 (\d+) \1"[^>]*>.+<\/svg>\s*$/
    );
  });

  it("should send the same SVG every time", async () => {
    const { agent, id } = await createLink();

    const first = await agent.get(`/qr/${id}`);
    const second = await agent.get(`/qr/${id}?type=svg&size=1024`);

    assert.strictEqual(first.body.toString(), second.body.toString());
  });

  it("should send the QR code as a PNG of 512 pixels by default", async () => {
    const { agent, id } = await createLink();

    for (const query of ["?type=png", "?type=png&size=300", "?type=png&size=abc"]) {
      const res = await agent.get(`/qr/${id}${query}`);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers["content-type"], "image/png");
      assert.deepStrictEqual(pngSize(res.body), { width: 512, height: 512 });
    }
  });

  it("should send the QR code as a PNG of the given size", async () => {
    const { agent, id } = await createLink();

    for (const size of [256, 512, 1024, 2048]) {
      const res = await agent.get(`/qr/${id}?type=png&size=${size}`);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers["content-type"], "image/png");
      assert.deepStrictEqual(pngSize(res.body), { width: size, height: size });
    }
  });

  it("should send the QR code as a file to download", async () => {
    const { agent, id, qrCodeId } = await createLink();

    const svg = await agent.get(`/qr/${id}?download=true`);
    assert.strictEqual(svg.statusCode, 200);
    assert.strictEqual(
      svg.headers["content-disposition"],
      `attachment; filename="${qrCodeId}.svg"`
    );

    const png = await agent.get(`/qr/${id}?download=true&type=png&size=256`);
    assert.strictEqual(png.statusCode, 200);
    assert.strictEqual(
      png.headers["content-disposition"],
      `attachment; filename="${qrCodeId}.png"`
    );

    // Only when it's exactly "true"
    const inline = await agent.get(`/qr/${id}?download=1`);
    assert.strictEqual(inline.headers["content-disposition"], undefined);
  });

  it("should send the QR code of a link of a logged in user", async () => {
    const agent = request.agent(app);
    await createUser(agent);
    const { body } = await agent.post("/url").send({ url: URL, type: "classic" });

    const res = await agent.get(`/qr/${body.URLId}`);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["content-type"], "image/svg+xml");
  });

  it("should not send the QR code of the link of someone else", async () => {
    const { id } = await createLink();

    const user = request.agent(app);
    await createUser(user);

    for (const agent of [user, request.agent(app)]) {
      const res = await agent.get(`/qr/${id}?type=png`);

      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.headers["content-type"], "application/json");
      assert.strictEqual(
        res.text,
        JSON.stringify({ error: "Not allowed to access." })
      );
    }
  });
});
