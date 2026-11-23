import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";

import { clientIpFor } from "./client-ip";
import { E2E_BASE_URL } from "./ports";

const CLIENT_IP = clientIpFor("notification-actions.spec.ts");

/** The invitation feed row whose actions this journey exercises. */
const INVITE_TYPE_KEY = "collab.invite.sent";

/**
 * E1 — act on a notification from the in-app feed, over the deployed HTTP
 * surface (OP-140, contract §7.3, notification design §7).
 *
 * The integration suite drives the action route in-process against seeds. This
 * spec proves the same journey end to end through a real `next start` server:
 * the middleware (CSRF + Origin), two real Better Auth sessions in two cookie
 * jars, the `current` tenant alias, and a **fan-out-written** feed row.
 *
 * ```
 * invitee signs up (email OTP) and reads `GET /me` for its own id
 *   → organizer signs up (email OTP), completes the account (phone OTP) and
 *     creates an event (`201` + `X-Tenant-Id`)
 *   → the organizer invites that **user** (§2.3's in-app channel; an email
 *     invitee gets no in-app row on the trunk, OP-89's lane)
 *   → the opportunistic `after()` fan-out writes the invitee's feed row
 *   → the invitee posts `POST /me/notifications/{id}/actions/accept`
 *   → the next `GET /me/notifications` shows both actions `unavailable` and
 *     `actionTarget.state: "resolved"` — the decision is closed for every
 *     device, which is the whole point of the story.
 * ```
 *
 * The e-mails and the phone are minted per run, and one fixed per-spec client
 * IP keeps the `auth.otp` buckets from bleeding into a re-run while
 * `reuseExistingServer` keeps the e2e server alive.
 */

/** The event payload the create route accepts (contract §4.1). */
function eventBody(now: number): Record<string, unknown> {
  return {
    name: "E2E Notification Action Wedding",
    description: "Feed action journey",
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
  request: APIRequestContext,
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

/**
 * Sign one caller up through the real email-OTP handshake.
 *
 * @param context - The API context (and cookie jar) the session belongs to.
 * @param email - The address to sign up with (unique per run).
 * @returns The signed-in caller's own user id (`GET /me`).
 */
async function signUp(context: APIRequestContext, email: string): Promise<string> {
  const sent = await context.post("/api/auth/email-otp/send-verification-otp", {
    headers: { origin: E2E_BASE_URL, "x-forwarded-for": CLIENT_IP },
    data: { email, type: "sign-in" },
  });
  expect(sent.status()).toBe(200);
  const signedIn = await context.post("/api/auth/sign-in/email-otp", {
    headers: { origin: E2E_BASE_URL, "x-forwarded-for": CLIENT_IP },
    data: { email, otp: await readOtp(context, email, "email") },
  });
  expect(signedIn.status()).toBe(200);
  const me = await context.get("/api/v1/me");
  expect(me.status()).toBe(200);
  const id = ((await me.json()) as { id?: string }).id;
  if (typeof id !== "string") {
    throw new Error("expected the caller's own id in the GET /me body");
  }
  return id;
}

/** One projected feed row, as this journey reads it. */
interface FeedRow {
  readonly id: string;
  readonly typeKey: string;
  readonly actionTarget: {
    readonly kind: string;
    readonly id: string;
    readonly state: string;
  } | null;
  readonly actions: readonly { readonly key: string; readonly state: string }[];
}

/**
 * Read the caller's feed and return the invitation row it carries.
 *
 * @param context - The signed-in caller's API context.
 * @returns The invitation row, or `undefined` before the fan-out has written it.
 */
async function readInviteRow(context: APIRequestContext): Promise<FeedRow | undefined> {
  const response = await context.get("/api/v1/me/notifications");
  expect(response.status()).toBe(200);
  const page = (await response.json()) as { data?: FeedRow[] };
  return (page.data ?? []).find((row) => row.typeKey === INVITE_TYPE_KEY);
}

test.describe("act on a notification from the in-app feed (E1)", () => {
  test("E1: an invitee accepts from the feed, and the next GET shows the actions unavailable", async ({
    request,
    playwright,
  }) => {
    const stamp = randomUUID();
    const organizerEmail = `e2e-op140-organizer-${stamp}@example.com`;
    const inviteeEmail = `e2e-op140-invitee-${stamp}@example.com`;
    const phone = `+91${String(100000000 + (parseInt(stamp.replace(/-/g, "").slice(0, 9), 16) % 900000000))}`;

    const invitee = await playwright.request.newContext({ baseURL: E2E_BASE_URL });
    try {
      // 1. The invitee signs up first, so the organizer has an account to
      //    invite and the fan-out has a userId to write the in-app row for.
      const inviteeUserId = await signUp(invitee, inviteeEmail);

      // 2. The organizer signs up and completes the account: `user:complete`
      //    gates the event create.
      await signUp(request, organizerEmail);
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

      // 4. The organizer invites that user: the in-app channel, which is what
      //    makes the notification a row the invitee can act on.
      const invited = await request.post(
        `/api/v1/tenants/${tenantId}/events/${eventId}/invitations`,
        {
          headers: {
            origin: E2E_BASE_URL,
            "x-requested-with": "XMLHttpRequest",
            "idempotency-key": randomUUID(),
          },
          data: { invitee: { kind: "user", userId: inviteeUserId }, role: "co_organizer" },
        }
      );
      expect(invited.status()).toBe(201);
      const invitation = (await invited.json()) as { id?: string; status?: string };
      if (typeof invitation.id !== "string") {
        throw new Error("expected the invitation id in the response body");
      }
      expect(invitation.status).toBe("pending");

      // 5. The fan-out is opportunistic (`after()`), so poll the feed rather
      //    than assuming the drain beat the response.
      await expect
        .poll(async () => (await readInviteRow(invitee))?.id ?? "", {
          message: "the invitation never reached the invitee's in-app feed",
          timeout: 20_000,
        })
        .not.toBe("");

      const row = await readInviteRow(invitee);
      if (row === undefined) {
        throw new Error("expected the invitation feed row");
      }
      expect(row.actionTarget).toEqual({ kind: "invitation", id: invitation.id, state: "open" });
      expect(row.actions.map((action) => [action.key, action.state])).toEqual([
        ["accept", "available"],
        ["reject", "available"],
      ]);

      // 6. The invitee accepts **from the feed**, over the real HTTP surface.
      const accepted = await invitee.post(`/api/v1/me/notifications/${row.id}/actions/accept`, {
        headers: {
          origin: E2E_BASE_URL,
          "x-requested-with": "XMLHttpRequest",
          "content-type": "application/json",
        },
        data: {},
      });
      expect(accepted.status()).toBe(200);
      const outcome = (await accepted.json()) as Record<string, unknown>;
      expect(outcome).toMatchObject({
        notificationId: row.id,
        actionKey: "accept",
        outcome: "applied",
        alreadyResolved: false,
        resolvedVia: "in_app",
        targetState: "accepted",
      });

      // 7. The next GET shows the action closed in the feed, for every device.
      const after = await readInviteRow(invitee);
      expect(after?.actionTarget).toEqual({
        kind: "invitation",
        id: invitation.id,
        state: "resolved",
      });
      expect((after?.actions ?? []).map((action) => [action.key, action.state])).toEqual([
        ["accept", "unavailable"],
        ["reject", "unavailable"],
      ]);
    } finally {
      await invitee.dispose();
    }
  });
});
