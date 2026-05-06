import type { CpeakRequest as Request, CpeakResponse as Response } from "cpeak";
import crypto from "crypto";

import { DB } from "../database/index.js";
import type { IUser, ISession } from "../database/types.js";
import { exchangeCodeForProfile } from "../lib/google-oauth.js";

const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

const handleOAuthCallback = async (req: Request, res: Response) => {
  const code = req.query?.code as string;
  if (!code) return res.redirect("/");

  const profile = await exchangeCodeForProfile(code);

  let dbUser = await DB.find<IUser>(
    "SELECT id FROM users WHERE google_id=$1",
    [profile.sub]
  );

  if (!dbUser) {
    dbUser = await DB.insert<IUser>("users", {
      email: profile.email,
      name: profile.name,
      google_id: profile.sub,
    });
  }

  if (!dbUser) return res.redirect("/");

  const userId = dbUser.id;

  // ---- Migrate any urls created during the anonymous session to the user account ---- //
  const sessionToken = req.signedCookies?.session_token || null;

  if (sessionToken) {
    const session = await DB.find<ISession>(
      `SELECT id FROM sessions WHERE session_token = $1`,
      [sessionToken]
    );

    if (session) {
      await DB.query(
        `UPDATE urls SET user_id = $1, session_id = NULL WHERE session_id = $2`,
        [userId, session.id]
      );
    }
  }

  res.cookie("uid", String(userId), {
    signed: true,
    httpOnly: true,
    maxAge: COOKIE_MAX_AGE,
    sameSite: "lax",
  });

  res.redirect("/");
};

const logOut = (req: Request, res: Response) => {
  res.clearCookie("uid");
  res.redirect("/");
};

// If user is logged in, return their info (email, username) else return false
const checkAuthStatus = async (req: Request, res: Response) => {
  // The function will generate a new session token, save it to the database, and send it as a cookie to the client
  const generateSessionToken = async () => {
    const sessionToken = crypto.randomBytes(16).toString("hex"); // 128 bits

    await DB.query(`INSERT INTO sessions (session_token) VALUES ($1)`, [
      sessionToken,
    ]);

    res.cookie("session_token", sessionToken, {
      signed: true,
      httpOnly: true,
      maxAge: COOKIE_MAX_AGE,
    });
  };

  if (req.user) {
    interface UserWithUsernames {
      email: string;
      usernames: { value: string; expires_at: Date | null; active: boolean }[];
    }

    const user = await DB.find<UserWithUsernames>(
      `SELECT
        users.email,
        COALESCE(
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'value', usernames.username,
            'expires_at', usernames.expires_at,
            'active', usernames.active
          )
          ORDER BY usernames.expires_at ASC NULLS LAST
        ) FILTER (WHERE usernames.username IS NOT NULL OR usernames.expires_at > NOW()), '[]') AS usernames
      FROM users
      LEFT JOIN usernames ON users.id = usernames.user_id
      WHERE users.id = $1
      GROUP BY users.id`,
      [req.user.id]
    );

    if (user && user.email) {
      return res.json({
        isSignedIn: true,
        email: user.email,
        usernames: user.usernames,
      });
    } else {
      // Something went wrong, log the user out
      res.clearCookie("uid");
      return res.json({ isSignedIn: false });
    }
  } else {
    const rawToken = req.signedCookies?.session_token;
    let sessionToken = typeof rawToken === "string" ? rawToken : null;

    // User doesn't have a session token
    if (!sessionToken) {
      await generateSessionToken();
    } else {
      /* User do have a session token, but we don't know yet if it's valid or expired */

      // Check if the supplied session token exists and not expired
      const session = await DB.find<ISession>(
        `SELECT id FROM sessions WHERE session_token = $1 AND expires_at > NOW()`,
        [sessionToken]
      );

      if (session) {
        // If session exists and it valid, update last_active
        await DB.query(
          `UPDATE sessions SET last_active = NOW() WHERE session_token = $1`,
          [sessionToken]
        );
      } else {
        // If session doesn't exist, create a new one
        await generateSessionToken();
      }
    }

    res.json({ isSignedIn: false });
  }
};

export default { handleOAuthCallback, logOut, checkAuthStatus };
