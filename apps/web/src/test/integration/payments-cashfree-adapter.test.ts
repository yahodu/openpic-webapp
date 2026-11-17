import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { createCashfreeProvider } from "@/server/adapters/cashfree/cashfree-provider";
import { cashfreeCreateSubscriptionRequestSchema } from "@/server/adapters/cashfree/schemas";
import { TransportError, UpstreamContractError } from "@/server/adapters/transport-error";
import { createLogger, memoryTransport, type Logger, type MemoryTransport } from "@/server/logging";
import type { ProviderRef } from "@/server/payments/payment-provider";

import {
  makeCashfreeChargeResponse,
  makeCashfreeCreateSubscriptionResponse,
  makeCashfreeSubscriptionStatusResponse,
  makeCreateMandateInput,
  makePaymentProviderConfig,
} from "../factories/payment";
import { server } from "./setup";

/**
 * I1–I5 — the Cashfree adapter against a mocked Cashfree API (OP-105).
 *
 * The adapter is the only module that speaks Cashfree HTTP, so every test here
 * drives the **port** and asserts what a caller observes: the request that left
 * (body validated by the pinned request schema, the pinned `x-api-version` /
 * `x-client-id` headers), the value returned, and — on drift — the classified
 * failure and its log line. No assertion reaches inside the adapter.
 *
 * I1: `createMandate` POSTs a schema-valid body to the sandbox subscriptions
 *     endpoint, parses the response and returns the opaque `checkoutUrl`, the
 *     vendor refs and the canonical RFC 3339 UTC ms `Z` expiry.
 * I2: a response missing a required field raises `UpstreamContractError` and is
 *     logged at `error` with the vendor and the operation.
 * I3: a 5xx from Cashfree is a **retryable** upstream failure.
 * I4: `fetchStatus` parses the status read into the normalized pair.
 * I5: `chargeOnce` sends the caller's idempotency key in `x-idempotency-key`.
 */

/** The sandbox origin the adapter derives from `env: "sandbox"`. */
const SANDBOX_ORIGIN = "https://sandbox.cashfree.com";

/** The Cashfree subscriptions collection endpoint (v2025-01-01). */
const CREATE_URL = `${SANDBOX_ORIGIN}/pg/subscriptions`;

/** The log event a response that breaks the pinned wire contract emits. */
const UPSTREAM_CONTRACT_EVENT = "payments.upstream_contract_violation";

/** The vendor subscription id every read/charge test addresses. */
const REF_ID = "sub_test_001";

/** The vendor ref every read/charge test addresses. */
const REF: ProviderRef = {
  provider: "cashfree",
  env: "sandbox",
  kind: "subscription",
  id: REF_ID,
};

/** The status-read URL for {@link REF}. */
const STATUS_URL = `${SANDBOX_ORIGIN}/pg/subscriptions/${REF_ID}`;

/** The on-demand charge URL for {@link REF}. */
const CHARGE_URL = `${SANDBOX_ORIGIN}/pg/subscriptions/${REF_ID}/payments`;

/** The Manage Subscription URL for {@link REF} (v2025-01-01, ADR-0460 §1). */
const MANAGE_URL = `${SANDBOX_ORIGIN}/pg/subscriptions/${REF_ID}/manage`;

/** Build a logger wired to a memory sink so a test can inspect emitted entries. */
function installLogger(): { readonly logger: Logger; readonly sink: MemoryTransport } {
  const sink = memoryTransport();
  const logger = createLogger({
    level: "trace",
    transports: [sink],
    service: "openpic-web",
    env: "test",
    version: "test-sha",
    base: { requestId: "req-payments-test" },
  });
  return { logger, sink };
}

