import type { OutboundMessage } from "@/server/notifications/message-transport";
import {
  type NovuTriggerResponse,
  type NovuWorkflowList,
  novuTriggerResponseSchema,
  novuWorkflowListSchema,
  transportWorkflowListSchema,
  transportWorkflowSchema,
  type TransportWorkflow,
} from "@/server/adapters/novu/schemas";

/**
 * Transport fixtures (CONVENTIONS §3): every fixture is produced by a `buildX`
 * factory that parses its own output through the wire schema, so a fixture can
 * never drift from the contract the adapter expects.
 *
 * `makeOutboundMessage` is the one exception: `OutboundMessage` is an internal
 * port type, not a wire payload, so it is constructed directly.
 */

/**
 * Build a fully rendered outbound email by default.
 *
 * @param overrides - Fields to replace on the default message.
 * @returns A valid {@link OutboundMessage}.
 */
export function makeOutboundMessage(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    channel: "email",
    to: { userId: "user-1", email: "ada@example.com" },
    subject: "Welcome to OpenPic",
    html: "<p>Hello Ada</p>",
    text: "Hello Ada",
    ...overrides,
  };
}

/**
 * Build a Novu trigger response carrying a transaction id.
 *
 * @param overrides - The transaction id to return (defaults to `txn-test-1`).
 * @returns A schema-valid Novu trigger response.
 */
export function makeNovuTriggerResponse(
  overrides: { readonly transactionId?: string } = {}
): NovuTriggerResponse {
  return novuTriggerResponseSchema.parse({
    data: { transactionId: overrides.transactionId ?? "txn-test-1" },
  });
}

/**
 * Build one normalized transport workflow.
 *
 * @param overrides - Fields to replace on the default (`transport-email`, one
 *   active `email` step).
 * @returns A schema-valid {@link TransportWorkflow}.
 */
export function makeTransportWorkflow(
  overrides: Partial<TransportWorkflow> = {}
): TransportWorkflow {
  return transportWorkflowSchema.parse({
    workflowId: "transport-email",
    steps: [{ active: true, channel: "email" }],
    ...overrides,
  });
}

/**
 * Build the canonical passing workflow list: exactly the three transport
 * workflows, one active step each, channel matching the name.
 *
 * @returns A schema-valid list of the three transport workflows.
 */
export function makeCanonicalTransportWorkflows(): TransportWorkflow[] {
  return transportWorkflowListSchema.parse([
    makeTransportWorkflow({
      workflowId: "transport-email",
      steps: [{ active: true, channel: "email" }],
    }),
    makeTransportWorkflow({
      workflowId: "transport-sms",
      steps: [{ active: true, channel: "sms" }],
    }),
    makeTransportWorkflow({
      workflowId: "transport-whatsapp",
      steps: [{ active: true, channel: "whatsapp" }],
    }),
  ]);
}

/**
 * Validate an arbitrary list of transport workflows.
 *
 * @param workflows - The list to validate (defaults to the canonical three).
 * @returns The same list, schema-parsed.
 */
export function makeTransportWorkflowList(
  workflows: readonly TransportWorkflow[] = makeCanonicalTransportWorkflows()
): TransportWorkflow[] {
  return transportWorkflowListSchema.parse(workflows);
}

/**
 * Build the raw Novu workflow-list response body for a normalized set.
 *
 * The adapter parses Novu's real shape (`steps[].template.type`) at the
 * boundary; this factory maps our normalized channels onto it and validates the
 * result with {@link novuWorkflowListSchema}, so MSW hands back exactly what the
 * adapter must accept.
 *
 * @param workflows - The normalized workflows to render as a Novu response.
 * @returns A schema-valid raw Novu workflow list.
 */
export function makeNovuWorkflowList(
  workflows: readonly TransportWorkflow[] = makeCanonicalTransportWorkflows()
): NovuWorkflowList {
  return novuWorkflowListSchema.parse({
    data: workflows.map((workflow) => ({
      workflowId: workflow.workflowId,
      steps: workflow.steps.map((step) => ({
        active: step.active,
        template: { type: step.channel },
      })),
    })),
  });
}
