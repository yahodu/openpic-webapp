import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCashfreeProvider } from "@/server/adapters/cashfree/cashfree-provider";

import {
  TEST_CASHFREE_WEBHOOK_SECRET,
  makeCashfreeWebhookHeaders,
  makeCreateMandateInput,
  makePaymentProviderConfig,
} from "../factories/payment";

/**
 * The in-process (no-network) memory **payment** provider for `APP_ENV=e2e`
 * (OP-105 GREEN §9 "a memory provider for e2e", ADR-0380 out-of-scope list).
 *
 * The provider is the swap-in the e2e lane drives end to end: OP-107 E1 checks
 * out through it and OP-108 E1 synthesises a signed webhook with its signer.
 * Four properties are pinned here, none of which the current tree satisfies
 * (no memory payment provider exists yet):
 *
 *   §1  `createMandate` answers in the *port's* vocabulary only — a
 *       deterministic `checkoutUrl` / `externalRefs` / `expiresAt`, no vendor
 *       field anywhere in the result (contract C1, §11.1).
 *   §2  `chargeOnce` answers a `payment` ref and is idempotent under the
 *       caller's `idempotencyKey` (a retry of one intent is one charge).
 *   §3  `signWebhook` signs a raw body with the **vendor scheme**
 *       (`base64(HMAC-SHA256(secret, timestamp + rawBody))` — the exact scheme
 *       `createCashfreeProvider` verifies) so an e2e can mint a valid signed
 *       webhook, and `verifyWebhook` / `parseWebhook` accept it and answer the
 *       normalized event.
 *
 * The memory provider's wire format is deliberately **our own normalized
 * event** (there is no vendor to emulate): the raw webhook body is
 * `JSON.stringify(<NormalizedProviderEvent with provider "memory">)`. That is
 * what `parseWebhook` validates and what an e2e signs — see ADR-0383.
 */

/** The fixed instant the freshness window and the default timestamp are measured against. */
const NOW = new Date("2026-10-25T10:31:35.000Z");

/** `NOW` as epoch milliseconds — the shape `x-webhook-timestamp` carries. */
const NOW_MS = String(NOW.getTime());

/** The ±300 s replay window the two adapters share (contract §10.1 step 2). */
const WINDOW_MS = 300_000;

/** The subscription ref `chargeOnce` is called with. */
const SUBSCRIPTION_REF = {
  provider: "memory",
  env: "sandbox",
  kind: "subscription",
  id: "mem_sub_1",
} as const;

/**
 * The normalized event an e2e will POST after signing it (contract §10.1.2).
 *
 * Kept as a plain literal — not annotated with the port's event type — so a
 * missing union member is an assertion failure here rather than a compile
 * error that hides the rest of the spec.
 */
function activationEvent(): Record<string, unknown> {
  return {
    provider: "memory",
    kind: "subscription_activated",
    occurredAt: NOW.toISOString(),
    providerEventId: null,
    externalRefs: [SUBSCRIPTION_REF],
    status: "active",
    mandateStatus: "active",
    transaction: null,
  };
}

