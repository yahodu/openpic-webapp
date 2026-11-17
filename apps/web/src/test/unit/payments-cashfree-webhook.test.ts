import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCashfreeProvider } from "@/server/adapters/cashfree/cashfree-provider";
import { UpstreamContractError } from "@/server/adapters/transport-error";
import type { NormalizedEventKind } from "@/server/payments/payment-provider";

import {
  TEST_CASHFREE_WEBHOOK_SECRET,
  WEBHOOK_EVENT_TIME,
  makeCashfreeWebhookBody,
  makeCashfreeWebhookHeaders,
  makePaymentProviderConfig,
} from "../factories/payment";

/**
 * U3/U4 — the Cashfree webhook boundary, pinned at the port (OP-105).
 *
 * U3: `verifyWebhook(rawBody, headers)` is the contract §10.1 step 1 gate. It
 *     verifies `base64(HMAC-SHA256(secret, x-webhook-timestamp + rawBody))`
 *     (Cashfree's documented scheme) **over the raw bytes**, and it bounds the
 *     timestamp to the ±300 s replay window of step 2. A body re-serialised
 *     after signing must fail.
 * U4: `parseWebhook(rawBody)` maps each vendor event type onto the normalized
 *     taxonomy of contract §10.1.2 — **the only place vendor event names may
 *     appear** — and projects the payload onto the state OP-108 writes.
 */

const provider = createCashfreeProvider(makePaymentProviderConfig());

/** The fixed instant the freshness window is measured against. */
const NOW = new Date("2026-10-25T10:31:35.000Z");

/** `NOW` as epoch milliseconds — the shape `x-webhook-timestamp` carries. */
const NOW_MS = String(NOW.getTime());

/** The ±300 s replay window (contract §10.1 step 2). */
const WINDOW_MS = 300_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Cashfree verifyWebhook", () => {
  it("accepts a body signed with the webhook secret over the raw bytes", () => {
    // Arrange
    const body = makeCashfreeWebhookBody("SUBSCRIPTION_STATUS_CHANGED");
    const headers = makeCashfreeWebhookHeaders(TEST_CASHFREE_WEBHOOK_SECRET, NOW_MS, body);

    // Act + Assert
    expect(provider.verifyWebhook(body, headers)).toBe(true);
  });

  it("rejects a body that was modified after it was signed", () => {
    // Arrange
    const body = makeCashfreeWebhookBody("SUBSCRIPTION_STATUS_CHANGED");
    const headers = makeCashfreeWebhookHeaders(TEST_CASHFREE_WEBHOOK_SECRET, NOW_MS, body);
    const tampered = body.replace('"sub_test_001"', '"sub_test_999"');

    // Act + Assert
    expect(tampered).not.toBe(body);
    expect(provider.verifyWebhook(tampered, headers)).toBe(false);
  });

  it("rejects a body signed with a different secret", () => {
    // Arrange
    const body = makeCashfreeWebhookBody("SUBSCRIPTION_STATUS_CHANGED");
    const headers = makeCashfreeWebhookHeaders("some-other-secret", NOW_MS, body);

    // Act + Assert
    expect(provider.verifyWebhook(body, headers)).toBe(false);
  });

  it("rejects a timestamp older than the ±300 s replay window", () => {
    // Arrange
    const body = makeCashfreeWebhookBody("SUBSCRIPTION_STATUS_CHANGED");
    const stale = String(NOW.getTime() - WINDOW_MS - 300_000);
    const headers = makeCashfreeWebhookHeaders(TEST_CASHFREE_WEBHOOK_SECRET, stale, body);

    // Act + Assert
    expect(provider.verifyWebhook(body, headers)).toBe(false);
  });

  it("rejects a timestamp beyond the ±300 s window in the future", () => {
    // Arrange
    const body = makeCashfreeWebhookBody("SUBSCRIPTION_STATUS_CHANGED");
    const future = String(NOW.getTime() + WINDOW_MS + 300_000);
    const headers = makeCashfreeWebhookHeaders(TEST_CASHFREE_WEBHOOK_SECRET, future, body);

    // Act + Assert
    expect(provider.verifyWebhook(body, headers)).toBe(false);
  });

  it("accepts a fresh timestamp inside the window", () => {
    // Arrange
    const body = makeCashfreeWebhookBody("SUBSCRIPTION_STATUS_CHANGED");
    const recent = String(NOW.getTime() - 60_000);
    const headers = makeCashfreeWebhookHeaders(TEST_CASHFREE_WEBHOOK_SECRET, recent, body);

    // Act + Assert
    expect(provider.verifyWebhook(body, headers)).toBe(true);
  });

  it("rejects a request that carries no signature header", () => {
    // Arrange
    const body = makeCashfreeWebhookBody("SUBSCRIPTION_STATUS_CHANGED");

    // Act + Assert
    expect(provider.verifyWebhook(body, { "x-webhook-timestamp": NOW_MS })).toBe(false);
  });
});

