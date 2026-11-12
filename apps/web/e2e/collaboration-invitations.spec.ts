import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { clientIpFor } from "./client-ip";
import { E2E_BASE_URL } from "./ports";

const CLIENT_IP = clientIpFor("collaboration-invitations.spec.ts");

/**
 * E1 — invite by email, sign up, accept in-app, read the event as a
 * co-organizer (OP-121, contract §2.3, §4.1).
 *
 * The integration suite drives the decision routes in-process. This spec proves
 * the same journey over the deployed HTTP surface — the middleware (CSRF +
 * Origin), two real Better Auth sessions in two cookie jars, and the `current`
 * tenant alias:
 *
 *   organizer signs up (email OTP) and completes the account (phone OTP) →
 *   `POST /tenants/current/events` provisions the workspace and answers `201`
 *   with the event id and `X-Tenant-Id` →
 *   the organizer invites the invitee **by email** (`201`, `pending`) →
 *   the invitee signs up with that address, so the OP-89 lazy-invite hook links
 *   `invitee.userId` to the new account →
 *   the invitee accepts **in-app** (`POST /me/invitations/{id}/accept`),
 *   answering `200` with `alreadyResolved: false` and `role: "co_organizer"` →
 *   the invitee reads the event back (`200`) — the whole point of the story.
 *
 * The invitation id is read from the **organizer's** list: `GET
 * /me/invitations` (the invitee's own pending list) does not exist on the trunk
 * and is not part of OP-121, so the id is the only fact this spec borrows.
 * Everything else is the invitee's own session.
 *
 * Both e-mails and the phone are minted per run, and one fixed per-spec client
 * IP keeps the `auth.otp` buckets from bleeding into a re-run while
 * `reuseExistingServer` keeps the e2e server alive.
 */

/** The event payload the create route accepts (contract §4.1). */
function eventBody(now: number): Record<string, unknown> {
  return {
    name: "E2E Collaboration Wedding",
    description: "Reception photos",
    startAt: new Date(now + 2 * 86_400_000).toISOString(),
    endAt: new Date(now + 3 * 86_400_000).toISOString(),
    displayTimeZone: "Asia/Kolkata",
    logoAssetId: null,
    watermarkAssetId: null,
    publish: true,
  };
}

/**
 * Read the OTP the test transport captured for one contact.
 *
 * @param request - The API context to probe with.
 * @param contact - The email address or phone number.
 * @param channel - `email` or `sms`.
 * @returns The captured code.
 */
async function readOtp(
  request: import("@playwright/test").APIRequestContext,
  contact: string,
  channel: "email" | "sms"
): Promise<string> {
  const captured = await request.get(
    `/api/v1/__test__/otp?contact=${encodeURIComponent(contact)}&channel=${channel}`
  );
  expect(captured.status()).toBe(200);
  const code = ((await captured.json()) as { code: string | null }).code;
  if (typeof code !== "string") {
    throw new Error(`expected a captured ${channel} OTP for ${contact}`);
  }
  return code;
}

