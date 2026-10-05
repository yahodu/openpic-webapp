import { expect, test } from "@playwright/test";

import { E2E_BASE_URL } from "./ports";

/**
 * E1 — sign-up via email OTP then `GET /me` shows the profile defaults (OP-89,
 * contract §1.1 "after user created", §1.2).
 *
 * The integration suite proves the lifecycle hook persists the profile and
 * preferences documents. This spec proves the same state is visible over the
 * deployed HTTP surface: after a first OTP sign-in the account bootstrap call
 * returns the schema §13.2 defaults the rest of the app relies on — the served
 * locale, `platformRole: "client"`, `status: "active"`, `marketingOptIn: false`
 * and "never probed" contact capabilities.
 *
 * The email is unique per run so `auth.otp`'s limit never bleeds into a re-run
 * when `reuseExistingServer` keeps the e2e server alive.
 */

test.describe("identity lifecycle over the API", () => {
  test("E1: sign-up via OTP then GET /me shows profile defaults", async ({ request }) => {
    const email = `e2e-op89-${String(Date.now())}-${Math.random().toString(16).slice(2)}@example.com`;

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

    const me = await request.get("/api/v1/me");
    expect(me.status()).toBe(200);

    const body = (await me.json()) as Record<string, unknown>;
    expect(body.locale).toBe("en-IN");
    expect(body.platformRole).toBe("client");
    expect(body.status).toBe("active");
    expect(body.marketingOptIn).toBe(false);
    expect(body.accountCompletedAt).toBeNull();
    expect(body.contactCapabilities).toMatchObject({
      whatsappCapable: null,
      whatsappCheckedAt: null,
    });
  });
});
