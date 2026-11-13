import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { clientIpFor } from "./client-ip";
import { E2E_BASE_URL } from "./ports";

/**
 * E1 — the attendee browses their gallery, polls their status and marks the
 * gallery seen, over the deployed HTTP surface
 * (OP-133 E1; contract §6.4, §6.5, §0.9, §0.11; ADR-0793 §1, §6, §9).
 *
 * The integration suites drive the route handlers in-process; this spec proves
 * the same journey through a real `next start` server, the Next middleware
 * (CSRF, `attendee` auth), a real cookie jar and a real `op_att` session:
 *
 *   organizer signs up, verifies a phone, publishes an event →
 *   attendee creates an anonymous session and grants consent →
 *   **the matcher fixture seeds three matches** (the worker is a later card and
 *   the e2e process cannot reach the server's in-memory database) →
 *   `GET …/gallery` (newest first, all `isNew`) → `GET …/me` (the poll) →
 *   `POST …/gallery:seen` → `GET …/gallery` again (nothing new) → `GET …/me`
 *   (`newMatchCount: 0`).
 *
 * ## What this spec pins that no in-process case can
 *
 * - The gallery and the poll are reachable with the **same** `op_att` cookie the
 *   selfie journey mints, so the attendee surface is one session, not two.
 * - A read (`GET`) never clears the "New" badges: the second `GET` still says
 *   `isNew: true` for every item, which is what makes a prefetch harmless.
 * - The explicit `POST …/gallery:seen` is the only thing that dismisses them,
 *   and the poll then answers `newMatchCount: 0` on the same jar.
 * - `pollIntervalMs` is the server's own cadence for a settled gallery
 *   (`60000`), not a client constant.
 */

/** A private per-spec client address (see `e2e/client-ip.ts`). */
const CLIENT_IP = clientIpFor("attendee-gallery.spec.ts");

/** The twelve keys §6.5 gives a gallery item, sorted. */
const ITEM_KEYS = [
  "aspectRatio",
  "confidence",
  "createdAt",
  "height",
  "imageId",
  "isNew",
  "matchId",
  "orientation",
  "originalAvailable",
  "thumbnailUrl",
  "thumbnailUrlExpiresAt",
  "width",
];

/** The settled cadence §6.4 states for a gallery that is fully indexed. */
const SETTLED_POLL_MS = 60000;

/** How many matches the fixture seeds. */
const SEEDED_MATCHES = 3;

/** The §6.5 gallery body, reduced to what this journey reads. */
interface GalleryBody {
  readonly data: readonly {
    readonly matchId: string;
    readonly imageId: string;
    readonly width: number;
    readonly height: number;
    readonly orientation: number;
    readonly aspectRatio: number;
    readonly isNew: boolean;
    readonly confidence: string;
    readonly originalAvailable: boolean;
    readonly thumbnailUrl: string;
  }[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
    readonly total: number;
  };
  readonly summary: {
    readonly matchCount: number;
    readonly newMatchCount: number;
    readonly hiddenCount: number;
  };
}

/** The §6.4 poll body, reduced to what this journey reads. */
interface ParticipationBody {
  readonly profileId: string;
  readonly status: string;
  readonly matchCount: number;
  readonly newMatchCount: number;
  readonly indexingComplete: boolean;
  readonly pollIntervalMs: number;
  readonly nextPollAfter: string;
  readonly latestMatchCursor: string | null;
}

/** The consent answer, for the consent id the journey asserts. */
interface ConsentBody {
  readonly consentId: string;
}

