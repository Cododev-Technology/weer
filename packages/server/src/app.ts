import cpeak, { serveStatic, parseJSON, cookieParser, auth } from "cpeak";
import type { CpeakRequest as Request, CpeakResponse as Response } from "cpeak";

import path from "path";
import compression from "compression";
import helmet from "helmet";

import log from "./lib/log.js";
import keys from "./config/keys.js";
import apiRouter from "./router.js";
import { DB } from "./database/index.js";

const app = cpeak();

// For parsing JSON body
app.beforeEach(parseJSON());

// app.beforeEach(helmet());
app.beforeEach(compression() as any);

const publicPath = new URL("../public", import.meta.url).pathname;
app.beforeEach(serveStatic(publicPath));

// For sever side rendering
// app.beforeEach(render());

if (!keys.cookieKey || keys.cookieKey.length < 32) {
  console.log(
    "You must set a cookie key in config/keys.ts file and it must be at least 32 characters long."
  );
  process.exit(1);
}

if (!keys.tokenSecret || keys.tokenSecret.length < 32) {
  console.log(
    "You must set a token secret in config/keys.ts file and it must be at least 32 characters long."
  );
  process.exit(1);
}

// Cookie parsing with signed cookie support
app.beforeEach(cookieParser({ secret: keys.cookieKey }));

// For authentication
app.beforeEach(
  auth({
    secret: keys.tokenSecret,
    tokenExpiry: 30 * 24 * 60 * 60 * 1000, // 30 days
    saveToken: async (tokenId, userId, expiresAt) => {
      await DB.insert("tokens", {
        id: tokenId,
        user_id: Number(userId),
        expires_at: expiresAt,
      });
    },
    findToken: async (tokenId) => {
      const row = await DB.find<{ user_id: number; expires_at: Date }>(
        "SELECT user_id, expires_at FROM tokens WHERE id = $1",
        [tokenId]
      );
      return row
        ? { userId: String(row.user_id), expiresAt: row.expires_at }
        : null;
    },
    revokeToken: async (tokenId) => {
      await DB.delete("tokens", "id = $1", [tokenId]);
    },
  })
);

// Restore req.user from the signed uid cookie (Google OAuth), Falls back to
// the email/password auth when uid isn't present
app.beforeEach(async (req, res, next) => {
  const uid = req.signedCookies?.uid;
  if (uid) {
    req.user = { id: Number(uid) };
    return next();
  }

  const token = req.signedCookies?.token;
  if (token) {
    const result = await req.verifyToken(token as string);
    if (result)
      req.user = {
        id: Number(result.userId),
        tokenId: (token as string).split(".")[0],
      };
  }

  next();
});

// Logging middleware
app.beforeEach((req, res, next) => {
  const requestStart = Date.now();
  // Grab requester ip address
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  // Once the request is finished
  res.on("finish", () => {
    // Get req status code and message
    const { statusCode, statusMessage } = res;
    // Calculate how much it took the request to finish
    const processingTime = Date.now() - requestStart;

    // Format the log message and send it to log function
    log(
      ip +
        " -- " +
        req.method +
        " " +
        req.url +
        " " +
        statusCode +
        " " +
        statusMessage +
        " -- response-time: " +
        processingTime +
        " ms"
    );
  });
  next();
});

// Show the home page
app.route("get", "/", (req: Request, res: Response) => {
  res.sendFile(path.join(publicPath, "./index.html"), "text/html");
});

app.route("get", "/terms", (req: Request, res: Response) => {
  res.sendFile(path.join(publicPath, "./terms.html"), "text/html");
});

app.route("get", "/privacy", (req: Request, res: Response) => {
  res.sendFile(path.join(publicPath, "./privacy.html"), "text/html");
});

app.route("get", "/reset-password", (req: Request, res: Response) => {
  res.sendFile(path.join(publicPath, "./index.html"), "text/html");
});

// ------ API Routes ------ //
apiRouter(app);

// Send 404 page for any route nothing else matched
app.fallback((req: Request, res: Response) => {
  res.status(404).sendFile(path.join(publicPath, "./404.html"), "text/html");
});

// Handle all the errors that could happen in the routes
app.handleErr((error: any, req: Request, res: Response) => {
  if (error && error.status) {
    res.status(error.status).json({ error: error.message });
  } else {
    console.error(error);
    log(error);
    res.status(500).json({
      error: "Sorry, something unexpected happened from our side.",
    });
  }
});

export default app;
