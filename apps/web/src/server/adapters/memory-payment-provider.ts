/**
 * In-process, no-network `PaymentProvider` (OP-105 follow-up, ADR-0383 /
 * ADR-0384).
 *
 * This is the second implementation of the port in
 * `@/server/payments/payment-provider`: the swap-in an e2e drives end to end
 * (OP-107 E1 checks out through it, OP-108 E1 synthesises a signed webhook with
 * its `signWebhook`). Three rules govern what may appear here:
 *
 *  - **No vendor.** There is no PSP to emulate, so every answer is expressed in
 *    the port's own vocabulary and tagged `provider: "memory"` (§11.1: the key
 *    names the registered adapter, never a vendor that was not called).
 *  - **Determinism, not the wall clock.** `createMandate` and `chargeOnce` are
 *    pure functions of their input, so a replayed checkout or charge returns a
 *    byte-identical result (ADR-0383 §1–§2). Nothing here throws on a value the
 *    provider itself minted.
 *  - **The wire format is our normalized event.** Because there is no vendor
 *    payload, the raw webhook body *is* `JSON.stringify(<NormalizedProviderEvent
 *    with provider "memory">)`; `parseWebhook` validates and returns it. The
 *    signature scheme is the exact one `createCashfreeProvider.verifyWebhook`
 *    verifies (ADR-0380 §3), so the two implementations interoperate.
 *
 * No secret is ever logged (CONVENTIONS §5.3); the module emits no log lines at
 * all.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { UpstreamContractError } from "@/server/adapters/transport-error";
import type {
  CancelMandateResult,
  ChargeOnceInput,
  ChargeOnceResult,
  CreateMandateInput,
  CreateMandateResult,
  FailureCategory,
  FetchStatusResult,
  NormalizedProviderEvent,
  NormalizedStatus,
  PaymentEnvironment,
  PaymentProvider,
  ProviderRef,
  SubscriptionStatus,
  WebhookHeaders,
} from "@/server/payments/payment-provider";

/** The provider key every ref and event this adapter mints carries (§11.1). */
const PROVIDER = "memory" as const;

/**
 * The webhook signing secret used when the caller configures none.
 *
 * A deliberate, low-entropy, stable constant — never a credential and never
 * shape-matched by the secret scanner. It has to be *stable* rather than random
 * so two independently constructed instances interoperate: an e2e signs a
 * webhook with one process's provider and the server verifies it with
 * another's (ADR-0383 §3). How the e2e process learns this value is OP-108's
 * wiring problem.
 */
export const MEMORY_PAYMENT_WEBHOOK_SECRET = "memory-payment-webhook-secret";

/** The environment a provider defaults to when its config names none. */
const DEFAULT_ENV: PaymentEnvironment = "sandbox";

/** The replay window a webhook timestamp must fall inside (§10.1 step 2). */
const REPLAY_WINDOW_MS = 300_000;

/**
 * The expiry every in-process checkout link carries.
 *
 * Pinned to a fixed instant rather than `Date.now() + ttl`, because
 * `createMandate` must be a pure function of its input (ADR-0383 §1): a
 * replayed checkout has to return a byte-identical result, so the provider
 * cannot read a clock. The value is deliberately far in the future so no e2e
 * trips an expiry check it did not ask for.
 */
const CHECKOUT_EXPIRES_AT = "2099-12-31T23:59:59.000Z";

/** The status a ref this provider minted is reported as by {@link fetchStatus}. */
const MEMORY_STATUS: NormalizedStatus = { status: "active", mandateStatus: "active" };

/**
 * The status a cancelled mandate is reported as by {@link cancelMandate}.
 *
 * Terminal and deterministic — the in-process adapter holds no state, so a
 * cancel always answers the same pair the Cashfree `CANCELLED` status
 * normalizes to.
 */
const MEMORY_CANCELLED_STATUS: NormalizedStatus = {
  status: "cancelled",
  mandateStatus: "revoked",
};

/**
 * The status pair for each value of *our own* subscription-status vocabulary.
 *
 * The memory provider has no vendor strings to translate, so `normalizeStatus`
 * reads the port's vocabulary directly and derives the mandate axis the way the
 * Cashfree status table does. A `ReadonlyMap` (not an object) keeps a caller
 * value out of a computed object key.
 */
const STATUS_BY_SUBSCRIPTION_STATUS: ReadonlyMap<string, NormalizedStatus> = new Map<
  SubscriptionStatus,
  NormalizedStatus
