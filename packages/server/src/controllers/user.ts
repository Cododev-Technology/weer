import type { CpeakRequest as Request, CpeakResponse as Response } from "cpeak";
import crypto from "crypto";

import { DB } from "../database/index.js";
import type { IUser, ISession, IUsername } from "../database/types.js";

const isUsernameAvailable = async (username: string): Promise<boolean> => {
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

  if (!username || typeof username !== "string") {
    return res
      .status(400)
      .json({ available: false, error: "Invalid username" });
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

  if (!newUsername || typeof newUsername !== "string") {
    return res.status(400).json({ error: "Invalid username" });
  }

  // Check if username is already taken
  const available = await isUsernameAvailable(newUsername);

  if (!available) {
    return res.status(409).json({ error: "Username is already taken" });
  }

  // Get all user's usernames. First record is the one that expires the soonest due to ORDER BY expires_at, and last
  // one is the active username (expires_at is NULL for active username)
  const usernameRecords = await DB.findMany<IUsername>(
    `SELECT username, expires_at, active FROM usernames WHERE user_id = $1 ORDER BY expires_at ASC NULLS LAST`,
    [userId]
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
      [userId, oldest.username]
    );
  }

  // Deactivate the existing username for the user and set expires_at one month from now
  await DB.query(
    `UPDATE usernames SET active = false, expires_at = NOW() + INTERVAL '1 month' WHERE user_id = $1 AND username = $2`,
    [userId, oldUsername]
  );

  // Insert the new username
  await DB.query(
    `INSERT INTO usernames (user_id, username, active) VALUES ($1, $2, true)`,
    [userId, newUsername.toLowerCase()]
  );

  return res.status(200).json({ message: "Username updated successfully" });
};

const switchUsername = async (req: Request, res: Response) => {
  const userId = req.user.id;
  const newUsername = req.body?.username;

  if (!newUsername || typeof newUsername !== "string") {
    return res.status(400).json({ error: "Invalid username" });
  }

  // Get all user's usernames
  const usernameRecords = await DB.findMany<IUsername>(
    `SELECT username, expires_at, active FROM usernames WHERE user_id = $1`,
    [userId]
  );

  // Check if the requested username exists and is inactive
  const targetRecord = usernameRecords.find(
    (r) => r.username === newUsername && !r.active
  );

  if (!targetRecord) {
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
      [userId, currentActiveRecord.username]
    );
  }

  // Activate the target username and clear expires_at
  await DB.query(
    `UPDATE usernames SET active = true, expires_at = NULL WHERE user_id = $1 AND username = $2`,
    [userId, newUsername]
  );

  return res.status(200).json({ message: "Username switched successfully" });
};

export default { checkUsernameAvailability, updateUsername, switchUsername };
