import type { LinkType } from "@weer/common";
import { redis } from "./redis.js";
import keys from "../config/keys.js";
import { DB } from "../database/index.js";
import type { IUrl } from "../database/types.js";

/**
 * Once a classic link (a 6 character code) is visited, we save it in Redis, so the redirects
 * after that don't have to ask the database. When the link changes or is deleted, it's removed,
 * and the next visit reads it from the database again.
 *
 * Get a saved link:
 * GET weer:link:abc123
 */

export const isEnabled = (): boolean => keys.redisEnabled && keys.linkCache;

const key = (code: string) => `weer:link:${code}`;

// The link saved for this code, if there is one. If Redis can't be reached, we just ask the
// database.
export const get = async (code: string): Promise<IUrl | null> => {
  try {
    const saved = await redis.get(key(code));
    if (!saved) return null;

    // Saved as "{id} {link_type} {real_url}", see set()
    const firstSpace = saved.indexOf(" ");
    const secondSpace = saved.indexOf(" ", firstSpace + 1);
    if (firstSpace === -1 || secondSpace === -1) return null;

    const id = Number(saved.slice(0, firstSpace));
    if (!Number.isInteger(id)) return null;

    return {
      id,
      link_type: saved.slice(firstSpace + 1, secondSpace) as LinkType,
      real_url: saved.slice(secondSpace + 1),
    } as IUrl;
  } catch (err: any) {
    console.error("[links-cache] GET failed:", err.message);
    return null;
  }
};

// Saves a link that was just read from the database. The redirect doesn't wait for it.
export const set = (code: string, url: IUrl): void => {
  void redis
    .set(key(code), `${url.id} ${url.link_type} ${url.real_url}`)
    .catch((err: Error) =>
      console.error("[links-cache] SET failed:", err.message)
    );
};

// The code the link with this id can be saved under. Get it before changing the link (the code
// might be gone after), and forget() it once the link is changed.
//
// (The classic lookup doesn't check the type of the link, so any link with a code can be saved,
// like an affix link with a 6 character code.)
export const codeOf = async (id: number): Promise<string | null> => {
  if (!isEnabled()) return null;

  const url = await DB.find<IUrl>(
    "SELECT shortened_url_id FROM urls WHERE id = $1",
    [id]
  );
  return url?.shortened_url_id ?? null;
};

// Removes a saved link. It waits for Redis, so that once it's done, no visit can find the old
// link anymore.
export const forget = async (code: string | null): Promise<void> => {
  if (!code) return;

  try {
    await redis.del(key(code));
  } catch (err: any) {
    console.error("[links-cache] DEL failed:", err.message);
  }
};
