import type { CpeakRequest as Request, CpeakResponse as Response } from "cpeak";
import { isValidName, isValidEmail, isValidPassword } from "@weer/common";
import type { API } from "@weer/common";
import crypto from "crypto";

import { DB } from "../database/index.js";
import type { IUser, ISession } from "../database/types.js";
import { exchangeCodeForProfile } from "../lib/google-oauth.js";
import sendEmail from "../lib/email/index.js";
import { enforceEmailCooldown, enforceIpLimit } from "../lib/rate-limit.js";
import { verifyEmailCode } from "../lib/email-codes.js";
import { isUsernameAvailable, isValidUsernameFormat } from "./user.js";
import keys from "../config/keys.js";
import util from "../lib/util.js";

const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
const CODE_EXPIRY_MINUTES = 10;
const RESET_LINK_EXPIRY_HOURS = 2;

function setTokenCookie(res: Response, token: string) {
  res.cookie("token", token, {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: COOKIE_MAX_AGE,
  });
}

const handleOAuthCallback = async (req: Request, res: Response) => {
  const code = req.query?.code as string;
  if (!code) return res.redirect("/");

  const profile = await exchangeCodeForProfile(code);

  let dbUser = await DB.find<IUser>("SELECT id FROM users WHERE google_id=$1", [
    profile.sub,
  ]);

  if (!dbUser) {
    // No Google-linked account yet. If a password account already exists for
    // this email, link Google to it instead of erroring on the unique constraint.
    const existingByEmail = await DB.find<IUser>(
      "SELECT id, google_id FROM users WHERE email=$1",
      [profile.email]
    );

    if (existingByEmail && !existingByEmail.google_id) {
      await DB.update<IUser>(
        "users",
        { google_id: profile.sub, verified: true },
        "id = $3",
        [existingByEmail.id]
      );
      dbUser = existingByEmail;
    } else {
      dbUser = await DB.insert<IUser>("users", {
        email: profile.email,
        name: profile.name,
        google_id: profile.sub,
      });
    }
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

const logOut = async (req: Request, res: Response) => {
  const token = req.signedCookies?.token;
  if (token) {
    await req.logout(token as string);
    res.clearCookie("token");
  }
  res.clearCookie("uid");
  res.redirect("/");
};

// If user is logged in, return their info (email, username) else return false
const checkAuthStatus = async (
  req: Request,
  res: Response<API.Auth.StatusResponse>
) => {
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
      link_credits: number;
      usernames: { value: string; expires_at: string | null; active: boolean }[];
    }

    const user = await DB.find<UserWithUsernames>(
      `SELECT
        users.email,
        users.link_credits,
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
        linkCredits: user.link_credits,
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

// Sends a 5-digit code to the given email to verify ownership before creating an account
const sendCode = async (req: Request<API.Auth.SendCodeBody>, res: Response) => {
  const { name, email, password, username } = req.body ?? {};

  if (!isValidName(name || ""))
    throw { status: 400, message: "Please enter a valid name." };
  if (!isValidEmail(email || ""))
    throw { status: 400, message: "Please enter a valid email address." };
  if (!isValidPassword(password || ""))
    throw {
      status: 400,
      message:
        "Password must be 8-30 characters and include an uppercase letter, a lowercase letter, and a number.",
    };

  const normalizedEmail = email!.toLowerCase();

  const existing = await DB.find<IUser>(
    "SELECT id, google_id FROM users WHERE email = $1",
    [normalizedEmail]
  );

  if (existing) {
    throw {
      status: 409,
      message: "You already have an account with us. Please login instead.",
    };
  }

  if (
    username &&
    (!isValidUsernameFormat(username) || !(await isUsernameAvailable(username)))
  ) {
    throw { status: 409, message: "Username is not available." };
  }

  await enforceEmailCooldown(normalizedEmail);

  const ip = util.getClientIp(req);
  if (ip) await enforceIpLimit(ip);

  const code = crypto.randomInt(10000, 100000);

  await DB.delete("email_codes", "email = $1", [normalizedEmail]);
  await DB.insert("email_codes", {
    email: normalizedEmail,
    code,
    expires_at: new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000),
  });

  await sendEmail(normalizedEmail, "Verify your email address", {
    htmlFile: "verify-email",
    templateData: {
      title: "Verify your email address",
      code,
      expiresIn: `${CODE_EXPIRY_MINUTES} minutes`,
    },
  });

  res.status(200).json({ message: "Verification code sent." });
};

// Verifies the code and creates the account, then logs the user in
const register = async (req: Request<API.Auth.RegisterBody>, res: Response) => {
  const { name, email, password, code, username } = req.body ?? {};

  if (!isValidName(name || ""))
    throw { status: 400, message: "Please enter a valid name." };
  if (!isValidEmail(email || ""))
    throw { status: 400, message: "Please enter a valid email address." };
  if (!isValidPassword(password || ""))
    throw {
      status: 400,
      message:
        "Password must be 8-30 characters and include an uppercase letter, a lowercase letter, and a number.",
    };

  const normalizedEmail = email!.toLowerCase();

  const existing = await DB.find<IUser>(
    "SELECT id, google_id FROM users WHERE email = $1",
    [normalizedEmail]
  );

  if (existing) {
    throw {
      status: 409,
      message: "You already have an account with us. Please login instead.",
    };
  }

  if (
    username &&
    (!isValidUsernameFormat(username) || !(await isUsernameAvailable(username)))
  ) {
    throw { status: 409, message: "Username is not available." };
  }

  await verifyEmailCode(normalizedEmail, code!);

  const hash = await req.hashPassword({ password: password! });

  const client = await DB.beginTransaction();
  let user: IUser;
  try {
    user = await DB.insert<IUser>(
      "users",
      {
        name,
        email: normalizedEmail,
        password: hash,
        verified: true,
      },
      client
    );

    if (username) {
      try {
        await DB.insert(
          "usernames",
          {
            user_id: user.id,
            username: username.toLowerCase(),
            active: true,
          },
          client
        );
      } catch (e: any) {
        if (e.code !== "23505") throw e;
      }
    }

    await DB.commit(client);
  } catch (e: any) {
    await DB.rollback(client);
    if (e.code === "23505") {
      throw {
        status: 409,
        message: "You already have an account with us. Please login instead.",
      };
    }
    throw e;
  }

  const token = await req.login({
    password: password!,
    hashedPassword: hash,
    userId: String(user.id),
  });

  if (!token)
    throw {
      status: 500,
      message: "Something went wrong. Please try logging in.",
    };

  setTokenCookie(res, token);

  res.status(201).json({ message: "Account created." });
};

// Logs a user in with email + password
const logIn = async (req: Request<API.Auth.LoginBody>, res: Response) => {
  const { email, password } = req.body ?? {};

  if (!email || !password)
    throw { status: 400, message: "Please enter your email and password." };

  const normalizedEmail = email.toLowerCase();

  const user = await DB.find<IUser>(
    "SELECT id, password, google_id FROM users WHERE email = $1",
    [normalizedEmail]
  );

  if (!user || !user.password) {
    if (user?.google_id) {
      throw {
        status: 401,
        message:
          "This account uses Google Sign-In. Continue with Google, or add a password from your Account settings after signing in.",
      };
    }
    throw { status: 401, message: "Incorrect email or password." };
  }

  const token = await req.login({
    password,
    hashedPassword: user.password,
    userId: String(user.id),
  });

  if (!token) throw { status: 401, message: "Incorrect email or password." };

  setTokenCookie(res, token);

  res.json({ message: "Logged in." });
};

// Sends a password reset link to the given email, whether the account already has a password or not
const forgotPassword = async (req: Request<API.Auth.ForgotPasswordBody>, res: Response) => {
  const { email } = req.body ?? {};
  if (!email) throw { status: 400, message: "Please enter your email." };

  const normalizedEmail = email.toLowerCase();

  const user = await DB.find<IUser>("SELECT id FROM users WHERE email = $1", [
    normalizedEmail,
  ]);

  if (user) {
    await enforceEmailCooldown(normalizedEmail);

    const ip = util.getClientIp(req);
    if (ip) await enforceIpLimit(ip);

    const token = crypto.randomBytes(32).toString("hex");
    const link = `${keys.domain}/reset-password?t=${token}&i=${user.id}`;

    await DB.update<IUser>(
      "users",
      { token_code: token, token_date: new Date() },
      "id = $3",
      [user.id]
    );

    await sendEmail(normalizedEmail, "Reset your password", {
      htmlFile: "reset-password",
      templateData: {
        title: "Reset your password",
        link,
        expiresIn: `${RESET_LINK_EXPIRY_HOURS} hours`,
      },
    });
  }

  res
    .status(200)
    .json({ message: "If that email is registered, we've sent a reset link." });
};

// Uses the token from the emailed reset link to set a new password
const resetPassword = async (
  req: Request<API.Auth.ResetPasswordBody>,
  res: Response
) => {
  const { userId, token, newPassword } = req.body || {};

  if (!userId || !token || !isValidPassword(newPassword || ""))
    throw { status: 400, message: "Please provide a valid new password." };

  const user = await DB.find<IUser>(
    "SELECT token_code, token_date FROM users WHERE id = $1",
    [userId]
  );

  if (!user || !user.token_code || !user.token_date)
    throw { status: 400, message: "Invalid or expired link." };

  const expiry =
    new Date(user.token_date).getTime() +
    RESET_LINK_EXPIRY_HOURS * 60 * 60 * 1000;
  if (Date.now() > expiry)
    throw { status: 400, message: "This reset link has expired." };

  const tokenBuf = Buffer.from(token, "utf8");
  const storedTokenBuf = Buffer.from(user.token_code, "utf8");
  if (
    tokenBuf.length !== storedTokenBuf.length ||
    !crypto.timingSafeEqual(tokenBuf, storedTokenBuf)
  ) {
    throw { status: 400, message: "Invalid or expired link." };
  }

  const hash = await req.hashPassword({ password: newPassword! });

  await DB.update<IUser>(
    "users",
    { password: hash, token_code: null, token_date: null },
    "id = $4",
    [userId]
  );

  // Revoke any existing logged-in sessions, since the requester may not be authenticated as this user
  await DB.delete("tokens", "user_id = $1", [userId]);

  res.status(200).json({ message: "Password updated. Please log in." });
};

export default {
  handleOAuthCallback,
  logOut,
  checkAuthStatus,
  sendCode,
  register,
  logIn,
  forgotPassword,
  resetPassword,
};
