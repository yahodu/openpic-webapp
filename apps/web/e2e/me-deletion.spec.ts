import { expect, test } from "@playwright/test";

import { E2E_BASE_URL } from "./ports";

/**
 * E1 — account deletion request and cancel over the deployed HTTP surface
 * (OP-91, contract §1.4).
 *
 * The integration suite drives the route handlers directly. This spec proves
 * the same journey through a real `next start` server, middleware and a real
 * Better Auth session cookie, across the two routes that make up the cancel
 * window:
 *
 *   sign in via email OTP → POST /me/deletion (matching confirmEmail) returns
 *   the scheduled purge → DELETE /me/deletion cancels it → a subsequent
 *   GET /me shows the account active again with no deletion schedule.
 *
 * The email is unique per run so `auth.otp`'s limit never bleeds into a re-run
 * when `reuseExistingServer` keeps the e2e server alive.
 */

test.describe("account deletion cancel window over the API", () => {
  test("E1: request deletion then cancel it via the API", async ({ request }) => {
    const email = `e2e-op91-${String(Date.now())}-${Math.random().toString(16).slice(2)}@example.com`;

    // Sign in with a real email OTP session cookie.
    const sent = await request.post("/api/auth/email-otp/send-verification-otp", {
      headers: { origin: E2E_BASE_URL },
      data: { email, type: "sign-in" },
    });
    expect(sent.status()).toBe(200);

    const captured = await request.get(
      `/api/v1/__test__/otp?contact=${encodeURIComponent(email)}&channel=email`
    );
    expect(captured.status()).toBe(200);
    const { code } = (await captured.json()) as { code: string | null };
    expect(typeof code).toBe("string");

    const signedIn = await request.post("/api/auth/sign-in/email-otp", {
      headers: { origin: E2E_BASE_URL },
      data: { email, otp: code },
    });
    expect(signedIn.status()).toBe(200);

    // Request deletion; a matching confirmEmail schedules the purge.
    const requested = await request.post("/api/v1/me/deletion", {
      headers: { origin: E2E_BASE_URL, "x-requested-with": "XMLHttpRequest" },
      data: { confirmEmail: email },
    });
    expect(requested.status()).toBe(202);
    const payload = (await requested.json()) as Record<string, unknown>;
    expect(payload.status).toBe("deletion_pending");
    expect(typeof payload.scheduledAt).toBe("string");
    expect(payload.cancelUntil).toBe(payload.scheduledAt);
    expect(payload.cancelUrl).toBe("/api/v1/me/deletion");

    // Cancel inside the window.
    const cancelled = await request.delete("/api/v1/me/deletion", {
      headers: { origin: E2E_BASE_URL, "x-requested-with": "XMLHttpRequest" },
    });
    expect(cancelled.status()).toBe(204);

    // The account is active again and no longer scheduled for purge.
    const me = await request.get("/api/v1/me");
    expect(me.status()).toBe(200);
    const account = (await me.json()) as Record<string, unknown>;
    expect(account.status).toBe("active");
    expect(account.deletionScheduledAt).toBeNull();
  });
});
