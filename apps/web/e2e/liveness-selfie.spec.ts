import { createHash, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { clientIpFor } from "./client-ip";
import { E2E_BASE_URL } from "./ports";

/**
 * E1 — the attendee's liveness + selfie journey over the deployed HTTP surface
 * (OP-132 E1; contract §6.1, §6.2, §6.3, §0.9, §0.11; ADR-0791).
 *
 * The integration suites drive the seven route handlers in-process; this spec
 * proves the same journey end to end through a real `next start` server, the
 * Next middleware (CSRF, `attendee` auth), a real cookie jar, a real Better
 * Auth session and the **memory** storage adapter:
 *
 *   organizer signs up, verifies a phone, publishes an event →
 *   attendee creates an anonymous session (cookie in its own jar) →
 *   `POST …/consent` → `POST …/liveness/challenges` →
 *   `POST …/selfies/uploads` → **PUT the bytes straight to the storage URL** →
 *   `POST …/selfies` → `202`.
 *
 * The bytes never transit the control plane, exactly as the browser's S3
 * plugin uploads them: the memory adapter's presigned URL points at the
 * test-only storage route on the same origin.
 *
 * ## What this spec pins
 *
 * - The landing call hands the attendee the **policy version** the consent
 *   body must echo, and `livenessRequired: true` — so no client can be told to
 *   prove liveness against a policy it was never shown.
 * - The consent grant succeeds **before** any selfie call on the same cookie
 *   jar, i.e. the hard precondition of §6.2 is satisfiable over HTTP.
 * - The challenge answer carries `challengeId`, `challengeKind`, `spec` and the
 *   evidence-binding `nonce`; the submit answer is exactly
 *   `{selfieId, profileId, status: "processing", pollIntervalMs, pollUrl,
 *   attemptsUsed, attemptsRemaining}` — seven keys, `attemptsUsed: 1`.
 * - The negative control is the point: re-submitting the **same** challenge
 *   answers `409 liveness_challenge_invalid` with `reason: "already_used"`, so
 *   a server that accepted every challenge would fail this spec.
 */

/** A private per-spec client address (see `e2e/client-ip.ts`). */
const CLIENT_IP = clientIpFor("liveness-selfie.spec.ts");

/** A minimal but real JPEG: SOI, an APP0 JFIF header, then EOI. */
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

/** The §6.1 landing body, reduced to what this journey reads. */
interface LandingBody {
  readonly slug: string;
  readonly event: { readonly id: string; readonly status: string };
  readonly selfie: {
    readonly livenessRequired: boolean;
    readonly attemptsAllowed: number;
  };
  readonly consent: {
    readonly purpose: string;
    readonly policyVersion: string;
    readonly policyUrl: string;
    readonly granted: boolean;
  };
}

/** The §6.3 challenge body. */
interface ChallengeBody {
  readonly challengeId: string;
  readonly challengeKind: string;
  readonly nonce: string;
  readonly spec: { readonly sequence: readonly string[]; readonly timeoutMs: number };
  readonly expiresAt: string;
}

/** The §6.3 selfie presign body. */
interface PresignBody {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly expiresAt: string;
  readonly confirmUrl: string;
}

/** The §6.3 submit body. */
interface SubmitBody {
  readonly selfieId: string;
  readonly profileId: string;
  readonly status: string;
  readonly pollUrl: string;
  readonly pollIntervalMs: number;
  readonly attemptsUsed: number;
  readonly attemptsRemaining: number;
}

/** The seven keys §6.3's `202` carries, sorted. */
const SUBMIT_KEYS = [
  "attemptsRemaining",
  "attemptsUsed",
  "pollIntervalMs",
  "pollUrl",
  "profileId",
  "selfieId",
  "status",
];

/** The five keys §6.3 gives the selfie presign envelope, sorted. */
const PRESIGN_KEYS = ["confirmUrl", "expiresAt", "headers", "method", "url"];

test.describe("attendee liveness and selfie submission", () => {
  test("E1: session → consent → challenge → upload → submit → 202", async ({
    request,
    playwright,
  }) => {
    const stamp = randomUUID();
    const email = `e2e-op132-${stamp}@example.com`;
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
        name: "E2E Liveness Event",
        description: "Reception on the lawn",
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
      const landingBody = (await landing.json()) as LandingBody;
      expect(landingBody.selfie.livenessRequired).toBe(true);
      expect(landingBody.consent.granted).toBe(false);
      expect(landingBody.consent.purpose).toBe("biometric_processing");

      // 3. An anonymous session — the `op_att` cookie stays in this jar.
      const session = await attendee.post("/api/v1/p/attendee-sessions", {
        headers: { origin, "x-requested-with": "XMLHttpRequest", "x-forwarded-for": CLIENT_IP },
        data: {},
      });
      expect(session.status()).toBe(201);

      // 4. Consent, at the policy version the landing call named.
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
      const consentBody = (await consent.json()) as { readonly consentId: string };
      expect(consentBody.consentId).toMatch(/^[0-9a-f]{24}$/);

      // 5. A liveness challenge.
      const challengeResponse = await attendee.post(
        `/api/v1/p/events/${slug}/liveness/challenges`,
        {
          headers: { origin, "x-requested-with": "XMLHttpRequest", "x-forwarded-for": CLIENT_IP },
          data: {},
        }
      );
      expect(challengeResponse.status()).toBe(201);
      const challenge = (await challengeResponse.json()) as ChallengeBody;
      expect(challenge.challengeKind).toBe("gesture");
      expect(challenge.spec.sequence).toHaveLength(3);
      expect(challenge.spec.timeoutMs).toBe(15_000);
      expect(challenge.nonce).toMatch(/^[0-9a-f]{32}$/);

      // 6. Presign, then PUT the bytes straight to the storage URL.
      const hash = createHash("sha256").update(JPEG_BYTES).digest("hex");
      const presignResponse = await attendee.post(`/api/v1/p/events/${slug}/selfies/uploads`, {
        headers: { origin, "x-requested-with": "XMLHttpRequest", "x-forwarded-for": CLIENT_IP },
        data: { hash, size: JPEG_BYTES.byteLength, mimeType: "image/jpeg" },
      });
      expect(presignResponse.status()).toBe(201);
      const presign = (await presignResponse.json()) as PresignBody;
      expect(Object.keys(presign).sort()).toEqual(PRESIGN_KEYS);
      expect(presign.method).toBe("PUT");

      const put = await attendee.put(presign.url, {
        headers: presign.headers,
        data: JPEG_BYTES,
      });
      expect(put.status()).toBe(200);

      // 7. Submit: 202 with the §6.3 envelope.
      const livenessEvidence = {
        nonce: challenge.nonce,
        frameHashes: [0, 1, 2].map((index) =>
          createHash("sha256")
            .update(`${challenge.nonce}:${String(index)}`)
            .digest("hex")
        ),
      };
      const submitHeaders = {
        origin,
        "x-requested-with": "XMLHttpRequest",
        "x-forwarded-for": CLIENT_IP,
        "idempotency-key": randomUUID(),
      };
      const submitted = await attendee.post(`/api/v1/p/events/${slug}/selfies`, {
        headers: submitHeaders,
        data: { hash, challengeId: challenge.challengeId, livenessEvidence },
      });
      expect(submitted.status()).toBe(202);
      const submitBody = (await submitted.json()) as SubmitBody;
      expect(Object.keys(submitBody).sort()).toEqual(SUBMIT_KEYS);
      expect(submitBody.status).toBe("processing");
      expect(submitBody.pollUrl).toBe(`/api/v1/p/events/${slug}/me`);
      expect(submitBody.pollIntervalMs).toBe(2000);
      expect(submitBody.attemptsUsed).toBe(1);
      expect(submitBody.attemptsRemaining).toBe(landingBody.selfie.attemptsAllowed - 1);
      expect(submitBody.selfieId).toMatch(/^[0-9a-f]{24}$/);
      expect(submitBody.profileId).toMatch(/^[0-9a-f]{24}$/);

      // 8. Negative control: the challenge is single-use, so the same one
      //    cannot buy a second attempt.
      const secondBytes = Buffer.concat([JPEG_BYTES, Buffer.from("second", "utf8")]);
      const secondHash = createHash("sha256").update(secondBytes).digest("hex");
      const secondPresign = await attendee.post(`/api/v1/p/events/${slug}/selfies/uploads`, {
        headers: { origin, "x-requested-with": "XMLHttpRequest", "x-forwarded-for": CLIENT_IP },
        data: { hash: secondHash, size: secondBytes.byteLength, mimeType: "image/jpeg" },
      });
      expect(secondPresign.status()).toBe(201);
      const secondPresignBody = (await secondPresign.json()) as PresignBody;
      const secondPut = await attendee.put(secondPresignBody.url, {
        headers: secondPresignBody.headers,
        data: secondBytes,
      });
      expect(secondPut.status()).toBe(200);

      const reused = await attendee.post(`/api/v1/p/events/${slug}/selfies`, {
        headers: { ...submitHeaders, "idempotency-key": randomUUID() },
        data: { hash: secondHash, challengeId: challenge.challengeId, livenessEvidence },
      });
      expect(reused.status()).toBe(409);
      const reusedBody = (await reused.json()) as {
        error: { code: string; details?: { reason?: string } };
      };
      expect(reusedBody.error.code).toBe("liveness_challenge_invalid");
      expect(reusedBody.error.details?.reason).toBe("already_used");
    } finally {
      await attendee.dispose();
    }
  });
});
