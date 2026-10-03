import { NextResponse, type NextRequest } from "next/server";

import type { ApiErrorCode, ApiErrorEnvelope } from "@openpic/contracts";

import { getConfig } from "@/server/config/env";
import { logEdgeSecurityWarning } from "@/server/logging/edge";
import {
  CSRF_HEADER,
  SESSION_COOKIE_NAMES,
  decideCsrf,
  type CsrfFacts,
  type CsrfReason,
} from "@/server/security/csrf";

/**
 * Edge middleware: CSRF, origin allowlist and internal-route shielding (OP-78).
 *
 * Runs on the Edge runtime before any route handler. It extracts the
 * security-relevant facts from the request, hands them to the pure decision
 * table (`decideCsrf`) and either lets the request continue or stops it with a
 * shared error envelope. The whole rule set — including why a request is
 * rejected — lives in `@/server/security/csrf`; this file is the thin adapter.
 *
 * It reads `ALLOWED_ORIGINS` from the validated configuration, so the allowlist
 * has one source of truth across app and edge code.
 */

/** Inbound/outbound correlation header (kept in sync with the runtime module). */
const REQUEST_ID_HEADER = "x-request-id";

/** Only a short, log-safe token is echoed; anything else is replaced. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Maps a denial reason to the client-facing error code and message. */
const DENIALS: Readonly<
  Record<CsrfReason, { readonly code: ApiErrorCode; readonly message: string }>
> = {
  origin_not_allowed: {
    code: "csrf_failed",
    message: "The request failed the CSRF origin check.",
  },
  missing_csrf_header: {
    code: "csrf_failed",
    message: "The request is missing the required CSRF header.",
  },
  internal_origin: {
    code: "forbidden",
    message: "Internal routes are not reachable from a browser.",
  },
};

/** Resolve the correlation id: echo a valid inbound id, else mint one. */
function resolveRequestId(inbound: string | null): string {
  if (inbound !== null && REQUEST_ID_PATTERN.test(inbound)) {
    return inbound;
  }
  return `req_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** The origin's host (no scheme), or `null` when absent/unparseable. */
function originHost(origin: string | null): string | null {
  if (origin === null) {
    return null;
  }
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** True when the request carries the browser session cookie. */
function hasSessionCookie(request: NextRequest): boolean {
  const header = request.headers.get("cookie");
  if (header === null) {
    return false;
  }
  return header
    .split(";")
    .some((pair) => SESSION_COOKIE_NAMES.has((pair.split("=", 1)[0] ?? "").trim()));
}

/** Extract the security-relevant facts the decision table consumes. */
function csrfFacts(request: NextRequest): CsrfFacts {
  return {
    method: request.method,
    path: request.nextUrl.pathname,
    origin: request.headers.get("origin"),
    requestedWith: request.headers.get(CSRF_HEADER),
    authorization: request.headers.get("authorization"),
    hasSessionCookie: hasSessionCookie(request),
  };
}

/**
 * The middleware entry point.
 *
 * @param request - The inbound request.
 * @returns `NextResponse.next()` when the gate allows the request, otherwise a
 *   `403` carrying the shared error envelope.
 */
export function middleware(request: NextRequest): NextResponse | Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const origin = request.headers.get("origin");
  const decision = decideCsrf(csrfFacts(request), getConfig().app.allowedOrigins);

  if (decision.allowed) {
    return NextResponse.next();
  }

  logEdgeSecurityWarning({
    event:
      decision.reason === "internal_origin"
        ? "security.internal_origin_denied"
        : "security.csrf_failed",
    path: pathname,
    originHost: originHost(origin),
  });

  const denial = DENIALS[decision.reason];
  const body: ApiErrorEnvelope = {
    error: {
      code: denial.code,
      message: denial.message,
      requestId: resolveRequestId(request.headers.get(REQUEST_ID_HEADER)),
      retryable: false,
    },
  };

  return NextResponse.json(body, { status: 403 });
}

/**
 * Middleware matcher: every route except Next.js internals and static assets,
 * so the gate runs on the API and on page requests alike without paying for
 * asset requests.
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|woff|woff2)$).*)",
  ],
};
