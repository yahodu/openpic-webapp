import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

/**
 * E1 — idempotent replay over a real HTTP server (API contract §0.9).
 *
 * `POST /api/v1/echo` is the pipeline's write route and honours an optional
 * `Idempotency-Key`. Two identical POSTs that share a key must execute once:
 * the first is served normally, the second is a replay carrying
 * `Idempotency-Replayed: true` with the identical stored body.
 *
 * The key is freshly generated per run and the client IP is unique, so the
 * test never replays into another spec or a previous run's record.
 */

const ECHO_URL = "/api/v1/echo";

test.describe("POST /api/v1/echo — idempotent replay", () => {
  test("E1: the second POST with the same Idempotency-Key carries Idempotency-Replayed: true", async ({
    request,
  }) => {
    const key = randomUUID();
    const clientIp = `203.0.113.${String(1 + Math.floor(Math.random() * 254))}`;
    const headers = {
      "content-type": "application/json",
      "x-forwarded-for": clientIp,
      "idempotency-key": key,
    };
    const data = { message: "charge-once" };

    const first = await request.post(ECHO_URL, { headers, data });
    expect(first.status()).toBe(200);
    expect(first.headers()["idempotency-replayed"]).toBeUndefined();
    const firstBody = await first.json();

    const second = await request.post(ECHO_URL, { headers, data });

    expect(second.status()).toBe(200);
    expect(second.headers()["idempotency-replayed"]).toBe("true");
    expect(await second.json()).toEqual(firstBody);
  });
});