>([
  ["incomplete", { status: "incomplete", mandateStatus: "pending" }],
  ["active", { status: "active", mandateStatus: "active" }],
  ["past_due", { status: "past_due", mandateStatus: "paused" }],
  ["downgraded", { status: "downgraded", mandateStatus: "revoked" }],
  ["cancelled", { status: "cancelled", mandateStatus: "revoked" }],
  ["expired", { status: "expired", mandateStatus: "expired" }],
]);

/**
 * The identity map over our own failure categories.
 *
 * `normalizeFailureCategory` mirrors `normalizeStatus`: with no vendor taxonomy
 * to translate, a value already in our vocabulary is returned as-is and
 * anything unrecognised degrades to `technical`, the same fail-safe default the
 * Cashfree adapter uses (§14.4).
 */
const FAILURE_CATEGORY_BY_CATEGORY: ReadonlyMap<string, FailureCategory> = new Map([
  ["insufficient_funds", "insufficient_funds"],
  ["mandate_revoked", "mandate_revoked"],
  ["auth_required", "auth_required"],
  ["technical", "technical"],
]);

/** How {@link memoryPaymentProvider} is configured. */
export interface MemoryPaymentProviderConfig {
  /** The environment every ref this provider mints belongs to. Defaults to `sandbox`. */
  readonly env?: PaymentEnvironment;
  /** The webhook signing secret. Defaults to {@link MEMORY_PAYMENT_WEBHOOK_SECRET}. Never logged. */
  readonly webhookSecret?: string;
}

/** The port plus the webhook signer the e2e lane needs (ADR-0383). */
export interface MemoryPaymentProvider extends PaymentProvider {
  /**
   * Sign a raw body the vendor way, so an e2e can mint a webhook the same
   * verifier a production adapter would accept.
   *
   * @param rawBody - The exact bytes the signature covers.
   * @param timestamp - The `x-webhook-timestamp` value (epoch ms); defaults to now.
   * @returns The `x-webhook-timestamp` / `x-webhook-signature` header pair.
   */
  signWebhook(rawBody: string, timestamp?: string): WebhookHeaders;
}

/**
 * A short, stable hex digest of a value.
 *
 * Deterministic by construction, so a replayed intent yields the same id and
 * the provider needs no mutable store (ADR-0383 §1–§2).
 */
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/**
 * The seed a mandate id is derived from.
 *
 * Built as an explicit, fixed-order projection of the input rather than
 * `JSON.stringify(input)`, so the id depends on the mandate's *values* and not
 * on the property order the caller happened to construct them in.
 */
function mandateSeed(input: CreateMandateInput): string {
  return JSON.stringify({
    planRef: input.planRef,
    customer: {
      name: input.customer.name,
      email: input.customer.email,
      phone: input.customer.phone,
    },
    returnUrl: input.returnUrl,
    paymentMethodKind: input.paymentMethodKind,
  });
}

/** Build the provider-ref for one object this adapter owns. */
function refFor(env: PaymentEnvironment, kind: ProviderRef["kind"], id: string): ProviderRef {
  return { provider: PROVIDER, env, kind, id };
}

/** A plain, timing-safe comparison of two signature strings. */
function signaturesMatch(expected: string, presented: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const presentedBytes = Buffer.from(presented);
  return (
    expectedBytes.length === presentedBytes.length && timingSafeEqual(expectedBytes, presentedBytes)
  );
}

/** The `{status, mandateStatus}` pair for our own status vocabulary. */
function normalizeMemoryStatus(status: string): NormalizedStatus {
  return (
    STATUS_BY_SUBSCRIPTION_STATUS.get(status) ?? { status: "incomplete", mandateStatus: "pending" }
  );
}

/**
 * The normalized event shape the memory provider's wire format *is*.
 *
 * Zod strips unknown keys by default, so a body carrying extras still parses
 * down to exactly the port's event — the property
 * `apps/web/src/test/unit/payments-memory-provider.test.ts` pins with
 * `toEqual`.
 */
