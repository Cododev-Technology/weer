import crypto from "crypto";
import { DB } from "../database/index.js";
import type { IEmailCode } from "../database/types.js";

const MAX_ATTEMPTS = 5;

export async function verifyEmailCode(email: string, code: string | number): Promise<void> {
  const codeRow = await DB.find<IEmailCode>(
    "UPDATE email_codes SET attempts = attempts + 1 WHERE email = $1 AND expires_at > NOW() RETURNING code, attempts",
    [email]
  );

  if (!codeRow) {
    throw { status: 400, message: "This code has expired. Please request a new one." };
  }

  const submittedBuf = Buffer.from(String(code), "utf8");
  const storedBuf = Buffer.from(String(codeRow.code), "utf8");
  const matches =
    submittedBuf.length === storedBuf.length && crypto.timingSafeEqual(submittedBuf, storedBuf);

  if (!matches) {
    if (codeRow.attempts >= MAX_ATTEMPTS) {
      await DB.delete("email_codes", "email = $1", [email]);
      throw { status: 429, message: "Too many incorrect attempts. Please request a new code." };
    }
    throw { status: 400, message: "The code you entered is invalid. Please try again." };
  }

  const consumed = await DB.delete("email_codes", "email = $1 AND code = $2", [
    email,
    codeRow.code,
  ]);

  if (!consumed) {
    throw { status: 400, message: "This code has already been used. Please request a new one." };
  }
}
