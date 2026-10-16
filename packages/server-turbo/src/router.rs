use cpeak::Cpeak;

use crate::controllers::{auth, url, user};
use crate::lib::google_oauth::build_auth_url;
use crate::middlewares;

// ------------------------------------------------ //
// ************ AUTH ROUTES ************* //
// ------------------------------------------------ //

pub fn api_router(app: &mut Cpeak) {
    app.route("get", "/auth/google", async |_req, res| {
        res.redirect(&build_auth_url())
    });

    app.route("get", "/auth/google/callback", auth::handle_oauth_callback);

    app.route("get", "/logout", auth::log_out);

    // Check to see if a user is logged in or not. Return user data if logged in
    app.route("get", "/auth/status", auth::check_auth_status);

    // Send a 5-digit code to verify an email before signup
    app.route("post", "/auth/send-code", auth::send_code);

    // Verify the code and create the account, then log the user in
    app.route("post", "/auth/register", auth::register);

    // Log in with email + password
    app.route_with(
        "post",
        "/auth/login",
        middlewares::rate_limit_login,
        auth::log_in,
    );

    // Send a password reset link
    app.route("post", "/auth/forgot-password", auth::forgot_password);

    // Reset the password using the emailed link's token
    app.route("patch", "/auth/reset-password", auth::reset_password);

    // ------------------------------------------------ //
    // ************ USER & ACCOUNT ROUTES ************* //
    // ------------------------------------------------ //

    app.route(
        "get",
        "/user/username-availability/:username",
        user::check_username_availability,
    );

    app.route_with(
        "patch",
        "/user/username",
        middlewares::require_auth,
        user::update_username,
    );

    app.route_with(
        "patch",
        "/user/username/switch",
        middlewares::require_auth,
        user::switch_username,
    );

    // Send a 5-digit code to a new email address to confirm the change
    app.route_with(
        "post",
        "/user/email/send-code",
        middlewares::require_auth,
        user::send_email_change_code,
    );

    // Confirm the code and apply the email change
    app.route_with(
        "patch",
        "/user/email/confirm",
        middlewares::require_auth,
        user::confirm_email_change,
    );

    // Change password
    app.route_with(
        "patch",
        "/user/password",
        middlewares::require_auth,
        user::change_password,
    );

    // ------------------------------------------------ //
    // ************ URL ROUTES ************* //
    // ------------------------------------------------ //

    // Get the url, shorten it and save to database
    app.route_with(
        "post",
        "/url",
        (
            middlewares::is_valid_url,
            middlewares::check_url_safety,
            middlewares::rate_limit_url,
        ),
        url::shorten,
    );

    // Change the type of a url (e.g. from default to custom). User can do this from the customization modal
    app.route_with(
        "patch",
        "/url/:id/type",
        (
            middlewares::check_url_ownership,
            middlewares::rate_limit_url,
        ),
        url::change_url_type,
    );

    // Update the destination URL of an existing shortened link
    app.route_with(
        "patch",
        "/url/:id/real-url",
        (
            middlewares::check_url_ownership,
            middlewares::is_valid_url,
            middlewares::check_url_safety,
            middlewares::rate_limit_url,
        ),
        url::update_real_url,
    );

    // Return the list of urls user has shortened
    app.route("get", "/url", url::get_urls);

    // Check to see if an affix code is available
    app.route(
        "get",
        "/url/affix-availability/:code",
        url::check_affix_availability,
    );

    // Check to see if a custom  code is available
    app.route(
        "get",
        "/url/custom-availability/:code",
        url::check_custom_availability,
    );

    // Send a QR code image for a link
    app.route_with(
        "get",
        "/qr/:id",
        middlewares::check_url_ownership,
        url::send_qr_code,
    );

    // Redirect to the real url via QR code
    app.route("get", "/q/:id", url::redirect);

    // Shown before redirecting to a non-whitelisted destination
    app.route("get", "/redirect-warning", url::redirect_warning_page);

    // Fetched client-side by the redirect warning page to get the destination it should show
    app.route("get", "/redirect-warning/data", url::redirect_warning_data);

    // Redirect to the real url
    app.route("get", "/:id", url::redirect);

    // Redirect to the real url (for affix type only)
    app.route("get", "/:username/:id", url::redirect);

    // Delete a url record
    app.route_with(
        "delete",
        "/url/:id",
        middlewares::check_url_ownership,
        url::remove,
    );

    // Get stats for a single shortened link
    app.route_with(
        "get",
        "/url/:id/stats",
        middlewares::check_url_ownership,
        url::get_stats,
    );
}
