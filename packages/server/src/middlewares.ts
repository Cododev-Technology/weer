import type {
  CpeakRequest as Request,
  CpeakResponse as Response,
  Next,
  RouteMiddleware,
} from "cpeak";
import { DB } from "./database/index.js";
import type { IUser, IUrl, ISession } from "./database/types.js";
import keys from "./config/keys.js";

interface Middlewares {
  isValidURL: RouteMiddleware;
  checkUrlOwnership: RouteMiddleware;
  requireAuth: RouteMiddleware;
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
    return /^(?:(?:(?:https?|ftp):)?\/\/)(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z\u00a1-\uffff0-9]-*)*[a-z\u00a1-\uffff0-9]+)(?:\.(?:[a-z\u00a1-\uffff0-9]-*)*[a-z\u00a1-\uffff0-9]+)*(?:\.(?:[a-z\u00a1-\uffff]{2,})))(?::\d{2,5})?(?:[/?#]\S*)?$/i.test(
      str
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

  if (!urlId) {
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

const middlewares: Middlewares = {
  isValidURL,
  checkUrlOwnership,
  requireAuth,
};

export default middlewares;
