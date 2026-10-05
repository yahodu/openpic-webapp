import type { AppEnv } from "@/server/config/env";

/**
 * Better Auth cookie policy derived from the deploy environment (OP-85,
 * contract §0.2 "Cookie: better-auth.session_token (web, `HttpOnly; Secure;
 * SameSite=Lax`)").
 *
 * The two environment-dependent knobs are:
 *
 *   - `useSecureCookies`: a `Secure` cookie is only ever sent over TLS, so it
 *     must be `false` on plain-HTTP local/e2e runs (otherwise sign-in silently
 *     fails — the browser drops the cookie) and `true` in `staging`/`production`.
 *   - `cookiePrefix`: `"__Secure-"` in a TLS environment is the browser's own
 *     guarantee that only a TLS origin may set the cookie, defeating a
 *     plain-HTTP shadow. It must be `""` off TLS or the cookie would be set
 *     under a name the browser rejects.
 *
 * `sameSite`, `httpOnly` and `path` are invariant: a cross-site-readable or
 * script-readable session cookie is a session-theft vector, so they are pinned
 * on every environment rather than only one.
 */

/** The cookie knobs Better Auth consumes (its `advanced` cookie options). */
export interface AuthCookieOptions {
  /** Feed into `advanced.useSecureCookies`. */
  readonly useSecureCookies: boolean;
  /** Feed into `advanced.cookiePrefix`. */
  readonly cookiePrefix: string;
  /** Feed into `advanced.defaultCookieAttributes.sameSite`. */
  readonly sameSite: "lax";
  /** Feed into `advanced.defaultCookieAttributes.httpOnly`. */
  readonly httpOnly: true;
  /** Feed into `advanced.defaultCookieAttributes.path`. */
  readonly path: "/";
}

/** Environments where the deploy terminates TLS and secrets are strict. */
const STRICT_ENVS: ReadonlySet<AppEnv> = new Set<AppEnv>(["staging", "production"]);

/**
 * Build the Better Auth cookie options for an environment.
 *
 * @param env - The validated deploy environment (`config.app.env`).
 * @returns The cookie options to hand to Better Auth's `advanced` block.
 */
export function buildCookieOptions(env: AppEnv): AuthCookieOptions {
  const strict = STRICT_ENVS.has(env);
  return {
    useSecureCookies: strict,
    cookiePrefix: strict ? "__Secure-" : "",
    sameSite: "lax",
    httpOnly: true,
    path: "/",
  };
}
