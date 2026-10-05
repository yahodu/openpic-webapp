import { describe, expect, it } from "vitest";

import {
  TRANSPORT_WORKFLOW_IDS,
  channelForWorkflowId,
  workflowIdForChannel,
} from "@/server/adapters/novu/workflow-map";

/**
 * U2 — the channel → workflow-id mapping.
 *
 * Novu is configured with exactly three pass-through workflows (notification
 * design §8.2). The mapping is the only place a concrete outbound channel is
 * turned into a Novu `name`; routing, templates and call sites know a channel,
 * never a vendor workflow id.
 */
describe("channel → transport workflow id", () => {
  it.each([
    ["email", "transport-email"],
    ["sms", "transport-sms"],
    ["whatsapp", "transport-whatsapp"],
  ] as const)("maps the %s channel to %s", (channel, workflowId) => {
    // Act
    const resolved = workflowIdForChannel(channel);

    // Assert
    expect(resolved).toBe(workflowId);
  });

  it.each([
    ["transport-email", "email"],
    ["transport-sms", "sms"],
    ["transport-whatsapp", "whatsapp"],
  ] as const)("maps %s back to the %s channel", (workflowId, channel) => {
    // Act
    const resolved = channelForWorkflowId(workflowId);

    // Assert
    expect(resolved).toBe(channel);
  });

  it("returns undefined for a workflow that is not a transport workflow", () => {
    // Act
    const resolved = channelForWorkflowId("welcome-email");

    // Assert
    expect(resolved).toBeUndefined();
  });

  it("freezes exactly the three pass-through workflow ids", () => {
    // Act
    const ids = [...TRANSPORT_WORKFLOW_IDS];

    // Assert
    expect(ids).toEqual(["transport-email", "transport-sms", "transport-whatsapp"]);
  });
});
