import { getAuth } from "@/server/auth";
import { appError } from "@/server/http/errors";

/**
 * Session revocation through Better Auth's own session endpoints (OP-91,
 * contract §1.3).
 *
 * Better Auth owns the `session` collection and the cookie/session store, so
 * the revoke surfaces delegate to its `revoke-session` / `revoke-other-sessions`
 * / `revoke-sessions` endpoints rather than hand-rolling a delete. The caller's
 * own credential is forwarded, and the endpoint's origin check satisfied with
 * the request's own origin (never a hard-coded one), so the internal call is
 * indistinguishable from a real client call.
 */

/** The Better Auth surface path for revoking one session by its token. */
const REVOKE_SESSION_PATH = "/api/auth/revoke-session";
/** The Better Auth surface path for revoking every session except the caller's. */
const REVOKE_OTHER_SESSIONS_PATH = "/api/auth/revoke-other-sessions";
/** The Better Auth surface path for revoking every session of the user. */
const REVOKE_SESSIONS_PATH = "/api/auth/revoke-sessions";

/** Forward the caller's credential and origin onto an internal auth request. */
function internalAuthHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {
    origin: new URL(request.url).origin,
    "content-type": "application/json",
  };
  const cookie = request.headers.get("cookie");
  if (cookie !== null) {
    headers.cookie = cookie;
  }
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    headers.authorization = authorization;
  }
  return headers;
}

/** Call one Better Auth POST endpoint internally, throwing on a refusal. */
async function callAuthEndpoint(request: Request, path: string, body: unknown): Promise<void> {
  const response = await getAuth().handler(
    new Request(new URL(path, request.url), {
      method: "POST",
      headers: internalAuthHeaders(request),
      body: JSON.stringify(body ?? {}),
    })
  );
  if (!response.ok) {
    throw appError("internal_error");
  }
}

/**
 * Revoke a single session by its token through Better Auth.
 *
 * @param request - The caller's request, carrying the credential to forward.
 * @param token - The target session's Better Auth token.
 */
export function revokeSessionToken(request: Request, token: string): Promise<void> {
  return callAuthEndpoint(request, REVOKE_SESSION_PATH, { token });
}

/**
 * Revoke the caller's sessions through Better Auth.
 *
 * @param request - The caller's request, carrying the credential to forward.
 * @param keepCurrent - When true, only the caller's *other* sessions are revoked.
 */
export function revokeCallerSessions(request: Request, keepCurrent: boolean): Promise<void> {
  return callAuthEndpoint(
    request,
    keepCurrent ? REVOKE_OTHER_SESSIONS_PATH : REVOKE_SESSIONS_PATH,
    {}
  );
}
