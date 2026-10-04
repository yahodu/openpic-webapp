import { describe, expect, it } from "vitest";

import type { RouteStageContext } from "@/server/http/define-route";
import {
  etagStage,
  eventETag,
  ifMatchSatisfied,
  ifNoneMatchSatisfied,
  strongETag,
  weakETag,
} from "@/server/http/etag";

/**
 * U5–U6 — ETag formatting and conditional-request evaluation (API contract
 * §0.10, RFC 7232).
 *
 * A mutable resource returns an `ETag`; a `PATCH`/`PUT` must present `If-Match`
 * (missing → `428 precondition_required`, mismatched → `412 etag_mismatch` with
 * `details.currentETag`). `If-Match` uses the **strong** comparison, so a weak
 * tag never matches; `If-None-Match` uses the **weak** comparison, so `W/"x"`
 * and `"x"` match. All comparisons are opaque-value based, never string-prefix.
 */

const CONTEXT: RouteStageContext = {
  requestId: "req_0123456789abcdef",
  route: "/api/v1/tenants/current/events/evt1",
  startedAt: new Date(0),
};

function request(method: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/v1/tenants/current/events/evt1", {
    method,
    headers,
  });
}

describe("ETag formatting", () => {
  it("U5: strongETag quotes a string token without a weakness prefix", () => {
    expect(strongETag("abc")).toBe('"abc"');
  });

  it("U5: strongETag accepts a numeric token (a version counter)", () => {
    expect(strongETag(7)).toBe('"7"');
  });

  it("U5: weakETag prefixes the quoted token with W/", () => {
    expect(weakETag("abc")).toBe('W/"abc"');
    expect(weakETag(7)).toBe('W/"7"');
  });

  it("U5: eventETag is the strong <updatedAtMs>-<schemaVersion> composite", () => {
    expect(eventETag(new Date(1790086920000), 3)).toBe('"1790086920000-3"');
    expect(eventETag(new Date(0), 0)).toBe('"0-0"');
  });
});

describe("events ETag — the current tag satisfies its own If-Match precondition", () => {
  it("U5/U6: a client can If-Match the events resource's own current ETag", () => {
    const current = eventETag(new Date(1790086920000), 3);

    expect(ifMatchSatisfied(request("PATCH", { "if-match": current }), current)).toBe(true);
  });
});

describe("ifMatchSatisfied — strong comparison (RFC 7232)", () => {
  it("U6: an exact strong tag matches", () => {
    expect(ifMatchSatisfied(request("PATCH", { "if-match": '"7"' }), '"7"')).toBe(true);
  });

  it("U6: a different tag does not match", () => {
    expect(ifMatchSatisfied(request("PATCH", { "if-match": '"8"' }), '"7"')).toBe(false);
  });

  it("U6: a weak client tag never strong-matches a strong current tag", () => {
    expect(ifMatchSatisfied(request("PATCH", { "if-match": 'W/"7"' }), '"7"')).toBe(false);
  });

  it("U6: a weak current tag never strong-matches, even with the same opaque value", () => {
    expect(ifMatchSatisfied(request("PATCH", { "if-match": 'W/"7"' }), 'W/"7"')).toBe(false);
    expect(ifMatchSatisfied(request("PATCH", { "if-match": '"7"' }), 'W/"7"')).toBe(false);
  });

  it("U6: a comma-separated list matches when any member matches", () => {
    expect(ifMatchSatisfied(request("PATCH", { "if-match": '"6", "7", "8"' }), '"7"')).toBe(true);
    expect(ifMatchSatisfied(request("PATCH", { "if-match": '"6", "8"' }), '"7"')).toBe(false);
  });

  it("U6: '*' matches an existing resource and a missing header does not match", () => {
    expect(ifMatchSatisfied(request("PATCH", { "if-match": "*" }), '"7"')).toBe(true);
    expect(ifMatchSatisfied(request("PATCH"), '"7"')).toBe(false);
  });
});

describe("ifNoneMatchSatisfied — weak comparison (RFC 7232)", () => {
  it("U6: the same opaque value matches across weak/strong forms", () => {
    expect(ifNoneMatchSatisfied(request("GET", { "if-none-match": 'W/"7"' }), '"7"')).toBe(true);
    expect(ifNoneMatchSatisfied(request("GET", { "if-none-match": '"7"' }), 'W/"7"')).toBe(true);
    expect(ifNoneMatchSatisfied(request("GET", { "if-none-match": '"7"' }), '"7"')).toBe(true);
  });

  it("U6: a different opaque value does not match", () => {
    expect(ifNoneMatchSatisfied(request("GET", { "if-none-match": '"8"' }), '"7"')).toBe(false);
  });

  it("U6: '*' matches and a missing header does not", () => {
    expect(ifNoneMatchSatisfied(request("GET", { "if-none-match": "*" }), '"7"')).toBe(true);
    expect(ifNoneMatchSatisfied(request("GET"), '"7"')).toBe(false);
  });
});

describe("etagStage — PATCH If-Match enforcement", () => {
  const CURRENT = strongETag(7);

  function stage() {
    return etagStage({ resolve: () => CURRENT, required: true });
  }

  it("U6: a mutation without If-Match is a 428 precondition_required", async () => {
    await expect(stage()(CONTEXT, request("PATCH"))).rejects.toMatchObject({
      code: "precondition_required",
      status: 428,
      details: { header: "If-Match" },
    });
  });

  it("U6: a mismatched If-Match is a 412 etag_mismatch carrying the current ETag", async () => {
    await expect(stage()(CONTEXT, request("PATCH", { "if-match": '"999"' }))).rejects.toMatchObject(
      {
        code: "etag_mismatch",
        status: 412,
        details: { currentETag: CURRENT },
      }
    );
  });

  it("U6: a matching If-Match lets the request through and echoes the ETag header", async () => {
    const result = await stage()(CONTEXT, request("PATCH", { "if-match": CURRENT }));

    expect(result).toMatchObject({ etag: CURRENT });
  });

  it("U6: with no resolvable ETag the stage is a no-op", async () => {
    const noResource = etagStage({ resolve: () => null, required: true });

    await expect(noResource(CONTEXT, request("PATCH"))).resolves.toBeUndefined();
  });
});
