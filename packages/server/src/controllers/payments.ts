import type { CpeakRequest as Request, CpeakResponse as Response } from "cpeak";

import { DB } from "../database/index.js";
import type { IPayment } from "../database/types.js";
import keys from "../config/keys.js";
import {
  paymentsEnabled,
  priceIdOf,
  creditsOf,
  createTransaction,
  getTransaction,
  getAdjustment,
} from "../lib/paddle.js";
import type { PaddleTransaction, PaddleAdjustment } from "../lib/paddle.js";

const TRANSACTION_ID = /^txn_[a-z\d]{26}$/;
const ADJUSTMENT_ID = /^adj_[a-z\d]{26}$/;

// Adds the credits of a paid transaction to its user, once per transaction
const addCredits = async (
  transaction: PaddleTransaction
): Promise<"added" | "unpaid" | "ignored"> => {
  if (transaction.status !== "paid" && transaction.status !== "completed") return "unpaid";

  const userId = Number(transaction.custom_data?.user_id);
  const [item] = transaction.items;
  const credits =
    transaction.items.length === 1 && item.quantity === 1 ? creditsOf(item.price.id) : undefined;

  if (!userId || !credits) return "ignored";

  const client = await DB.beginTransaction();
  try {
    const payment = await DB.find<IPayment>(
      `INSERT INTO payments (paddle_id, transaction_id, user_id, credits, amount, currency)
      VALUES ($1, $1, $2, $3, $4, $5)
      ON CONFLICT (paddle_id) DO NOTHING
      RETURNING id`,
      [
        transaction.id,
        userId,
        credits,
        transaction.details.totals.grand_total,
        transaction.currency_code,
      ],
      client
    );

    // Accounts from before the credit check stopped at 0 can still be below it
    if (payment) {
      await DB.query(
        `UPDATE users SET link_credits = GREATEST(link_credits, 0) + $1 WHERE id = $2`,
        [credits, userId],
        client
      );
    }

    await DB.commit(client);
  } catch (error) {
    await DB.rollback(client);
    throw error;
  }

  return "added";
};

// Takes back the refunded share of a purchase's credits, once per approved refund or chargeback
const takeBackCredits = async (adjustment: PaddleAdjustment) => {
  if (adjustment.action !== "refund" && adjustment.action !== "chargeback") return;
  if (adjustment.status !== "approved") return;

  const purchase = await DB.find<IPayment>(
    `SELECT user_id, credits, amount, currency FROM payments WHERE paddle_id = $1`,
    [adjustment.transaction_id]
  );
  if (!purchase || purchase.currency !== adjustment.currency_code) return;

  const refunded = Number(adjustment.totals.total);
  const credits = Math.min(
    purchase.credits,
    Math.round((purchase.credits * refunded) / Number(purchase.amount))
  );

  const client = await DB.beginTransaction();
  try {
    const payment = await DB.find<IPayment>(
      `INSERT INTO payments (paddle_id, transaction_id, user_id, credits, amount, currency)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (paddle_id) DO NOTHING
      RETURNING id`,
      [
        adjustment.id,
        adjustment.transaction_id,
        purchase.user_id,
        -credits,
        refunded,
        adjustment.currency_code,
      ],
      client
    );

    if (payment) {
      await DB.query(`UPDATE users SET link_credits = link_credits - $1 WHERE id = $2`, [
        credits,
        purchase.user_id,
      ], client);
    }

    await DB.commit(client);
  } catch (error) {
    await DB.rollback(client);
    throw error;
  }
};

const getStatus = async (req: Request, res: Response) => {
  res.json({ enabled: paymentsEnabled() });
};

// Creates the Paddle transaction that the browser's checkout opens
const createCheckout = async (req: Request, res: Response) => {
  if (!paymentsEnabled()) {
    return res.status(503).json({ error: "Buying credits isn't available yet." });
  }

  const priceId = priceIdOf(Number(req.body?.credits));
  if (!priceId) return res.status(400).json({ error: "Invalid credit pack." });

  const transaction = await createTransaction(priceId, req.user.id);
  const user = await DB.find<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [
    req.user.id,
  ]);

  res.status(201).json({
    transactionId: transaction.id,
    clientToken: keys.paddleClientToken,
    environment: keys.paddleEnvironment,
    email: user?.email,
  });
};

// Called by the browser after a payment. The webhook adds the same credits if the browser never calls.
const confirmCheckout = async (req: Request, res: Response) => {
  const transactionId = req.body?.transactionId;
  if (typeof transactionId !== "string" || !TRANSACTION_ID.test(transactionId)) {
    return res.status(400).json({ error: "Invalid transaction." });
  }

  const transaction = paymentsEnabled() ? await getTransaction(transactionId) : null;

  // Only the user who bought it can confirm it
  if (!transaction || Number(transaction.custom_data?.user_id) !== req.user.id) {
    return res.status(404).json({ error: "Transaction not found." });
  }

  const result = await addCredits(transaction);
  if (result === "unpaid") {
    return res.status(409).json({ error: "This payment hasn't gone through yet." });
  }

  const user = await DB.find<{ link_credits: number }>(
    `SELECT link_credits FROM users WHERE id = $1`,
    [req.user.id]
  );

  res.json({ linkCredits: user?.link_credits });
};

// Only the id is taken from the request; the transaction or adjustment is fetched from Paddle's API
const handleWebhook = async (req: Request, res: Response) => {
  const eventType = req.body?.event_type;
  const id = req.body?.data?.id;

  if (paymentsEnabled() && typeof id === "string") {
    if (
      (eventType === "transaction.paid" || eventType === "transaction.completed") &&
      TRANSACTION_ID.test(id)
    ) {
      const transaction = await getTransaction(id);
      if (transaction) await addCredits(transaction);
    }

    if (
      (eventType === "adjustment.created" || eventType === "adjustment.updated") &&
      ADJUSTMENT_ID.test(id)
    ) {
      const adjustment = await getAdjustment(id);
      if (adjustment) await takeBackCredits(adjustment);
    }
  }

  // Other events are acknowledged too, or Paddle keeps resending them
  res.status(200).json({ received: true });
};

export default {
  getStatus,
  createCheckout,
  confirmCheckout,
  handleWebhook,
};
