/**
 * The `op_att` session cookie (OP-129, contract §1.5).
 *
 * The attribute set *is* the security posture: `HttpOnly` keeps the bearer
 * token away from scripts, `SameSite=Lax` stops a cross-site request from riding
 * it, `Path=/` reaches every `/p/**` call and `Max-Age` must equal the session
 * TTL the row was stamped with.
 *
 * The builder is pure — no environment read, no clock read — so the route owns
 * both policy reads, exactly as `buildCookieOptions` scopes the Better Auth
 * cookie's TLS attributes to the deploy environment (ADR-0769 §4).
 */

/** The cookie carrying the attendee session token. */
export const ATTENDEE_COOKIE_NAME = "op_att";

/** Inputs for {@link buildAttendeeSessionCookie}. */
export interface AttendeeSessionCookieInput {
  /** The raw token (a browser holds the credential). */
  readonly token: string;
  /** The session TTL in seconds. */
  readonly maxAgeSeconds: number;
  /** True only on a TLS deployment; a browser drops `Secure` off TLS. */
  readonly secure: boolean;
}

/**
 * Build the `Set-Cookie` header value for an attendee session.
 *
 * @param input - Token, TTL and the TLS flag.
 * @returns `op_att=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<n>[; Secure]`.
 */
export function buildAttendeeSessionCookie(input: AttendeeSessionCookieInput): string {
  const attributes = [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${String(input.maxAgeSeconds)}`,
  ];
  if (input.secure) {
    attributes.push("Secure");
  }
  return `${ATTENDEE_COOKIE_NAME}=${input.token}; ${attributes.join("; ")}`;
}
