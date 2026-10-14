import type { CpeakRequest as Request } from "cpeak";
import { DB } from "../database/index.js";
import util from "./util.js";

const USER_LIFETIME_LIMIT = 100;
const IP_BURST_LIMIT = 10; // per 10 minutes
const EMAIL_BURST_LIMIT = 3; // per 5 minutes
const LOGIN_BURST_LIMIT = 5; // per 10 minutes, per email attempted

async function enforceUserLimit(userId: number): Promise<void> {
  const row = await DB.find<{ link_credits: number }>(
    `UPDATE users SET link_credits = link_credits - 1 WHERE id = $1 RETURNING link_credits`,
    [userId]
  );

  if ((row?.link_credits ?? 0) < 0) {
    throw {
      status: 402,
      message:
        "You've used all your credits. Please contact support to increase your limit for free.",
    };
  }
}

// Refunds a credit spent by enforceUserLimit when the operation it was gating ultimately failed.
export async function refundUserCredit(userId: number): Promise<void> {
  await DB.query(`UPDATE users SET link_credits = link_credits + 1 WHERE id = $1`, [
    userId,
  ]);
}

export async function enforceIpLimit(ip: string): Promise<void> {
  const row = await DB.find<{ burst_count: number }>(
    `
    INSERT INTO rate_limits (ip_address, burst_count, burst_reset_at)
    VALUES ($1, 1, now())
    ON CONFLICT (ip_address) DO UPDATE SET
      burst_count = CASE WHEN rate_limits.burst_reset_at < now() - interval '10 minutes' THEN 1 ELSE rate_limits.burst_count + 1 END,
      burst_reset_at = CASE WHEN rate_limits.burst_reset_at < now() - interval '10 minutes' THEN now() ELSE rate_limits.burst_reset_at END
    RETURNING burst_count
    `,
    [ip]
  );

  if ((row?.burst_count ?? 0) > IP_BURST_LIMIT) {
    throw {
      status: 429,
      message: "Too many requests. Please try again later.",
    };
  }
}

export async function enforceEmailCooldown(email: string): Promise<void> {
  const row = await DB.find<{ burst_count: number }>(
    `
    INSERT INTO email_rate_limits (email, burst_count, burst_reset_at)
    VALUES ($1, 1, now())
    ON CONFLICT (email) DO UPDATE SET
      burst_count = CASE WHEN email_rate_limits.burst_reset_at < now() - interval '5 minutes' THEN 1 ELSE email_rate_limits.burst_count + 1 END,
      burst_reset_at = CASE WHEN email_rate_limits.burst_reset_at < now() - interval '5 minutes' THEN now() ELSE email_rate_limits.burst_reset_at END
    RETURNING burst_count
    `,
    [email]
  );

  if ((row?.burst_count ?? 0) > EMAIL_BURST_LIMIT) {
    throw {
      status: 429,
      message: "Too many requests for this email. Please wait a few minutes and try again.",
    };
  }
}

export async function enforceLoginRateLimit(email: string): Promise<void> {
  const row = await DB.find<{ burst_count: number }>(
    `
    INSERT INTO login_rate_limits (email, burst_count, burst_reset_at)
    VALUES ($1, 1, now())
    ON CONFLICT (email) DO UPDATE SET
      burst_count = CASE WHEN login_rate_limits.burst_reset_at < now() - interval '10 minutes' THEN 1 ELSE login_rate_limits.burst_count + 1 END,
      burst_reset_at = CASE WHEN login_rate_limits.burst_reset_at < now() - interval '10 minutes' THEN now() ELSE login_rate_limits.burst_reset_at END
    RETURNING burst_count
    `,
    [email]
  );

  if ((row?.burst_count ?? 0) > LOGIN_BURST_LIMIT) {
    throw {
      status: 429,
      message: "Too many login attempts for this account. Please wait a few minutes and try again.",
    };
  }
}

export async function enforceRateLimit(req: Request): Promise<void> {
  if (req.user) return enforceUserLimit(req.user.id);

  const ip = util.getClientIp(req);
  if (!ip) return; // no derivable IP (shouldn't happen for a real connection)

  return enforceIpLimit(ip);
}
