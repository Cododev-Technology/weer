import assert from "node:assert/strict";
import request from "supertest";
import { describe, it } from "mocha";
import app from "./helpers/target.js";
import { DB } from "../src/database/index.js";
import type { IUsername } from "../src/database/types.js";
import { createUser } from "./helpers/factories/user.js";

describe("User Endpoints", () => {
  it("should not let anonymous visitors use the username routes", async () => {
    const agent = request.agent(app);
    await agent.get("/auth/status");

    const responses = [
      await agent.get("/user/username-availability/joe"),
      await agent.patch("/user/username").send({ username: "joe" }),
      await agent.patch("/user/username/switch").send({ username: "joe" }),
    ];

    for (const res of responses) {
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.text, JSON.stringify({ error: "Unauthorized" }));
    }
  });

  it("should tell if a username is available", async () => {
    const agent = request.agent(app);
    await createUser(agent);

    const res = await agent.get("/user/username-availability/joe");

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.text, JSON.stringify({ available: true }));
  });

  it("should tell if a username is taken, whatever the letter case", async () => {
    const owner = request.agent(app);
    await createUser(owner, "owner@example.com");
    await owner.patch("/user/username").send({ username: "Joe" });

    const agent = request.agent(app);
    await createUser(agent);

    for (const username of ["joe", "JOE", "Joe"]) {
      const res = await agent.get("/user/username-availability/" + username);

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.body, { available: false });
    }
  });

  it("should set the first username of a user", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent);

    const res = await agent.patch("/user/username").send({ username: "Joe" });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(
      res.text,
      JSON.stringify({ message: "Username updated successfully" })
    );

    // Usernames are saved in lower case
    const usernames = await DB.findMany<IUsername>(
      "SELECT username, active, expires_at FROM usernames WHERE user_id = $1",
      [user.id]
    );
    assert.deepStrictEqual(usernames, [
      { username: "joe", active: true, expires_at: null },
    ]);
  });

  it("should not update the username if it is not valid", async () => {
    const agent = request.agent(app);
    await createUser(agent);

    for (const body of [{}, { username: "" }, { username: 123 }]) {
      const res = await agent.patch("/user/username").send(body);

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.text, JSON.stringify({ error: "Invalid username" }));
    }
  });

  it("should not update the username if it is already taken", async () => {
    const owner = request.agent(app);
    await createUser(owner, "owner@example.com");
    await owner.patch("/user/username").send({ username: "joe" });

    const agent = request.agent(app);
    await createUser(agent);

    const res = await agent.patch("/user/username").send({ username: "JOE" });

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(
      res.text,
      JSON.stringify({ error: "Username is already taken" })
    );
  });

  it("should keep the old username for a month after changing it", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent);

    await agent.patch("/user/username").send({ username: "first" });
    const res = await agent.patch("/user/username").send({ username: "second" });

    assert.strictEqual(res.statusCode, 200);

    const usernames = await DB.query(
      `SELECT
        username,
        active,
        expires_at > NOW() + INTERVAL '27 days' AND expires_at < NOW() + INTERVAL '32 days' AS expires_in_a_month
      FROM usernames WHERE user_id = $1 ORDER BY id`,
      [user.id]
    );
    assert.deepStrictEqual(usernames, [
      { username: "first", active: false, expires_in_a_month: true },
      { username: "second", active: true, expires_in_a_month: null },
    ]);
  });

  it("should only keep 3 old usernames", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent);

    for (const username of ["one", "two", "three", "four", "five"]) {
      const res = await agent.patch("/user/username").send({ username });
      assert.strictEqual(res.statusCode, 200);
    }

    // "one" was the old username that expired the soonest, so it had to go
    const usernames = await DB.findMany<IUsername>(
      "SELECT username, active FROM usernames WHERE user_id = $1 ORDER BY id",
      [user.id]
    );
    assert.deepStrictEqual(usernames, [
      { username: "two", active: false },
      { username: "three", active: false },
      { username: "four", active: false },
      { username: "five", active: true },
    ]);

    // The one that was dropped is free to take again
    const res = await agent.get("/user/username-availability/one");
    assert.deepStrictEqual(res.body, { available: true });
  });

  it("should switch back to an old username", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent);

    await agent.patch("/user/username").send({ username: "first" });
    await agent.patch("/user/username").send({ username: "second" });

    const res = await agent
      .patch("/user/username/switch")
      .send({ username: "first" });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(
      res.text,
      JSON.stringify({ message: "Username switched successfully" })
    );

    const usernames = await DB.query(
      "SELECT username, active, expires_at IS NULL AS never_expires FROM usernames WHERE user_id = $1 ORDER BY id",
      [user.id]
    );
    assert.deepStrictEqual(usernames, [
      { username: "first", active: true, never_expires: true },
      { username: "second", active: false, never_expires: false },
    ]);
  });

  it("should not switch to a username that is not one of the old ones", async () => {
    const other = request.agent(app);
    await createUser(other, "other@example.com");
    await other.patch("/user/username").send({ username: "taken" });
    await other.patch("/user/username").send({ username: "other" });

    const agent = request.agent(app);
    await createUser(agent);
    await agent.patch("/user/username").send({ username: "current" });

    // Someone else's old username, the active one, and one that doesn't exist
    for (const username of ["taken", "current", "nobody"]) {
      const res = await agent.patch("/user/username/switch").send({ username });

      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(
        res.text,
        JSON.stringify({
          error: "The specified username does not exist or is already active",
        })
      );
    }
  });

  it("should not switch the username if it is not valid", async () => {
    const agent = request.agent(app);
    await createUser(agent);

    for (const body of [{}, { username: "" }, { username: ["joe"] }]) {
      const res = await agent.patch("/user/username/switch").send(body);

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.text, JSON.stringify({ error: "Invalid username" }));
    }
  });
});