const memoryEventSchema = z.object({
  provider: z.literal("memory"),
  kind: z.enum([
    "mandate_pending",
    "subscription_activated",
    "subscription_cancelled",
    "mandate_failed",
    "payment_succeeded",
    "payment_failed",
    "refund_processed",
    "ignored",
  ]),
  occurredAt: z.string(),
  providerEventId: z.string().nullable(),
  externalRefs: z.array(
    z.object({
      provider: z.literal("memory"),
      env: z.enum(["sandbox", "production"]),
      kind: z.enum(["subscription", "payment", "refund"]),
      id: z.string(),
    })
  ),
  status: z
    .enum(["incomplete", "active", "past_due", "downgraded", "cancelled", "expired"])
    .nullable(),
  mandateStatus: z.enum(["pending", "active", "paused", "revoked", "expired"]).nullable(),
  transaction: z
    .object({
      kind: z.enum(["authorization", "charge", "refund"]),
      status: z.enum(["succeeded", "failed"]),
      amountMinor: z.number(),
      currency: z.string(),
      failureCategory: z
        .enum(["insufficient_funds", "mandate_revoked", "auth_required", "technical"])
        .nullable(),
    })
    .nullable(),
});

/**
 * Build an in-process `PaymentProvider` for `APP_ENV=e2e`.
 *
 * @param config - The environment refs belong to and the webhook secret; both
 *   default (see {@link MemoryPaymentProviderConfig}).
 * @returns The provider, extended with {@link MemoryPaymentProvider.signWebhook}.
 */
export function memoryPaymentProvider(
  config: MemoryPaymentProviderConfig = {}
): MemoryPaymentProvider {
  const env = config.env ?? DEFAULT_ENV;
  const webhookSecret = config.webhookSecret ?? MEMORY_PAYMENT_WEBHOOK_SECRET;

  return {
    createMandate(input: CreateMandateInput): Promise<CreateMandateResult> {
      const id = `mem_sub_${digest(mandateSeed(input))}`;
      return Promise.resolve({
        externalRefs: [refFor(env, "subscription", id)],
        checkoutUrl: `https://memory.openpic.local/checkout/${id}`,
        expiresAt: CHECKOUT_EXPIRES_AT,
      });
    },

    chargeOnce(input: ChargeOnceInput): Promise<ChargeOnceResult> {
      // The payment id is a function of the caller's idempotency key, so a
      // replay of one intent is observably one charge with no stored state.
      const id = `mem_pay_${digest(input.idempotencyKey)}`;
      return Promise.resolve({ externalRefs: [refFor(env, "payment", id)] });
    },

    cancelMandate(): Promise<CancelMandateResult> {
      // Cancelling a mandate is terminal and deterministic: no vendor is
      // reached, so the answer is always the same `cancelled` + `revoked` pair
      // (`normalizeStatus` of a cancelled subscription).
      return Promise.resolve({ status: MEMORY_CANCELLED_STATUS });
    },

    fetchStatus(): Promise<FetchStatusResult> {
      // The provider holds no state: a ref it minted is reported healthy, which
      // is the path an e2e drives (ADR-0383 §"Open items").
      return Promise.resolve(MEMORY_STATUS);
    },

    verifyWebhook(rawBody: string, headers: WebhookHeaders): boolean {
      const timestamp = headers["x-webhook-timestamp"];
      const signature = headers["x-webhook-signature"];
      if (timestamp === undefined || signature === undefined) {
        return false;
      }

      const timestampMs = Number(timestamp);
      if (!Number.isFinite(timestampMs)) {
        return false;
      }
      if (Math.abs(Date.now() - timestampMs) > REPLAY_WINDOW_MS) {
        return false;
      }

      const expected = createHmac("sha256", webhookSecret)
        .update(timestamp + rawBody)
        .digest("base64");
      return signaturesMatch(expected, signature);
    },

    parseWebhook(rawBody: string): NormalizedProviderEvent {
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch (error) {
        throw new UpstreamContractError("Memory webhook body was not JSON.", { cause: error });
      }

      const parsed = memoryEventSchema.safeParse(payload);
      if (!parsed.success) {
        throw new UpstreamContractError("Memory webhook body did not match the pinned contract.", {
          cause: parsed.error,
        });
      }
      return parsed.data;
    },

    normalizeStatus(vendorStatus: string): NormalizedStatus {
      return normalizeMemoryStatus(vendorStatus);
    },

    normalizeFailureCategory(vendorCode: string): FailureCategory {
      return FAILURE_CATEGORY_BY_CATEGORY.get(vendorCode) ?? "technical";
    },

    signWebhook(rawBody: string, timestamp?: string): WebhookHeaders {
      const value = timestamp ?? String(Date.now());
      const signature = createHmac("sha256", webhookSecret)
        .update(value + rawBody)
        .digest("base64");
      return { "x-webhook-timestamp": value, "x-webhook-signature": signature };
    },
  };
}
