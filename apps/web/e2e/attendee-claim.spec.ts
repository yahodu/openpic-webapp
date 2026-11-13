import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { clientIpFor } from "./client-ip";
import { E2E_BASE_URL } from "./ports";

/**
 * E1 — the anonymous attendance becomes the account's own, over the deployed
 * HTTP surface (OP-134 E1; contract §6.7, §1.1 "session created", §6.2, §0.12;
 * schema §13.5, §15.3; ADR-0813).
 *
 * The integration suites call the route handlers in-process and can install a
 * logger and a database handle. This spec proves the same journey through a real
 * `next start` server with the real middleware, a real cookie jar and a real
 * Better Auth hook chain:
 *
 *   organizer signs up, verifies a phone, publishes an event →
 *   attendee creates an anonymous session and grants consent in **her own jar** →
 *   she signs in **from the same jar** (so the `op_att` cookie rides the auth
 *   request) → the explicit claim answers `200` → `GET /me/events` lists the event
 *   with its gallery link.
 *
 * ## What this spec pins that no in-process case can
 *
 * - The `op_att` cookie a browser holds after the attendee flow is the **same**
 *   cookie Better Auth's session-created hook can read: the implicit claim
 *   fires on a real sign-in request, with no client cooperation beyond the
 *   browser's own cookie jar.
 * - The claim is reachable through the middleware's CSRF rule for a
 *   state-changing cookie request (`X-Requested-With: XMLHttpRequest`), and it
 *   clears `op_att` in the real response header.
 * - `/me/events` answers the **account's** cookie — not the attendee's — with the
 *   event she attended anonymously.
 *
 * The explicit claim after a sign-in that already claimed the session is a
 * no-op `200` with an empty `claimed` list: §6.7's endpoint is idempotent for the
 * owner, and a refusal here would mean the browser must special-case the order
 * of its own calls.
 */

/** A private per-spec client address (see `e2e/client-ip.ts`). */
const CLIENT_IP = clientIpFor("attendee-claim.spec.ts");

/** The §6.7 claim body, reduced to what this journey reads. */
interface ClaimBody {
  readonly claimed: readonly {
    readonly eventId: string;
    readonly eventName: string;
    readonly profileId: string;
    readonly matchCount: number;
    readonly galleryUrl: string;
  }[];
  readonly skipped: readonly { readonly eventId: string; readonly reason: string }[];
}

