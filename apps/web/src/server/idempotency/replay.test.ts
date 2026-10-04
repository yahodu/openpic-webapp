import { describe, expect, it } from "vitest";

import { replayedStatus } from "./index";

/**
 * U3 — `replayedStatus` (API contract §0.9).
 *
 * A replay returns the stored response body verbatim but is always served as
 * `200`, never the original `201 Created` — a client must not mistake a replay
 * for a resource that was created by *this* call.
 */

describe("replayedStatus", () => {
  it("U3: rewrites a stored 201 response to 200 on replay", () => {
    expect(replayedStatus(201)).toBe(200);
  });

  it("U3: keeps a stored 200 response at 200", () => {
    expect(replayedStatus(200)).toBe(200);
  });

  it("U3: never returns 201 for any stored status", () => {
    expect(replayedStatus(201)).not.toBe(201);
  });
});
