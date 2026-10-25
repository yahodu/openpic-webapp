/**
 * Cashfree `PaymentProvider` adapter (OP-105, ADR-0380 / ADR-0381).
 *
 * This is the only module that talks to Cashfree: it derives the base URL from
 * the configured environment, sends the pinned headers, validates **both**
 * directions with the schemas in `./schemas`, classifies every failure through
 * the shared `classifyTransportFailure`, and answers exclusively in the
 * provider-neutral vocabulary of `@/server/payments/payment-provider`.
 *
 * Two rules govern what may appear here:
 *
 *  - **Vendor strings stay in the tables below** — the status table, the failure
 *    table, the §10.1.2 event map and the idempotency header. Nothing else in
 *    the adapter (and nothing at all outside it) may name a Cashfree value.
 *  - **Nothing sensitive is logged.** No client secret, no signature and no raw
 *    payload ever reaches a log line; the drift signal an on-call engineer is
 *    paged on is `payments.upstream_contract_violation`, and `payments.call`
 *    carries only the operation, the HTTP status and the duration.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { z } from "zod";

import {
  classifyTransportFailure,
  TransportError,
  UpstreamContractError,
} from "@/server/adapters/transport-error";
import type {
  ChargeOnceInput,
  ChargeOnceResult,
  CreateMandateInput,
  CreateMandateResult,
  FailureCategory,
  FetchStatusResult,
  NormalizedEventKind,
  NormalizedProviderEvent,
  NormalizedStatus,
  NormalizedTransaction,
  PaymentEnvironment,
  PaymentMethodKind,
  PaymentProvider,
  PaymentProviderConfig,
  ProviderRef,
  SubscriptionStatus,
  WebhookHeaders,
} from "@/server/payments/payment-provider";

import {
  cashfreeChargeRequestSchema,
  cashfreeChargeResponseSchema,
  cashfreeCreateSubscriptionRequestSchema,
  cashfreeCreateSubscriptionResponseSchema,
  cashfreeSubscriptionStatusResponseSchema,
  cashfreeWebhookEventSchema,
} from "./schemas";

/** The provider key every ref and event carries (§11.1). */
const PROVIDER = "cashfree" as const;

/** The log event emitted for a response that breaks the pinned wire contract. */
export const UPSTREAM_CONTRACT_VIOLATION_EVENT = "payments.upstream_contract_violation";

/** The log event emitted for every upstream call (operation, status, duration). */
export const PAYMENTS_CALL_EVENT = "payments.call";

/** The Cashfree API origin per environment (ADR-0380 §5). */
const BASE_URLS: Readonly<Record<PaymentEnvironment, string>> = {
  sandbox: "https://sandbox.cashfree.com",
  production: "https://api.cashfree.com",
};

/** The request timeout used when the config does not pin one. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** The replay window a webhook timestamp must fall inside (§10.1 step 2). */
const REPLAY_WINDOW_MS = 300_000;

/**
 * The vendor `subscription_status` → `{status, mandateStatus}` table
 * (ADR-0380 §1). The two axes are split because the schema stores them
 * independently (§14.3).
 */
const STATUS_TABLE: ReadonlyMap<string, NormalizedStatus> = new Map([
  ["INITIALIZED", { status: "incomplete", mandateStatus: "pending" }],
  ["BANK_APPROVAL_PENDING", { status: "incomplete", mandateStatus: "pending" }],
  ["ACTIVE", { status: "active", mandateStatus: "active" }],
  ["ON_HOLD", { status: "past_due", mandateStatus: "paused" }],
  ["PAUSED", { status: "active", mandateStatus: "paused" }],
  ["CUSTOMER_PAUSED", { status: "active", mandateStatus: "paused" }],
  ["CUSTOMER_CANCELLED", { status: "cancelled", mandateStatus: "revoked" }],
  ["CANCELLED", { status: "cancelled", mandateStatus: "revoked" }],
  ["EXPIRED", { status: "expired", mandateStatus: "expired" }],
  ["LINK_EXPIRED", { status: "expired", mandateStatus: "expired" }],
  ["COMPLETED", { status: "expired", mandateStatus: "expired" }],
  ["CARD_EXPIRED", { status: "active", mandateStatus: "expired" }],
]);

