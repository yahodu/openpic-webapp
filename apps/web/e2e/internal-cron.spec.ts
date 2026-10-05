import { expect, test } from "@playwright/test";

/**
 * E1 — the `internal` auth label at the deployed HTTP surface (OP-87, contract
 * §0.3/§10.2).
 *
 * The in-process integration suite proves the HMAC stage; this spec proves the
 * same guard is wired onto a real Next.js cron route and that a caller who
 * presents the wrong shared secret is refused with the shared §0.6 error
 * envelope and a `401`.
 *
 * The route under test is the framework's proving-ground cron job,
 * `GET /api/v1/internal/cron/sample`. The real `CRON_SECRET` is generated
 * per-run by the e2e launcher and is intentionally unavailable here, so the
 * only credential this spec can exercise is a wrong one.
 */

test.describe("internal cron route over the API", () => {
  test("E1: GET cron with a wrong secret is 401 internal_auth_failed", async ({ request }) => {
    const response = await request.get("/api/v1/internal/cron/sample", {
      headers: { authorization: "Bearer definitely-not-the-cron-secret" },
    });

    expect(response.status()).toBe(401);
    expect(response.headers()["content-type"] ?? "").toContain("application/json");

    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("internal_auth_failed");
  });

  test("E1: GET cron with no credential is 401", async ({ request }) => {
    const response = await request.get("/api/v1/internal/cron/sample");

    expect(response.status()).toBe(401);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("internal_auth_failed");
  });
});
