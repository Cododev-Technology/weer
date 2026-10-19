import assert from "node:assert/strict";
import request from "supertest";
import { describe, it, beforeEach } from "mocha";
import app from "./helpers/target.js";
import { DB } from "../src/database/index.js";
import type { IPayment } from "../src/database/types.js";
import { createUser } from "./helpers/factories/user.js";
import { paddle, PRICE_IDS } from "./helpers/paddle.js";
import keys from "../src/config/keys.js";

const credits = async (userId: number) =>
  (await DB.find<{ link_credits: number }>(`SELECT link_credits FROM users WHERE id = $1`, [
    userId,
  ]))!.link_credits;

const payments = (userId: number) =>
  DB.findMany<IPayment>(
    `SELECT paddle_id, transaction_id, credits, amount, currency FROM payments WHERE user_id = $1 ORDER BY id`,
    [userId]
  );

const webhook = (agent: ReturnType<typeof request.agent>, eventType: string, id: string) =>
  agent.post("/payments/webhook").send({ event_type: eventType, data: { id } });

describe("Payment Endpoints", () => {
  beforeEach(() => paddle.reset());

  it("should tell that credits can be bought", async () => {
    const res = await request(app).get("/payments/status");

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.text, JSON.stringify({ enabled: true }));
  });

  it("should not let anonymous visitors buy credits", async () => {
    const agent = request.agent(app);

    const responses = [
      await agent.post("/payments/checkout").send({ credits: 200 }),
      await agent.post("/payments/confirm").send({ transactionId: "txn_" + "a".repeat(26) }),
    ];

    for (const res of responses) {
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.text, JSON.stringify({ error: "Unauthorized" }));
    }
    assert.strictEqual(paddle.transactions.size, 0);
  });

  it("should create the Paddle transaction of a pack for the user", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent);

    const res = await agent.post("/payments/checkout").send({ credits: 5000 });

    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(Object.keys(res.body).sort(), [
      "clientToken",
      "email",
      "environment",
      "transactionId",
    ]);
    assert.strictEqual(res.body.clientToken, keys.paddleClientToken);
    assert.strictEqual(res.body.environment, keys.paddleEnvironment);
    assert.strictEqual(res.body.email, "user@example.com");

    const transaction = paddle.transactions.get(res.body.transactionId);
    assert.deepStrictEqual(transaction.custom_data, { user_id: user.id });
    assert.deepStrictEqual(transaction.items, [{ price: { id: PRICE_IDS[1] }, quantity: 1 }]);
  });

  it("should not create a transaction for a pack that doesn't exist", async () => {
    const agent = request.agent(app);
    await createUser(agent);

    for (const body of [{ credits: 123 }, { credits: "lots" }, {}]) {
      const res = await agent.post("/payments/checkout").send(body);

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.text, JSON.stringify({ error: "Invalid credit pack." }));
    }
    assert.strictEqual(paddle.transactions.size, 0);
  });

  it("should add the credits of a paid checkout only once", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent);

    const checkout = await agent.post("/payments/checkout").send({ credits: 200 });
    const { transactionId } = checkout.body;
    paddle.pay(transactionId);

    for (let i = 0; i < 2; i++) {
      const res = await agent.post("/payments/confirm").send({ transactionId });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.text, JSON.stringify({ linkCredits: 225 }));
    }

    assert.strictEqual(await credits(user.id), 225);
    assert.deepStrictEqual(await payments(user.id), [
      {
        paddle_id: transactionId,
        transaction_id: transactionId,
        credits: 200,
        amount: "499",
        currency: "USD",
      },
    ]);
  });

  it("should not add credits before the payment goes through", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent);

    const checkout = await agent.post("/payments/checkout").send({ credits: 200 });
    const res = await agent
      .post("/payments/confirm")
      .send({ transactionId: checkout.body.transactionId });

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.text, JSON.stringify({ error: "This payment hasn't gone through yet." }));
    assert.strictEqual(await credits(user.id), 25);
  });

  it("should not let a user confirm a transaction that isn't theirs", async () => {
    const owner = request.agent(app);
    const ownerUser = await createUser(owner, "owner@example.com");
    const transactionId = paddle.addTransaction(ownerUser.id);

    const agent = request.agent(app);
    const user = await createUser(agent);

    for (const id of [transactionId, "txn_" + "b".repeat(26)]) {
      const res = await agent.post("/payments/confirm").send({ transactionId: id });

      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(res.text, JSON.stringify({ error: "Transaction not found." }));
    }

    for (const id of ["abc", "txn_../../customers", 12]) {
      const res = await agent.post("/payments/confirm").send({ transactionId: id });

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.text, JSON.stringify({ error: "Invalid transaction." }));
    }

    assert.strictEqual(await credits(user.id), 25);
    assert.strictEqual(await credits(ownerUser.id), 25);
  });

  it("should give all the credits of a pack to a user who went below 0", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent);
    await DB.query(`UPDATE users SET link_credits = -5 WHERE id = $1`, [user.id]);

    const transactionId = paddle.addTransaction(user.id);
    const res = await agent.post("/payments/confirm").send({ transactionId });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.text, JSON.stringify({ linkCredits: 200 }));
  });

  it("should add the credits from Paddle's webhook only once", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent);
    const transactionId = paddle.addTransaction(user.id, PRICE_IDS[2]);

    for (const eventType of ["transaction.paid", "transaction.completed"]) {
      const res = await webhook(request.agent(app), eventType, transactionId);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.text, JSON.stringify({ received: true }));
    }

    // And the browser confirming it after the webhook
    const res = await agent.post("/payments/confirm").send({ transactionId });
    assert.strictEqual(res.text, JSON.stringify({ linkCredits: 25025 }));

    assert.strictEqual(await credits(user.id), 25025);
    assert.strictEqual((await payments(user.id)).length, 1);
  });

  it("should only add credits for what Paddle's API says was paid", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent);
    const draft = paddle.addTransaction(user.id, PRICE_IDS[0], "draft");
    const otherProduct = paddle.addTransaction(user.id, "pri_somethingelse");

    for (const id of [draft, otherProduct, "txn_" + "c".repeat(26), "not-an-id"]) {
      const res = await webhook(request.agent(app), "transaction.completed", id);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.text, JSON.stringify({ received: true }));
    }

    assert.strictEqual(await credits(user.id), 25);
    assert.strictEqual((await payments(user.id)).length, 0);
  });

  it("should take back the refunded share of the credits only once", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent);
    const transactionId = paddle.addTransaction(user.id);
    await webhook(agent, "transaction.completed", transactionId);

    // $2.00 of $4.99 is 80 of the 200 credits
    const pending = paddle.addAdjustment(transactionId, "200", "refund", "pending_approval");
    await webhook(agent, "adjustment.created", pending);
    assert.strictEqual(await credits(user.id), 225);

    paddle.adjustments.get(pending).status = "approved";
    for (let i = 0; i < 2; i++) {
      const res = await webhook(agent, "adjustment.updated", pending);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.text, JSON.stringify({ received: true }));
    }
    assert.strictEqual(await credits(user.id), 145);

    // And a chargeback of the rest
    const chargeback = paddle.addAdjustment(transactionId, "299", "chargeback");
    await webhook(agent, "adjustment.created", chargeback);

    assert.strictEqual(await credits(user.id), 25);
    assert.deepStrictEqual(
      (await payments(user.id)).map((payment) => [payment.paddle_id, payment.credits, payment.amount]),
      [
        [transactionId, 200, "499"],
        [pending, -80, "200"],
        [chargeback, -120, "299"],
      ]
    );
  });

  it("should acknowledge the events it doesn't use", async () => {
    const agent = request.agent(app);
    const user = await createUser(agent);
    const transactionId = paddle.addTransaction(user.id);
    const credit = paddle.addAdjustment(transactionId, "499", "credit");

    for (const [eventType, id] of [
      ["customer.created", "ctm_" + "d".repeat(26)],
      ["transaction.created", transactionId],
      ["adjustment.created", credit],
    ]) {
      const res = await webhook(agent, eventType, id);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.text, JSON.stringify({ received: true }));
    }

    const res = await agent.post("/payments/webhook").send({});
    assert.strictEqual(res.statusCode, 200);

    assert.strictEqual(await credits(user.id), 25);
  });
});
