import { expect, test } from "@playwright/test";

import { E2E_BASE_URL } from "./ports";

/**
 * E1 — full email OTP sign-in over a real `next start` server (OP-85, contract
 * §1.1).
 *
 * The integration suite drives the auth handler in-process; this spec proves
 * the same journey works through the deployed HTTP surface: the `next start`
 * server routes `/api/auth/**` to Better Auth, the OTP is captured by the
 * server's memory transport (read back through the test-only route), and a
 * successful sign-in returns a `better-auth.session_token` cookie with the
 * §0.2 security attributes.
 *
 * The email is unique per run so `auth.otp`'s 5/hour/contact limit never bleeds
 * into a re-run when `reuseExistingServer` keeps the e2e server alive.
 */

test.describe("email OTP sign-in over the API", () => {
  test("E1: send → read the captured code → sign in returns a session cookie", async ({
    request,
  }) => {
    const email = `e2e-${String(Date.now())}-${Math.random().toString(16).slice(2)}@example.com`;

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
    expect(setCookie).toContain("better-auth.session_token=");
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
  });
});
