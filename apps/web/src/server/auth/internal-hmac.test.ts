import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { API_ERROR_CODES, errorCodeSchema } from "@openpic/contracts";

import {
  authorizeInternalRequest,
  verifyInternalSignature,
  type InternalAuthCode,
  type InternalAuthResult,
} from "@/server/auth/internal-hmac";

/**
 * Unit — internal shared-secret HMAC auth (OP-87, contract §0.3 `internal`).
 *
 * The story splits internal auth into a pure verifier and a pure authorizer so
 * the crypto and the cron-GET exception are each testable without an HTTP
 * server, a clock or a database:
 *
 *   - {@link verifyInternalSignature} checks the `X-Signature`
 *     (`sha256=<hex HMAC of the raw body>`) against `X-Timestamp` with a ±300 s
 *     skew, using a known-answer vector and an injected `now`.
 *   - {@link authorizeInternalRequest} adds the bearer check and the documented
 *     exception: a `GET` under `/api/v1/internal/cron/**` may carry the
 *     `CRON_SECRET` bearer with an empty, unsigned body.
 *
 * Contract expected of the implementation:
 *
 *   - `@/server/auth/internal-hmac` exports
 *     `verifyInternalSignature(input) -> { ok: true } | { ok: false, code }`,
 *     `authorizeInternalRequest(input) -> same`, the `InternalAuthCode` union
 *     (`"internal_auth_failed" | "invalid_signature" | "stale_signature"`) and
 *     the `InternalAuthResult` type.
 *   - `X-Timestamp` is epoch **seconds** as a string (the Vercel-cron-friendly
 *     encoding); `X-Signature` is `sha256=<64 lowercase hex>`.
 *   - The verifier is constant-time and never throws: every failure is a
 *     stable `code`.
 */

const SECRET = "test-internal-secret-0000000000000000";
const CRON_SECRET = "test-cron-secret-000000000000000000";

/** The exact raw body the known-answer vector was computed over. */
const BODY = JSON.stringify({ hello: "world" });

/**
 * Known-answer vector: HMAC-SHA256(SECRET, BODY) in lowercase hex.
 *
 * Computed independently in {@link expectedSignature} below, so a verifier that
 * agrees with this literal is proven to implement the contract algorithm rather
 * than merely round-tripping its own helper.
 */
const KNOWN_SIGNATURE_HEX = "ce00528eb5c0d075c87ca43a3c17efa463347b30a9d464037bf0d7fe18cca90c";

/** Recompute the vector with Node's crypto so the literal can never drift. */
function expectedSignature(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

const BASE_INSTANT = new Date("2026-01-02T03:04:05.000Z");

/** The epoch-seconds header value for an instant. */
function timestampHeader(at: Date): string {
  return String(Math.floor(at.getTime() / 1000));
}

/** A well-formed `sha256=<hex>` signature header for a body. */
function signatureHeader(secret: string, body: string): string {
  return `sha256=${expectedSignature(secret, body)}`;
}

/** A verifier result that must carry a denial code. */
function expectDenied(result: InternalAuthResult, code: InternalAuthCode): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(code);
  }
}

