import crypto from "node:crypto";
import type request from "supertest";
import { DB } from "../../../src/database/index.js";
import type { IUser } from "../../../src/database/types.js";
import keys from "../../../src/config/keys.js";

// Signs a cookie value the same way the cookieParser of Cpeak does
export const signCookie = (value: string): string => {
  const sig = crypto
    .createHmac("sha256", keys.cookieKey)
    .update(value)
    .digest("base64url");
  return encodeURIComponent(`s:${value}.${sig}`);
};

// Logs the agent in as the user with this id. This is what the Google OAuth callback does at the end.
export const logIn = (
  agent: ReturnType<typeof request.agent>,
  userId: number
): void => {
  agent.jar.setCookie(`uid=${signCookie(String(userId))}`);
};

// Adds a new user to the database and logs the agent in as that user
export const createUser = async (
  agent: ReturnType<typeof request.agent>,
  email = "user@example.com"
): Promise<IUser> => {
  const user = await DB.insert<IUser>("users", {
    email,
    name: "Test User",
    google_id: "google-" + email,
  });

  logIn(agent, user.id);
  return user;
};
