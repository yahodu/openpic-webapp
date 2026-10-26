import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { E2E_BASE_URL } from "./ports";

/**
 * E1 — create, PATCH with its ETag, then delete an event (OP-117, contract
 * §4.1, §0.10).
 *
 * The integration suite drives the route handlers in-process; this spec proves
 * the same conditional-write journey through a real `next start` server, the
 * middleware (CSRF + Origin), a real Better Auth session and the
 * `current`-alias provisioning:
 *
 *   sign up (email OTP) → bind and verify a phone number so the account is
 *   **complete** → `POST /tenants/current/events` provisions the workspace
 *   and answers `201` → `GET /tenants/{t}/events/{e}` returns the event's
 *   quoted `ETag` → `PATCH /events/{e}` with `If-Match: <etag>` updates the
 *   description → `DELETE /events/{e}` with the exact `confirmName` answers
 *   `202 {status: "deleting", purgeScheduledAt, irreversible: true}`.
 *
 * The delete is the only content-destroying path and is user-initiated; the
 * PATCH+DELETE use the global `/events/{e}` surface the co-organizer writes
 * go through (ADR-0580).
 */

test.describe("update and delete an event over the real HTTP surface", () => {
  test("E1: create, then PATCH with the ETag, then delete", async ({ request }) => {
    const stamp = randomUUID();
    const email = `e2e-op117-${stamp}@example.com`;
    const phone = `+91${String(100000000 + (parseInt(stamp.replace(/-/g, "").slice(0, 9), 16) % 900000000))}`;

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

    // 2. Complete the account: bind and verify a phone number.
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
        name: "E2E Update Wedding",
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

    // 4. Read the event back to obtain its quoted ETag for the conditional
    //    write (contract §0.10: PATCH must present If-Match).
    const fetched = await request.get(`/api/v1/tenants/${tenantId}/events/${eventId}`);
    expect(fetched.status()).toBe(200);
    const etag = fetched.headers().etag;
    if (typeof etag !== "string") {
      throw new Error("expected an etag header on the event read");
    }
    expect(etag).toMatch(/^"[^"]+"$/);

    // 5. PATCH the description guarded by If-Match.
    const patched = await request.patch(`/api/v1/events/${eventId}`, {
      headers: {
        origin: E2E_BASE_URL,
        "x-requested-with": "XMLHttpRequest",
        "if-match": etag,
      },
      data: { description: "Updated by the organizer" },
    });
    expect(patched.status()).toBe(200);
    const patchedBody = (await patched.json()) as Record<string, unknown>;
    expect(patchedBody.id).toBe(eventId);
    expect(patchedBody.description).toBe("Updated by the organizer");

    // 6. Delete with the exact name — deliberate and irreversible.
    const patchedEtag = patched.headers().etag;
    if (typeof patchedEtag !== "string") {
      throw new Error("expected an etag header on the event PATCH");
    }
    const deleted = await request.delete(`/api/v1/events/${eventId}`, {
      headers: {
        origin: E2E_BASE_URL,
        "x-requested-with": "XMLHttpRequest",
        "if-match": patchedEtag,
      },
      data: { confirmName: "E2E Update Wedding" },
    });
    expect(deleted.status()).toBe(202);
    const deleteBody = (await deleted.json()) as Record<string, unknown>;
    expect(deleteBody.status).toBe("deleting");
    expect(deleteBody.irreversible).toBe(true);
    expect(typeof deleteBody.purgeScheduledAt).toBe("string");
  });
});
