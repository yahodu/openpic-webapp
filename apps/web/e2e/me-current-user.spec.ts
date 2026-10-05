import { expect, test } from "@playwright/test";

import { E2E_BASE_URL } from "./ports";

/**
 * E1 — the account bootstrap call and a profile edit over the deployed HTTP
 * surface (OP-90, contract §1.2).
 *
 * The integration suite drives the route handlers directly; this spec proves
 * the same contract through a real `next start` server, middleware (CSRF) and a
 * real Better Auth session cookie:
 *
 *   sign in via email OTP → GET /me returns the full §1.2 body →
 *   PATCH /me { displayName } returns the updated body and is persisted →
 *   a second GET /me reflects the change.
 *
 * The email is unique per run so `auth.otp`'s limit never bleeds into a re-run
 * when `reuseExistingServer` keeps the e2e server alive.
 */

test.describe("current user over the API", () => {
  test("E1: sign in, read /me, patch displayName, then read the change back", async ({
    request,
  }) => {
    const email = `e2e-op90-${String(Date.now())}-${Math.random().toString(16).slice(2)}@example.com`;
    const displayName = "Rahul E2E";

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

    // The bootstrap read returns the full §1.2 body in one round trip.
    const before = await request.get("/api/v1/me");
    expect(before.status()).toBe(200);
    const bootstrap = (await before.json()) as Record<string, unknown>;
    expect(typeof bootstrap.id).toBe("string");
    expect(bootstrap.email).toBe(email);
    expect(bootstrap.displayName).toBeNull();
    expect(bootstrap.platformRole).toBe("client");
    expect(bootstrap.status).toBe("active");
    expect(bootstrap.timeZone).toBe("Asia/Kolkata");
    expect(bootstrap.capabilities).toEqual({
      canCreateEvent: false,
      canPurchase: false,
      isAdmin: false,
    });
    expect(typeof bootstrap.unreadNotificationCount).toBe("number");

    // Editing the profile (a cookie-authenticated write needs the CSRF pair).
    const patched = await request.patch("/api/v1/me", {
      headers: {
        origin: E2E_BASE_URL,
        "x-requested-with": "XMLHttpRequest",
      },
      data: { displayName: `  ${displayName}  ` },
    });
    expect(patched.status()).toBe(200);
    const updated = (await patched.json()) as Record<string, unknown>;
    expect(updated.displayName).toBe(displayName);

    // The change is persisted, not just echoed.
    const after = await request.get("/api/v1/me");
    expect(after.status()).toBe(200);
    const reflected = (await after.json()) as Record<string, unknown>;
    expect(reflected.displayName).toBe(displayName);
    expect(reflected.email).toBe(email);
  });
});
