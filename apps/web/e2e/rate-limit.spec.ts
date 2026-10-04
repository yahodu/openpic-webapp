import { expect, test, type APIResponse } from "@playwright/test";

/**
 * E1 — rate limiting over a real HTTP server.
 *
 * `POST /api/v1/echo` is the pipeline's write route; it runs the `write.normal`
 * limit (60 / minute) through the memory provider under `APP_ENV=e2e`. A burst
 * from one client identity must tip over to 429 with the §0.11 headers, and an
 * ordinary early write must carry the RateLimit-* headers.
 *
 * The client identity is a unique `x-forwarded-for` so the burst never bleeds
 * into the other e2e specs that share the server process.
 */

const ECHO_URL = "/api/v1/echo";
const CLIENT_IP = "203.0.113.231";

test.describe("POST /api/v1/echo — rate limiting", () => {
  test("E1: a burst of writes returns 429 with the contract headers", async ({ request }) => {
    let firstHeaders: Record<string, string> | undefined;
    let limited: APIResponse | undefined;

    for (let i = 0; i < 61 && limited === undefined; i += 1) {
      const response = await request.post(ECHO_URL, {
        headers: { "content-type": "application/json", "x-forwarded-for": CLIENT_IP },
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
