/**
 * Payment provider fixtures (OP-105, CONVENTIONS §3).
 *
 * Two kinds of fixture live here:
 *
 *  - **Port values** (`CreateMandateInput`, `PaymentProviderConfig`) are internal
 *    types, not wire payloads, so they are constructed directly — the same
 *    exception `makeOutboundMessage` makes for the transport port.
 *  - **Cashfree wire payloads** are produced by the Cashfree Zod schemas
 *    (`@/server/adapters/cashfree/schemas`) and parsed by their own factories, so
 *    a fixture can never drift from the contract the adapter parses. The MSW
 *    handlers in the integration specs return these fixtures.
 *
 * Webhook bodies are the one wire payload *not* parsed here: `parseWebhook`
 * consumes the **raw** body as a string (CONVENTIONS §3, contract §10.1 step 1 —
 * the signature is verified over the raw bytes), so the factory emits a JSON
 * string built from the documented Cashfree payload shape.
 */
import { createHmac } from "node:crypto";

import {
  cashfreeCreateSubscriptionRequestSchema,
  cashfreeCreateSubscriptionResponseSchema,
  cashfreeChargeResponseSchema,
  cashfreeSubscriptionStatusResponseSchema,
  type CashfreeChargeResponse,
  type CashfreeCreateSubscriptionRequest,
  type CashfreeCreateSubscriptionResponse,
  type CashfreeSubscriptionStatusResponse,
} from "@/server/adapters/cashfree/schemas";
import type {
  CreateMandateInput,
  PaymentProviderConfig,
  WebhookHeaders,
} from "@/server/payments/payment-provider";

/**
 * The webhook secret every fixture signature is keyed with.
 *
 * A deliberate, low-entropy test string — never a real credential and never
 * shape-matched by the secret scanner the way a random-looking literal would be.
 */
export const TEST_CASHFREE_WEBHOOK_SECRET = "test-cashfree-webhook-secret";

/**
 * Build the Cashfree adapter configuration.
 *
 * @param overrides - Fields to replace on the sandbox default.
 * @returns A valid {@link PaymentProviderConfig}.
 */
export function makePaymentProviderConfig(
  overrides: Partial<PaymentProviderConfig> = {}
): PaymentProviderConfig {
  return {
    env: "sandbox",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    apiVersion: "2025-01-01",
    webhookSecret: TEST_CASHFREE_WEBHOOK_SECRET,
    ...overrides,
  };
}

/**
 * Build a mandate-creation request for the port.
 *
 * @param overrides - Fields to replace on the default Starter monthly mandate.
 * @returns A valid {@link CreateMandateInput}.
 */
export function makeCreateMandateInput(
  overrides: Partial<CreateMandateInput> = {}
): CreateMandateInput {
  return {
    planRef: "STARTER_MONTHLY_V1",
    customer: {
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "9900000000",
    },
    returnUrl: "https://app.example.com/billing/return",
    paymentMethodKind: "mandate_upi",
    ...overrides,
  };
}

/**
 * Build the Cashfree `POST /pg/subscriptions` request body the adapter sends.
 *
 * @param overrides - Fields to replace on the default body.
 * @returns A schema-valid {@link CashfreeCreateSubscriptionRequest}.
 */
export function makeCashfreeCreateSubscriptionRequest(
  overrides: Partial<CashfreeCreateSubscriptionRequest> = {}
): CashfreeCreateSubscriptionRequest {
  return cashfreeCreateSubscriptionRequestSchema.parse({
    subscription_id: "sub_test_001",
    customer_details: {
      customer_name: "Ada Lovelace",
      customer_email: "ada@example.com",
      customer_phone: "9900000000",
    },
    plan_details: { plan_id: "STARTER_MONTHLY_V1" },
    subscription_meta: { return_url: "https://app.example.com/billing/return" },
    ...overrides,
  });
}

/**
 * Build the Cashfree `POST /pg/subscriptions` response body.
 *
 * A realistic **superset**: Cashfree's own payloads carry more keys than any one
 * version of the API pins, and the boundary schema is non-strict, so the extra
 * keys are tolerated (the Novu adapter's schemas make the same allowance). The
 * `auth_link` is the hosted authorisation URL the port maps onto `checkoutUrl`
 * (`docs/Subscription flow.md` §2.2: "Cashfree returns an `authLink`").
 *
 * @param overrides - Fields to replace on the default initialised mandate.
 * @returns A schema-valid {@link CashfreeCreateSubscriptionResponse}.
 */
export function makeCashfreeCreateSubscriptionResponse(
  overrides: Partial<CashfreeCreateSubscriptionResponse> = {}
): CashfreeCreateSubscriptionResponse {
  return cashfreeCreateSubscriptionResponseSchema.parse({
    subscription_id: "sub_test_001",
    cf_subscription_id: "23639356",
    subscription_status: "INITIALIZED",
    subscription_session_id: "session_test_001",
    subscription_expiry_time: "2026-11-01T10:30:46+05:30",
    auth_link: "https://payments-test.cashfree.com/links/test-001",
    subscription_meta: { return_url: "https://app.example.com/billing/return" },
    ...overrides,
  });
}

/**
 * Build the Cashfree `GET /pg/subscriptions/{id}` response body.
 *
 * @param overrides - Fields to replace on the default `ACTIVE` mandate.
 * @returns A schema-valid {@link CashfreeSubscriptionStatusResponse}.
 */
