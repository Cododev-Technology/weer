import type { CpeakRequest as Request, CpeakResponse as Response } from "cpeak";
import { isValidEmail, isValidPassword, isValidUsername } from "@weer/common";
import type { API } from "@weer/common";
import crypto from "crypto";

import { DB } from "../database/index.js";
import type { IUser, IUsername } from "../database/types.js";
import sendEmail from "../lib/email/index.js";
import { enforceEmailCooldown, enforceIpLimit } from "../lib/rate-limit.js";
import { verifyEmailCode } from "../lib/email-codes.js";
import { RESERVED_ROUTE_SEGMENTS } from "../lib/link-definitions.js";
import util from "../lib/util.js";

const CODE_EXPIRY_MINUTES = 10;

export const isValidUsernameFormat = (username: string): boolean =>
  isValidUsername(username) &&
  !RESERVED_ROUTE_SEGMENTS.includes(username.toLowerCase());

export const isUsernameAvailable = async (
  username: string
): Promise<boolean> => {
  // We use EXISTS to optimize the query since we only care about existence
  const [{ taken }] = await DB.query(
    `SELECT EXISTS(
      SELECT 1 FROM usernames WHERE username = $1
    ) as "taken"`,
    [username.toLowerCase()]
  );

  return !taken;
};

// Checks if a username is available
const checkUsernameAvailability = async (req: Request, res: Response) => {
  const username = req.params?.username;

  if (
    !username ||
    typeof username !== "string" ||
    !isValidUsernameFormat(username)
  ) {
    return res.status(200).json({ available: false });
  }

  const available = await isUsernameAvailable(username);

  return res.status(200).json({
    available,
  });
};

// Updates the user's username
const updateUsername = async (req: Request, res: Response) => {
  const userId = req.user.id;
  const newUsername = req.body?.username;

  if (
    !newUsername ||
    typeof newUsername !== "string" ||
    !isValidUsernameFormat(newUsername)
  ) {
    return res.status(400).json({ error: "Invalid username" });
  }

  // Check if username is already taken
  const available = await isUsernameAvailable(newUsername);

  if (!available) {
    return res.status(409).json({ error: "Username is already taken" });
  }

  const client = await DB.beginTransaction();
  try {
    // Get all user's usernames. First record is the one that expires the soonest due to ORDER BY expires_at, and last
    // one is the active username (expires_at is NULL for active username)
    const usernameRecords = await DB.findMany<IUsername>(
      `SELECT username, expires_at, active FROM usernames WHERE user_id = $1 ORDER BY expires_at ASC NULLS LAST`,
      [userId],
      client
    );

    // Find the user's active username
    const oldUsername = usernameRecords.find((r) => r.active)?.username;

    // We only keep 3 inactive usernames per user. If the user already has 3 inactive usernames, delete
    // the one that is set to expire the soonest

    const inactiveUsernames = usernameRecords
      ? usernameRecords.filter((r) => !r.active)
      : [];

    if (inactiveUsernames.length >= 3) {
      // Find the oldest inactive username
      const oldest = inactiveUsernames[0];

      // Delete the oldest inactive username
      await DB.query(
        `DELETE FROM usernames WHERE user_id = $1 AND username = $2`,
        [userId, oldest.username],
        client
      );
    }

    // Deactivate the existing username for the user and set expires_at one month from now
    await DB.query(
      `UPDATE usernames SET active = false, expires_at = NOW() + INTERVAL '1 month' WHERE user_id = $1 AND username = $2`,
      [userId, oldUsername],
      client
    );

    // Insert the new username
    await DB.query(
      `INSERT INTO usernames (user_id, username, active) VALUES ($1, $2, true)`,
      [userId, newUsername.toLowerCase()],
      client
    );

    await DB.commit(client);
    return res.status(200).json({ message: "Username updated successfully" });
  } catch (e: any) {
    await DB.rollback(client);
    if (e.code === "23505") {
      return res.status(409).json({ error: "Username is already taken" });
    }
    throw e;
  }
};