/**
 * The vendor failure-code → §14.4 category table (ADR-0380 §2), looked up
 * case-insensitively; anything unrecognised falls back to `technical`.
 */
const FAILURE_CATEGORY_TABLE: ReadonlyMap<string, FailureCategory> = new Map([
  ["INSUFFICIENT_FUNDS", "insufficient_funds"],
  ["MANDATE_REVOKED", "mandate_revoked"],
  ["AUTHENTICATION_FAILED", "auth_required"],
  ["TECHNICAL_ERROR", "technical"],
]);

/**
 * The neutral §14.3 mandate kind → the pinned `authorization_details.payment_methods`
 * preference (F3). The pinned Subscriptions API version (`x-api-version: 2025-01-01`)
 * exposes one payment-method preference per subscription, and each self-serve kind
 * maps onto exactly one vendor value. `invoice` / `manual` are the off-platform
 * Enterprise kinds — they have no vendor mandate — so they are deliberately absent.
 */
const PAYMENT_METHOD_TABLE: ReadonlyMap<PaymentMethodKind, string> = new Map([
  ["mandate_upi", "upi"],
  ["mandate_bank_debit", "enach"],
  ["card", "card"],
]);

/**
 * The vendor event type names of contract §10.1.2.
 *
 * Declared once so the mapping tables are the only place a vendor event string
 * appears — and so a typo is a compile error rather than a silently ignored
 * webhook.
 */
const VENDOR_EVENT = {
  SUBSCRIPTION_STATUS_CHANGED: "SUBSCRIPTION_STATUS_CHANGED",
  SUBSCRIPTION_AUTH_STATUS: "SUBSCRIPTION_AUTH_STATUS",
  SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED: "SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED",
  SUBSCRIPTION_PAYMENT_SUCCESS: "SUBSCRIPTION_PAYMENT_SUCCESS",
  SUBSCRIPTION_PAYMENT_FAILED: "SUBSCRIPTION_PAYMENT_FAILED",
  SUBSCRIPTION_PAYMENT_CANCELLED: "SUBSCRIPTION_PAYMENT_CANCELLED",
  SUBSCRIPTION_REFUND_STATUS: "SUBSCRIPTION_REFUND_STATUS",
} as const;

/**
 * The §10.1.2 vendor-event → normalized-kind rows whose `kind` does not depend
 * on the payload (`SUBSCRIPTION_STATUS_CHANGED` and `SUBSCRIPTION_AUTH_STATUS`
 * are resolved from their details instead).
 */
const VENDOR_EVENT_KINDS: ReadonlyMap<string, NormalizedEventKind> = new Map([
  [VENDOR_EVENT.SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED, "ignored"],
  [VENDOR_EVENT.SUBSCRIPTION_PAYMENT_SUCCESS, "payment_succeeded"],
  [VENDOR_EVENT.SUBSCRIPTION_PAYMENT_FAILED, "payment_failed"],
  [VENDOR_EVENT.SUBSCRIPTION_PAYMENT_CANCELLED, "payment_failed"],
  [VENDOR_EVENT.SUBSCRIPTION_REFUND_STATUS, "refund_processed"],
]);

/** The vendor `authorization_status` that means the mandate was authorized. */
const AUTHORIZATION_SUCCESS = "SUCCESS";

/** The vendor `refund_status` that means the refund settled. */
const REFUND_SUCCESS = "SUCCESS";

/**
 * The webhook `data` block, as the pinned schema types it.
 */
type CashfreeWebhookData = z.infer<typeof cashfreeWebhookEventSchema>["data"];

/**
 * The message a `subscription_status` outside the pinned table carries.
 *
 * Shared by the pure table lookup and the wire path so the thrown error and the
 * drift line always carry the same text (ADR-0380 §6).
 */
function unknownStatusMessage(vendorStatus: string): string {
  return `Unknown Cashfree subscription status: ${vendorStatus}.`;
}

/**
 * Map a raw vendor status onto the `{status, mandateStatus}` pair.
 *
 * An unknown status throws rather than defaulting: extending entitlements on an
 * unrecognised `active`-ish value and revoking them on a `cancelled`-ish one are
 * both worse than a loud, non-retryable contract failure.
 */