/** Import a fresh copy of the factory (module state must not leak between cases). */
async function loadProvider(): Promise<typeof import("@/server/adapters/memory-payment-provider")> {
  vi.resetModules();
  return import("@/server/adapters/memory-payment-provider");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("memoryPaymentProvider — createMandate (§1)", () => {
  it("answers a port-shaped result: deterministic checkoutUrl, refs and expiry", async () => {
    // Arrange
    const { memoryPaymentProvider } = await loadProvider();
    const provider = memoryPaymentProvider({ env: "sandbox" });
    const input = makeCreateMandateInput();

    // Act
    const first = await provider.createMandate(input);
    const second = await provider.createMandate(input);

    // Assert
    expect(first).toEqual(second);
    expect(first.checkoutUrl).toMatch(/^https?:\/\//);
    expect(Number.isNaN(Date.parse(first.expiresAt))).toBe(false);
  });

  it("returns exactly the port's fields — never a vendor-named field", async () => {
    // Arrange
    const { memoryPaymentProvider } = await loadProvider();
    const provider = memoryPaymentProvider({ env: "sandbox" });

    // Act
    const result = await provider.createMandate(makeCreateMandateInput());

    // Assert
    expect(Object.keys(result).sort()).toEqual(["checkoutUrl", "expiresAt", "externalRefs"]);
    expect(Object.keys(result.externalRefs[0] ?? {}).sort()).toEqual([
      "env",
      "id",
      "kind",
      "provider",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/cashfree/i);
  });

  it("tags the subscription ref with the memory provider and the configured environment", async () => {
    // Arrange
    const { memoryPaymentProvider } = await loadProvider();
    const provider = memoryPaymentProvider({ env: "sandbox" });

    // Act
    const result = await provider.createMandate(makeCreateMandateInput());

    // Assert
    expect(result.externalRefs).toHaveLength(1);
    expect(result.externalRefs[0]).toMatchObject({
      provider: "memory",
      env: "sandbox",
      kind: "subscription",
    });
    expect(result.externalRefs[0]?.id).not.toBe("");
  });
});

describe("memoryPaymentProvider — chargeOnce (§2)", () => {
  it("answers a payment ref in the port's vocabulary", async () => {
    // Arrange
    const { memoryPaymentProvider } = await loadProvider();
    const provider = memoryPaymentProvider({ env: "sandbox" });

    // Act
    const result = await provider.chargeOnce({
      ref: SUBSCRIPTION_REF,
      amountMinor: 49900,
      idempotencyKey: "idem-key-1",
    });

    // Assert
    expect(result.externalRefs).toHaveLength(1);
    expect(result.externalRefs[0]).toMatchObject({
      provider: "memory",
      env: "sandbox",
      kind: "payment",
    });
    expect(Object.keys(result.externalRefs[0] ?? {}).sort()).toEqual([
      "env",
      "id",
      "kind",
      "provider",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/cashfree/i);
  });

  it("honours the caller's idempotency key: a replay is the same payment", async () => {
    // Arrange
    const { memoryPaymentProvider } = await loadProvider();
    const provider = memoryPaymentProvider({ env: "sandbox" });
    const input = {
      ref: SUBSCRIPTION_REF,
      amountMinor: 49900,
      idempotencyKey: "idem-key-1",
    };

    // Act
    const first = await provider.chargeOnce(input);
    const replay = await provider.chargeOnce(input);
    const distinct = await provider.chargeOnce({ ...input, idempotencyKey: "idem-key-2" });

    // Assert
    expect(replay.externalRefs).toEqual(first.externalRefs);
    expect(distinct.externalRefs[0]?.id).not.toBe(first.externalRefs[0]?.id);
  });
});

describe("memoryPaymentProvider — webhook signer and parser (§3)", () => {
  it("signs over the raw body with the vendor scheme the Cashfree verifier accepts", async () => {
    // Arrange
    const { memoryPaymentProvider } = await loadProvider();
    const provider = memoryPaymentProvider({
      env: "sandbox",
      webhookSecret: TEST_CASHFREE_WEBHOOK_SECRET,
    });
    const cashfree = createCashfreeProvider(
      makePaymentProviderConfig({ webhookSecret: TEST_CASHFREE_WEBHOOK_SECRET })
    );
    const rawBody = JSON.stringify(activationEvent());

    // Act
    const headers = provider.signWebhook(rawBody, NOW_MS);

    // Assert
    expect(headers["x-webhook-timestamp"]).toBe(NOW_MS);
    expect(cashfree.verifyWebhook(rawBody, headers)).toBe(true);
  });

  it("accepts a signature produced by the vendor scheme over its own body", async () => {
    // Arrange
    const { memoryPaymentProvider } = await loadProvider();
    const provider = memoryPaymentProvider({
      env: "sandbox",
      webhookSecret: TEST_CASHFREE_WEBHOOK_SECRET,
    });
    const rawBody = JSON.stringify(activationEvent());
    const vendorHeaders = makeCashfreeWebhookHeaders(TEST_CASHFREE_WEBHOOK_SECRET, NOW_MS, rawBody);

    // Act + Assert
    expect(provider.verifyWebhook(rawBody, vendorHeaders)).toBe(true);
  });

  it("defaults the timestamp to now, inside the replay window, when none is given", async () => {
    // Arrange
    const { memoryPaymentProvider } = await loadProvider();
    const provider = memoryPaymentProvider({
      env: "sandbox",
      webhookSecret: TEST_CASHFREE_WEBHOOK_SECRET,
    });
    const cashfree = createCashfreeProvider(
      makePaymentProviderConfig({ webhookSecret: TEST_CASHFREE_WEBHOOK_SECRET })
    );
    const rawBody = JSON.stringify(activationEvent());

    // Act
    const headers = provider.signWebhook(rawBody);

    // Assert
    expect(Number(headers["x-webhook-timestamp"])).toBe(NOW.getTime());
    expect(cashfree.verifyWebhook(rawBody, headers)).toBe(true);
  });

  it("rejects a tampered body, a missing signature and a stale timestamp", async () => {
    // Arrange
    const { memoryPaymentProvider } = await loadProvider();
    const provider = memoryPaymentProvider({
      env: "sandbox",
      webhookSecret: TEST_CASHFREE_WEBHOOK_SECRET,
    });
    const rawBody = JSON.stringify(activationEvent());
    const headers = provider.signWebhook(rawBody, NOW_MS);
    const stale = provider.signWebhook(rawBody, String(NOW.getTime() - WINDOW_MS - 1));

    // Act + Assert
    expect(provider.verifyWebhook(`${rawBody} `, headers)).toBe(false);
    expect(provider.verifyWebhook(rawBody, {})).toBe(false);
    expect(
      provider.verifyWebhook(rawBody, { "x-webhook-signature": headers["x-webhook-signature"] })
    ).toBe(false);
    expect(provider.verifyWebhook(rawBody, stale)).toBe(false);
  });

  it("parses its own signed body into the normalized event", async () => {
    // Arrange
    const { memoryPaymentProvider } = await loadProvider();
    const provider = memoryPaymentProvider({
      env: "sandbox",
      webhookSecret: TEST_CASHFREE_WEBHOOK_SECRET,
    });
    const event = activationEvent();
    const rawBody = JSON.stringify(event);

    // Act
    const parsed = provider.parseWebhook(rawBody);

    // Assert
    expect(parsed).toEqual(event);
  });

  it("rejects a body that is not JSON, and a body outside the pinned event shape", async () => {
    // Arrange
    const { memoryPaymentProvider } = await loadProvider();
    const provider = memoryPaymentProvider({ env: "sandbox" });

    // Act + Assert
    expect(() => provider.parseWebhook("not json")).toThrow();
    expect(() => provider.parseWebhook(JSON.stringify({ hello: "world" }))).toThrow();
  });

  it("uses a stable default secret: one instance's signature verifies on another", async () => {
    // Arrange
    const { memoryPaymentProvider } = await loadProvider();
    const signer = memoryPaymentProvider({ env: "sandbox" });
    const verifier = memoryPaymentProvider({ env: "sandbox" });
    const rawBody = JSON.stringify(activationEvent());

    // Act
    const headers = signer.signWebhook(rawBody, NOW_MS);

    // Assert
    expect(verifier.verifyWebhook(rawBody, headers)).toBe(true);
  });
});

/**
 * The three port methods ADR-0384 §3 implemented but left unpinned. These are
 * **characterization pins** of shipped behaviour (ADR-0385): the memory
 * provider has no vendor to translate, so `normalizeStatus` /
 * `normalizeFailureCategory` read *our own* vocabulary and fail safe on
 * anything outside it, and `fetchStatus` reports a ref it minted as healthy
 * because the provider holds no state.
 */
describe("memoryPaymentProvider — fetchStatus (§4)", () => {
  it("reports a ref it minted as healthy: an active subscription on an active mandate", async () => {
    // Arrange
    const { memoryPaymentProvider } = await loadProvider();
    const provider = memoryPaymentProvider({ env: "sandbox" });

    // Act
    const status = await provider.fetchStatus(SUBSCRIPTION_REF);

    // Assert
    expect(status).toEqual({ status: "active", mandateStatus: "active" });
  });

  it("holds no state: refs of different kinds and environments answer alike", async () => {
    // Arrange
    const { memoryPaymentProvider } = await loadProvider();
    const sandbox = memoryPaymentProvider({ env: "sandbox" });
    const production = memoryPaymentProvider({ env: "production" });

    // Act
    const statuses = await Promise.all([
      sandbox.fetchStatus(SUBSCRIPTION_REF),
      production.fetchStatus({ ...SUBSCRIPTION_REF, kind: "payment", id: "mem_pay_1" }),
    ]);

    // Assert
    expect(statuses[0]).toEqual(statuses[1]);
    expect(statuses[1]).toEqual({ status: "active", mandateStatus: "active" });
  });
});

describe("memoryPaymentProvider — normalizeStatus (§4)", () => {
  it.each([
    ["incomplete", "incomplete", "pending"],
    ["active", "active", "active"],
    ["past_due", "past_due", "paused"],
    ["downgraded", "downgraded", "revoked"],
    ["cancelled", "cancelled", "revoked"],
    ["expired", "expired", "expired"],
  ])(
    "maps our own %s status onto the %s / %s axis pair",
    async (vendorStatus, status, mandateStatus) => {
      // Arrange
      const { memoryPaymentProvider } = await loadProvider();
      const provider = memoryPaymentProvider({ env: "sandbox" });

      // Act
      const normalized = provider.normalizeStatus(vendorStatus);

      // Assert
      expect(normalized).toEqual({ status, mandateStatus });
    }
  );

  it("defaults a value outside our own status vocabulary to incomplete / pending", async () => {
    // Arrange
    const { memoryPaymentProvider } = await loadProvider();
    const provider = memoryPaymentProvider({ env: "sandbox" });

    // Act + Assert
    expect(provider.normalizeStatus("ON_HOLD")).toEqual({
      status: "incomplete",
      mandateStatus: "pending",
    });
  });
});

describe("memoryPaymentProvider — normalizeFailureCategory (§4)", () => {
  it.each(["insufficient_funds", "mandate_revoked", "auth_required", "technical"])(
    "maps our own %s category onto itself",
    async (category) => {
      // Arrange
      const { memoryPaymentProvider } = await loadProvider();
      const provider = memoryPaymentProvider({ env: "sandbox" });

      // Act + Assert
      expect(provider.normalizeFailureCategory(category)).toBe(category);
    }
  );

  it("defaults a code outside our four categories to technical", async () => {
    // Arrange
    const { memoryPaymentProvider } = await loadProvider();
    const provider = memoryPaymentProvider({ env: "sandbox" });

    // Act + Assert
    expect(provider.normalizeFailureCategory("CARD_DECLINED")).toBe("technical");
  });
});
