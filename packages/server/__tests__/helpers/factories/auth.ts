import type request from "supertest";
import { DB } from "../../../src/database/index.js";

export const DEFAULT_PASSWORD = "TestPass123";

export const getEmailCode = async (email: string): Promise<string> => {
  const row = await DB.find<{ code: number }>(
    "SELECT code FROM email_codes WHERE email = $1",
    [email]
  );
  if (!row) throw new Error(`No email_codes row for ${email}`);
  return String(row.code);
};

export const signUpAndLogIn = async (
  agent: ReturnType<typeof request.agent>,
  email: string,
  name = "Test User",
  password = DEFAULT_PASSWORD
): Promise<number> => {
  await agent.post("/auth/send-code").send({ name, email, password });
  const code = await getEmailCode(email);
  await agent.post("/auth/register").send({ name, email, password, code });

  const user = await DB.find<{ id: number }>(
    "SELECT id FROM users WHERE email = $1",
    [email]
  );
  if (!user) throw new Error(`No user row for ${email}`);
  return user.id;
};
