/**
 * The CSRF + internal-route decision table (OP-78, epic Edge Security).
 *
 * `decideCsrf` is the pure, side-effect-free heart of `src/middleware.ts`: given
 * the security-relevant facts of an inbound request and the configured origin
 * allowlist, it says whether the edge gate lets the request continue or rejects
 * it. Keeping the whole rule table in a pure function lets every branch be
 * pinned without standing up a Next.js server (and keeps the middleware itself
 * a thin adapter over this module).
 *
 * Design notes:
 *   - Signals are exhaustive: `{ allowed: true }` or `{ allowed: false, reason }`.
 *     The middleware maps a `reason` to the shared error envelope.
 *   - Internal routes are server-to-server only and are checked *before* the
 *     safe-method and Bearer exemptions: any browser `Origin` header on
 *     `/api/v1/internal/**` is rejected regardless of method or credentials,
 *     so a browser can never reach an internal route.
 *   - Safe methods (GET/HEAD/OPTIONS) do not change state and always pass.
 *   - A `Bearer` request carries explicit, non-ambient credentials and is
 *     exempt (the browser never attaches it automatically, so CSRF does not
 *     apply).
 *   - A request without the session cookie has no ambient authority to ride,
 *     so it is exempt.
 *   - `/api/auth/**` and `/api/v1/webhooks/**` are exempt: Better Auth performs
 *     its own origin checks and webhooks are signature-verified.
 *   - Every other state-changing cookie request needs an allowlisted `Origin`
 *     (exact string match) AND `X-Requested-With: XMLHttpRequest`.
 */

/** A browser session cookie whose presence marks a request as cookie-authenticated. */
export const SESSION_COOKIE_NAME = "better-auth.session_token";

/** The value the custom `X-Requested-With` header must carry (case-sensitive). */
export const CSRF_HEADER = "x-requested-with";
export const CSRF_HEADER_VALUE = "XMLHttpRequest";

/** Methods that never change state, so they are exempt from the CSRF check. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** Exempt path classes (Better Auth origin checks / signature-verified webhooks). */
const AUTH_PATH_PREFIX = "/api/auth";
const WEBHOOK_PATH_PREFIX = "/api/v1/webhooks";

/** Server-to-server routes that must never be reachable from a browser. */
const INTERNAL_PATH_PREFIX = "/api/v1/internal";

/** The security-relevant facts extracted from an inbound request. */
export interface CsrfFacts {
  /** The HTTP method, any case. */
  readonly method: string;
  /** The request path (no query string). */
  readonly path: string;
  /** The `Origin` header, or `null` when absent. */
  readonly origin: string | null;
  /** The `X-Requested-With` header, or `null` when absent. */
  readonly requestedWith: string | null;
  /** The `Authorization` header, or `null` when absent. */
  readonly authorization: string | null;
  /** Whether the request carries the session cookie. */
  readonly hasSessionCookie: boolean;
}

/** Why the gate rejected a request; the middleware maps it to an error code. */
export type CsrfReason = "origin_not_allowed" | "missing_csrf_header" | "internal_origin";

/** The outcome of {@link decideCsrf}. */
export type CsrfDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: CsrfReason };

/** True when `path` is `prefix` itself or lives beneath it. */
function isWithin(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** True when the `Authorization` value is a Bearer token. */
function isBearer(authorization: string | null): boolean {
  return authorization !== null && /^Bearer\s+\S/.test(authorization);
}

/**
 * Decide whether the edge gate lets a request continue.
 *
 * @param facts - The request's security-relevant facts.
 * @param allowedOrigins - The exact origins the deployment trusts.
 * @returns `{ allowed: true }`, or the denial `reason`.
 */
export function decideCsrf(facts: CsrfFacts, allowedOrigins: readonly string[]): CsrfDecision {
  // Internal routes are unreachable from a browser: reject any request that
  // carries an Origin, no matter the method or credentials.
  if (isWithin(facts.path, INTERNAL_PATH_PREFIX)) {
    return facts.origin === null
      ? { allowed: true }
      : { allowed: false, reason: "internal_origin" };
  }

  if (SAFE_METHODS.has(facts.method.toUpperCase())) {
    return { allowed: true };
  }

  if (isWithin(facts.path, AUTH_PATH_PREFIX) || isWithin(facts.path, WEBHOOK_PATH_PREFIX)) {
    return { allowed: true };
  }

  if (isBearer(facts.authorization)) {
    return { allowed: true };
  }

  // No session cookie means no ambient authority for a cross-site request to
  // ride, so there is nothing to protect against.
  if (!facts.hasSessionCookie) {
    return { allowed: true };
  }

  if (facts.origin === null || !allowedOrigins.includes(facts.origin)) {
    return { allowed: false, reason: "origin_not_allowed" };
  }

  if (facts.requestedWith !== CSRF_HEADER_VALUE) {
    return { allowed: false, reason: "missing_csrf_header" };
  }

  return { allowed: true };
}
