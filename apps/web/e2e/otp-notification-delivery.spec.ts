import { expect, test } from "@playwright/test";

import { E2E_BASE_URL } from "./ports";

/**
 * E1 — full email OTP sign-in over a real `next start` server, now delivered by
 * the synchronous `NotificationService` path (OP-95, ADR-0096).
 *
 * The integration suite drives the auth handler in-process; this spec proves the
 * same journey works through the deployed HTTP surface with the **real** OTP
 * sender: the send is resolved → rendered → handed to the configured
 * `MessageTransport` (= the memory transport in `APP_ENV=e2e`), the code is
 * captured for read-back, and a successful sign-in returns a
 * `better-auth.session_token` cookie with the §0.2 security attributes.
 *
 * The read-back route must expose the transport receipt (`providerMessageId`)
 * alongside the code: it is the only e2e-observable proof that the code
 * travelled through the injected transport rather than a legacy in-process
 * capture (contrast the OP-85 `memoryOtpSender`, which minted no provider id).
 * The legacy reader returned only `{ code }`, so this spec is RED until the
 * real sender + memory transport are wired.
 *
 * The email is unique per run so `auth.otp`'s 5/hour/contact limit never bleeds
 * into a re-run when `reuseExistingServer` keeps the e2e server alive.
 */

test.describe("email OTP sign-in through the NotificationService (E1)", () => {
  test("E1: send reaches the memory transport → read the captured code → sign in mints a session", async ({
    request,
  }) => {
    const email = `e2e-op95-${String(Date.now())}-${Math.random().toString(16).slice(2)}@example.com`;

    const sent = await request.post("/api/auth/email-otp/send-verification-otp", {
      headers: { origin: E2E_BASE_URL },
      data: { email, type: "sign-in" },
    });
    expect(sent.status()).toBe(200);

    const captured = await request.get(
      `/api/v1/__test__/otp?contact=${encodeURIComponent(email)}&channel=email`
    );
    expect(captured.status()).toBe(200);
    const body = (await captured.json()) as {
      code: string | null;
      providerMessageId?: string | null;
    };
    expect(typeof body.code).toBe("string");
    // Proof the code travelled through the injected MessageTransport.
    expect(typeof body.providerMessageId).toBe("string");
    expect(body.providerMessageId).not.toBe("");

    const signedIn = await request.post("/api/auth/sign-in/email-otp", {
      headers: { origin: E2E_BASE_URL },
      data: { email, otp: body.code },
    });
    expect(signedIn.status()).toBe(200);

    const setCookie = signedIn.headers()["set-cookie"] ?? "";
    expect(setCookie).toContain("better-auth.session_token=");
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
  });
});
