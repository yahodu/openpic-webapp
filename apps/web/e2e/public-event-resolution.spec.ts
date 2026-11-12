import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { clientIpFor } from "./client-ip";
import { E2E_BASE_URL } from "./ports";

/**
 * E1 — an organizer creates an event, then an unauthenticated attendee opens it
 * by slug (OP-130, contract §6.1, ADR-0784).
 *
 * The integration suite drives both handlers in-process, so it never crosses
 * the middleware, never uses a real cookie jar and never proves that the two
 * routes meet on the same slug. This spec does: a brand-new organizer signs up,
 * completes the account (the create route is `user:complete`), creates a
 * **published** event and the response's own active slug is then fetched by a
 * **fresh, cookie-less** request context — the exact state of a phone that just
 * scanned the QR.
 *
 * Two negative controls keep the 200 attributable:
 *
 *   - the public call is made without the organizer's cookies, so it cannot be
 *     an authenticated read in disguise;
 *   - an unknown slug answers `404 not_found` on the same server, so a route
 *     that answered `200` to any slug would fail the second half.
 *
 * A brand-new email + phone are minted per run so the `auth.otp` / `auth.verify`
 * limit buckets never bleed into a re-run while `reuseExistingServer` keeps the
 * e2e server alive.
 */

/** A private per-spec client address (see `e2e/client-ip.ts`). */
const CLIENT_IP = clientIpFor("public-event-resolution.spec.ts");

/** The §4.1 create body's answer, reduced to what this journey reads. */
interface CreatedEvent {
  readonly id: string;
  readonly name: string;
  readonly accessLinks: readonly { readonly slug: string; readonly active: boolean }[];
}

/** The §6.1 landing body, reduced to the fields this journey asserts. */
interface PublicEventBody {
  readonly slug: string;
  readonly event: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly displayTimeZone: string;
    readonly startAt: string;
    readonly startAtLocal: string;
    readonly status: string;
  };
  readonly gallery: { readonly open: boolean };
  readonly session: { readonly kind: string; readonly hasProfile: boolean };
}

test.describe("public event resolution", () => {
  test("E1: an organizer's created event renders from one unauthenticated GET", async ({
    request,
    playwright,
  }) => {
    const stamp = randomUUID();
    const email = `e2e-op130-${stamp}@example.com`;
    const phone = `+91${String(100000000 + (parseInt(stamp.replace(/-/g, "").slice(0, 9), 16) % 900000000))}`;

    // 1. Sign up with the email OTP handshake (real Better Auth flow).
    const sent = await request.post("/api/auth/email-otp/send-verification-otp", {
      headers: { origin: E2E_BASE_URL, "x-forwarded-for": CLIENT_IP },
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

    // 2. Complete the account (phone verify), so the `user:complete` create
    //    route admits the caller.
    const phoneSent = await request.post("/api/auth/phone-number/send-otp", {
      headers: { origin: E2E_BASE_URL, "x-forwarded-for": CLIENT_IP },
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

    // 3. Create a published event; the response carries its one active slug.
    const now = Date.now();
    const created = await request.post("/api/v1/tenants/current/events", {
      headers: {
        origin: E2E_BASE_URL,
        "x-requested-with": "XMLHttpRequest",
        "idempotency-key": randomUUID(),
      },
      data: {
        name: "E2E Public Event",
        description: "Reception on the lawn, dinner at 8",
        startAt: new Date(now + 2 * 86_400_000).toISOString(),
        endAt: new Date(now + 3 * 86_400_000).toISOString(),
        displayTimeZone: "Asia/Kolkata",
        logoAssetId: null,
        watermarkAssetId: null,
        publish: true,
      },
    });
    expect(created.status()).toBe(201);
    const createdBody = (await created.json()) as CreatedEvent;
    const activeLink = createdBody.accessLinks.find((link) => link.active);
    if (activeLink === undefined) {
      throw new Error("expected the created event to carry one active access link");
    }

    // 4. The attendee's phone: a fresh context with no cookies, no session.
    const attendee = await playwright.request.newContext({ baseURL: E2E_BASE_URL });
    try {
      const response = await attendee.get(`/api/v1/p/events/${activeLink.slug}`, {
        headers: { "x-forwarded-for": CLIENT_IP },
      });

      expect(response.status()).toBe(200);
      // §6.1: the landing call is privately cacheable for 30 s.
      expect(response.headers()["cache-control"]).toBe("private, max-age=30");

      const body = (await response.json()) as PublicEventBody;
      expect(Object.keys(body).sort()).toEqual([
        "consent",
        "event",
        "gallery",
        "selfie",
        "session",
        "slug",
      ]);
      expect(body.slug).toBe(activeLink.slug);
      expect(body.event.id).toBe(createdBody.id);
      expect(body.event.name).toBe("E2E Public Event");
      expect(body.event.description).toBe("Reception on the lawn, dinner at 8");
      expect(body.event.status).toBe("published");
      expect(body.event.displayTimeZone).toBe("Asia/Kolkata");

      // `startAtLocal` is pre-rendered in the event's zone: Asia/Kolkata has a
      // fixed +05:30 offset, and the value must name the same instant as the
      // canonical UTC `startAt` (contract §6.1, schema §15.1). The rendered
      // value is second-precision, so the instant round-trips to the second.
      expect(body.event.startAtLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/);
      expect(Date.parse(body.event.startAtLocal)).toBe(
        Math.floor(Date.parse(body.event.startAt) / 1000) * 1000
      );

      expect(body.gallery.open).toBe(true);
      expect(body.session.kind).toBe("anonymous");
      expect(body.session.hasProfile).toBe(false);
      // §0.15: no credential material and no internal identifier in the body.
      expect(JSON.stringify(body)).not.toContain(email);

      // 5. Negative control: the same server answers 404 for a slug that names
      //    no link, so the 200 above is attributable to the created slug.
      const unknown = await attendee.get(`/api/v1/p/events/nosuchslug`, {
        headers: { "x-forwarded-for": CLIENT_IP },
      });
      expect(unknown.status()).toBe(404);
      const error = (await unknown.json()) as { error: { code: string } };
      expect(error.error.code).toBe("not_found");
    } finally {
      await attendee.dispose();
    }
  });
});