describe("Cashfree adapter (MSW)", () => {
  it("I1: createMandate posts a schema-valid body and returns the checkout url the provider issued", async () => {
    // Arrange
    const response = makeCashfreeCreateSubscriptionResponse();
    let apiVersion: unknown = undefined;
    let clientId: unknown = undefined;
    let body: unknown = undefined;
    server.use(
      http.post(CREATE_URL, async ({ request }) => {
        apiVersion = request.headers.get("x-api-version");
        clientId = request.headers.get("x-client-id");
        body = await request.json();
        return HttpResponse.json(response);
      })
    );

    const provider = createCashfreeProvider(makePaymentProviderConfig());
    const input = makeCreateMandateInput();

    // Act
    const result = await provider.createMandate(input);

    // Assert
    expect(apiVersion).toBe("2025-01-01");
    expect(clientId).toBe("test-client-id");

    expect(cashfreeCreateSubscriptionRequestSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      customer_details: {
        customer_name: input.customer.name,
        customer_email: input.customer.email,
      },
      plan_details: { plan_id: input.planRef },
      subscription_meta: { return_url: input.returnUrl },
    });

    expect(result.checkoutUrl).toBe(response.auth_link);
    // The port canonicalizes the vendor expiry to RFC 3339 UTC ms `Z` (§0.13);
    // the fixture default is the vendor-shaped `2026-11-01T10:30:46+05:30`.
    expect(result.expiresAt).toBe("2026-11-01T05:00:46.000Z");
    expect(result.externalRefs).toContainEqual({
      provider: "cashfree",
      env: "sandbox",
      kind: "subscription",
      id: response.subscription_id,
    });
  });

  it("I2: a response missing a required field raises UpstreamContractError and logs the vendor and operation", async () => {
    // Arrange
    const { logger, sink } = installLogger();
    server.use(
      http.post(CREATE_URL, () =>
        HttpResponse.json({ subscription_id: "sub_test_partial", cf_subscription_id: "1" })
      )
    );

    const provider = createCashfreeProvider(makePaymentProviderConfig({ logger }));

    // Act
    const create = provider.createMandate(makeCreateMandateInput());

    // Assert
    await expect(create).rejects.toBeInstanceOf(UpstreamContractError);

    const entry = sink.entries.find((logged) => logged.event === UPSTREAM_CONTRACT_EVENT);
    expect(entry).toBeDefined();
    expect(entry?.level).toBe("error");
    expect(entry?.provider).toBe("cashfree");
    expect(entry?.operation).toBe("createMandate");
  });

  it("I3: a 5xx from Cashfree is a retryable upstream failure", async () => {
    // Arrange
    server.use(http.post(CREATE_URL, () => new HttpResponse(null, { status: 503 })));
    const provider = createCashfreeProvider(makePaymentProviderConfig());

    // Act
    const create = provider.createMandate(makeCreateMandateInput());

    // Assert
    await expect(create).rejects.toBeInstanceOf(TransportError);
    await expect(create).rejects.toMatchObject({ retryable: true, status: 503 });
  });

  it("I4: fetchStatus parses the vendor status into the normalized pair", async () => {
    // Arrange
    server.use(
      http.get(STATUS_URL, () =>
        HttpResponse.json(makeCashfreeSubscriptionStatusResponse({ subscription_status: "ACTIVE" }))
      )
    );
    const provider = createCashfreeProvider(makePaymentProviderConfig());

    // Act
    const status = await provider.fetchStatus(REF);

    // Assert
    expect(status).toEqual({ status: "active", mandateStatus: "active" });
  });

  it("I4b: fetchStatus reports a held mandate as past_due with a paused mandate", async () => {
    // Arrange
    server.use(
      http.get(STATUS_URL, () =>
        HttpResponse.json(
          makeCashfreeSubscriptionStatusResponse({ subscription_status: "ON_HOLD" })
        )
      )
    );
    const provider = createCashfreeProvider(makePaymentProviderConfig());

    // Act
    const status = await provider.fetchStatus(REF);

    // Assert
    expect(status).toEqual({ status: "past_due", mandateStatus: "paused" });
  });

  it("I5: chargeOnce sends the caller's idempotency key", async () => {
    // Arrange
    let idempotencyKey: unknown = undefined;
    server.use(
      http.post(CHARGE_URL, ({ request }) => {
        idempotencyKey = request.headers.get("x-idempotency-key");
        return HttpResponse.json(makeCashfreeChargeResponse());
      })
    );
    const provider = createCashfreeProvider(makePaymentProviderConfig());

    // Act
    await provider.chargeOnce({
      ref: REF,
      amountMinor: 49_900,
      idempotencyKey: "charge-idem-0001",
    });

    // Assert
    expect(idempotencyKey).toBe("charge-idem-0001");
  });

  it("F4: cancelMandate parses the pinned v2025-01-01 Manage response into cancelled/revoked", async () => {
    // Cashfree's Manage Subscription response is its `SubscriptionEntity` — the
    // subscription object, which carries **no** `auth_link` (that field belongs
    // to the Create response alone). Parsing it through the create-response
    // schema would reject a real manage response, so the adapter must pin the
    // manage shape on its own terms.
    const { logger, sink } = installLogger();
    server.use(
      http.post(MANAGE_URL, () =>
        HttpResponse.json(
          makeCashfreeSubscriptionStatusResponse({ subscription_status: "CANCELLED" })
        )
      )
    );
    const provider = createCashfreeProvider(makePaymentProviderConfig({ logger }));

    // Act
    const result = await provider.cancelMandate({ ref: REF });

    // Assert
    expect(result.status).toEqual({ status: "cancelled", mandateStatus: "revoked" });
    expect(sink.entries.filter((entry) => entry.event === UPSTREAM_CONTRACT_EVENT)).toEqual([]);
  });

  it("F4: a manage response carrying only the create shape is refused as vendor drift", async () => {
    // A body with the create-response fields and **none** of the manage/status
    // fields (`subscription_first_charge_time`, `next_schedule_date`) is not a
    // manage response: reading a status off it would trust a shape the vendor
    // never promised for this call, so it is refused explicitly (and logged).
    const { logger, sink } = installLogger();
    server.use(
      http.post(MANAGE_URL, () =>
        HttpResponse.json(
          makeCashfreeCreateSubscriptionResponse({ subscription_status: "CANCELLED" })
        )
      )
    );
    const provider = createCashfreeProvider(makePaymentProviderConfig({ logger }));

    // Act
    const cancel = provider.cancelMandate({ ref: REF });

    // Assert
    await expect(cancel).rejects.toBeInstanceOf(UpstreamContractError);
    const entry = sink.entries.find((logged) => logged.event === UPSTREAM_CONTRACT_EVENT);
    expect(entry?.operation).toBe("cancelMandate");
  });
});
