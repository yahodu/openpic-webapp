import { createHmac, timingSafeEqual } from "node:crypto";

import { hmacSha256Hex } from "@/server/runtime/crypto";

/**
 * The DSR receipt token — the anonymous attendee's durable read credential for
 * the request they filed (OP-138, contract §8.1, ADR-0905).
 *
 * An attendee has no verified email or phone, so the `202` receipt's `pollUrl`
 * is the only way back to the request once the `op_att` session row is gone.
 * The token is therefore stateless — no column stores it, and it carries no
 * `exp`: its lifetime is the lifetime of the `dataSubjectRequests` row, which
 * has no TTL. There is no re-issue path; a lost receipt cannot be replaced.
 *
 * ## The wire format (ADR-0905)
 *
 * ```
 * token   = base64url(payloadJson) + "." + lowercase hex HMAC-SHA256(base64url(payloadJson))
 * payload = { v: 1, kind: "dsr_receipt", requestId: "<24-hex>" }
 * key     = hex HMAC-SHA256(INTERNAL_API_SECRET, "dsr-receipt:v1")
 * ```
 *
 * The HMAC is compared in constant time (`timingSafeEqual`) before the payload
 * is parsed, so a tampered token is rejected without a usable timing oracle and
 * cannot probe the payload. The key is a domain-separated subkey of
 * `INTERNAL_API_SECRET`, so no new env var, settings key or collection is
 * introduced.
 */

/** The domain separator that derives the receipt's signing key. */
const KEY_DOMAIN = "dsr-receipt:v1";

/** The token version and kind the payload must name (contract §8.1). */
const TOKEN_VERSION = 1;
const TOKEN_KIND = "dsr_receipt";

/** A request id is a 24-character lowercase hex `ObjectId` (schema §20.3). */
const REQUEST_ID_PATTERN = /^[0-9a-f]{24}$/;

/** The options {@link signDsrReceipt} accepts. */
export interface DsrReceiptOptions {
  /** The filing request's id, as 24-hex. */
  readonly requestId: string;
  /** The `INTERNAL_API_SECRET` the subkey is derived from. */
  readonly secret: string;
}

/** The verifier's verdict: the request the token names, or why it was rejected. */
export type DsrReceiptVerdict =
  | { readonly valid: true; readonly requestId: string }
  | { readonly valid: false; readonly reason: "invalid" };

/** The subkey every receipt is signed and verified with (ADR-0905). */
function signingKey(secret: string): string {
  return hmacSha256Hex(secret, KEY_DOMAIN);
}

/** The HMAC-SHA256 of one encoded segment, lowercase hex (ADR-0905 wire format). */
function signatureHex(key: string, encoded: string): string {
  return createHmac("sha256", key).update(encoded, "utf8").digest("hex");
}

/**
 * Compare two strings in constant time.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths are compared
 * first and a mismatch answers `false` at once: both operands here are a
 * fixed-width 64-hex signature or an attacker-supplied string, so the only
 * thing the early return discloses is the length the caller already knows.
 */
function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Mint the receipt token for one filed request (contract §8.1; ADR-0905).
 *
 * @param options - The request id and the `INTERNAL_API_SECRET`.
 * @returns The `base64url(payload).signature` token.
 */
export function signDsrReceipt(options: DsrReceiptOptions): string {
  const encoded = Buffer.from(
    JSON.stringify({ v: TOKEN_VERSION, kind: TOKEN_KIND, requestId: options.requestId }),
    "utf8"
  ).toString("base64url");

  return `${encoded}.${signatureHex(signingKey(options.secret), encoded)}`;
}

/**
 * Decode and shape-check the payload segment of a token.
 *
 * @param encoded - The base64url payload segment.
 * @returns The request id the payload names, or `null` when it is not a payload.
 */
function decodeReceiptPayload(encoded: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const { v, kind, requestId } = parsed as Record<string, unknown>;
  if (v !== TOKEN_VERSION || kind !== TOKEN_KIND) {
    return null;
  }
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
    return null;
  }

  return requestId;
}

/**
 * Verify a receipt token and return the request it names (contract §8.1).
 *
 * Never throws: a malformed, truncated or tampered token is
 * `{ valid: false, reason: "invalid" }`. The signature is recomputed over the
 * token's own payload segment and compared in constant time before the payload
 * is parsed.
 *
 * @param token - The raw `?receipt=` value.
 * @param secret - The `INTERNAL_API_SECRET` the subkey is derived from.
 * @returns `{ valid: true, requestId }`, or the coded rejection.
 */
export function verifyDsrReceipt(token: string, secret: string): DsrReceiptVerdict {
  const segments = token.split(".");
  if (segments.length !== 2) {
    return { valid: false, reason: "invalid" };
  }

  const [encoded, signature] = segments;
  if (encoded === undefined || signature === undefined) {
    return { valid: false, reason: "invalid" };
  }

  if (!constantTimeEquals(signature, signatureHex(signingKey(secret), encoded))) {
    return { valid: false, reason: "invalid" };
  }

  const requestId = decodeReceiptPayload(encoded);
  if (requestId === null) {
    return { valid: false, reason: "invalid" };
  }

  return { valid: true, requestId };
}
