import type { RateLimitScope } from "./identity";

/**
 * The rate-limit class table — the executable copy of contract §0.11.
 *
 * Every class named in §0.11 is configured here with its documented limit(s)
 * and window(s). A class may be keyed by more than one scope (e.g. `auth.otp`
 * is keyed by the contact *and* the IP); the stricter limit then wins. The
 * values are config, so a later story can override them from `platformSettings`
 * without touching this module. `webhook` is present with no rules because it
 * is never limited (signature verification is its protection).
 */

/** Every rate-limit class in contract §0.11. */
export type RateLimitClass =
  | "auth.otp"
  | "auth.verify"
  | "read.hot"
  | "read.normal"
  | "write.normal"
  | "upload.resolve"
  | "upload.sign"
  | "upload.complete"
  | "selfie.submit"
  | "liveness.challenge"
  | "public.gallery"
  | "media.sign"
  | "admin"
  | "webhook"
  | "internal";

/** One limit: a scope, its allowance and the sliding-window length in seconds. */
export interface RateLimitRule {
  readonly scope: RateLimitScope;
  readonly limit: number;
  readonly windowSeconds: number;
}

/** Whether a limiter failure lets the request through or denies it. */
export type RateLimitFailurePolicy = "fail-open" | "fail-closed";

/** The §0.11 class table. `webhook` carries no rules (never limited). */
export const RATE_LIMIT_CLASSES: Readonly<Record<RateLimitClass, readonly RateLimitRule[]>> = {
  "auth.otp": [
    { scope: "contact", limit: 5, windowSeconds: 3600 },
    { scope: "ip", limit: 15, windowSeconds: 3600 },
  ],
  "auth.verify": [{ scope: "contact", limit: 10, windowSeconds: 600 }],
  "read.hot": [{ scope: "user", limit: 60, windowSeconds: 60 }],
  "read.normal": [{ scope: "user", limit: 300, windowSeconds: 60 }],
  "write.normal": [{ scope: "user", limit: 60, windowSeconds: 60 }],
  "upload.resolve": [{ scope: "user", limit: 60, windowSeconds: 60 }],
  "upload.sign": [{ scope: "user", limit: 900, windowSeconds: 60 }],
  "upload.complete": [{ scope: "user", limit: 600, windowSeconds: 60 }],
  "selfie.submit": [
    { scope: "attendee", limit: 6, windowSeconds: 3600 },
    { scope: "ip", limit: 20, windowSeconds: 3600 },
  ],
  "liveness.challenge": [{ scope: "attendee", limit: 12, windowSeconds: 3600 }],
  "public.gallery": [
    { scope: "attendee", limit: 120, windowSeconds: 60 },
    { scope: "ip", limit: 600, windowSeconds: 60 },
  ],
  "media.sign": [{ scope: "user", limit: 120, windowSeconds: 60 }],
  admin: [{ scope: "user", limit: 300, windowSeconds: 60 }],
  webhook: [],
  internal: [{ scope: "user", limit: 600, windowSeconds: 60 }],
};

/**
 * Classes that are never limited (§0.11). A request whose class is bypassed
 * never consults the limiter; the empty rule list above is the data, this set
 * is the guard a caller branches on.
 */
export const RATE_LIMIT_BYPASS_CLASSES: ReadonlySet<RateLimitClass> = new Set<RateLimitClass>([
  "webhook",
]);

/** Abuse-prone classes that must fail closed when the limiter is unavailable. */
const FAIL_CLOSED_CLASSES: ReadonlySet<RateLimitClass> = new Set<RateLimitClass>([
  "auth.otp",
  "auth.verify",
  "selfie.submit",
  "liveness.challenge",
]);

/**
 * Whether a class bypasses rate limiting entirely.
 *
 * @param classKey - The class to test.
 * @returns `true` only for the webhook class.
 */
export function isRateLimitBypassed(classKey: RateLimitClass): boolean {
  return RATE_LIMIT_BYPASS_CLASSES.has(classKey);
}

/**
 * The failure policy for a class (§0.11): abuse-prone auth/selfie/liveness
 * classes fail closed, every ordinary read/write class fails open.
 *
 * @param classKey - The class to resolve.
 * @returns `"fail-closed"` or `"fail-open"`.
 */
export function rateLimitFailurePolicy(classKey: RateLimitClass): RateLimitFailurePolicy {
  return FAIL_CLOSED_CLASSES.has(classKey) ? "fail-closed" : "fail-open";
}