/** The §6.7 `/me/events` body, reduced to what this journey reads. */
interface MyEventsBody {
  readonly data: readonly {
    readonly eventId: string;
    readonly slug: string;
    readonly galleryUrl: string;
    readonly matchCount: number;
    readonly expiringSoon: boolean;
  }[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

test.describe("attendee claim at sign-in", () => {
  test("E1: anonymous flow, sign-in, claim, then GET /me/events", async ({
    request,
    playwright,
  }) => {
    const stamp = randomUUID();
    const email = `e2e-op134-${stamp}@example.com`;
    const phone = `+91${String(700000000 + (parseInt(stamp.replace(/-/g, "").slice(0, 9), 16) % 200000000))}`;
    const origin = E2E_BASE_URL;

    // 1. Organizer signs up (email OTP), completes the account (phone verify)
    //    and publishes an event; the response carries its one active slug.
    const sent = await request.post("/api/auth/email-otp/send-verification-otp", {
      headers: { origin, "x-forwarded-for": CLIENT_IP },
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
      headers: { origin },
      data: { email, otp: emailCode },
    });
    expect(signedIn.status()).toBe(200);

    const phoneSent = await request.post("/api/auth/phone-number/send-otp", {
      headers: { origin, "x-forwarded-for": CLIENT_IP },
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
      headers: { origin },
      data: { phoneNumber: phone, code: phoneCode },
    });
    expect(phoneVerified.status()).toBe(200);

    const now = Date.now();
    const created = await request.post("/api/v1/tenants/current/events", {
      headers: { origin, "x-requested-with": "XMLHttpRequest", "idempotency-key": randomUUID() },
      data: {
        name: "E2E Claim Event",
        description: "Drinks by the pool",
        startAt: new Date(now + 2 * 86_400_000).toISOString(),
        endAt: new Date(now + 3 * 86_400_000).toISOString(),
        displayTimeZone: "Asia/Kolkata",
        logoAssetId: null,
        watermarkAssetId: null,
        publish: true,
      },
    });
    expect(created.status()).toBe(201);
    const createdBody = (await created.json()) as {
      readonly id: string;
      readonly accessLinks: readonly { readonly slug: string; readonly active: boolean }[];
    };
    const eventId = createdBody.id;
    const activeLink = createdBody.accessLinks.find((link) => link.active);
    if (activeLink === undefined) {
      throw new Error("expected the created event to carry one active access link");
    }
    const slug = activeLink.slug;

    // 2. The attendee's own jar: one client address, one anonymous session, one
    //    granted consent (which is what creates the attendee profile).
    const attendee = await playwright.request.newContext({ baseURL: origin });
    try {
      const landing = await attendee.get(`/api/v1/p/events/${slug}`, {
        headers: { "x-forwarded-for": CLIENT_IP },
      });
      expect(landing.status()).toBe(200);
      const landingBody = (await landing.json()) as {
        readonly consent: { readonly policyVersion: string };
      };

      const session = await attendee.post("/api/v1/p/attendee-sessions", {
        headers: { origin, "x-requested-with": "XMLHttpRequest", "x-forwarded-for": CLIENT_IP },
        data: {},
      });
      expect(session.status()).toBe(201);

      const consent = await attendee.post(`/api/v1/p/events/${slug}/consent`, {
        headers: { origin, "x-requested-with": "XMLHttpRequest", "x-forwarded-for": CLIENT_IP },
        data: {
          purpose: "biometric_processing",
          policyVersion: landingBody.consent.policyVersion,
          granted: true,
          ageConfirmed: true,
        },
      });
      expect(consent.status()).toBe(201);

      // 3. She signs in from the same jar, so the `op_att` cookie rides the auth
      //    request and the session-created hook claims it.
      const attendeeEmail = `e2e-op134-attendee-${stamp}@example.com`;
      const attendeeSent = await attendee.post("/api/auth/email-otp/send-verification-otp", {
        headers: { origin, "x-forwarded-for": CLIENT_IP },
        data: { email: attendeeEmail, type: "sign-in" },
      });
      expect(attendeeSent.status()).toBe(200);
      const attendeeOtp = await attendee.get(
        `/api/v1/__test__/otp?contact=${encodeURIComponent(attendeeEmail)}&channel=email`
      );
      expect(attendeeOtp.status()).toBe(200);
      const attendeeCode = ((await attendeeOtp.json()) as { code: string | null }).code;
      expect(typeof attendeeCode).toBe("string");
      const attendeeSignedIn = await attendee.post("/api/auth/sign-in/email-otp", {
        headers: { origin },
        data: { email: attendeeEmail, otp: attendeeCode },
      });
      expect(attendeeSignedIn.status()).toBe(200);

      // 4. The explicit §6.7 claim. The sign-in already claimed it, so this is a
      //    no-op `200` — and that is the point: the client may call it either way.
      const claim = await attendee.post("/api/v1/me/attendee-sessions:claim", {
        headers: {
          origin,
          "x-requested-with": "XMLHttpRequest",
          "x-forwarded-for": CLIENT_IP,
          "idempotency-key": randomUUID(),
        },
        data: {},
      });
      expect(claim.status()).toBe(200);
      const claimBody = (await claim.json()) as ClaimBody;
      expect(claimBody.claimed).toEqual([]);
      const clearCookie = claim.headers()["set-cookie"] ?? "";
      expect(clearCookie.toLowerCase()).toContain("op_att=");
      expect(clearCookie.toLowerCase()).toContain("max-age=0");

      // 5. The account's own list — served from the account's cookie, carrying
      //    the event she only ever attended anonymously.
      const mine = await attendee.get("/api/v1/me/events");
      expect(mine.status()).toBe(200);
      const body = (await mine.json()) as MyEventsBody;
      expect(body.data).toHaveLength(1);
      const [item] = body.data;
      if (item === undefined) {
        throw new Error("expected the claimed event in the account's list");
      }
      expect(item.eventId).toBe(eventId);
      expect(item.slug).toBe(slug);
      expect(item.galleryUrl).toBe(`/e/${slug}/gallery`);
      expect(item.matchCount).toBe(0);
      expect(item.expiringSoon).toBe(false);
      expect(body.page.nextCursor).toBeNull();
      expect(body.page.hasMore).toBe(false);

      // 6. Negative control: the organizer's account never attended, so its own
      //    list is empty — the read is keyed on the caller, not on the event.
      const organizerList = await request.get("/api/v1/me/events");
      expect(organizerList.status()).toBe(200);
      expect(((await organizerList.json()) as MyEventsBody).data).toEqual([]);
    } finally {
      await attendee.dispose();
    }
  });
});
