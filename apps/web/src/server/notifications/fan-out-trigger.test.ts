import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit contract — the opportunistic fan-out trigger
 * (`@/server/notifications/fan-out-trigger`, OP-94 §1 follow-up, ADR-0106 §6).
 *
 * `runNotificationFanOutTrigger` is the deferred work `emitDomainEvent` hands to
 * Next.js's `after()`. It is a latency optimisation, never a correctness path:
 * every collaborator is resolved lazily via dynamic `import()` (a static
 * `fan-out` import would cycle, since `fan-out` imports `domain-events`), and
 * every failure is swallowed and logged so it can never surface as an
 * unhandled rejection after the response.
 *
 * Two properties are pinned here with module doubles, no database:
 *
 *   U1  It runs the fan-out with the resolved transport and recipient source,
 *       and the fan-out module is loaded lazily — importing the trigger alone
 *       must not evaluate `fan-out` (the cycle the dynamic import breaks).
 *   U2  A rejection from the fan-out (or a synchronous failure while resolving
 *       its collaborators) is swallowed: the trigger resolves, and it logs
 *       `notification.fan_out_trigger_failed` at error.
 */

const spies = vi.hoisted(() => ({
  runNotificationFanOut: vi.fn(),
  getNotificationTransport: vi.fn(),
  notificationRecipients: { readonly: "recipient-source" },
  fanOutLoads: 0,
  error: vi.fn(),
}));

vi.mock("@/server/notifications/fan-out", () => {
  spies.fanOutLoads += 1;
  return { runNotificationFanOut: spies.runNotificationFanOut };
});

vi.mock("@/server/services/notification-transport", () => ({
  getNotificationTransport: spies.getNotificationTransport,
}));

vi.mock("@/server/repos/notification-recipients", () => ({
  notificationRecipients: spies.notificationRecipients,
}));

vi.mock("@/server/logging", () => ({
  getLogger: () => ({ error: spies.error }),
}));

import { runNotificationFanOutTrigger } from "@/server/notifications/fan-out-trigger";

/** The number of times `fan-out` had been evaluated when this file loaded. */
const fanOutLoadsAtImport = spies.fanOutLoads;

/** A stand-in transport the trigger must pass through to the fan-out unchanged. */
const transport = { send: vi.fn() };

beforeEach(() => {
  spies.runNotificationFanOut.mockReset();
  spies.getNotificationTransport.mockReset();
  spies.error.mockReset();
  spies.getNotificationTransport.mockReturnValue(transport);
});

describe("runNotificationFanOutTrigger — collaborators (U1)", () => {
  it("loads the fan-out lazily and runs it with the resolved transport and recipients", async () => {
    // Arrange / Assert — importing the trigger must not have evaluated fan-out.
    expect(fanOutLoadsAtImport).toBe(0);

    // Act
    await runNotificationFanOutTrigger();

    // Assert
    expect(spies.fanOutLoads).toBeGreaterThan(0);
    expect(spies.runNotificationFanOut).toHaveBeenCalledWith({
      transport,
      recipients: spies.notificationRecipients,
    });
  });
});

describe("runNotificationFanOutTrigger — failure path (U2)", () => {
  it("swallows a fan-out rejection and logs notification.fan_out_trigger_failed", async () => {
    // Arrange
    spies.runNotificationFanOut.mockRejectedValue(new Error("fan-out exploded"));

    // Act / Assert — the trigger resolves, never rejects.
    await expect(runNotificationFanOutTrigger()).resolves.toBeUndefined();
    expect(spies.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "notification.fan_out_trigger_failed" })
    );
  });

  it("swallows a failure while resolving the collaborators and logs notification.fan_out_trigger_failed", async () => {
    // Arrange — the transport service throws before the fan-out is ever called.
    spies.getNotificationTransport.mockImplementationOnce(() => {
      throw new Error("transport misconfigured");
    });

    // Act / Assert
    await expect(runNotificationFanOutTrigger()).resolves.toBeUndefined();
    expect(spies.runNotificationFanOut).not.toHaveBeenCalled();
    expect(spies.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "notification.fan_out_trigger_failed" })
    );
  });
});