/** One row of the vendor-event → normalized-kind table (contract §10.1.2). */
type KindCase = readonly [vendorType: string, body: string, expected: NormalizedEventKind];

/** A status-changed body carrying one vendor `subscription_status`. */
function statusChanged(status: string): string {
  return makeCashfreeWebhookBody("SUBSCRIPTION_STATUS_CHANGED", {
    subscriptionDetails: { subscription_status: status },
  });
}

/** An authorisation-completion body (success or failure). */
function authStatus(status: string, extraData: Readonly<Record<string, unknown>> = {}): string {
  return makeCashfreeWebhookBody("SUBSCRIPTION_AUTH_STATUS", {
    subscriptionDetails: { subscription_status: "ACTIVE" },
    authorizationDetails: { authorization_status: status },
    extraData: {
      payment_id: "ab-auth-001",
      cf_payment_id: "49988825",
      payment_type: "AUTH",
      payment_amount: 2,
      payment_currency: "INR",
      ...extraData,
    },
  });
}

/**
 * Every row of contract §10.1.2, paired with the raw vendor body that triggers
 * it and the normalized `kind` the port must report.
 */
const KIND_TABLE: ReadonlyArray<KindCase> = [
  [
    "SUBSCRIPTION_STATUS_CHANGED → BANK_APPROVAL_PENDING",
    statusChanged("BANK_APPROVAL_PENDING"),
    "mandate_pending",
  ],
  ["SUBSCRIPTION_STATUS_CHANGED → ACTIVE", statusChanged("ACTIVE"), "subscription_activated"],
  [
    "SUBSCRIPTION_STATUS_CHANGED → CUSTOMER_CANCELLED",
    statusChanged("CUSTOMER_CANCELLED"),
    "subscription_cancelled",
  ],
  ["SUBSCRIPTION_STATUS_CHANGED → ON_HOLD", statusChanged("ON_HOLD"), "subscription_cancelled"],
  ["SUBSCRIPTION_STATUS_CHANGED → EXPIRED", statusChanged("EXPIRED"), "subscription_cancelled"],
  ["SUBSCRIPTION_AUTH_STATUS (success)", authStatus("SUCCESS"), "subscription_activated"],
  ["SUBSCRIPTION_AUTH_STATUS (failure)", authStatus("FAILED"), "mandate_failed"],
  [
    "SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED",
    makeCashfreeWebhookBody("SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED"),
    "ignored",
  ],
  [
    "SUBSCRIPTION_PAYMENT_SUCCESS",
    makeCashfreeWebhookBody("SUBSCRIPTION_PAYMENT_SUCCESS", {
      extraData: {
        payment_id: "ab-charge-001",
        cf_payment_id: "49914526",
        payment_type: "CHARGE",
        payment_status: "SUCCESS",
        payment_amount: 499,
        payment_currency: "INR",
      },
    }),
    "payment_succeeded",
  ],
  [
    "SUBSCRIPTION_PAYMENT_FAILED",
    makeCashfreeWebhookBody("SUBSCRIPTION_PAYMENT_FAILED", {
      extraData: {
        payment_id: "ab-charge-002",
        cf_payment_id: "49914527",
        payment_type: "CHARGE",
        payment_status: "FAILED",
        payment_amount: 499,
        payment_currency: "INR",
        failure_details: { failure_reason: "MANDATE_REVOKED" },
      },
    }),
    "payment_failed",
  ],
  [
    "SUBSCRIPTION_PAYMENT_CANCELLED",
    makeCashfreeWebhookBody("SUBSCRIPTION_PAYMENT_CANCELLED", {
      extraData: {
        payment_id: "ab-charge-003",
        cf_payment_id: "49914528",
        payment_type: "CHARGE",
        payment_status: "CANCELLED",
        payment_amount: 499,
        payment_currency: "INR",
      },
    }),
    "payment_failed",
  ],
  [
    "SUBSCRIPTION_REFUND_STATUS",
    makeCashfreeWebhookBody("SUBSCRIPTION_REFUND_STATUS", {
      extraData: {
        refund_id: "refund-001",
        cf_refund_id: "700001",
        refund_status: "SUCCESS",
        refund_amount: 499,
        refund_currency: "INR",
        payment_id: "ab-charge-001",
        cf_payment_id: "49914526",
      },
    }),
    "refund_processed",
  ],
];

