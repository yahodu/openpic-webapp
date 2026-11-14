import { describe, expect, it } from "vitest";

import { buildHeartbeatResponse } from "@/server/internal/worker-heartbeat";

/**
 * Unit — the worker heartbeat response builder (OP-135 U2; contract §10.3.2,
 * §9.10; schema §20.4).
 *
 * §10.3.2 calls the heartbeat's answer the worker's **configuration channel**:
 * the face space, the lease length, the attempt ceiling and the operator's
 * pause switch reach the worker without a redeploy. That makes the body a
 * five-key contract, not a free-form ack, and it makes every value a read of
 * `platformSettings` — a hard-coded constant in this builder would silently
 * pin the fleet to the values of the day the code was written.
 *
 * The builder is separated from the route so this mapping is pinned without a
 * database: the route resolves the settings document, the builder shapes the
 * answer.
 */

/** The `pipeline`/`face` settings a worker is paced by (§20.4). */
const CONFIG = {
  activeSpaceKey: "arcface_r100_512",
  leaseMinutes: 10,
  maxAttempts: 5,
  pauseRequested: false,
} as const;

describe("the worker heartbeat response builder", () => {
  it("U2: answers exactly the five documented keys, acknowledged", () => {
    const response = buildHeartbeatResponse({ ...CONFIG });

    expect(Object.keys(response).sort()).toEqual([
      "acknowledged",
      "activeSpaceKey",
      "leaseMinutes",
      "maxAttempts",
      "pauseRequested",
    ]);
    expect(response.acknowledged).toBe(true);
  });

  it("U2: carries the configured face space, lease length and attempt ceiling verbatim", () => {
    const response = buildHeartbeatResponse({
      activeSpaceKey: "arcface_r100_512_v2",
      leaseMinutes: 7,
      maxAttempts: 3,
      pauseRequested: false,
    });

    expect(response.activeSpaceKey).toBe("arcface_r100_512_v2");
    expect(response.leaseMinutes).toBe(7);
    expect(response.maxAttempts).toBe(3);
  });

  it("U2: reports a pause when the operator requested one", () => {
    const response = buildHeartbeatResponse({ ...CONFIG, pauseRequested: true });

    expect(response.pauseRequested).toBe(true);
  });

  it("U2: reports no pause by default", () => {
    const response = buildHeartbeatResponse({ ...CONFIG, pauseRequested: false });

    expect(response.pauseRequested).toBe(false);
  });
});
