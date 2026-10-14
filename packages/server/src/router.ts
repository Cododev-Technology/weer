import type {
  Cpeak,
  CpeakRequest as Request,
  CpeakResponse as Response,
} from "cpeak";

import { buildAuthUrl } from "./lib/google-oauth.js";
import middlewares from "./middlewares.js";
import Auth from "./controllers/auth.js";
import User from "./controllers/user.js";
import Url from "./controllers/url.js";

// ------------------------------------------------ //
// ************ AUTH ROUTES ************* //
// ------------------------------------------------ //

export default (app: Cpeak) => {
  app.route("get", "/auth/google", (req: Request, res: Response) => {
    res.redirect(buildAuthUrl());
  });

  app.route("get", "/auth/google/callback", Auth.handleOAuthCallback);

  app.route("get", "/logout", Auth.logOut);

  // Check to see if a user is logged in or not. Return user data if logged in
  app.route("get", "/auth/status", Auth.checkAuthStatus);

  // Send a 5-digit code to verify an email before signup
  app.route("post", "/auth/send-code", Auth.sendCode);

  // Verify the code and create the account, then log the user in
  app.route("post", "/auth/register", Auth.register);

  // Log in with email + password
  app.route("post", "/auth/login", middlewares.rateLimitLogin, Auth.logIn);

  // Send a password reset link
  app.route("post", "/auth/forgot-password", Auth.forgotPassword);

  // Reset the password using the emailed link's token
  app.route("patch", "/auth/reset-password", Auth.resetPassword);

  // ------------------------------------------------ //
  // ************ USER & ACCOUNT ROUTES ************* //
  // ------------------------------------------------ //

  app.route(
    "get",
    "/user/username-availability/:username",
    User.checkUsernameAvailability
  );

  app.route(
    "patch",
    "/user/username",
    middlewares.requireAuth,
    User.updateUsername
  );

  app.route(
    "patch",
    "/user/username/switch",
    middlewares.requireAuth,
    User.switchUsername
  );

  // Send a 5-digit code to a new email address to confirm the change
  app.route(
    "post",
    "/user/email/send-code",
    middlewares.requireAuth,
    User.sendEmailChangeCode
  );

  // Confirm the code and apply the email change
  app.route(
    "patch",
    "/user/email/confirm",
    middlewares.requireAuth,
    User.confirmEmailChange
  );

  // Change password
  app.route(
    "patch",
    "/user/password",
    middlewares.requireAuth,
    User.changePassword
  );

  // ------------------------------------------------ //
  // ************ URL ROUTES ************* //
  // ------------------------------------------------ //

  // Get the url, shorten it and save to database
  app.route("post", "/url", middlewares.isValidURL, middlewares.checkUrlSafety, middlewares.rateLimitUrl, Url.shorten);

  // Change the type of a url (e.g. from default to custom). User can do this from the customization modal
  app.route("patch", "/url/:id/type", middlewares.checkUrlOwnership, middlewares.rateLimitUrl, Url.changeUrlType);

  // Update the destination URL of an existing shortened link
  app.route("patch", "/url/:id/real-url", middlewares.checkUrlOwnership, middlewares.isValidURL, middlewares.checkUrlSafety, middlewares.rateLimitUrl, Url.updateRealUrl);

  // Return the list of urls user has shortened
  app.route("get", "/url", Url.getUrls);

  // Check to see if an affix code is available
  app.route("get", "/url/affix-availability/:code", Url.checkAffixAvailability);

  // Check to see if a custom  code is available
  app.route(
    "get",
    "/url/custom-availability/:code",
    Url.checkCustomAvailability
  );

  // Send a QR code image for a link
  app.route("get", "/qr/:id", middlewares.checkUrlOwnership, Url.sendQrCode);

  // Redirect to the real url via QR code
  app.route("get", "/q/:id", Url.redirect);

  // Shown before redirecting to a non-whitelisted destination
  app.route("get", "/redirect-warning", Url.redirectWarningPage);

  // Fetched client-side by the redirect warning page to get the destination it should show
  app.route("get", "/redirect-warning/data", Url.redirectWarningData);

  // Redirect to the real url
  app.route("get", "/:id", Url.redirect);

  // Redirect to the real url (for affix type only)
  app.route("get", "/:username/:id", Url.redirect);

  // Delete a url record
  app.route("delete", "/url/:id", middlewares.checkUrlOwnership, Url.remove);

  // Get stats for a single shortened link
  app.route("get", "/url/:id/stats", middlewares.checkUrlOwnership, Url.getStats);
};
