import cpeak, { serveStatic, parseJSON, cookieParser } from "cpeak";
import type { CpeakRequest as Request, CpeakResponse as Response } from "cpeak";

import path from "path";
import compression from "compression";
import helmet from "helmet";

import log from "./lib/log.js";
import keys from "./config/keys.js";
import apiRouter from "./router.js";

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

// Cookie parsing with signed cookie support
app.beforeEach(cookieParser({ secret: keys.cookieKey }));

// Restore req.user from signed uid cookie on every request
app.beforeEach((req, res, next) => {
  const uid = req.signedCookies?.uid;
  if (uid) req.user = { id: uid };
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

// ------ API Routes ------ //
apiRouter(app);

/*

// Send 404 page
app.get("*", (req, res) => {
  res.sendFile("404.html", { root: __dirname + "/../public" });
});

*/

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
