import { describe, expect, it } from "vitest";

import type { AppEnv } from "@/server/config/env";
import { buildCookieOptions } from "@/server/auth/cookies";

/**
 * U1 — the Better Auth cookie option builder by environment (OP-85, contract
 * §0.2 "Cookie: better-auth.session_token (web, `HttpOnly; Secure; SameSite=Lax`)").
 *
 * Better Auth decides the session cookie's security attributes from
 * `advanced.useSecureCookies` and the cookie name prefix from
 * `advanced.cookiePrefix`. Those two knobs MUST be derived from the validated
 * deploy environment, never hard-coded, or a non-TLS local/e2e run and a TLS
 * production run would share one of two wrong behaviours:
 *
 *   - a `Secure` cookie on plain HTTP is never sent back by the browser, so
 *     local sign-in silently fails;
 *   - an un-prefixed, non-`Secure` cookie in production is sniffable and can be
 *     shadowed by a plain-HTTP origin (the `__Secure-` prefix is the browser's
 *     guarantee that only a TLS origin may set it).
 *
 * Contract expected of the implementation
 * (`@/server/auth/cookies`):
 *
 *   buildCookieOptions(env: AppEnv): AuthCookieOptions
 *     `AuthCookieOptions` includes at least
 *       { useSecureCookies: boolean; cookiePrefix: string;
 *         sameSite: "lax"; httpOnly: true; path: "/" }
 *
 * The `sameSite`/`httpOnly`/`path` values are part of the §0.2 contract: a
 * cross-site-readable or script-readable cookie is a session-theft vector, so
 * the invariant is pinned on every environment rather than only one.
 */

const STRICT_ENVS: readonly AppEnv[] = ["staging", "production"];
const RELAXED_ENVS: readonly AppEnv[] = ["development", "test", "e2e"];

describe("buildCookieOptions — security attributes by environment", () => {
  it.each(STRICT_ENVS)(
    "U1: sets Secure cookies with the __Secure- prefix when APP_ENV=%s",
    (env) => {
      const options = buildCookieOptions(env);

      expect(options.useSecureCookies).toBe(true);
      expect(options.cookiePrefix).toBe("__Secure-");
    }
  );

  it.each(RELAXED_ENVS)(
    "U1: disables Secure cookies and the __Secure- prefix when APP_ENV=%s",
    (env) => {
      const options = buildCookieOptions(env);

      expect(options.useSecureCookies).toBe(false);
      expect(options.cookiePrefix).toBe("");
    }
  );

  it.each([...STRICT_ENVS, ...RELAXED_ENVS])(
    "U1: keeps HttpOnly, SameSite=Lax and Path=/ on every environment (%s)",
    (env) => {
      const options = buildCookieOptions(env);

      expect(options.httpOnly).toBe(true);
      expect(options.sameSite).toBe("lax");
      expect(options.path).toBe("/");
    }
  );
});