describe("Cashfree parseWebhook — the vendor event mapping", () => {
  it.each(KIND_TABLE)("maps %s to the normalized %s event", (_label, body, expected) => {
    // Act
    const event = provider.parseWebhook(body);

    // Assert
    expect(event.kind).toBe(expected);
  });
});

describe("Cashfree parseWebhook — the normalized projection", () => {
  it("carries the normalized status pair for a status-changed event", () => {
    // Act
    const event = provider.parseWebhook(statusChanged("BANK_APPROVAL_PENDING"));

    // Assert
    expect(event.status).toBe("incomplete");
    expect(event.mandateStatus).toBe("pending");
    expect(event.transaction).toBeNull();
  });

  it("carries a succeeded authorization transaction for an auth-success event", () => {
    // Act
    const event = provider.parseWebhook(authStatus("SUCCESS"));

    // Assert
    expect(event.status).toBe("active");
    expect(event.mandateStatus).toBe("active");
    expect(event.transaction).toEqual({
      kind: "authorization",
      status: "succeeded",
      amountMinor: 200,
      currency: "INR",
      failureCategory: null,
    });
  });

  it("carries a failed authorization transaction with the mapped failure category", () => {
    // Arrange
    const body = makeCashfreeWebhookBody("SUBSCRIPTION_AUTH_STATUS", {
      subscriptionDetails: { subscription_status: "INITIALIZED" },
      authorizationDetails: { authorization_status: "FAILED" },
      extraData: {
        cf_payment_id: "49988826",
        payment_type: "AUTH",
        payment_status: "FAILED",
        payment_amount: 2,
        payment_currency: "INR",
        failure_details: { failure_reason: "INSUFFICIENT_FUNDS" },
      },
    });

    // Act
    const event = provider.parseWebhook(body);

    // Assert
    expect(event.kind).toBe("mandate_failed");
    expect(event.status).toBe("incomplete");
    expect(event.transaction).toEqual({
      kind: "authorization",
      status: "failed",
      amountMinor: 200,
      currency: "INR",
      failureCategory: "insufficient_funds",
    });
  });

  it("carries a charge transaction whose amount is reported in minor units", () => {
    // Arrange
    const body = makeCashfreeWebhookBody("SUBSCRIPTION_PAYMENT_SUCCESS", {
      extraData: {
        cf_payment_id: "49914526",
        payment_type: "CHARGE",
        payment_status: "SUCCESS",
        payment_amount: 499.5,
        payment_currency: "INR",
      },
    });

    // Act
    const event = provider.parseWebhook(body);

    // Assert
    expect(event.transaction?.kind).toBe("charge");
    expect(event.transaction?.status).toBe("succeeded");
    expect(event.transaction?.amountMinor).toBe(49_950);
  });

  it("treats a cancelled payment as a failed charge with the auth_required category", () => {
    // Arrange
    const body = makeCashfreeWebhookBody("SUBSCRIPTION_PAYMENT_CANCELLED", {
      extraData: {
        cf_payment_id: "49914528",
        payment_type: "CHARGE",
        payment_status: "CANCELLED",
        payment_amount: 499,
        payment_currency: "INR",
      },
    });

    // Act
    const event = provider.parseWebhook(body);

    // Assert
    expect(event.kind).toBe("payment_failed");
    expect(event.transaction?.kind).toBe("charge");
    expect(event.transaction?.status).toBe("failed");
    expect(event.transaction?.failureCategory).toBe("auth_required");
  });

  it("carries a refund transaction for a refund-status event", () => {
    // Arrange
    const body = makeCashfreeWebhookBody("SUBSCRIPTION_REFUND_STATUS", {
      extraData: {
        cf_refund_id: "700001",
        refund_status: "SUCCESS",
        refund_amount: 499,
        refund_currency: "INR",
        cf_payment_id: "49914526",
      },
    });

    // Act
    const event = provider.parseWebhook(body);

    // Assert
    expect(event.transaction?.kind).toBe("refund");
    expect(event.transaction?.status).toBe("succeeded");
    expect(event.transaction?.amountMinor).toBe(49_900);
  });

  it("reads occurredAt from the vendor event_time", () => {
    // Act
    const event = provider.parseWebhook(statusChanged("ACTIVE"));

    // Assert
    expect(event.occurredAt).toBe(new Date(WEBHOOK_EVENT_TIME).toISOString());
  });

  it("carries the vendor payment id as the provider event id for a payment event", () => {
    // Arrange
    const body = makeCashfreeWebhookBody("SUBSCRIPTION_PAYMENT_SUCCESS", {
      extraData: { cf_payment_id: "49914526", payment_status: "SUCCESS" },
    });

    // Act
    const event = provider.parseWebhook(body);

    // Assert
    expect(event.providerEventId).toBe("49914526");
  });

  it("carries no provider event id for a status-changed event", () => {
    // Act
    const event = provider.parseWebhook(statusChanged("ACTIVE"));

    // Assert
    expect(event.providerEventId).toBeNull();
  });

  it("always reports its own provider key", () => {
    // Act
    const event = provider.parseWebhook(statusChanged("ACTIVE"));

    // Assert
    expect(event.provider).toBe("cashfree");
  });
});

describe("Cashfree parseWebhook — contract drift", () => {
  it("throws UpstreamContractError for an unknown vendor event type", () => {
    // Arrange
    const body = makeCashfreeWebhookBody("SUBSCRIPTION_SOMETHING_NEW");

    // Act
    const parse = (): unknown => provider.parseWebhook(body);

    // Assert
    expect(parse).toThrow(UpstreamContractError);
  });

  it("throws UpstreamContractError when the payload carries no event_time", () => {
    // Arrange
    const body = JSON.stringify({ type: "SUBSCRIPTION_PAYMENT_SUCCESS", data: {} });

    // Act
    const parse = (): unknown => provider.parseWebhook(body);

    // Assert
    expect(parse).toThrow(UpstreamContractError);
  });

  it("throws UpstreamContractError when the body is not JSON", () => {
    // Act
    const parse = (): unknown => provider.parseWebhook("<html>gateway timeout</html>");

    // Assert
    expect(parse).toThrow(UpstreamContractError);
  });
});
