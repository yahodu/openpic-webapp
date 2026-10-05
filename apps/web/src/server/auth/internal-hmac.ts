import { createHmac, timingSafeEqual } from "node:crypto";

import { appError } from "@/server/http/errors";
import type { RouteStage } from "@/server/http/define-route";
import { requestLogger } from "@/server/logging";
import { systemClock, type Clock } from "@/server/runtime/clock";

/**
 * Internal shared-secret HMAC auth (OP-87, contract §0.3 `internal`, ADR-0028).
 *
 * Machine-to-machine callers (cron jobs, the Python worker) are authenticated
 * with a shared secret plus an HMAC over the raw request body, rather than a
 * Better Auth session. The story splits the policy into two pure functions so
 * each is testable without an HTTP server, a clock or a database:
 *
 *   - {@link verifyInternalSignature} is the crypto: it compares
 *     `X-Signature: sha256=<hex HMAC of the raw body>` against `X-Timestamp`
 *     (epoch **seconds**) inside a ±300 s window, in constant time, using an
 *     injected `now`. It never throws — every failure is a stable code.
 *   - {@link authorizeInternalRequest} adds the bearer check and the documented
 *     Vercel-Cron exception: a `GET` under `/api/v1/internal/cron/**` may carry
 *     the `CRON_SECRET` bearer with an empty, unsigned body.
 *   - {@link internalAuthStage} joins them into a `defineRoute` pipeline stage.
 */

/** The three stable denial codes internal auth can produce (contract §0.3). */
export type InternalAuthCode = "internal_auth_failed" | "invalid_signature" | "stale_signature";

/** The verifier/authorizer verdict. */
export type InternalAuthResult =
  { readonly ok: true } | { readonly ok: false; readonly code: InternalAuthCode };

/** The default timestamp window, in seconds. */
const DEFAULT_MAX_SKEW_SECONDS = 300;

/** The route prefix whose `GET` requests may use the `CRON_SECRET` bearer. */
const CRON_PATH_PREFIX = "/api/v1/internal/cron/";

/** A well-formed `X-Signature`: the `sha256=` prefix and 64 lowercase hex digits. */
const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/;

/** The `X-Timestamp` encoding: epoch seconds as a decimal string. */
const TIMESTAMP_PATTERN = /^\d+$/;

/** Input accepted by {@link verifyInternalSignature}. */
export interface VerifyInternalSignatureInput {
  /** The shared secret the body was signed with. */
  readonly secret: string;
  /** The exact raw body the signature was computed over. */
  readonly body: string;
  /** The raw `X-Signature` header, `sha256=<hex>`, or `null` when absent. */
  readonly signature: string | null;
  /** The raw `X-Timestamp` header, epoch seconds as a string, or `null`. */
  readonly timestamp: string | null;
  /** The instant the window is measured against; injected so it is exact. */
  readonly now: Date;
  /** The allowed absolute skew in seconds; defaults to 300. */
  readonly maxSkewSeconds?: number;
}

/** Input accepted by {@link authorizeInternalRequest}. */
export interface AuthorizeInternalRequestInput {
  /** The HTTP method (uppercase). */
  readonly method: string;
  /** The request path, used for the cron-prefix exception. */
  readonly path: string;
  /** The raw `Authorization` header, or `null` when absent. */
  readonly authorization: string | null;
  /** The raw `X-Signature` header, or `null` when absent. */
  readonly signature: string | null;
  /** The raw `X-Timestamp` header, or `null` when absent. */
  readonly timestamp: string | null;
  /** The exact raw body (empty for an unsigned cron `GET`). */
  readonly body: string;
  /** The instant the timestamp window is measured against. */
  readonly now: Date;
  /** The shared secret for ordinary internal callers. */
  readonly internalApiSecret: string;
  /** The shared secret Vercel Cron presents as a bearer. */
  readonly cronSecret: string;
  /** The allowed absolute skew in seconds; defaults to 300. */
  readonly maxSkewSeconds?: number;
}

/** Options accepted by {@link internalAuthStage}. */
export interface InternalAuthStageOptions {
  /** The shared secret for ordinary internal callers. */
  readonly internalApiSecret: string;
  /** The shared secret Vercel Cron presents as a bearer. */
  readonly cronSecret: string;
  /** The clock the timestamp window is measured against; defaults to the wall clock. */
  readonly clock?: Clock;
  /** The allowed absolute skew in seconds; defaults to 300. */
  readonly maxSkewSeconds?: number;
}

/** Constant-time string compare that never short-circuits on a length mismatch. */
function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