describe("internal HMAC signature verification (U1–U3)", () => {
  it("U1: accepts the known-answer vector for the raw body", () => {
    expect(expectedSignature(SECRET, BODY)).toBe(KNOWN_SIGNATURE_HEX);

    const result = verifyInternalSignature({
      secret: SECRET,
      body: BODY,
      signature: `sha256=${KNOWN_SIGNATURE_HEX}`,
      timestamp: timestampHeader(BASE_INSTANT),
      now: BASE_INSTANT,
    });

    expect(result).toEqual({ ok: true });
  });

  it("U2: accepts a timestamp exactly 300s old and rejects 301s old", () => {
    const atTheBoundary = verifyInternalSignature({
      secret: SECRET,
      body: BODY,
      signature: signatureHeader(SECRET, BODY),
      timestamp: timestampHeader(new Date(BASE_INSTANT.getTime() - 300_000)),
      now: BASE_INSTANT,
    });
    expect(atTheBoundary).toEqual({ ok: true });

    const pastTheBoundary = verifyInternalSignature({
      secret: SECRET,
      body: BODY,
      signature: signatureHeader(SECRET, BODY),
      timestamp: timestampHeader(new Date(BASE_INSTANT.getTime() - 301_000)),
      now: BASE_INSTANT,
    });
    expectDenied(pastTheBoundary, "stale_signature");
  });

  it("U2: applies the ±300s skew symmetrically to future timestamps", () => {
    const atTheBoundary = verifyInternalSignature({
      secret: SECRET,
      body: BODY,
      signature: signatureHeader(SECRET, BODY),
      timestamp: timestampHeader(new Date(BASE_INSTANT.getTime() + 300_000)),
      now: BASE_INSTANT,
    });
    expect(atTheBoundary).toEqual({ ok: true });

    const pastTheBoundary = verifyInternalSignature({
      secret: SECRET,
      body: BODY,
      signature: signatureHeader(SECRET, BODY),
      timestamp: timestampHeader(new Date(BASE_INSTANT.getTime() + 301_000)),
      now: BASE_INSTANT,
    });
    expectDenied(pastTheBoundary, "stale_signature");
  });

  it("U3: rejects a body tampered after signing", () => {
    const tampered = JSON.stringify({ hello: "evi1" });

    const result = verifyInternalSignature({
      secret: SECRET,
      body: tampered,
      signature: signatureHeader(SECRET, BODY),
      timestamp: timestampHeader(BASE_INSTANT),
      now: BASE_INSTANT,
    });

    expectDenied(result, "invalid_signature");
  });

  it("U3: rejects a signature made with the wrong secret", () => {
    const result = verifyInternalSignature({
      secret: SECRET,
      body: BODY,
      signature: signatureHeader("some-other-secret", BODY),
      timestamp: timestampHeader(BASE_INSTANT),
      now: BASE_INSTANT,
    });

    expectDenied(result, "invalid_signature");
  });

  it("U3: rejects a missing signature instead of trusting the bearer alone", () => {
    const result = verifyInternalSignature({
      secret: SECRET,
      body: BODY,
      signature: null,
      timestamp: timestampHeader(BASE_INSTANT),
      now: BASE_INSTANT,
    });

    expectDenied(result, "invalid_signature");
  });

  it("U2: rejects a missing timestamp as stale rather than fresh", () => {
    const result = verifyInternalSignature({
      secret: SECRET,
      body: BODY,
      signature: signatureHeader(SECRET, BODY),
      timestamp: null,
      now: BASE_INSTANT,
    });

    expectDenied(result, "stale_signature");
  });
});

describe("internal request authorization (U4)", () => {
  /** The insecure default for a fresh cron GET: empty, unsigned body. */
  const CRON_GET = {
    method: "GET",
    path: "/api/v1/internal/cron/sample",
    signature: null,
    timestamp: null,
    body: "",
    now: BASE_INSTANT,
    internalApiSecret: SECRET,
    cronSecret: CRON_SECRET,
  } as const;

  it("U4: accepts a CRON_SECRET GET under the cron prefix", () => {
    const result = authorizeInternalRequest({
      ...CRON_GET,
      authorization: `Bearer ${CRON_SECRET}`,
    });

    expect(result).toEqual({ ok: true });
  });

  it("U4: rejects the CRON_SECRET bearer outside the cron prefix", () => {
    const result = authorizeInternalRequest({
      ...CRON_GET,
      path: "/api/v1/internal/domain-events",
      authorization: `Bearer ${CRON_SECRET}`,
    });

    expectDenied(result, "internal_auth_failed");
  });

  it("U4: rejects a wrong cron bearer under the cron prefix", () => {
    const result = authorizeInternalRequest({
      ...CRON_GET,
      authorization: "Bearer not-the-cron-secret",
    });

    expectDenied(result, "internal_auth_failed");
  });

  it("U4: rejects a missing bearer", () => {
    const result = authorizeInternalRequest({
      ...CRON_GET,
      authorization: null,
    });

    expectDenied(result, "internal_auth_failed");
  });

  it("U4: accepts an INTERNAL_API_SECRET POST with a valid HMAC and fresh timestamp", () => {
    const result = authorizeInternalRequest({
      method: "POST",
      path: "/api/v1/internal/domain-events",
      authorization: `Bearer ${SECRET}`,
      signature: signatureHeader(SECRET, BODY),
      timestamp: timestampHeader(BASE_INSTANT),
      body: BODY,
      now: BASE_INSTANT,
      internalApiSecret: SECRET,
      cronSecret: CRON_SECRET,
    });

    expect(result).toEqual({ ok: true });
  });

  it("U4: propagates the verifier's stale_signature for a valid bearer with an old timestamp", () => {
    const result = authorizeInternalRequest({
      method: "POST",
      path: "/api/v1/internal/domain-events",
      authorization: `Bearer ${SECRET}`,
      signature: signatureHeader(SECRET, BODY),
      timestamp: timestampHeader(new Date(BASE_INSTANT.getTime() - 600_000)),
      body: BODY,
      now: BASE_INSTANT,
      internalApiSecret: SECRET,
      cronSecret: CRON_SECRET,
    });

    expectDenied(result, "stale_signature");
  });
});

