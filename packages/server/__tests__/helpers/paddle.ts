import http from "node:http";
import crypto from "node:crypto";
import { CREDIT_PACKS } from "@weer/common";
import keys from "../../src/config/keys.js";

// A fake of Paddle's API on PADDLE_API_URL, so the tests never call Paddle. It runs in the test
// process, which also works when the tests run against a server elsewhere (TEST_BASE_URL).
const PORT = 2090;

// The Paddle price ids of the packs, smallest first
export const PRICE_IDS = CREDIT_PACKS.map((pack) => pack.paddle[keys.paddleEnvironment]);

// What each price costs, in cents
const PRICES: Record<string, string> = Object.fromEntries(
  CREDIT_PACKS.map((pack, i) => [PRICE_IDS[i], String(Math.round(Number(pack.price) * 100))])
);

const transactions = new Map<string, any>();
const adjustments = new Map<string, any>();

// Like Paddle's ids: a prefix and 26 letters and digits
const newId = (prefix: string) =>
  prefix + "_" + crypto.randomBytes(13).toString("hex");

const transaction = (id: string, priceId: string, userId: number | undefined, status: string) => ({
  id,
  status,
  custom_data: userId === undefined ? null : { user_id: userId },
  currency_code: "USD",
  items: [{ price: { id: priceId }, quantity: 1 }],
  details: { totals: { grand_total: PRICES[priceId] ?? "0" } },
});

export const paddle = {
  transactions,
  adjustments,

  reset() {
    transactions.clear();
    adjustments.clear();
  },

  // What the checkout does once the buyer pays
  pay(id: string) {
    transactions.get(id).status = "completed";
  },

  addTransaction(userId: number, priceId = PRICE_IDS[0], status = "completed"): string {
    const id = newId("txn");
    transactions.set(id, transaction(id, priceId, userId, status));
    return id;
  },

  addAdjustment(transactionId: string, total: string, action = "refund", status = "approved"): string {
    const id = newId("adj");
    adjustments.set(id, {
      id,
      action,
      status,
      transaction_id: transactionId,
      currency_code: "USD",
      totals: { total },
    });
    return id;
  },
};

const send = (res: http.ServerResponse, status: number, body: object) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${keys.paddleApiKey}`) {
    return send(res, 403, { error: { code: "forbidden", detail: "Wrong API key" } });
  }

  const url = new URL(req.url!, `http://127.0.0.1:${PORT}`);
  const notFound = { error: { code: "entity_not_found", detail: "Not found" } };

  if (req.method === "POST" && url.pathname === "/transactions") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { items, custom_data } = JSON.parse(body);

    const id = newId("txn");
    transactions.set(id, transaction(id, items[0].price_id, custom_data?.user_id, "draft"));
    return send(res, 201, { data: transactions.get(id) });
  }

  const match = url.pathname.match(/^\/transactions\/([^/]+)$/);
  if (req.method === "GET" && match) {
    const found = transactions.get(decodeURIComponent(match[1]));
    return found ? send(res, 200, { data: found }) : send(res, 404, notFound);
  }

  if (req.method === "GET" && url.pathname === "/adjustments") {
    const found = adjustments.get(url.searchParams.get("id") ?? "");
    return send(res, 200, { data: found ? [found] : [] });
  }

  send(res, 404, notFound);
});

server.listen(PORT, "127.0.0.1");
