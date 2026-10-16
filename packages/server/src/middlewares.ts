import type {
  CpeakRequest as Request,
  CpeakResponse as Response,
  Next,
  RouteMiddleware,
} from "cpeak";
import { DB } from "./database/index.js";
import type { IUser, IUrl, ISession } from "./database/types.js";
import keys from "./config/keys.js";
import { isAllowlistedDomain } from "./lib/domain-allowlist.js";
import { isUrlMalicious } from "./lib/web-risk.js";
import { enforceRateLimit, enforceLoginRateLimit, enforceIpLimit } from "./lib/rate-limit.js";
import util from "./lib/util.js";

interface Middlewares {
  isValidURL: RouteMiddleware;
  checkUrlOwnership: RouteMiddleware;
  requireAuth: RouteMiddleware;
  checkUrlSafety: RouteMiddleware;
  rateLimitUrl: RouteMiddleware;
  rateLimitLogin: RouteMiddleware;
}

function isValidURL(req: Request, res: Response, next: Next) {
  const body = req.body as { url?: string };
  const url = body.url || "";

  if (url.length === 0)
    throw {
      status: 400,
      message: "Please first put your URL here.",
    };

  // Function to validate url
  const validURL = (str: string) => {
    // No white space or control characters, and http://, https:// or ftp:// at the start
    if (/[\s\p{Cc}]/u.test(str) || !/^(?:https?|ftp):\/\//i.test(str)) {
      return false;
    }

    let hostname: string;
    try {
      hostname = new URL(str).hostname;
    } catch {
      return false;
    }

    // An IP address, but not one of a private network or of this machine
    if (/^[\d.]+$/.test(hostname)) {
      const [first, second, , last] = hostname.split(".").map(Number);
      return (
        first >= 1 &&
        first <= 223 &&
        last >= 1 &&
        last <= 254 &&
        first !== 10 &&
        first !== 127 &&
        !(first === 169 && second === 254) &&
        !(first === 192 && second === 168) &&
        !(first === 172 && second >= 16 && second <= 31)
      );
    }

    // A domain: letters, digits and hyphens between its dots, and a TLD at the end
    // (a TLD that is not in English is written as xn--..., like xn--p1ai for рф)
    return /^(?:[a-z0-9]+(?:-+[a-z0-9]+)*\.)+(?:xn--[a-z0-9-]*[a-z0-9]|[a-z]{2,})$/.test(
      hostname
    );
  };

  if (validURL(url)) {
    next();
  } else {
    throw { status: 400, message: "The URL you put is not valid." };
  }
}

async function checkUrlOwnership(req: Request, res: Response, next: Next) {
  const urlId = Number(req.params?.id);

  // Only digits, and not more than a PostgreSQL integer can hold
  if (!urlId || !/^\d+$/.test(req.params?.id) || urlId > 2147483647) {
    throw { status: 400, message: "Invalid URL ID." };
  }

  const url = await DB.find<IUrl>(
    `SELECT user_id, session_id FROM urls WHERE id=$1`,
    [urlId]
  );

  if (!req.user) {
    const session = await DB.find<ISession>(
      `SELECT id FROM sessions WHERE session_token=$1`,
      [req.signedCookies?.session_token || null]
    );

    if (url && url.session_id === session?.id) {
      return next();
    }
  } else if (url && url.user_id === req.user.id) {
    return next();
  }

  throw { status: 403, message: "Not allowed to access." };
}

async function requireAuth(req: Request, res: Response, next: Next) {
  if (!req.user) throw { status: 401, message: "Unauthorized" };
  next();
}

async function checkUrlSafety(req: Request, res: Response, next: Next) {
  const url = (req.body as { url?: string })?.url || "";

  if (!isAllowlistedDomain(url) && (await isUrlMalicious(url))) {
    throw {
      status: 400,
      message: "This URL has been flagged as unsafe and cannot be shortened.",
    };
  }

  next();
}

async function rateLimitUrl(req: Request, res: Response, next: Next) {
  await enforceRateLimit(req);
  next();
}

async function rateLimitLogin(req: Request, res: Response, next: Next) {
  const email = (req.body as { email?: string })?.email;
  if (email) await enforceLoginRateLimit(email.toLowerCase());

  const ip = util.getClientIp(req);
  if (ip) await enforceIpLimit(ip);

  next();
}

const middlewares: Middlewares = {
  isValidURL,
  checkUrlOwnership,
  requireAuth,
  checkUrlSafety,
  rateLimitUrl,
  rateLimitLogin,
};

export default middlewares;
