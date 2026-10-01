import { expect, test } from "@playwright/test";

/**
 * E1 — the liveness endpoint over a real `next start` server, driven through
 * Playwright's `request` fixture. Complements the unit-level handler test by
 * proving routing, headers and serialization work end to end.
 */
test.describe("GET /api/v1/health", () => {
  test("returns 200 JSON with Cache-Control: no-store", async ({ request }) => {
    const response = await request.get("/api/v1/health");

    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");

    const body: unknown = await response.json();
    expect(body).toEqual({ status: "ok" });
  });
});