function normalizeVendorStatus(vendorStatus: string): NormalizedStatus {
  const normalized = STATUS_TABLE.get(vendorStatus);
  if (normalized === undefined) {
    throw new UpstreamContractError(unknownStatusMessage(vendorStatus));
  }
  return normalized;
}

/** Map a raw vendor failure code onto the four-category taxonomy. */
function normalizeVendorFailure(vendorCode: string): FailureCategory {
  return FAILURE_CATEGORY_TABLE.get(vendorCode.toUpperCase()) ?? "technical";
}

/**
 * The §10.1.2 kind of a `subscription_status` change.
 *
 * Derived from the normalized status rather than from a second vendor table, so
 * the event and the status pair can never disagree (§10.1.2 groups the terminal
 * statuses into one row, and the projection reads `status`, not `kind`).
 */
function kindForStatus(status: SubscriptionStatus): NormalizedEventKind {
  switch (status) {
    case "incomplete":
      return "mandate_pending";
    case "active":
      return "subscription_activated";
    // `downgraded` is our own billing state — no vendor status normalizes onto
    // it — so it is grouped with the terminal rows purely for exhaustiveness.
    case "past_due":
    case "cancelled":
    case "expired":
    case "downgraded":
      return "subscription_cancelled";
  }
}

/** The §10.1.2 kind of a vendor event type. */
function kindForEvent(type: string, data: CashfreeWebhookData): NormalizedEventKind {
  if (type === VENDOR_EVENT.SUBSCRIPTION_STATUS_CHANGED) {
    const vendorStatus = data.subscription_details?.subscription_status;
    if (vendorStatus === undefined) {
      throw new UpstreamContractError(
        "Cashfree status-changed webhook carried no subscription_status."
      );
    }
    return kindForStatus(normalizeVendorStatus(vendorStatus).status);
  }

  if (type === VENDOR_EVENT.SUBSCRIPTION_AUTH_STATUS) {
    return data.authorization_details?.authorization_status === AUTHORIZATION_SUCCESS
      ? "subscription_activated"
      : "mandate_failed";
  }

  const kind = VENDOR_EVENT_KINDS.get(type);
  if (kind === undefined) {
    throw new UpstreamContractError(`Unknown Cashfree webhook event type: ${type}.`);
  }
  return kind;
}

/** The vendor's own event identity for a payment or refund, else `null` (§10.1 step 3). */
function providerEventIdFor(type: string, data: CashfreeWebhookData): string | null {
  switch (type) {
    case VENDOR_EVENT.SUBSCRIPTION_AUTH_STATUS:
    case VENDOR_EVENT.SUBSCRIPTION_PAYMENT_SUCCESS:
    case VENDOR_EVENT.SUBSCRIPTION_PAYMENT_FAILED:
    case VENDOR_EVENT.SUBSCRIPTION_PAYMENT_CANCELLED:
      return data.cf_payment_id ?? null;
    case VENDOR_EVENT.SUBSCRIPTION_REFUND_STATUS:
      return data.cf_refund_id ?? null;
    default:
      return null;
  }
}

/** The vendor's failure reason, or the empty string the taxonomy defaults on. */
function failureReason(data: CashfreeWebhookData): string {
  return data.failure_details?.failure_reason ?? "";
}

/** Convert the vendor's major-unit amount into the integer minor units we store. */
function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

/** Convert our integer minor units back into the vendor's major units. */
function toMajorUnits(amountMinor: number): number {
  return amountMinor / 100;
}

/**
 * Read the amount/currency a transaction reports.
 *
 * The pinned schema marks the payment detail fields optional — a payment-status
 * update does not have to repeat the amount — so an event that omits them
 * projects onto a zero amount rather than failing the whole webhook. A body that
 * fails to parse is dropped with nothing written and nothing to retry, which for
 * a money event is strictly worse than a durable, reconcilable row. The currency
 * falls back to the plan's, which the payload carries.
 */
function transactionAmount(
  data: CashfreeWebhookData,
  amount: number | undefined,
  currency: string | undefined
): { readonly amountMinor: number; readonly currency: string } {
  return {
    amountMinor: amount === undefined ? 0 : toMinorUnits(amount),
    currency: currency ?? data.plan_details?.plan_currency ?? "",
  };
}