const switchUsername = async (req: Request, res: Response) => {
  const userId = req.user.id;
  const newUsername = req.body?.username;

  if (!newUsername || typeof newUsername !== "string") {
    return res.status(400).json({ error: "Invalid username" });
  }

  const client = await DB.beginTransaction();
  try {
    // Get all user's usernames
    const usernameRecords = await DB.findMany<IUsername>(
      `SELECT username, expires_at, active FROM usernames WHERE user_id = $1 FOR UPDATE`,
      [userId],
      client
    );

    // Check if the requested username exists and is inactive
    const targetRecord = usernameRecords.find(
      (r) => r.username === newUsername && !r.active
    );

    if (!targetRecord) {
      await DB.rollback(client);
      return res.status(404).json({
        error: "The specified username does not exist or is already active",
      });
    }

    // Find the user's current active username
    const currentActiveRecord = usernameRecords.find((r) => r.active);

    // Deactivate the current active username and set expires_at one month from now
    if (currentActiveRecord) {
      await DB.query(
        `UPDATE usernames SET active = false, expires_at = NOW() + INTERVAL '1 month' WHERE user_id = $1 AND username = $2`,
        [userId, currentActiveRecord.username],
        client
      );
    }

    // Activate the target username and clear expires_at
    await DB.query(
      `UPDATE usernames SET active = true, expires_at = NULL WHERE user_id = $1 AND username = $2`,
      [userId, newUsername],
      client
    );

    await DB.commit(client);
    return res.status(200).json({ message: "Username switched successfully" });
  } catch (e: any) {
    await DB.rollback(client);
    if (e.code === "23505") {
      return res.status(409).json({
        error: "Could not switch usernames. Please refresh and try again.",
      });
    }
    throw e;
  }
};

// Sends a 5-digit code to a new email address to confirm the user owns it before changing to it
const sendEmailChangeCode = async (
  req: Request<API.User.SendEmailChangeCodeBody>,
  res: Response
) => {
  const newEmail = req.body?.newEmail;

  if (!isValidEmail(newEmail || ""))
    throw { status: 400, message: "Please enter a valid email address." };

  const normalizedEmail = newEmail!.toLowerCase();

  const existing = await DB.find<IUser>(
    "SELECT id FROM users WHERE email = $1 AND id != $2",
    [normalizedEmail, req.user.id]
  );

  if (existing) throw { status: 409, message: "This email is already in use." };

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

  await sendEmail(normalizedEmail, "Confirm your new email address", {
    htmlFile: "change-email",
    templateData: {
      title: "Confirm your new email address",
      code,
      expiresIn: `${CODE_EXPIRY_MINUTES} minutes`,
    },
  });

  res.status(200).json({ message: "Verification code sent." });
};

// Confirms the code sent to the new email address and applies the change
const confirmEmailChange = async (
  req: Request<API.User.ConfirmEmailChangeBody>,
  res: Response
) => {
  const { newEmail, code } = req.body ?? {};

  if (!isValidEmail(newEmail || ""))
    throw { status: 400, message: "Please enter a valid email address." };

  const normalizedEmail = newEmail!.toLowerCase();

  await verifyEmailCode(normalizedEmail, code!);

  const oldUser = await DB.find<IUser>(
    "SELECT email FROM users WHERE id = $1",
    [req.user.id]
  );

  try {
    await DB.update<IUser>("users", { email: normalizedEmail }, "id = $2", [
      req.user.id,
    ]);
  } catch (e: any) {
    if (e.code === "23505") {
      throw { status: 409, message: "This email is already in use." };
    }
    throw e;
  }

  if (oldUser?.email) {
    // Best-effort notice to the old address, don't fail the request if this errors
    try {
      await sendEmail(oldUser.email, "Your email address was changed", {
        htmlFile: "email-changed-notice",
        templateData: {
          title: "Your email address was changed",
          newEmail: normalizedEmail,
        },
      });
    } catch (e) {
      console.error(e);
    }
  }

  if (req.user.tokenId) {
    await DB.delete("tokens", "user_id = $1 AND id != $2", [
      req.user.id,
      req.user.tokenId,
    ]);
  } else {
    await DB.delete("tokens", "user_id = $1", [req.user.id]);
  }

  res
    .status(200)
    .json({ message: "Email updated successfully.", email: normalizedEmail });
};

const changePassword = async (
  req: Request<API.User.ChangePasswordBody>,
  res: Response
) => {
  const { newPassword } = req.body ?? {};

  if (!isValidPassword(newPassword || ""))
    throw {
      status: 400,
      message:
        "Password must be 8-30 characters and include an uppercase letter, a lowercase letter, and a number.",
    };

  const hash = await req.hashPassword({ password: newPassword! });

  await DB.update<IUser>("users", { password: hash }, "id = $2", [req.user.id]);

  if (req.user.tokenId) {
    await DB.delete("tokens", "user_id = $1 AND id != $2", [
      req.user.id,
      req.user.tokenId,
    ]);
  } else {
    await DB.delete("tokens", "user_id = $1", [req.user.id]);
  }

  res.status(200).json({ message: "Password updated successfully." });
};

export default {
  checkUsernameAvailability,
  updateUsername,
  switchUsername,
  sendEmailChangeCode,
  confirmEmailChange,
  changePassword,
};
