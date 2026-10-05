import { expect, test } from "@playwright/test";

import { E2E_BASE_URL } from "./ports";

/**
 * E1 — the `user` auth label at the deployed HTTP surface (OP-86, contract
 * §0.3).
 *
 * The integration suite drives a route built with `defineRoute` in-process;
 * this spec proves the same guard is wired onto a real Next.js route and that
 * an unauthenticated caller gets the §0.6 error envelope plus the
 * `WWW-Authenticate` challenge a client uses to discover the credential type.
 *
 * The route under test is `GET /api/v1/me` (contract §1.2), which OP-86 guards
 * with `requireAuth("user")`. Its handler exists only so the guard has a
 * protected target; the `/me` response body itself is OP-88's contract.
 */

test.describe("user-labelled route over the API", () => {
  test("E1: an unauthenticated request is 401 with WWW-Authenticate", async ({ request }) => {
    const response = await request.get("/api/v1/me");

    expect(response.status()).toBe(401);

    // A 401 must advertise the challenge scheme so a client knows how to
    // authenticate (contract §0.6/§0.12).
    const challenge = response.headers()["www-authenticate"];
    expect(typeof challenge).toBe("string");
    expect(challenge ?? "").toContain("Bearer");

    const payload = (await response.json()) as {
      error: { code: string; details?: { loginUrl?: string } };
    };
    expect(payload.error.code).toBe("authentication_required");
    expect(typeof payload.error.details?.loginUrl).toBe("string");

    // No credential reaches the origin as a redirect to the login page: an API
    // route answers JSON, never a 302.
    expect(response.url()).toBe(`${E2E_BASE_URL}/api/v1/me`);
  });
});
