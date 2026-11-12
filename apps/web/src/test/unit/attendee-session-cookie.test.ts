import { describe, expect, it } from "vitest";

import { ATTENDEE_COOKIE_NAME, buildAttendeeSessionCookie } from "@/server/attendee/session-cookie";

/**
 * Unit contract — the `op_att` session cookie builder (OP-129 U2, contract
 * §1.5, ADR-0780).
 *
 * **Why this exists.** The anonymous attendee session rides a cookie, and the
 * cookie's attribute set *is* the security posture: `HttpOnly` keeps the bearer
 * token away from scripts, `SameSite=Lax` blocks a cross-site POST from riding
 * it, `Path=/` makes it reach every `/p/**` call, and `Max-Age` must equal the
 * session TTL the row was stamped with (`retention.attendeeSessionDays`) — a
 * longer cookie keeps presenting a token whose session has already expired, and
 * a shorter one logs the attendee out early.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/attendee/session-cookie` must export:
 *
 * ```ts
 * ATTENDEE_COOKIE_NAME: "op_att"
 * buildAttendeeSessionCookie(input: {
 *   token: string;         // the RAW token (a browser holds the credential)
 *   maxAgeSeconds: number; // the session TTL in seconds
 *   secure: boolean;       // true only on a TLS deployment
 * }): string               // a `Set-Cookie` header value
 * ```
 *
 * The builder is **pure**: no environment read, no clock read, so the route
 * decides `secure` from the deploy environment (exactly as
 * `buildCookieOptions` does for the Better Auth cookie, `@/server/auth/cookies`)
 * and the TTL from `platformSettings`.
 *
 * ## Assumptions (ADR-0780 §Assumptions)
 *
 * - `secure` is an explicit input rather than an absolute. Contract §1.5's
 *   example shows `Secure` unconditionally, which a browser on a plain-HTTP
 *   local/e2e origin would silently drop; the repository already resolves this
 *   for the Better Auth cookie by making TLS-dependent attributes
 *   environment-scoped (ADR-0022). `Secure` is therefore present when
 *   `secure: true` and absent when `secure: false`, and a TLS deploy always
 *   sets it.
 * - No `Domain` attribute: the cookie is host-only.
 * - The value is the raw token verbatim (no encoding, no quoting): base64url is
 *   already a cookie-safe alphabet, and the resolver hashes exactly what a
 *   client presents.
 */

/** A parsed `Set-Cookie` header value. */
interface ParsedCookie {
  readonly name: string;
  readonly value: string;
  readonly attributes: readonly string[];
}

/**
 * Split a `Set-Cookie` header value into its pair and its attributes.
 *
 * @param header - The header value under test.
 * @returns The cookie name, its raw value and the attribute list.
 * @throws {Error} When the header carries no `name=value` pair.
 */
function parseCookie(header: string): ParsedCookie {
  const [pair = "", ...attributes] = header.split("; ");
  const separator = pair.indexOf("=");
  if (separator < 0) {
    throw new Error(`expected a name=value cookie pair, got "${pair}"`);
  }
  return {
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
    attributes,
  };
}

/** The session TTL the route derives from `retention.attendeeSessionDays`. */
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * A raw token shaped like the minted one (U1).
 *
 * Deliberately low-entropy: a realistic high-entropy literal is
 * indistinguishable from a leaked credential to `gitleaks`
 * (`generic-api-key`), so this fixture carries the shape without the entropy.
 */
const TOKEN = "opat_cookie-vector-0000000000000000000000";

describe("buildAttendeeSessionCookie", () => {
  it("U2: names the cookie 'op_att'", () => {
    expect(ATTENDEE_COOKIE_NAME).toBe("op_att");

    expect(
      parseCookie(
        buildAttendeeSessionCookie({ token: TOKEN, maxAgeSeconds: MAX_AGE_SECONDS, secure: true })
      ).name
    ).toBe(ATTENDEE_COOKIE_NAME);
  });

  it("U2: a secure cookie carries HttpOnly, SameSite=Lax, Path=/ and the TTL", () => {
    const cookie = parseCookie(
      buildAttendeeSessionCookie({
        token: TOKEN,
        maxAgeSeconds: MAX_AGE_SECONDS,
        secure: true,
      })
    );

    expect(new Set(cookie.attributes)).toEqual(
      new Set([
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${String(MAX_AGE_SECONDS)}`,
        "Secure",
      ])
    );
  });

  it("U2: an off-TLS cookie is identical minus the Secure attribute", () => {
    const cookie = parseCookie(
      buildAttendeeSessionCookie({
        token: TOKEN,
        maxAgeSeconds: MAX_AGE_SECONDS,
        secure: false,
      })
    );

    expect(new Set(cookie.attributes)).toEqual(
      new Set(["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${String(MAX_AGE_SECONDS)}`])
    );
    expect(cookie.attributes).not.toContain("Secure");
  });

  it("U2: carries the raw token verbatim so the resolver can hash what a client sent", () => {
    const cookie = parseCookie(
      buildAttendeeSessionCookie({ token: TOKEN, maxAgeSeconds: MAX_AGE_SECONDS, secure: true })
    );

    expect(cookie.value).toBe(TOKEN);
  });

  it("U2: takes Max-Age from the injected TTL, never from a constant", () => {
    const cookie = parseCookie(
      buildAttendeeSessionCookie({ token: TOKEN, maxAgeSeconds: 604_800, secure: false })
    );

    expect(cookie.attributes).toContain("Max-Age=604800");
  });

  it("U2: is host-only — no Domain attribute", () => {
    const cookie = parseCookie(
      buildAttendeeSessionCookie({ token: TOKEN, maxAgeSeconds: MAX_AGE_SECONDS, secure: true })
    );

    expect(cookie.attributes.some((attribute) => attribute.startsWith("Domain"))).toBe(false);
  });
});