/** The §10.1.2 transaction a vendor event projects onto, or `null` for a lifecycle row. */
function transactionFor(type: string, data: CashfreeWebhookData): NormalizedTransaction | null {
  switch (type) {
    case VENDOR_EVENT.SUBSCRIPTION_AUTH_STATUS: {
      const succeeded = data.authorization_details?.authorization_status === AUTHORIZATION_SUCCESS;
      return {
        kind: "authorization",
        status: succeeded ? "succeeded" : "failed",
        ...transactionAmount(data, data.payment_amount, data.payment_currency),
        failureCategory: succeeded ? null : normalizeVendorFailure(failureReason(data)),
      };
    }
    case VENDOR_EVENT.SUBSCRIPTION_PAYMENT_SUCCESS:
    case VENDOR_EVENT.SUBSCRIPTION_PAYMENT_FAILED: {
      const succeeded = type === VENDOR_EVENT.SUBSCRIPTION_PAYMENT_SUCCESS;
      return {
        kind: "charge",
        status: succeeded ? "succeeded" : "failed",
        ...transactionAmount(data, data.payment_amount, data.payment_currency),
        failureCategory: succeeded ? null : normalizeVendorFailure(failureReason(data)),
      };
    }
    case VENDOR_EVENT.SUBSCRIPTION_PAYMENT_CANCELLED:
      // §10.1.2: a payment the customer cancelled is dunned exactly like a
      // failed one, with the `auth_required` category.
      return {
        kind: "charge",
        status: "failed",
        ...transactionAmount(data, data.payment_amount, data.payment_currency),
        failureCategory: "auth_required",
      };
    case VENDOR_EVENT.SUBSCRIPTION_REFUND_STATUS: {
      const succeeded = data.refund_status === REFUND_SUCCESS;
      return {
        kind: "refund",
        status: succeeded ? "succeeded" : "failed",
        ...transactionAmount(data, data.refund_amount, data.refund_currency),
        failureCategory: succeeded ? null : normalizeVendorFailure(failureReason(data)),
      };
    }
    default:
      return null;
  }
}

/** A plain, timing-safe comparison of two signature strings. */
function signaturesMatch(expected: string, presented: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const presentedBytes = Buffer.from(presented);
  return (
    expectedBytes.length === presentedBytes.length && timingSafeEqual(expectedBytes, presentedBytes)
  );
}

/** Build the provider-ref for one vendor object. */
function refFor(env: PaymentEnvironment, kind: ProviderRef["kind"], id: string): ProviderRef {
  return { provider: PROVIDER, env, kind, id };
}