test.describe("accept a co-organizer invitation over the real HTTP surface", () => {
  test("E1: invite by email, sign up, accept in-app, then GET the event as co_organizer", async ({
    request,
    playwright,
  }) => {
    const stamp = randomUUID();
    const organizerEmail = `e2e-op121-organizer-${stamp}@example.com`;
    const inviteeEmail = `e2e-op121-invitee-${stamp}@example.com`;
    const phone = `+91${String(100000000 + (parseInt(stamp.replace(/-/g, "").slice(0, 9), 16) % 900000000))}`;

    // 1. The organizer signs up with the email OTP handshake.
    const organizerSent = await request.post("/api/auth/email-otp/send-verification-otp", {
      headers: { origin: E2E_BASE_URL, "x-forwarded-for": CLIENT_IP },
      data: { email: organizerEmail, type: "sign-in" },
    });
    expect(organizerSent.status()).toBe(200);

    const organizerSignedIn = await request.post("/api/auth/sign-in/email-otp", {
      headers: { origin: E2E_BASE_URL, "x-forwarded-for": CLIENT_IP },
      data: { email: organizerEmail, otp: await readOtp(request, organizerEmail, "email") },
    });
    expect(organizerSignedIn.status()).toBe(200);

    // 2. The organizer completes the account: `user:complete` gates the create.
    const phoneSent = await request.post("/api/auth/phone-number/send-otp", {
      headers: { origin: E2E_BASE_URL, "x-forwarded-for": CLIENT_IP },
      data: { phoneNumber: phone },
    });
    expect(phoneSent.status()).toBe(200);
    const phoneVerified = await request.post("/api/auth/phone-number/verify", {
      headers: { origin: E2E_BASE_URL, "x-forwarded-for": CLIENT_IP },
      data: { phoneNumber: phone, code: await readOtp(request, phone, "sms") },
    });
    expect(phoneVerified.status()).toBe(200);

    // 3. The workspace is provisioned by the create, and its id is echoed.
    const created = await request.post("/api/v1/tenants/current/events", {
      headers: {
        origin: E2E_BASE_URL,
        "x-requested-with": "XMLHttpRequest",
        "idempotency-key": randomUUID(),
      },
      data: eventBody(Date.now()),
    });
    expect(created.status()).toBe(201);
    const eventId = ((await created.json()) as { id?: string }).id;
    if (typeof eventId !== "string") {
      throw new Error("expected the created event id in the response body");
    }
    const tenantId = created.headers()["x-tenant-id"];
    if (typeof tenantId !== "string") {
      throw new Error("expected the x-tenant-id response header");
    }

    // 4. The organizer invites the invitee by email; the row starts pending.
    const invited = await request.post(
      `/api/v1/tenants/${tenantId}/events/${eventId}/invitations`,
      {
        headers: {
          origin: E2E_BASE_URL,
          "x-requested-with": "XMLHttpRequest",
          "idempotency-key": randomUUID(),
        },
        data: { invitee: { kind: "email", email: inviteeEmail }, role: "co_organizer" },
      }
    );
    expect(invited.status()).toBe(201);
    const invitation = (await invited.json()) as { id?: string; status?: string };
    if (typeof invitation.id !== "string") {
      throw new Error("expected the invitation id in the response body");
    }
    expect(invitation.status).toBe("pending");

    // 5. The invitee signs up with the invited address; the lazy-invite hook
    //    resolves the pending row to the new account (OP-89).
    const invitee = await playwright.request.newContext({ baseURL: E2E_BASE_URL });
    try {
      const inviteeSent = await invitee.post("/api/auth/email-otp/send-verification-otp", {
        headers: { origin: E2E_BASE_URL, "x-forwarded-for": CLIENT_IP },
        data: { email: inviteeEmail, type: "sign-in" },
      });
      expect(inviteeSent.status()).toBe(200);

      const inviteeSignedIn = await invitee.post("/api/auth/sign-in/email-otp", {
        headers: { origin: E2E_BASE_URL, "x-forwarded-for": CLIENT_IP },
        data: { email: inviteeEmail, otp: await readOtp(invitee, inviteeEmail, "email") },
      });
      expect(inviteeSignedIn.status()).toBe(200);

      // 6. The invitee accepts in-app and is granted the co-organizer role.
      const accepted = await invitee.post(`/api/v1/me/invitations/${invitation.id}/accept`, {
        headers: { origin: E2E_BASE_URL, "x-requested-with": "XMLHttpRequest" },
      });
      expect(accepted.status()).toBe(200);
      const decision = (await accepted.json()) as Record<string, unknown>;
      expect(decision.id).toBe(invitation.id);
      expect(decision.status).toBe("accepted");
      expect(decision.alreadyResolved).toBe(false);
      expect(decision.resolvedVia).toBe("in_app");
      expect(decision.membership).toEqual({ eventId, role: "co_organizer" });

      // 7. The membership is real: the invitee reads the event it now co-runs.
      const event = await invitee.get(`/api/v1/tenants/${tenantId}/events/${eventId}`);
      expect(event.status()).toBe(200);
      const eventPayload = (await event.json()) as Record<string, unknown>;
      expect(eventPayload.id).toBe(eventId);
      expect(eventPayload.name).toBe("E2E Collaboration Wedding");
    } finally {
      await invitee.dispose();
    }

    // 8. The organizer sees the decision on the invitation list.
    const listed = await request.get(`/api/v1/tenants/${tenantId}/events/${eventId}/invitations`);
    expect(listed.status()).toBe(200);
    const rows = ((await listed.json()) as { data?: { id: string; status: string }[] }).data ?? [];
    expect(rows.map((row) => [row.id, row.status])).toEqual([[invitation.id, "accepted"]]);
  });
});
