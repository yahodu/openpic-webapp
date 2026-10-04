import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineRoute } from "@/server/http/define-route";
import { etagStage, weakETag } from "@/server/http/etag";

/**
 * I2 — a conditional `GET` answers `304 Not Modified` with no body when the
 * client's `If-None-Match` matches (API contract §0.7, §0.10).
 *
 * `GET /plans` (and `GET /me/notifications/unread-count`) is polled, so the ETag
 * stage turns an unchanged representation into a bodyless `304` the client
 * treats as "no re-render". The route is declared on the real `defineRoute`
 * pipeline, so this pins the wire behaviour: `304`, zero bytes, the current
 * `ETag` echoed — and a normal `200` + body on a miss.
 */

const PLANS_ETAG = weakETag("3-1790086920000");

function plansRoute() {
  return defineRoute({
    route: "/api/v1/plans",
    env: "test",
    response: z.object({ items: z.array(z.string()) }),
    etag: etagStage({ resolve: () => PLANS_ETAG }),
    handler: () => ({ body: { items: ["basic", "pro"] } }),
  });
}

describe("GET /api/v1/plans — conditional request handling", () => {
  it("I2: an unconditional GET returns 200, the body and the current ETag", async () => {
    const response = await plansRoute()(new Request("http://localhost/api/v1/plans"));

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(PLANS_ETAG);
    expect(await response.json()).toEqual({ items: ["basic", "pro"] });
  });

  it("I2: a matching If-None-Match returns 304 with no body", async () => {
    const response = await plansRoute()(
      new Request("http://localhost/api/v1/plans", {
        headers: { "if-none-match": PLANS_ETAG },
      })
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(PLANS_ETAG);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("I2: a non-matching If-None-Match returns the full 200 response again", async () => {
    const response = await plansRoute()(
      new Request("http://localhost/api/v1/plans", {
        headers: { "if-none-match": weakETag("other") },
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: ["basic", "pro"] });
  });
});