/** A JSON request the adapter issues, paired with the schema its body must satisfy. */
interface CashfreeCall<T> {
  readonly operation: string;
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly schema: z.ZodType<T>;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Build a Cashfree-backed {@link PaymentProvider}.
 *
 * @param config - The environment, credentials, pinned API version, webhook
 *   secret and optional logger/timeout.
 * @returns The adapter.
 */
export function createCashfreeProvider(config: PaymentProviderConfig): PaymentProvider {
  const baseUrl = BASE_URLS[config.env];
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger = config.logger;

  /** Log a completed call's operation, status and duration — never its payload. */
  function logCall(operation: string, status: number, startedAtMs: number): void {
    logger?.info("Cashfree call completed.", {
      event: PAYMENTS_CALL_EVENT,
      provider: PROVIDER,
      operation,
      status,
      durationMs: Date.now() - startedAtMs,
    });
  }

  /** Log a contract break and build the error that carries it. */
  function contractViolation(
    operation: string,
    message: string,
    cause: unknown
  ): UpstreamContractError {
    logger?.error(message, {
      event: UPSTREAM_CONTRACT_VIOLATION_EVENT,
      provider: PROVIDER,
      operation,
    });
    return new UpstreamContractError(message, { cause });
  }

  /**
   * Normalize a vendor `subscription_status` observed on the wire.
   *
   * ADR-0380 §6 pins `payments.upstream_contract_violation` as the signal an
   * on-call engineer is paged on for a response that breaks the pinned
   * contract. The wire schemas are deliberately non-strict on the status
   * string, so an unknown status only fails the table lookup — the one
   * detection path that must still leave a line, naming the surface that
   * observed it. A status inside the table stays silent, so the line remains a
   * drift signal rather than a per-call line.
   *
   * @param operation - The port operation that observed the status
   *   (`fetchStatus` or `parseWebhook`).
   * @param vendorStatus - The raw vendor `subscription_status`.
   * @returns The normalized `{status, mandateStatus}` pair.
   * @throws UpstreamContractError (via {@link contractViolation}) when the
   *   status is outside the pinned table.
   */
  function normalizeWireStatus(operation: string, vendorStatus: string): NormalizedStatus {
    try {
      return normalizeVendorStatus(vendorStatus);
    } catch (error) {
      throw contractViolation(operation, unknownStatusMessage(vendorStatus), error);
    }
  }

  /**
   * Canonicalize a vendor `subscription_expiry_time` onto the one `Timestamp`
   * shape the contract admits — RFC 3339, UTC, millisecond precision, `Z`
   * (§0.13; §3.3 serves `checkout.expiresAt` in exactly that form).
   *
   * Cashfree answers ISO 8601 with an explicit IST `+05:30` offset, second
   * precision and no `Z` (its Create Subscription reference: "We store
   * timestamps in IST"). OP-107 projects `CreateMandateResult.expiresAt`
   * straight onto `checkout.expiresAt`, so the offset is consumed here — the
   * one boundary that already speaks the vendor's dialect — rather than carried
   * onto our wire.
   *
   * A value that cannot become a valid instant is a contract break, never
   * garbage to return: like the schema-drift path in {@link call}, it raises
   * `UpstreamContractError` (and pages on the drift line) instead of handing a
   * caller `Invalid Date` or a raw vendor string.
   *
   * @param operation - The port operation that observed the value.
   * @param vendorExpiry - The raw vendor `subscription_expiry_time`.
   * @returns The RFC 3339 UTC ms `Z` timestamp.
   * @throws UpstreamContractError (via {@link contractViolation}) when the
   *   value is not a parseable instant.
   */
  function normalizeExpiry(operation: string, vendorExpiry: string): string {
    const parsed = new Date(vendorExpiry);
    if (Number.isNaN(parsed.getTime())) {
      throw contractViolation(
        operation,
        "Cashfree returned an unparseable subscription_expiry_time.",
        undefined
      );
    }
    return parsed.toISOString();
  }

  /** Issue one call: pinned headers, a timeout, and a validated response. */
  async function call<T>(request: CashfreeCall<T>): Promise<T> {
    const startedAtMs = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: {
          "x-api-version": config.apiVersion,
          "x-client-id": config.clientId,
          "x-client-secret": config.clientSecret,
          accept: "application/json",
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
          ...request.headers,
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
      });
    } catch (error) {
      logCall(request.operation, 0, startedAtMs);
      throw classifyTransportFailure({ error });
    } finally {
      clearTimeout(timeout);
    }

    logCall(request.operation, response.status, startedAtMs);
    if (!response.ok) {
      throw classifyTransportFailure({ status: response.status });
    }

    const body: unknown = await response.json().catch((error: unknown) => {
      throw contractViolation(
        request.operation,
        "Cashfree returned a non-JSON response body.",
        error
      );
    });

