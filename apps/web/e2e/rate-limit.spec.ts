import { expect, test, type APIResponse } from "@playwright/test";

/**
 * E1 — rate limiting over a real HTTP server.
 *
 * `POST /api/v1/echo` is the pipeline's write route; it runs the `write.normal`
 * limit (60 / minute) through the memory provider under `APP_ENV=e2e`. A burst
 * from one client identity must tip over to 429 with the §0.11 headers, and an
 * ordinary early write must carry the RateLimit-* headers.
 *
 * The client identity is a fresh `x-forwarded-for` per test run so the burst
 * never bleeds into another e2e spec — or into a re-run on a reused server
 * process (`reuseExistingServer`), where a fixed literal would leave the
 * process-global memory limiter bucket already consumed (the observed flake:
 * `ratelimit-remaining` was `57`/`0` instead of `59`). The identity is derived
 * inside the test so a Playwright retry also starts from a clean bucket.
 */

const ECHO_URL = "/api/v1/echo";

test.describe("POST /api/v1/echo — rate limiting", () => {
  test("E1: a burst of writes returns 429 with the contract headers", async ({ request }) => {
    // TEST-NET-3 (203.0.113.0/24) with a per-invocation octet: unique to this
    // limiter key so the first write always observes a full bucket.
    const clientIp = `203.0.113.${String(Math.floor(Math.random() * 254) + 1)}`;
    let firstHeaders: Record<string, string> | undefined;
    let limited: APIResponse | undefined;

    for (let i = 0; i < 61 && limited === undefined; i += 1) {
      const response = await request.post(ECHO_URL, {
        headers: { "content-type": "application/json", "x-forwarded-for": clientIp },
        data: { message: `burst-${String(i)}` },
      });

      if (i === 0) {
        firstHeaders = response.headers();
      }
      if (response.status() === 429) {
        limited = response;
      }
    }

    expect(firstHeaders?.["ratelimit-limit"]).toBe("60");
    expect(firstHeaders?.["ratelimit-remaining"]).toBe("59");

    expect(limited, "expected a 429 within a burst of 61 writes").toBeDefined();
    expect(limited?.headers()["retry-after"]).toMatch(/^\d+$/);
    expect(limited?.headers()["ratelimit-limit"]).toBe("60");
    expect(limited?.headers()["ratelimit-remaining"]).toBe("0");
    expect(limited?.headers()["ratelimit-reset"]).toMatch(/^\d+$/);

    const body = await limited?.json();
    expect(body).toMatchObject({ error: { code: "rate_limited", retryable: true } });
  });
});