/** Extract the token from an `Authorization: Bearer <token>` header, or `null`. */
function bearerToken(authorization: string | null): string | null {
  if (authorization === null) {
    return null;
  }
  const match = /^Bearer (.+)$/.exec(authorization);
  return match === null ? null : (match[1] ?? null);
}

/** The HMAC-SHA256 of a raw body, lowercase hex. */
function signatureHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/**
 * Verify the `X-Signature` / `X-Timestamp` pair for a raw body.
 *
 * Checks the timestamp window first (so a missing or unparseable timestamp is
 * `stale_signature`, never silently fresh), then the signature shape, then a
 * constant-time compare of the recomputed HMAC. Never throws.
 *
 * @param input - Secret, raw body, the two headers, `now` and optional skew.
 * @returns `{ ok: true }` or a coded denial.
 */
export function verifyInternalSignature(input: VerifyInternalSignatureInput): InternalAuthResult {
  const maxSkewSeconds = input.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  const timestamp = input.timestamp;

  if (timestamp === null || !TIMESTAMP_PATTERN.test(timestamp)) {
    return { ok: false, code: "stale_signature" };
  }
  const skewedMs = Math.abs(input.now.getTime() - Number(timestamp) * 1000);
  if (skewedMs > maxSkewSeconds * 1000) {
    return { ok: false, code: "stale_signature" };
  }

  const match = input.signature === null ? null : SIGNATURE_PATTERN.exec(input.signature);
  if (match === null) {
    return { ok: false, code: "invalid_signature" };
  }
  const providedHex = match[1] ?? "";
  const expectedHex = signatureHex(input.secret, input.body);
  if (!constantTimeEquals(providedHex, expectedHex)) {
    return { ok: false, code: "invalid_signature" };
  }

  return { ok: true };
}

/** True when the path is under the cron prefix. */
function isCronPath(path: string): boolean {
  return path.startsWith(CRON_PATH_PREFIX);
}

/**
 * Authorize an internal request: the bearer policy plus the HMAC policy.
 *
 * A `GET` under `/api/v1/internal/cron/**` presenting the `CRON_SECRET` bearer
 * is accepted with an empty, unsigned body (Vercel Cron issues GETs and cannot
 * sign one). Every other request needs `Bearer <INTERNAL_API_SECRET>` and a
 * valid signature; a `CRON_SECRET` bearer anywhere else (including a non-GET
 * cron request) is refused so the exception cannot be replayed.
 *
 * @param input - Method, path, the credential headers, `now` and both secrets.
 * @returns `{ ok: true }` or a coded denial.
 */
export function authorizeInternalRequest(input: AuthorizeInternalRequestInput): InternalAuthResult {
  const token = bearerToken(input.authorization);

  if (input.method === "GET" && isCronPath(input.path)) {
    if (token !== null && constantTimeEquals(token, input.cronSecret)) {
      return { ok: true };
    }
  }

  if (token === null || !constantTimeEquals(token, input.internalApiSecret)) {
    return { ok: false, code: "internal_auth_failed" };
  }

  return verifyInternalSignature({
    secret: input.internalApiSecret,
    body: input.body,
    signature: input.signature,
    timestamp: input.timestamp,
    now: input.now,
    ...(input.maxSkewSeconds === undefined ? {} : { maxSkewSeconds: input.maxSkewSeconds }),
  });
}

/**
 * Build the `defineRoute` auth stage for the `internal` label.
 *
 * Reads the raw body once (through `request.clone()`, so a later stage that
 * clones the request still sees an unread stream), runs
 * {@link authorizeInternalRequest} with the injected clock, and on denial logs
 * exactly one `warn` line carrying only the reason code — never the secret or
 * the signature — before throwing the catalogue `AppError` (all three codes are
 * `401`).
 *
 * @param options - The two shared secrets, the clock and an optional skew.
 * @returns A pipeline stage.
 */
export function internalAuthStage(options: InternalAuthStageOptions): RouteStage {
  const clock = options.clock ?? systemClock;

  return async (ctx, request) => {
    const body = await request.clone().text();
    const result = authorizeInternalRequest({
      method: request.method,
      path: new URL(request.url).pathname,
      authorization: request.headers.get("authorization"),
      signature: request.headers.get("x-signature"),
      timestamp: request.headers.get("x-timestamp"),
      body,
      now: clock.now(),
      internalApiSecret: options.internalApiSecret,
      cronSecret: options.cronSecret,
      ...(options.maxSkewSeconds === undefined ? {} : { maxSkewSeconds: options.maxSkewSeconds }),
    });

    if (!result.ok) {
      requestLogger(request, { route: ctx.route }).warn("internal request denied", {
        event: "internal.auth.denied",
        reason: result.code,
      });
      throw appError(result.code);
    }

    return undefined;
  };
}