    const parsed = request.schema.safeParse(body);
    if (!parsed.success) {
      throw contractViolation(
        request.operation,
        "Cashfree returned a payload outside the pinned contract.",
        parsed.error
      );
    }
    return parsed.data;
  }

  return {
    async createMandate(input: CreateMandateInput): Promise<CreateMandateResult> {
      const paymentMethod = PAYMENT_METHOD_TABLE.get(input.paymentMethodKind);
      if (paymentMethod === undefined) {
        throw new TransportError(
          `The mandate kind "${input.paymentMethodKind}" has no Cashfree mandate to create.`,
          { retryable: false, code: "invalid_request" }
        );
      }

      const request = cashfreeCreateSubscriptionRequestSchema.safeParse({
        subscription_id: randomUUID(),
        customer_details: {
          customer_name: input.customer.name,
          customer_email: input.customer.email,
          customer_phone: input.customer.phone,
        },
        plan_details: { plan_id: input.planRef },
        subscription_meta: { return_url: input.returnUrl },
        authorization_details: { payment_methods: [paymentMethod] },
      });
      if (!request.success) {
        throw new TransportError(
          "The mandate request did not match the pinned Cashfree contract.",
          { retryable: false, code: "invalid_request", cause: request.error }
        );
      }

      const response = await call({
        operation: "createMandate",
        url: `${baseUrl}/pg/subscriptions`,
        method: "POST",
        schema: cashfreeCreateSubscriptionResponseSchema,
        body: request.data,
      });

      return {
        externalRefs: [refFor(config.env, "subscription", response.subscription_id)],
        checkoutUrl: response.auth_link,
        expiresAt: normalizeExpiry("createMandate", response.subscription_expiry_time),
      };
    },

    async chargeOnce(input: ChargeOnceInput): Promise<ChargeOnceResult> {
      const request = cashfreeChargeRequestSchema.safeParse({
        payment_amount: toMajorUnits(input.amountMinor),
      });
      if (!request.success) {
        throw new TransportError("The charge request did not match the pinned Cashfree contract.", {
          retryable: false,
          code: "invalid_request",
          cause: request.error,
        });
      }

      const response = await call({
        operation: "chargeOnce",
        url: `${baseUrl}/pg/subscriptions/${encodeURIComponent(input.ref.id)}/payments`,
        method: "POST",
        schema: cashfreeChargeResponseSchema,
        body: request.data,
        headers: { "x-idempotency-key": input.idempotencyKey },
      });

      return {
        externalRefs: [refFor(config.env, "payment", response.cf_payment_id)],
      };
    },

    async fetchStatus(ref: ProviderRef): Promise<FetchStatusResult> {
      const response = await call({
        operation: "fetchStatus",
        url: `${baseUrl}/pg/subscriptions/${encodeURIComponent(ref.id)}`,
        method: "GET",
        schema: cashfreeSubscriptionStatusResponseSchema,
      });

      return normalizeWireStatus("fetchStatus", response.subscription_status);
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

      const expected = createHmac("sha256", config.webhookSecret)
        .update(timestamp + rawBody)
        .digest("base64");
      return signaturesMatch(expected, signature);
    },

    parseWebhook(rawBody: string): NormalizedProviderEvent {
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch (error) {
        throw new UpstreamContractError("Cashfree webhook body was not JSON.", { cause: error });
      }

      const parsed = cashfreeWebhookEventSchema.safeParse(payload);
      if (!parsed.success) {
        throw new UpstreamContractError(
          "Cashfree webhook body did not match the pinned contract.",
          { cause: parsed.error }
        );
      }

      const { type, event_time: eventTime, data } = parsed.data;
      const occurredAt = new Date(eventTime);
      if (Number.isNaN(occurredAt.getTime())) {
        throw new UpstreamContractError("Cashfree webhook carried an unparseable event_time.");
      }

      const vendorStatus = data.subscription_details?.subscription_status;
      const normalized =
        vendorStatus === undefined ? null : normalizeWireStatus("parseWebhook", vendorStatus);
      const kind = kindForEvent(type, data);

      const externalRefs: ProviderRef[] = [];
      const subscriptionId = data.subscription_details?.subscription_id;
      if (subscriptionId !== undefined) {
        externalRefs.push(refFor(config.env, "subscription", subscriptionId));
      }
      if (data.cf_payment_id !== undefined) {
        externalRefs.push(refFor(config.env, "payment", data.cf_payment_id));
      }
      if (data.cf_refund_id !== undefined) {
        externalRefs.push(refFor(config.env, "refund", data.cf_refund_id));
      }

      return {
        provider: PROVIDER,
        kind,
        occurredAt: occurredAt.toISOString(),
        providerEventId: providerEventIdFor(type, data),
        externalRefs,
        status: normalized?.status ?? null,
        mandateStatus: normalized?.mandateStatus ?? null,
        transaction: transactionFor(type, data),
      };
    },

    normalizeStatus(vendorStatus: string): NormalizedStatus {
      return normalizeVendorStatus(vendorStatus);
    },

    normalizeFailureCategory(vendorCode: string): FailureCategory {
      return normalizeVendorFailure(vendorCode);
    },
  };
}
