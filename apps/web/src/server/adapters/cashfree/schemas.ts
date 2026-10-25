/**
 * Cashfree wire schemas (OP-105, ADR-0380 §3/§5).
 *
 * Every request the adapter sends and every response or webhook it accepts is
 * parsed with Zod at the boundary, so a field Cashfree renames or drops raises
 * `UpstreamContractError` instead of propagating an unbounded vendor shape into
 * the server. Zod objects are non-strict, so Cashfree's extra keys are
 * tolerated — the pinned fields are what the adapter reads.
 *
 * Field names come from the Cashfree Subscriptions API (v2025-01-01): the
 * `POST /pg/subscriptions` request/response, `GET /pg/subscriptions/{id}` and
 * the subscription webhook payload.
 */
import { z } from "zod";

/** The `POST /pg/subscriptions` request body (the mandate-creation request). */
export const cashfreeCreateSubscriptionRequestSchema = z.object({
  subscription_id: z.string().min(1),
  customer_details: z.object({
    customer_name: z.string().min(1),
    customer_email: z.string().min(1),
    customer_phone: z.string().min(1),
  }),
  plan_details: z.object({ plan_id: z.string().min(1) }),
  subscription_meta: z.object({ return_url: z.string().min(1) }),
  /**
   * The payment-method preference the vendor honours for this subscription
   * (F3). The pinned `POST /pg/subscriptions` marks the block optional; the
   * adapter projects the neutral §14.3 mandate kind onto `payment_methods`.
   * Declared explicitly so the projection survives Zod's key stripping.
   */
  authorization_details: z
    .object({ payment_methods: z.array(z.string().min(1)).min(1) })
    .optional(),
});

/**
 * The `POST /pg/subscriptions` response body.
 *
 * `auth_link` is the hosted authorization URL the port exposes as
 * `checkoutUrl`; `subscription_expiry_time` is its expiry.
 */
export const cashfreeCreateSubscriptionResponseSchema = z.object({
  subscription_id: z.string().min(1),
  cf_subscription_id: z.string().min(1),
  subscription_status: z.string().min(1),
  subscription_session_id: z.string().min(1).optional(),
  subscription_expiry_time: z.string().min(1),
  auth_link: z.string().min(1),
  subscription_meta: z.object({ return_url: z.string().min(1) }).optional(),
});

/** The `GET /pg/subscriptions/{id}` response body. */
export const cashfreeSubscriptionStatusResponseSchema = z.object({
  subscription_id: z.string().min(1),
  cf_subscription_id: z.string().min(1),
  subscription_status: z.string().min(1),
  subscription_expiry_time: z.string().min(1),
  subscription_first_charge_time: z.string().nullable(),
  next_schedule_date: z.string().nullable(),
});

/** The `POST /pg/subscriptions/{id}/payments` (on-demand charge) response body. */
export const cashfreeChargeResponseSchema = z.object({
  payment_id: z.string().min(1),
  cf_payment_id: z.string().min(1),
  subscription_id: z.string().min(1),
  cf_subscription_id: z.string().min(1),
  payment_type: z.string().min(1),
  payment_status: z.string().min(1),
  payment_amount: z.number(),
  payment_currency: z.string().min(1),
  payment_schedule_date: z.string().min(1),
  payment_initiated_date: z.string().min(1),
});

/**
 * The `POST /pg/subscriptions/{id}/payments` (on-demand charge) request body.
 *
 * Strict, unlike the wire-response schemas: the outbound body is projected from
 * one field, so an unrecognised key is a projection bug rather than vendor
 * drift the adapter has to tolerate (F5).
 */
export const cashfreeChargeRequestSchema = z
  .object({ payment_amount: z.number().positive() })
  .strict();

/** The `subscription_details` block every subscription webhook carries. */
const cashfreeWebhookSubscriptionDetailsSchema = z.object({
  subscription_id: z.string().min(1).optional(),
  cf_subscription_id: z.string().min(1).optional(),
  subscription_status: z.string().min(1),
});

/**
 * The Cashfree subscription webhook body.
 *
 * `type` and `event_time` are required — a payload without them is drift, not a
 * body to guess at. The detail fields are optional because each vendor event
 * carries a different subset; a transaction is only built for the event types
 * of contract §10.1.2 and only from the fields that event must carry.
 */
export const cashfreeWebhookEventSchema = z.object({
  type: z.string().min(1),
  event_time: z.string().min(1),
  data: z.object({
    subscription_details: cashfreeWebhookSubscriptionDetailsSchema.optional(),
    authorization_details: z.object({ authorization_status: z.string().min(1) }).optional(),
    plan_details: z.object({ plan_currency: z.string().min(1).optional() }).optional(),
    payment_id: z.string().min(1).optional(),
    cf_payment_id: z.string().min(1).optional(),
    payment_type: z.string().min(1).optional(),
    payment_status: z.string().min(1).optional(),
    payment_amount: z.number().optional(),
    payment_currency: z.string().min(1).optional(),
    failure_details: z.object({ failure_reason: z.string().optional() }).optional(),
    refund_id: z.string().min(1).optional(),
    cf_refund_id: z.string().min(1).optional(),
    refund_status: z.string().min(1).optional(),
    refund_amount: z.number().optional(),
    refund_currency: z.string().min(1).optional(),
  }),
});

export type CashfreeCreateSubscriptionRequest = z.infer<
  typeof cashfreeCreateSubscriptionRequestSchema
>;
export type CashfreeCreateSubscriptionResponse = z.infer<
  typeof cashfreeCreateSubscriptionResponseSchema
>;
export type CashfreeSubscriptionStatusResponse = z.infer<
  typeof cashfreeSubscriptionStatusResponseSchema
>;
export type CashfreeChargeRequest = z.infer<typeof cashfreeChargeRequestSchema>;
export type CashfreeChargeResponse = z.infer<typeof cashfreeChargeResponseSchema>;
export type CashfreeWebhookEvent = z.infer<typeof cashfreeWebhookEventSchema>;
