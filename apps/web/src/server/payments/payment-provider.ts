/**
 * The provider-neutral payment port (OP-105, ADR-0380 / ADR-0381, ADR-0001).
 *
 * Everything the billing lane needs from a payment vendor is expressed here in
 * our own vocabulary: subscription statuses, mandate statuses, failure
 * categories, transaction kinds and the normalized provider event. No vendor
 * status string, wire field name or event type appears in this module, so
 * swapping Cashfree for another PSP is an adapter change and nothing else
 * (`docs/API Contract.md` §10.1.1, §14.3, §14.4).
 *
 * The port takes an explicit {@link PaymentProviderConfig} rather than reading
 * the environment, so an adapter is constructible in a test (or a script)
 * without one; the config-driven composition root is a later card's job.
 */
import type { Logger } from "@/server/logging";

/** Which Cashfree environment a call and a reference belong to (§11.1). */
export type PaymentEnvironment = "sandbox" | "production";

/**
 * The provider key stored on every `externalRefs` entry and normalized event
 * (§11.1). Extend the union when a second PSP is wired.
 *
 * `memory` is the in-process adapter selected for `APP_ENV=e2e` (OP-105
 * follow-up, ADR-0383 §4): the key names the *registered adapter*, so an e2e
 * ref must say `memory` — tagging it `cashfree` would attribute a simulated
 * event to a vendor that was never called.
 */
export type PaymentProviderKey = "cashfree" | "memory";

/** How the customer is billed (§14.3) — generic, never a vendor term. */
export type PaymentMethodKind =
  "mandate_upi" | "mandate_bank_debit" | "card" | "invoice" | "manual";

/** What a {@link ProviderRef} points at (§11.1). */
export type ProviderRefKind = "subscription" | "payment" | "refund";

/** `subscriptions.status` (§14.3) — the lifecycle business rules branch on. */
export type SubscriptionStatus =
  "incomplete" | "active" | "past_due" | "downgraded" | "cancelled" | "expired";

/**
 * `subscriptions.mandateStatus` (§14.3) — an axis **independent** of
 * {@link SubscriptionStatus}: a revoked mandate on a paid-up period is
 * `active` + `revoked`.
 */
export type MandateStatus = "pending" | "active" | "paused" | "revoked" | "expired";

/**
 * `billingTransactions.failure.category` (§14.4) — the only thing dunning copy
 * and retry policy branch on, so a vendor failure code never leaks.
 */
export type FailureCategory =
  "insufficient_funds" | "mandate_revoked" | "auth_required" | "technical";

/** The vendor-neutral transaction taxonomy (§14.4). */
export type TransactionKind = "authorization" | "charge" | "refund";

/** The two-state outcome a normalized transaction reports. */
export type TransactionStatus = "succeeded" | "failed";

/** The normalized provider-event taxonomy of contract §10.1.2. */
export type NormalizedEventKind =
  | "mandate_pending"
  | "subscription_activated"
  | "subscription_cancelled"
  | "mandate_failed"
  | "payment_succeeded"
  | "payment_failed"
  | "refund_processed"
  | "ignored";

/** An opaque, vendor-neutral pointer to something the provider owns (§11.1). */
export interface ProviderRef {
  readonly provider: PaymentProviderKey;
  readonly env: PaymentEnvironment;
  readonly kind: ProviderRefKind;
  readonly id: string;
}

/**
 * The headers of an inbound webhook request, lower-cased.
 *
 * Values stay `string | undefined` because a request may carry no signature or
 * no timestamp at all, and the adapter must answer `false` rather than throw.
 */
export type WebhookHeaders = Readonly<Record<string, string | undefined>>;

/** The `{status, mandateStatus}` pair the schema stores (§14.3). */
export interface NormalizedStatus {
  readonly status: SubscriptionStatus;
  readonly mandateStatus: MandateStatus;
}

/** What {@link PaymentProvider.fetchStatus} answers. */
export type FetchStatusResult = NormalizedStatus;

/** A single money movement, normalized (§14.4). */
export interface NormalizedTransaction {
  readonly kind: TransactionKind;
  readonly status: TransactionStatus;
  /** Always an integer in minor units: ₹499 → `49900`. */
  readonly amountMinor: number;
  readonly currency: string;
  readonly failureCategory: FailureCategory | null;
}

/**
 * A webhook, normalized.
 *
 * `status`/`mandateStatus` are `null` when the payload carries no subscription
 * status to normalize, and `transaction` is `null` for the lifecycle rows of
 * §10.1.2.
 */
