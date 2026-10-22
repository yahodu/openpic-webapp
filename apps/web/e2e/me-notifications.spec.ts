import { expect, test } from "@playwright/test";

import { E2E_BASE_URL } from "./ports";

/**
 * E1 — the in-app notification badge over the deployed HTTP surface (OP-97,
 * contract §7.1/§7.2).
 *
 * The integration suites drive the route handlers in-process against a seeded
 * collection. This spec proves the same journey end to end, through a real
 * `next start` server, with the notification produced by the production write
 * path rather than by a fixture: creating an account emits `account.welcome`
 * into the outbox, the opportunistic `after()` drain fans it out (design §2),
 * and the resulting in-app row is visible to the badge poll, readable, and then
 * gone from the count.
 *
 * The email is unique per run so `auth.otp`'s per-contact limit never bleeds
 * into a re-run when `reuseExistingServer` keeps the e2e server alive.
 *
 * ## What this spec deliberately does not assert
 *
 * How the e2e environment gets a resolvable notification catalogue. The suite's
 * `api` project boots an empty database (`e2e/start-server.mjs`); either the
 * fan-out resolves the catalogue with the sanctioned non-production seed
 * fallback already used by the synchronous OTP path (ADR-0098 §6), or the
 * environment seeds `notificationTypes`/`notificationTemplates` first. The
 * journey below is agnostic: it observes only the badge, the row and the read.
 */

test.describe("in-app notification feed (E1)", () => {
  test("E1: a welcome notification raises the badge, and reading it clears it", async ({
    request,
  }) => {
    const email = `e2e-op97-${String(Date.now())}-${Math.random().toString(16).slice(2)}@example.com`;

    // Sign in through the real email-OTP handshake so the account-creation hook
    // runs and emits `account.welcome`.
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

    const setCookie = signedIn.headers()["set-cookie"] ?? "";
    const sessionCookie = setCookie.split(";")[0] ?? "";
    expect(sessionCookie).toContain("better-auth.session_token=");

    // The endpoint must exist before the journey can be observed at all.
    const probe = await request.get("/api/v1/me/notifications/unread-count", {
      headers: { cookie: sessionCookie },
    });
    expect(probe.status()).toBe(200);

    // The fan-out is opportunistic (`after()`), so poll the badge rather than
    // assuming the drain beat the response.
    await expect
      .poll(
        async () => {
          const response = await request.get("/api/v1/me/notifications/unread-count", {
            headers: { cookie: sessionCookie },
          });
          if (response.status() !== 200) {
            return -1;
          }
          return ((await response.json()) as { unreadCount: number }).unreadCount;
        },
        {
          message: "the welcome notification never reached the unread badge",
          timeout: 20_000,
        }
      )
      .toBe(1);

    const listing = await request.get("/api/v1/me/notifications", {
      headers: { cookie: sessionCookie },
    });
    expect(listing.status()).toBe(200);
    const page = (await listing.json()) as { data: { id: string; typeKey: string }[] };
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.typeKey).toBe("account.welcome");
    const notificationId = page.data[0]?.id ?? "";

    const read = await request.post(`/api/v1/me/notifications/${notificationId}/read`, {
      headers: {
        cookie: sessionCookie,
        origin: E2E_BASE_URL,
        "x-requested-with": "XMLHttpRequest",
      },
    });
    expect(read.status()).toBe(204);

    const after = await request.get("/api/v1/me/notifications/unread-count", {
      headers: { cookie: sessionCookie },
    });
    expect(after.status()).toBe(200);
    expect(((await after.json()) as { unreadCount: number }).unreadCount).toBe(0);
  });
});
