import { expect, test } from "@playwright/test";

/**
 * E1 — the readiness endpoint over a real `next start` server.
 *
 * Complements the integration spec by proving the probe survives routing,
 * header handling and JSON serialization in the e2e environment. For this to
 * be meaningful the e2e runtime must have a reachable MongoDB (the readiness
 * probe really pings it), exactly as the integration suite runs against a
 * replica-set memory server.
 */
test.describe("GET /api/v1/health/ready", () => {
  test("returns 200 JSON with Cache-Control: no-store in the e2e environment", async ({
    request,
  }) => {
    const response = await request.get("/api/v1/health/ready");

    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");

    const body: unknown = await response.json();
    expect(body).toMatchObject({ status: "ok" });
  });
});
