import { expect, test } from "@playwright/test";

import { E2E_BASE_URL } from "./ports";

/**
 * E1 — sign up, create an event, then read it back (OP-115, contract §4.1).
 *
 * The integration suite drives the route handlers in-process; this spec proves
 * the same journey through a real `next start` server, the middleware (CSRF +
 * Origin), a real Better Auth session and the `current` alias:
 *
 *   sign up (email OTP) → bind and verify a phone number so the account is
 *   **complete** (`user:complete` is the guard on the create route) →
 *   `POST /tenants/current/events` **provisions the workspace** for the
 *   primary-less caller (`ensureTenantForUser`) and answers `201` with
 *   `Location` + the event id → `GET` that event returns the Event DTO.
 *
 * A brand-new email + phone are minted per run so the `auth.otp` / `auth.verify`
 * rate-limit buckets never bleed into a re-run while `reuseExistingServer`
 * keeps the e2e server alive.
 */

test.describe("create an event over the real HTTP surface", () => {
  test("E1: sign-up, create an event as a brand-new organizer, then GET it", async ({
    request,
  }) => {
    const stamp = `${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
    const email = `e2e-op115-${stamp}@example.com`;
    const phone = `+91${String(Math.floor(100000000 + Math.random() * 899999999))}`;

    // 1. Sign up with the email OTP handshake (real Better Auth flow).
    const sent = await request.post("/api/auth/email-otp/send-verification-otp", {
      headers: { origin: E2E_BASE_URL },
      data: { email, type: "sign-in" },
    });
    expect(sent.status()).toBe(200);

    const emailOtp = await request.get(
      `/api/v1/__test__/otp?contact=${encodeURIComponent(email)}&channel=email`
    );
    expect(emailOtp.status()).toBe(200);
    const emailCode = ((await emailOtp.json()) as { code: string | null }).code;
    expect(typeof emailCode).toBe("string");

    const signedIn = await request.post("/api/auth/sign-in/email-otp", {
      headers: { origin: E2E_BASE_URL },
      data: { email, otp: emailCode },
    });
    expect(signedIn.status()).toBe(200);

    // 2. Complete the account: bind and verify a phone number, so the
    //    `user:complete` guard on the events route passes.
    const phoneSent = await request.post("/api/auth/phone-number/send-otp", {
      headers: { origin: E2E_BASE_URL },
      data: { phoneNumber: phone },
    });
    expect(phoneSent.status()).toBe(200);

    const phoneOtp = await request.get(
      `/api/v1/__test__/otp?contact=${encodeURIComponent(phone)}&channel=sms`
    );
    expect(phoneOtp.status()).toBe(200);
    const phoneCode = ((await phoneOtp.json()) as { code: string | null }).code;
    expect(typeof phoneCode).toBe("string");

    const phoneVerified = await request.post("/api/auth/phone-number/verify", {
      headers: { origin: E2E_BASE_URL },
      data: { phoneNumber: phone, code: phoneCode },
    });
    expect(phoneVerified.status()).toBe(200);

    const me = await request.get("/api/v1/me");
    expect(me.status()).toBe(200);
    const meBody = (await me.json()) as { accountCompletedAt?: string | null };
    expect(typeof meBody.accountCompletedAt).toBe("string");

    // 3. Create the event; the caller has no workspace, so the route
    //    provisions one and echoes it on the wire.
    const now = Date.now();
    const created = await request.post("/api/v1/tenants/current/events", {
      headers: {
        origin: E2E_BASE_URL,
        "x-requested-with": "XMLHttpRequest",
        "idempotency-key": crypto.randomUUID(),
      },
      data: {
        name: "E2E Wedding",
        description: "Rehearsal dinner photos",
        startAt: new Date(now + 2 * 86_400_000).toISOString(),
        endAt: new Date(now + 3 * 86_400_000).toISOString(),
        displayTimeZone: "Asia/Kolkata",
        logoAssetId: null,
        watermarkAssetId: null,
        publish: true,
      },
    });
    expect(created.status()).toBe(201);
    const createdBody = (await created.json()) as { id?: string };
    const eventId = createdBody.id;
    if (typeof eventId !== "string") {
      throw new Error("expected the created event id in the response body");
    }

    const tenantId = created.headers()["x-tenant-id"];
    if (typeof tenantId !== "string") {
      throw new Error("expected the x-tenant-id response header");
    }
    expect(created.headers().location).toBe(`/api/v1/tenants/${tenantId}/events/${eventId}`);

    // 4. The event reads back through the tenant-scoped GET.
    const fetched = await request.get(`/api/v1/tenants/${tenantId}/events/${eventId}`);
    expect(fetched.status()).toBe(200);
    const fetchedBody = (await fetched.json()) as Record<string, unknown>;
    expect(fetchedBody.id).toBe(eventId);
    expect(fetchedBody.name).toBe("E2E Wedding");
    expect(fetchedBody.status).toBe("published");
  });
});