describe("internal auth codes are part of the client-facing contract", () => {
  it.each<InternalAuthCode>(["internal_auth_failed", "invalid_signature", "stale_signature"])(
    "pins %s in the closed API_ERROR_CODES enum",
    (code) => {
      expect((API_ERROR_CODES as readonly string[]).includes(code)).toBe(true);
      expect(errorCodeSchema.safeParse(code).success).toBe(true);
    }
  );
});

describe("internal request authorization — the cron exception is GET-only (U4b)", () => {
  it("U4b: rejects the CRON_SECRET bearer on a non-GET cron request", () => {
    const result = authorizeInternalRequest({
      method: "POST",
      path: "/api/v1/internal/cron/sample",
      authorization: `Bearer ${CRON_SECRET}`,
      signature: null,
      timestamp: null,
      body: "",
      now: BASE_INSTANT,
      internalApiSecret: SECRET,
      cronSecret: CRON_SECRET,
    });

    expectDenied(result, "internal_auth_failed");
  });
});

describe("internal HMAC malformed inputs (U3b/U2b/U2c)", () => {
  it.each(["deadbeef", "sha256=", "sha256=zzzz"])(
    "U3b: rejects the malformed signature %j as invalid_signature",
    (signature) => {
      const result = verifyInternalSignature({
        secret: SECRET,
        body: BODY,
        signature,
        timestamp: timestampHeader(BASE_INSTANT),
        now: BASE_INSTANT,
      });

      expectDenied(result, "invalid_signature");
    }
  );

  it("U2b: rejects a non-numeric timestamp as stale_signature", () => {
    const result = verifyInternalSignature({
      secret: SECRET,
      body: BODY,
      signature: signatureHeader(SECRET, BODY),
      timestamp: "not-a-number",
      now: BASE_INSTANT,
    });

    expectDenied(result, "stale_signature");
  });

  it("U2c: honours a maxSkewSeconds override at its exact boundary", () => {
    const withinOverride = verifyInternalSignature({
      secret: SECRET,
      body: BODY,
      signature: signatureHeader(SECRET, BODY),
      timestamp: timestampHeader(new Date(BASE_INSTANT.getTime() - 60_000)),
      now: BASE_INSTANT,
      maxSkewSeconds: 60,
    });
    expect(withinOverride).toEqual({ ok: true });

    const pastOverride = verifyInternalSignature({
      secret: SECRET,
      body: BODY,
      signature: signatureHeader(SECRET, BODY),
      timestamp: timestampHeader(new Date(BASE_INSTANT.getTime() - 61_000)),
      now: BASE_INSTANT,
      maxSkewSeconds: 60,
    });
    expectDenied(pastOverride, "stale_signature");
  });
});