test.describe("attendee gallery and participation polling", () => {
  test("E1: seed matches, browse the gallery, poll, mark seen", async ({ request, playwright }) => {
    const stamp = randomUUID();
    const email = `e2e-op133-${stamp}@example.com`;
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
        name: "E2E Gallery Event",
        description: "Cocktails on the terrace",
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
      readonly accessLinks: readonly { readonly slug: string; readonly active: boolean }[];
    };
    const activeLink = createdBody.accessLinks.find((link) => link.active);
    if (activeLink === undefined) {
      throw new Error("expected the created event to carry one active access link");
    }
    const slug = activeLink.slug;

    // 2. The attendee's own jar: no organizer cookies, one client address.
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
      const consentBody = (await consent.json()) as ConsentBody;
      expect(consentBody.consentId).toMatch(/^[0-9a-f]{24}$/);

      // 3. The poll is the one read that names the profile: §6.2's consent body
      //    deliberately does not (it is exactly six keys), so the attendee's own
      //    poll is what hands the client its `profileId`.
      const firstPoll = await attendee.get(`/api/v1/p/events/${slug}/me`);
      expect(firstPoll.status()).toBe(200);
      const profile = (await firstPoll.json()) as ParticipationBody;
      expect(profile.profileId).toMatch(/^[0-9a-f]{24}$/);
      expect(profile.status).toBe("no_selfie");
      expect(profile.matchCount).toBe(0);
      expect(profile.pollIntervalMs).toBe(SETTLED_POLL_MS);

      // 4. The matcher fixture stands in for the worker: the e2e process cannot
      //    reach the server's in-memory MongoDB, so a test-only route seeds the
      //    photos this attendee would have matched.
      const seededResponse = await attendee.post("/api/v1/test-support/attendee-matches", {
        headers: { origin, "x-requested-with": "XMLHttpRequest", "x-forwarded-for": CLIENT_IP },
        data: { slug, profileId: profile.profileId, count: SEEDED_MATCHES },
      });
      expect(seededResponse.status()).toBe(201);
      const seeded = (await seededResponse.json()) as { readonly matchIds: readonly string[] };
      expect(seeded.matchIds).toHaveLength(SEEDED_MATCHES);

      // 4. First read: every match is new and the order is newest first.
      const first = await attendee.get(`/api/v1/p/events/${slug}/gallery`);
      expect(first.status()).toBe(200);
      const firstBody = (await first.json()) as GalleryBody;
      expect(firstBody.data).toHaveLength(SEEDED_MATCHES);
      expect(firstBody.summary.matchCount).toBe(SEEDED_MATCHES);
      expect(firstBody.summary.hiddenCount).toBe(0);
      expect(firstBody.data.map((item) => item.matchId)).toEqual([...seeded.matchIds].reverse());
      expect(firstBody.data.every((item) => item.isNew)).toBe(true);
      expect(Object.keys(firstBody.data[0] ?? {}).sort()).toEqual(ITEM_KEYS);
      const tile = firstBody.data.at(0);
      if (tile === undefined) {
        throw new Error("expected the seeded gallery to serve at least one tile");
      }
      expect(typeof tile.width).toBe("number");
      expect(typeof tile.aspectRatio).toBe("number");
      expect(tile.thumbnailUrl).toMatch(/^https:\/\/pic\.openpic\.in\/t\//);

      // 5. A prefetch must not dismiss the badge.
      const second = await attendee.get(`/api/v1/p/events/${slug}/gallery`);
      expect(second.status()).toBe(200);
      const secondBody = (await second.json()) as GalleryBody;
      expect(secondBody.data.every((item) => item.isNew)).toBe(true);

      // 6. The poll knows the same counts and its own cadence.
      const polled = await attendee.get(`/api/v1/p/events/${slug}/me`);
      expect(polled.status()).toBe(200);
      const poll = (await polled.json()) as ParticipationBody;
      expect(poll.profileId).toBe(profile.profileId);
      expect(poll.matchCount).toBe(SEEDED_MATCHES);
      expect(poll.newMatchCount).toBe(SEEDED_MATCHES);
      expect(poll.indexingComplete).toBe(true);
      expect(poll.pollIntervalMs).toBe(SETTLED_POLL_MS);
      expect(typeof poll.latestMatchCursor).toBe("string");
      const nextPollAfter = Date.parse(poll.nextPollAfter);
      expect(nextPollAfter).toBeGreaterThan(now);

      // 7. The explicit seen call is the only thing that dismisses the badges.
      const seen = await attendee.post(`/api/v1/p/events/${slug}/gallery:seen`, {
        headers: { origin, "x-requested-with": "XMLHttpRequest", "x-forwarded-for": CLIENT_IP },
        data: {},
      });
      expect(seen.status()).toBe(204);

      const afterSeen = await attendee.get(`/api/v1/p/events/${slug}/gallery`);
      expect(afterSeen.status()).toBe(200);
      const afterSeenBody = (await afterSeen.json()) as GalleryBody;
      expect(afterSeenBody.data.every((item) => !item.isNew)).toBe(true);
      expect(afterSeenBody.summary.newMatchCount).toBe(0);

      const repolled = await attendee.get(`/api/v1/p/events/${slug}/me`);
      expect(repolled.status()).toBe(200);
      expect(((await repolled.json()) as ParticipationBody).newMatchCount).toBe(0);

      // 8. Negative control: the same gallery without the attendee's cookie is
      //    not readable, so the journey above proved a credential and not a
      //    public list.
      const anonymous = await playwright.request.newContext({ baseURL: origin });
      try {
        const denied = await anonymous.get(`/api/v1/p/events/${slug}/gallery`, {
          headers: { "x-forwarded-for": CLIENT_IP },
        });
        expect(denied.status()).toBe(401);
      } finally {
        await anonymous.dispose();
      }
    } finally {
      await attendee.dispose();
    }
  });
});
