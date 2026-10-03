import { expect, test } from "@playwright/test";

/**
 * E1/E2 — the edge CSRF gate over a real `next start` server (OP-78).
 *
 * Complements the unit decision table and the integration middleware spec by
 * proving the gate is actually wired into the Next.js request path: the
 * `middleware.ts` matcher runs, reads the configured allowlist and can stop a
 * state-changing request before a route handler sees it.
 *
 * The e2e server sets `ALLOWED_ORIGINS=http://127.0.0.1:3000` (see
 * `e2e/start-server.mjs`), so that origin is trusted and anything else is
 * foreign. `POST /api/v1/echo` is the tracer-bullet route the pipeline was
 * built on.
 *
 * Note on the card's "(then 401 without session)": no auth-protected route
 * exists yet (that is a later story). E2 therefore proves "CSRF passed" by
 * contrast — the allowlisted request reaches the route handler (2xx) while an
 * otherwise identical request with a foreign Origin is stopped by the gate
 * (403). When an authenticated route lands, the allowlisted outcome becomes a
 * 401.
 */
const APP_ORIGIN = "http://127.0.0.1:3000";
const FOREIGN_ORIGIN = "https://evil.example";
const SESSION_COOKIE = "better-auth.session_token=test-stub";

test.describe("middleware — CSRF origin allowlist (e2e)", () => {
  test("E1: a cookie POST with a foreign Origin is rejected with 403 csrf_failed", async ({
    request,
  }) => {
    const response = await request.post("/api/v1/echo", {
      headers: {
        origin: FOREIGN_ORIGIN,
        "x-requested-with": "XMLHttpRequest",
        cookie: SESSION_COOKIE,
      },
      data: { message: "hi" },
    });

    expect(response.status()).toBe(403);

    const body: unknown = await response.json();
    expect(body).toMatchObject({ error: { code: "csrf_failed", retryable: false } });
  });

  test("E2: the allowlisted Origin + header passes CSRF while a foreign Origin does not", async ({
    request,
  }) => {
    const headers = {
      "x-requested-with": "XMLHttpRequest",
      cookie: SESSION_COOKIE,
    };

    const allowed = await request.post("/api/v1/echo", {
      headers: { ...headers, origin: APP_ORIGIN },
      data: { message: "hi" },
    });
    const foreign = await request.post("/api/v1/echo", {
      headers: { ...headers, origin: FOREIGN_ORIGIN },
      data: { message: "hi" },
    });

    // Same request in every respect except the Origin: the allowlisted one
    // clears the gate and reaches the route handler; the foreign one does not.
    expect(allowed.status()).toBe(200);
    expect(await allowed.json()).toEqual({ message: "hi" });
    expect(foreign.status()).toBe(403);
  });
});
