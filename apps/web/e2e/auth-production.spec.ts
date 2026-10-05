import { expect, test } from "@playwright/test";

/**
 * E2 — the test-only OTP route is reachable only outside production (OP-85).
 *
 * This spec runs in the `api-production` project, whose server boots with
 * `APP_ENV=production` (see `start-production-server.mjs`). It asserts both
 * halves of the guard so it cannot pass vacuously:
 *
 *   - the same route answers `200` on the e2e server (the positive control —
 *     without it, a route that simply does not exist would also "pass" the
 *     404 assertion);
 *   - it answers `404` on the production server, so a leaked OTP reader is
 *     never exposed to real users.
 *
 * `playwright.request.newContext` is used for the cross-server control probe
 * because the project's default `request` fixture is pinned to the production
 * base URL.
 */

const E2E_ORIGIN = "http://127.0.0.1:3000";

test.describe("test-only OTP route — environment guard", () => {
  test("E2: 200 on the e2e server, 404 under APP_ENV=production", async ({
    request,
    playwright,
  }) => {
    const e2e = await playwright.request.newContext({
      baseURL: E2E_ORIGIN,
      extraHTTPHeaders: { accept: "application/json" },
    });

    try {
      const reachable = await e2e.get("/api/v1/__test__/otp?contact=a@b.com&channel=email");
      expect(reachable.status()).toBe(200);
    } finally {
      await e2e.dispose();
    }

    const denied = await request.get("/api/v1/__test__/otp?contact=a@b.com&channel=email");
    expect(denied.status()).toBe(404);
  });
});