export interface NormalizedProviderEvent {
  readonly provider: PaymentProviderKey;
  readonly kind: NormalizedEventKind;
  /** ISO 8601, taken from the vendor `event_time`. */
  readonly occurredAt: string;
  /** The vendor's own event identity, or `null` when it reports none. */
  readonly providerEventId: string | null;
  readonly externalRefs: readonly ProviderRef[];
  readonly status: SubscriptionStatus | null;
  readonly mandateStatus: MandateStatus | null;
  readonly transaction: NormalizedTransaction | null;
}

/** The customer a mandate is created for. */
export interface MandateCustomer {
  readonly name: string;
  readonly email: string;
  readonly phone: string;
}

/** What {@link PaymentProvider.createMandate} needs. */
export interface CreateMandateInput {
  readonly planRef: string;
  readonly customer: MandateCustomer;
  readonly returnUrl: string;
  readonly paymentMethodKind: PaymentMethodKind;
}

/** What {@link PaymentProvider.createMandate} answers. */
export interface CreateMandateResult {
  readonly externalRefs: readonly ProviderRef[];
  /** The hosted authorization URL — opaque to every caller (§3.2). */
  readonly checkoutUrl: string;
  /**
   * When that URL stops working, as RFC 3339 UTC with millisecond precision and
   * a `Z` suffix (contract §0.13) — the one shape §3.3's `checkout.expiresAt`
   * admits. The adapter canonicalizes the vendor's own representation.
   */
  readonly expiresAt: string;
}

/** What {@link PaymentProvider.chargeOnce} needs. */
export interface ChargeOnceInput {
  readonly ref: ProviderRef;
  readonly amountMinor: number;
  /** Ours, stable across retries of the same intent. */
  readonly idempotencyKey: string;
}

/** What {@link PaymentProvider.chargeOnce} answers. */
export interface ChargeOnceResult {
  readonly externalRefs: readonly ProviderRef[];
}

/** What {@link PaymentProvider.cancelMandate} needs (OP-109, ADR-0460 §1). */
export interface CancelMandateInput {
  /** The mandate to release. */
  readonly ref: ProviderRef;
}

/**
 * What {@link PaymentProvider.cancelMandate} answers.
 *
 * The cancelled mandate's normalized status — for a recurring mandate that is
 * `cancelled` + `revoked` — so a caller can store it on the subscription row
 * without re-reading the vendor.
 */
export interface CancelMandateResult {
  readonly status: NormalizedStatus;
}

/**
 * How an adapter is configured.
 *
 * An explicit object, so no adapter reads `process.env` and a test can build one
 * without an environment (`@/test/factories/payment`).
 */
export interface PaymentProviderConfig {
  readonly env: PaymentEnvironment;
  readonly clientId: string;
  readonly clientSecret: string;
  /** The pinned vendor API version, sent as `x-api-version`. */
  readonly apiVersion: string;
  /** The webhook signing secret. Never logged. */
  readonly webhookSecret: string;
  readonly logger?: Logger;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/**
 * The payment port.
 *
 * `normalizeStatus` / `normalizeFailureCategory` are the two "vendor strings
 * never leave the adapter" functions of §10.1.1; `verifyWebhook` /
 * `parseWebhook` are steps 1–2 and 3 of the §10.1 handler order.
 *
 * `cancelMandate` is the one shared cancel seam: OP-109's upgrade releases the
 * old mandate with it and OP-110's `POST /billing/cancel` cancels the live one,
 * so its name and wire shape are pinned once (ADR-0460 §1).
 */
export interface PaymentProvider {
  /** Create a recurring mandate and return the hosted authorization URL. */
  createMandate(input: CreateMandateInput): Promise<CreateMandateResult>;
  /** Charge an existing mandate on demand, keyed by the caller's idempotency key. */
  chargeOnce(input: ChargeOnceInput): Promise<ChargeOnceResult>;
  /** Cancel a recurring mandate, answering its normalized (terminal) status. */
  cancelMandate(input: CancelMandateInput): Promise<CancelMandateResult>;
  /** Read the mandate's live status, normalized. */
  fetchStatus(ref: ProviderRef): Promise<FetchStatusResult>;
  /** Verify a webhook signature over the raw body, within the replay window. */
  verifyWebhook(rawBody: string, headers: WebhookHeaders): boolean;
  /** Parse a raw webhook body into the normalized event. */
  parseWebhook(rawBody: string): NormalizedProviderEvent;
  /** Split a vendor subscription status onto the `{status, mandateStatus}` axes. */
  normalizeStatus(vendorStatus: string): NormalizedStatus;
  /** Map a vendor failure code onto the four-category taxonomy. */
  normalizeFailureCategory(vendorCode: string): FailureCategory;
}