export function makeCashfreeSubscriptionStatusResponse(
  overrides: Partial<CashfreeSubscriptionStatusResponse> = {}
): CashfreeSubscriptionStatusResponse {
  return cashfreeSubscriptionStatusResponseSchema.parse({
    subscription_id: "sub_test_001",
    cf_subscription_id: "23639356",
    subscription_status: "ACTIVE",
    subscription_expiry_time: "2047-07-30T13:24:54+05:30",
    subscription_first_charge_time: null,
    next_schedule_date: null,
    ...overrides,
  });
}

/**
 * Build the Cashfree on-demand charge (`POST …/payments`) response body.
 *
 * @param overrides - Fields to replace on the default successful charge.
 * @returns A schema-valid {@link CashfreeChargeResponse}.
 */
export function makeCashfreeChargeResponse(
  overrides: Partial<CashfreeChargeResponse> = {}
): CashfreeChargeResponse {
  return cashfreeChargeResponseSchema.parse({
    payment_id: "ab-charge-001",
    cf_payment_id: "49914526",
    subscription_id: "sub_test_001",
    cf_subscription_id: "23639356",
    payment_type: "CHARGE",
    payment_status: "INITIALIZED",
    payment_amount: 499,
    payment_currency: "INR",
    payment_schedule_date: "2026-10-25",
    payment_initiated_date: "2026-10-25T10:32:21+05:30",
    ...overrides,
  });
}

/** The Cashfree subscription status a status-changed fixture reports. */
export type CashfreeStatusChangedValue =
  | "INITIALIZED"
  | "BANK_APPROVAL_PENDING"
  | "ACTIVE"
  | "ON_HOLD"
  | "CUSTOMER_CANCELLED"
  | "CUSTOMER_PAUSED"
  | "EXPIRED"
  | "LINK_EXPIRED"
  | "COMPLETED"
  | "CARD_EXPIRED";

/** Options for {@link makeCashfreeWebhookBody}. */
export interface CashfreeWebhookBodyOptions {
  /** Overrides merged into `data.subscription_details`. */
  readonly subscriptionDetails?: Readonly<Record<string, unknown>>;
  /** Overrides merged into `data.authorization_details`. */
  readonly authorizationDetails?: Readonly<Record<string, unknown>>;
  /** Extra keys merged into `data` (payment fields, failure details, …). */
  readonly extraData?: Readonly<Record<string, unknown>>;
  /** Overrides the top-level `event_time`. */
  readonly eventTime?: string;
}

/** The default `event_time` every webhook fixture carries (a fixed instant). */
export const WEBHOOK_EVENT_TIME = "2026-10-25T10:31:35+05:30";

/**
 * Build a raw Cashfree subscription webhook body, as Cashfree would POST it.
 *
 * @param type - The vendor event `type` (`SUBSCRIPTION_STATUS_CHANGED`, …).
 * @param options - Detail/meta overrides.
 * @returns The raw JSON body string — the exact bytes the signature covers.
 */
export function makeCashfreeWebhookBody(
  type: string,
  options: CashfreeWebhookBodyOptions = {}
): string {
  const data: Record<string, unknown> = {
    subscription_details: {
      cf_subscription_id: "23639356",
      subscription_id: "sub_test_001",
      subscription_status: "ACTIVE",
      subscription_expiry_time: "2055-08-07T10:30:46",
      subscription_first_charge_time: null,
      next_schedule_date: null,
      ...options.subscriptionDetails,
    },
    customer_details: {
      customer_name: "Ada Lovelace",
      customer_email: "ada@example.com",
      customer_phone: "9900000000",
    },
    plan_details: {
      plan_id: "STARTER_MONTHLY_V1",
      plan_name: "Starter Monthly",
      plan_type: "PERIODIC",
      plan_currency: "INR",
    },
    payment_gateway_details: {
      gateway_name: "CASHFREE",
      gateway_subscription_id: "23639356",
    },
    ...options.extraData,
  };

  if (options.authorizationDetails !== undefined) {
    data.authorization_details = options.authorizationDetails;
  }

  return JSON.stringify({
    type,
    event_time: options.eventTime ?? WEBHOOK_EVENT_TIME,
    data,
  });
}

/**
 * Build a Cashfree webhook request's signature headers for a raw body.
 *
 * Uses `node:crypto` exactly as Cashfree documents it — `base64(HMAC-SHA256(
 * timestamp + rawBody))` keyed by the webhook secret — so a test can produce a
 * known-good vector without duplicating the adapter's implementation.
 *
 * @param secret - The webhook secret.
 * @param timestamp - The `x-webhook-timestamp` value (epoch milliseconds).
 * @param rawBody - The exact raw body bytes.
 * @returns The `x-webhook-signature` / `x-webhook-timestamp` header pair.
 */
export function makeCashfreeWebhookHeaders(
  secret: string,
  timestamp: string,
  rawBody: string
): WebhookHeaders {
  return {
    "x-webhook-timestamp": timestamp,
    "x-webhook-signature": signCashfreeWebhook(secret, timestamp, rawBody),
  };
}

/** Sign a raw body the Cashfree way: `base64(HMAC-SHA256(secret, ts + body))`. */
function signCashfreeWebhook(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret)
    .update(timestamp + rawBody)
    .digest("base64");
}
