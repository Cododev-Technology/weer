import assert from "node:assert/strict";
import request from "supertest";
import { describe, it } from "mocha";
import app from "./helpers/target.js";
import { DB } from "../src/database/index.js";
import type { ISession, IUser } from "../src/database/types.js";
import keys from "../src/config/keys.js";
import { createUser, logIn, signCookie } from "./helpers/factories/user.js";

// What the server sends to remove the uid cookie
const CLEARED_UID_COOKIE =
  "uid=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";

describe("Auth Endpoints", () => {
  it("should start an anonymous session for a new visitor", async () => {
    const res = await request(app).get("/auth/status");

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["content-type"], "application/json");
    assert.strictEqual(res.text, JSON.stringify({ isSignedIn: false }));

    // The session token is 16 random bytes in hex, in a signed cookie that lasts for 30 days
    const cookies = res.headers["set-cookie"];
    assert.strictEqual(cookies.length, 1);
    assert.match(
      cookies[0],
      /^session_token=s%3A[0-9a-f]{32}\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly$/
    );

    const sessions = await DB.findMany<ISession>(
      "SELECT session_token FROM sessions"
    );
    assert.strictEqual(sessions.length, 1);
    assert.ok(cookies[0].includes(sessions[0].session_token));
  });

  it("should keep the same session on the next visits", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");

    await DB.query(
      "UPDATE sessions SET last_active = NOW() - INTERVAL '1 hour'"
    );

    const res = await agent.get("/auth/status");

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { isSignedIn: false });
    assert.strictEqual(res.headers["set-cookie"], undefined);

    // Still the one session, and it was marked as active again
    const sessions = await DB.query(
      "SELECT last_active > NOW() - INTERVAL '1 minute' AS active FROM sessions"
    );
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].active, true);
  });

  it("should start a new session if the session cookie was tampered with", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");

    const session = await DB.find<ISession>(
      "SELECT session_token FROM sessions"
    );

    const res = await request(app)
      .get("/auth/status")
      .set(
        "Cookie",
        `session_token=s%3A${session!.session_token}.not-the-right-signature`
      );

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { isSignedIn: false });
    assert.strictEqual(res.headers["set-cookie"].length, 1);
    assert.ok(!res.headers["set-cookie"][0].includes(session!.session_token));
  });

  it("should start a new session if the session has expired", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");

    await DB.query("UPDATE sessions SET expires_at = NOW() - INTERVAL '1 day'");

    const res = await agent.get("/auth/status");

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { isSignedIn: false });
    assert.strictEqual(res.headers["set-cookie"].length, 1);

    const sessions = await DB.findMany<ISession>("SELECT id FROM sessions");
    assert.strictEqual(sessions.length, 2);
  });

  it("should return the info of a logged in user", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent, "joe@example.com");

    const res = await agent.get("/auth/status");

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(
      res.text,
      JSON.stringify({
        isSignedIn: true,
        email: "joe@example.com",
        linkCredits: 100,
        usernames: [],
      })
    );

    // A logged in user doesn't get an anonymous session
    assert.strictEqual(res.headers["set-cookie"], undefined);
    assert.strictEqual(user.link_credits, 100);
  });

  it("should return the usernames of a logged in user", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent);

    await DB.query(
      `INSERT INTO usernames (user_id, username, active, expires_at) VALUES
        ($1, 'current', true, NULL),
        ($1, 'older', false, '2040-01-15T10:20:30.123456Z'),
        ($1, 'oldest', false, '2040-01-10T10:20:30Z')`,
      [user.id]
    );

    const res = await agent.get("/auth/status");

    assert.strictEqual(res.statusCode, 200);

    // The ones that expire the soonest come first, and the active one (that never expires) comes last
    const usernames = res.body.usernames;
    assert.deepStrictEqual(
      usernames.map((u: any) => [u.value, u.active]),
      [
        ["oldest", false],
        ["older", false],
        ["current", true],
      ]
    );
    assert.deepStrictEqual(Object.keys(usernames[0]), [
      "value",
      "expires_at",
      "active",
    ]);

    // The dates come straight from PostgreSQL (as JSON), in the time zone of the database session
    assert.match(
      usernames[1].expires_at,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.123456[+-]\d{2}:\d{2}$/
    );
    assert.strictEqual(
      new Date(usernames[1].expires_at).toISOString(),
      "2040-01-15T10:20:30.123Z"
    );
    assert.strictEqual(
      new Date(usernames[0].expires_at).toISOString(),
      "2040-01-10T10:20:30.000Z"
    );
    assert.strictEqual(usernames[2].expires_at, null);
  });

  it("should log out a user whose account does not exist anymore", async () => {
    const agent = request.agent(app);
    logIn(agent, 12345);

    const res = await agent.get("/auth/status");

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { isSignedIn: false });
    assert.deepStrictEqual(res.headers["set-cookie"], [CLEARED_UID_COOKIE]);
  });

  it("should not log a user in with a uid cookie that is not signed by us", async () => {
    const user = await DB.insert<IUser>("users", { email: "joe@example.com" });

    // The signature of another value, and no signature at all
    const forged = signCookie("999").replace("999", String(user.id));
    const unsigned = String(user.id);

    for (const uid of [forged, unsigned]) {
      const res = await request(app)
        .get("/auth/status")
        .set("Cookie", `uid=${uid}`);

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.body, { isSignedIn: false });
    }
  });

  it("should log the user out", async () => {
    const agent = request.agent(app);
    await createUser(agent);

    const res = await agent.get("/logout");

    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers.location, "/");
    assert.deepStrictEqual(res.headers["set-cookie"], [CLEARED_UID_COOKIE]);

    // The agent has dropped the cookie, so it is an anonymous visitor again
    const status = await agent.get("/auth/status");
    assert.deepStrictEqual(status.body, { isSignedIn: false });
  });

  it("should send the user to Google to log in", async () => {
    const res = await request(app).get("/auth/google");

    const params = new URLSearchParams({
      client_id: keys.googleClientID,
      redirect_uri: `${keys.domain}/auth/google/callback`,
      response_type: "code",
      scope: "profile email",
      access_type: "online",
    });

    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(
      res.headers.location,
      `https://accounts.google.com/o/oauth2/v2/auth?${params}`
    );
    assert.ok(res.headers.location.includes("&scope=profile+email&"));
  });

  it("should go back to the home page if Google did not send a code", async () => {
    const res = await request(app).get("/auth/google/callback");

    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers.location, "/");
    assert.strictEqual(res.headers["set-cookie"], undefined);
  });
});
