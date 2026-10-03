import type { CsrfFacts } from "@/server/security/csrf";

/**
 * Fixture factory for the CSRF decision function (OP-78).
 *
 * The default describes the canonical browser request the gate exists to
 * defend: a cookie-authenticated, same-origin, state-changing fetch that carries
 * the custom `X-Requested-With` header. Each test overrides exactly the one
 * fact it is about, so a failing assertion points at a single rule.
 *
 * @param overrides - Facts to replace on the canonical request.
 * @returns A complete `CsrfFacts` object.
 */
export function makeCsrfFacts(overrides: Partial<CsrfFacts> = {}): CsrfFacts {
  return {
    method: "POST",
    path: "/api/v1/photos",
    origin: "http://localhost:3000",
    requestedWith: "XMLHttpRequest",
    authorization: null,
    secFetchSite: null,
    hasSessionCookie: true,
    ...overrides,
  };
}

/** Origins the fixture configuration trusts (mirrors a parsed `ALLOWED_ORIGINS`). */
export const ALLOWED_ORIGINS: readonly string[] = [
  "http://localhost:3000",
  "https://app.openpic.test",
];
