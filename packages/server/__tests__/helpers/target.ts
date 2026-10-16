import { it } from "mocha";

// The tests run against the app of this process by default. To run the very same tests against
// a server that is already running (like server-turbo), set TEST_BASE_URL to its address.
let target: any = process.env.TEST_BASE_URL;

if (!target) {
  target = (await import("../../src/app.js")).default;

  // Without this, supertest starts the app on a new random port for every single request and
  // stops it again afterwards. Now and then that port is one that another program on the
  // machine listens on (for 127.0.0.1 only), and the request ends up there instead.
  target.listen(0);
}

export default target;

// For the tests that fake Google with the fetch() of this process. A server running elsewhere
// doesn't use that fetch() and would call the real Google, so they're skipped with TEST_BASE_URL.
export const itInProcess = process.env.TEST_BASE_URL ? it.skip : it;
