import { expect, test } from "@playwright/test";

/**
 * E1 — `GET /api/v1/plans` conditional request over a real `next start` server
 * (OP-102, contract §3.1 + §0.10, ADR-0320).
 *
 * The integration suite drives the handler in-process; this spec proves the
 * behaviour through the deployed surface — routing, the middleware, the real
 * `defineRoute` pipeline and a real HTTP cache revalidation:
 *
 *   an unconditional GET answers `200` with a strong-or-weak `ETag` and the
 *   §3.1 `Cache-Control`, and replaying that tag as `If-None-Match` answers a
 *   bodyless `304`.
 *
 * It deliberately does not depend on the seeded catalogue: an empty response is
 * still a validatable representation, so the spec pins the caching contract and
 * not the seed content.
 */

const PLANS_PATH = "/api/v1/plans";

test.describe("GET /api/v1/plans — caching and revalidation", () => {
  test("E1: an unconditional GET returns an ETag, then a conditional GET returns 304", async ({
    request,
  }) => {
    const first = await request.get(PLANS_PATH);

    expect(first.status()).toBe(200);
    expect(first.headers()["cache-control"]).toBe("public, max-age=300");

    const etag = first.headers().etag ?? "";
    expect(etag).not.toBe("");

    // The representation must be valid JSON (the envelope shape itself is
    // pinned by the integration suite).
    await first.json();

    const revalidated = await request.get(PLANS_PATH, {
      headers: { "if-none-match": etag },
    });

    expect(revalidated.status()).toBe(304);
    expect(revalidated.headers().etag).toBe(etag);
    expect((await revalidated.body()).byteLength).toBe(0);
  });
});
