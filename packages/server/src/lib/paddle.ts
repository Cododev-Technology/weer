import { CREDIT_PACKS } from "@weer/common";
import keys from "../config/keys.js";

const API_URL =
  keys.paddleApiUrl ||
  (keys.paddleEnvironment === "production"
    ? "https://api.paddle.com"
    : "https://sandbox-api.paddle.com");

export interface PaddleTransaction {
  id: string;
  status: "draft" | "ready" | "billed" | "paid" | "completed" | "canceled" | "past_due";
  custom_data: { user_id?: number } | null;
  currency_code: string;
  items: { price: { id: string }; quantity: number }[];
  details: { totals: { grand_total: string } };
}

export interface PaddleAdjustment {
  id: string;
  action: string; // "refund", "chargeback", "credit", ...
  status: string; // "pending_approval", "approved", "rejected" or "reversed"
  transaction_id: string;
  currency_code: string;
  totals: { total: string };
}

export const paymentsEnabled = () => !!keys.paddleApiKey;

export const priceIdOf = (credits: number): string | undefined =>
  CREDIT_PACKS.find((pack) => pack.credits === credits)?.paddle[keys.paddleEnvironment] ||
  undefined;

export const creditsOf = (priceId: string): number | undefined =>
  CREDIT_PACKS.find((pack) => pack.paddle[keys.paddleEnvironment] === priceId)?.credits;

// Returns the data of Paddle's response, or null on a 404
async function request<T>(method: "GET" | "POST", path: string, body?: object): Promise<T | null> {
  const res = await fetch(API_URL + path, {
    method,
    headers: {
      Authorization: `Bearer ${keys.paddleApiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 404) return null;

  const json = (await res.json()) as { data: T; error?: { code: string; detail: string } };
  if (!res.ok) {
    throw new Error(
      `Paddle ${method} ${path}: ${res.status} ${json.error?.code ?? ""} ${json.error?.detail ?? ""}`
    );
  }

  return json.data;
}

// The user id is set here, never by the browser
export const createTransaction = async (priceId: string, userId: number) =>
  (await request<PaddleTransaction>("POST", "/transactions", {
    items: [{ price_id: priceId, quantity: 1 }],
    custom_data: { user_id: userId },
  }))!;

export const getTransaction = (id: string) =>
  request<PaddleTransaction>("GET", `/transactions/${encodeURIComponent(id)}`);

export const getAdjustment = async (id: string) =>
  (await request<PaddleAdjustment[]>("GET", `/adjustments?id=${encodeURIComponent(id)}`))?.[0] ?? null;
