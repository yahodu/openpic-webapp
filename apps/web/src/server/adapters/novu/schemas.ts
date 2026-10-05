/**
 * Novu wire schemas (OP-92, ADR-0072 §3).
 *
 * Every request the adapter sends and every response it accepts is parsed at
 * the boundary with Zod. A response that no longer matches raises
 * `UpstreamContractError` instead of propagating an unbounded vendor shape into
 * the server. Zod objects are non-strict, so Novu's extra fields are tolerated.
 */
import { z } from "zod";

/** The trigger request body POSTed to `{baseUrl}/v1/events/trigger`. */
export const novuTriggerRequestSchema = z.object({
  name: z.string().min(1),
  to: z.object({
    subscriberId: z.string().min(1),
    email: z.string().min(1).optional(),
    phone: z.string().min(1).optional(),
  }),
  payload: z.record(z.string(), z.unknown()).optional(),
});

/** The trigger response body: Novu echoes the created transaction id. */
export const novuTriggerResponseSchema = z.object({
  data: z.object({
    transactionId: z.string().min(1),
  }),
});

/** One raw Novu workflow step (`template.type` names the channel). */
export const novuWorkflowStepSchema = z.object({
  active: z.boolean(),
  template: z.object({ type: z.string().min(1) }),
});

/** One raw Novu workflow. */
export const novuWorkflowSchema = z.object({
  workflowId: z.string().min(1),
  steps: z.array(novuWorkflowStepSchema),
});

/** The raw `GET /v1/workflows` response body. */
export const novuWorkflowListSchema = z.object({
  data: z.array(novuWorkflowSchema),
});

/** One normalized transport workflow step. */
export const transportWorkflowStepSchema = z.object({
  active: z.boolean(),
  channel: z.string().min(1),
});

/** One normalized transport workflow. */
export const transportWorkflowSchema = z.object({
  workflowId: z.string().min(1),
  steps: z.array(transportWorkflowStepSchema),
});

/** A normalized list of transport workflows. */
export const transportWorkflowListSchema = z.array(transportWorkflowSchema);

export type NovuTriggerRequest = z.infer<typeof novuTriggerRequestSchema>;
export type NovuTriggerResponse = z.infer<typeof novuTriggerResponseSchema>;
export type NovuWorkflowStep = z.infer<typeof novuWorkflowStepSchema>;
export type NovuWorkflow = z.infer<typeof novuWorkflowSchema>;
export type NovuWorkflowList = z.infer<typeof novuWorkflowListSchema>;
export type TransportWorkflowStep = z.infer<typeof transportWorkflowStepSchema>;
export type TransportWorkflow = z.infer<typeof transportWorkflowSchema>;
