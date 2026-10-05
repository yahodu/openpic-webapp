/**
 * Channel → transport workflow-id mapping (OP-92, ADR-0072).
 *
 * Novu is configured with exactly three single-step pass-through workflows.
 * This is the only place a concrete outbound channel is turned into a Novu
 * `name`; routing, templates and call sites know a channel, never a vendor
 * workflow id.
 */
import type { OutboundChannel } from "../../notifications/message-transport";

/** The three pass-through workflow ids Novu must hold, in canonical order. */
export const TRANSPORT_WORKFLOW_IDS = Object.freeze([
  "transport-email",
  "transport-sms",
  "transport-whatsapp",
] as const);

/** A pass-through workflow id. */
export type TransportWorkflowId = (typeof TRANSPORT_WORKFLOW_IDS)[number];

/** The channel behind each transport workflow id. */
const CHANNEL_BY_WORKFLOW_ID: Readonly<Record<TransportWorkflowId, OutboundChannel>> = {
  "transport-email": "email",
  "transport-sms": "sms",
  "transport-whatsapp": "whatsapp",
};

/**
 * Resolve the Novu workflow id for an outbound channel.
 *
 * @param channel - The rendered message channel.
 * @returns The matching transport workflow id.
 */
export function workflowIdForChannel(channel: OutboundChannel): TransportWorkflowId {
  switch (channel) {
    case "email":
      return "transport-email";
    case "sms":
      return "transport-sms";
    case "whatsapp":
      return "transport-whatsapp";
  }
}

/**
 * Resolve the channel behind a Novu workflow id.
 *
 * @param workflowId - A workflow id, which need not be a transport workflow.
 * @returns The matching channel, or `undefined` when it is not a transport
 *   workflow.
 */
export function channelForWorkflowId(workflowId: string): OutboundChannel | undefined {
  return Object.prototype.hasOwnProperty.call(CHANNEL_BY_WORKFLOW_ID, workflowId)
    ? CHANNEL_BY_WORKFLOW_ID[workflowId as TransportWorkflowId]
    : undefined;
}
