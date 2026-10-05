import type { Db } from "mongodb";

/**
 * Test helpers for driving the OpenPic Better Auth surface (OP-85).
 *
 * The integration specs exercise the auth instance through its HTTP handler
 * (`auth.handler(request)`) — the library's documented server entry point —
 * rather than reaching into plugin internals, so a spec is coupled only to the
 * request/response contract a real client sees.
 *
 * `AuthLike` is a *structural* view of the Better Auth instance so these specs
 * do not import `better-auth` types: the RED suite must compile (or fail
 * meaningfully) before the dependency is added by the implementer.
 */

/** The one method the specs use from the configured auth instance. */
export interface AuthLike {
  handler(request: Request): Promise<Response>;
}

/** Options accepted by the intended `createAuth` factory (`@/server/auth`). */
export interface CreateAuthOptions {
  /** The MongoDB database the adapter writes auth collections to. */
  readonly db: Db;
}

/** A JSON `POST` through the auth handler, carrying the trusted Origin header. */
export function authPost(
  auth: AuthLike,
  origin: string,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<Response> {
  return auth.handler(
    new Request(new URL(path, origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        ...headers,
      },
      body: JSON.stringify(body),
    })
  );
}

/** Every `Set-Cookie` header on a response. */
export function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

/**
 * The `Set-Cookie` header for the session cookie, if the response set one.
 *
 * Matches both the plain (`better-auth.session_token`) and the `__Secure-`
 * prefixed name Better Auth uses when secure cookies are enabled.
 */
export function sessionCookie(response: Response): string | undefined {
  return setCookies(response).find((cookie) =>
    /(^|;\s|,)(__Secure-)?better-auth\.session_token=/.test(cookie)
  );
}

/** True when the header carries the given attribute (case-insensitive). */
export function hasCookieAttribute(header: string, attribute: string): boolean {
  return header.toLowerCase().includes(attribute.toLowerCase());
}

/** The value of the cookie in a `Set-Cookie` header (the `name=value` part). */
export function cookiePair(header: string): string {
  return header.split(";")[0] ?? "";
}

/** Parse a JSON body without assuming a shape. */
export async function body(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}
