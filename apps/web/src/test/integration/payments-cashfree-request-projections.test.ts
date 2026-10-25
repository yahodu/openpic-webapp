import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { createCashfreeProvider } from "@/server/adapters/cashfree/cashfree-provider";
import * as schemas from "@/server/adapters/cashfree/schemas";
import { TransportError } from "@/server/adapters/transport-error";
import type { PaymentMethodKind, ProviderRef } from "@/server/payments/payment-provider";

import {
  makeCashfreeChargeResponse,
  makeCashfreeCreateSubscriptionResponse,
  makeCreateMandateInput,
  makePaymentProviderConfig,
} from "../factories/payment";
import { server } from "./setup";

/**
 * F3/F5 — the Cashfree adapter's outbound request projections (OP-105).
 *
 * This spec drives the **port** against a mocked Cashfree API and asserts only
 * what a caller or Cashfree observes: the JSON body that left for the wire and
 * the classified failure raised when a projection cannot be built. Nothing here
 * reaches inside the adapter.
 *
 * F3: `createMandate` must project `CreateMandateInput.paymentMethodKind` (the
 *     neutral §14.3 enum) onto the pinned `POST /pg/subscriptions` request
 *     field `authorization_details.payment_methods` — the one payment-method
 *     preference the **pinned** Cashfree Subscriptions API version
 *     (`x-api-version: 2025-01-01`) exposes. The mapping table is pinned below.
 * F5: `chargeOnce` must build its outbound body through the exported
 *     `cashfreeChargeRequestSchema`; a body the schema rejects (a non-positive
 *     `payment_amount`) must raise a non-retryable `invalid_request` **before**
 *     any HTTP request is issued, mirroring `createMandate`.
 */

/** The sandbox origin the adapter derives from `env: "sandbox"`. */
const SANDBOX_ORIGIN = "https://sandbox.cashfree.com";

/** The Cashfree subscriptions collection endpoint (v2025-01-01). */
const CREATE_URL = `${SANDBOX_ORIGIN}/pg/subscriptions`;

/** The vendor subscription every charge test addresses. */
const REF_ID = "sub_test_001";

/** The vendor ref every charge test addresses. */
const REF: ProviderRef = {
  provider: "cashfree",
  env: "sandbox",
  kind: "subscription",
  id: REF_ID,
};

/** The on-demand charge URL for {@link REF}. */
const CHARGE_URL = `${SANDBOX_ORIGIN}/pg/subscriptions/${REF_ID}/payments`;

/**
 * The pinned neutral-kind → vendor payment-method table.
 *
 * Each self-serve §14.3 mandate kind maps onto exactly one value of the pinned
 * `authorization_details.payment_methods` array: UPI Autopay is `upi`, an
 * electronic bank debit (e-NACH) is `enach`, and a card mandate is `card`.
 * `invoice` / `manual` are the off-platform Enterprise kinds — they are created
 * as rows with no vendor mandate, so `createMandate` must refuse them instead
 * of opening a subscription whose payment method it cannot express.
 */
const PAYMENT_METHOD_TABLE: ReadonlyArray<readonly [PaymentMethodKind, string]> = [
  ["mandate_upi", "upi"],
  ["mandate_bank_debit", "enach"],
  ["card", "card"],
];

/** The off-platform kinds that have no vendor mandate to create. */
const OFF_PLATFORM_KINDS: ReadonlyArray<PaymentMethodKind> = ["invoice", "manual"];

/**
 * Answer the create-subscription call while capturing the body that left for
 * the wire.
 *
 * @returns A reader for the captured body, `undefined` until the handler ran.
 */
function captureCreateRequest(): { readonly body: () => Record<string, unknown> | undefined } {
  let captured: Record<string, unknown> | undefined = undefined;
  server.use(
    http.post(CREATE_URL, async ({ request }) => {
      captured = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(makeCashfreeCreateSubscriptionResponse());
    })
  );
  return { body: () => captured };
}

/**
 * Count the create-subscription calls that reach the mocked Cashfree API.
 *
 * @returns A reader for the call count.
 */
function countCreateRequests(): { readonly calls: () => number } {
  let calls = 0;
  server.use(
    http.post(CREATE_URL, () => {
      calls += 1;
      return HttpResponse.json(makeCashfreeCreateSubscriptionResponse());
    })
  );
  return { calls: () => calls };
}

/** The behavioural surface of the pinned outbound-charge request schema. */
interface ChargeRequestSchema {
  readonly safeParse: (value: unknown) => { readonly success: boolean };
}

/**
 * Read `cashfreeChargeRequestSchema` off the schemas module.
 *
 * Read through the namespace so that a missing export fails this spec with a
 * message naming the missing export — rather than a `TypeError` that hides
 * which contract is missing.
 *
 * @returns The exported charge request schema.
 * @throws Error when the module does not export `cashfreeChargeRequestSchema`.
 */
function chargeRequestSchema(): ChargeRequestSchema {
  const exported = (schemas as unknown as Record<string, ChargeRequestSchema | undefined>)
    .cashfreeChargeRequestSchema;
  if (exported === undefined) {
    throw new Error(
      "cashfreeChargeRequestSchema is not exported from @/server/adapters/cashfree/schemas"
    );
  }
  return exported;
}

describe("createMandate projects paymentMethodKind onto the create wire (F3)", () => {
  it.each(PAYMENT_METHOD_TABLE)(
    "maps the neutral kind %s onto the Cashfree payment_methods preference %s",
    async (kind, vendorMethod) => {
      // Arrange
      const capture = captureCreateRequest();
      const provider = createCashfreeProvider(makePaymentProviderConfig());

      // Act
      await provider.createMandate(makeCreateMandateInput({ paymentMethodKind: kind }));

      // Assert
      expect(capture.body()?.authorization_details).toEqual({ payment_methods: [vendorMethod] });
    }
  );

  it("keeps the mapped preference alongside the pinned mandate fields", async () => {
    // Arrange
    const capture = captureCreateRequest();
    const provider = createCashfreeProvider(makePaymentProviderConfig());
    const input = makeCreateMandateInput({ paymentMethodKind: "mandate_bank_debit" });

    // Act
    await provider.createMandate(input);

    // Assert
    expect(capture.body()).toMatchObject({
      authorization_details: { payment_methods: ["enach"] },
      customer_details: {
        customer_name: input.customer.name,
        customer_email: input.customer.email,
      },
      plan_details: { plan_id: input.planRef },
      subscription_meta: { return_url: input.returnUrl },
    });
  });

  it.each(OFF_PLATFORM_KINDS)(
    "refuses to open a vendor mandate for the off-platform kind %s before the wire",
    async (kind) => {
      // Arrange
      const counter = countCreateRequests();
      const provider = createCashfreeProvider(makePaymentProviderConfig());

      // Act
      const create = provider.createMandate(makeCreateMandateInput({ paymentMethodKind: kind }));

      // Assert
      await expect(create).rejects.toBeInstanceOf(TransportError);
      await expect(create).rejects.toMatchObject({ retryable: false, code: "invalid_request" });
      expect(counter.calls()).toBe(0);
    }
  );
});

describe("chargeOnce validates its outbound request with cashfreeChargeRequestSchema (F5)", () => {
  it("exports a schema that accepts the pinned charge body", () => {
    // Act
    const parsed = chargeRequestSchema().safeParse({ payment_amount: 499 });

    // Assert
    expect(parsed.success).toBe(true);
  });

  it.each<readonly [string, Record<string, unknown>]>([
    ["a missing payment_amount", {}],
    ["a zero amount", { payment_amount: 0 }],
    ["a negative amount", { payment_amount: -499 }],
    ["a non-numeric amount", { payment_amount: "499" }],
    ["an unrecognised extra field", { payment_amount: 499, extra: "nope" }],
  ])("rejects %s", (_label, body) => {
    // Act
    const parsed = chargeRequestSchema().safeParse(body);

    // Assert
    expect(parsed.success).toBe(false);
  });

  it("posts the amount in major units, matching the exported request schema", async () => {
    // Arrange
    let captured: Record<string, unknown> | undefined = undefined;
    server.use(
      http.post(CHARGE_URL, async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
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
    expect(captured).toEqual({ payment_amount: 499 });
    expect(chargeRequestSchema().safeParse(captured).success).toBe(true);
  });

  it("refuses a non-positive charge before the wire with a non-retryable error", async () => {
    // Arrange
    let calls = 0;
    server.use(
      http.post(CHARGE_URL, () => {
        calls += 1;
        return HttpResponse.json(makeCashfreeChargeResponse());
      })
    );
    const provider = createCashfreeProvider(makePaymentProviderConfig());

    // Act
    const charge = provider.chargeOnce({
      ref: REF,
      amountMinor: 0,
      idempotencyKey: "charge-idem-0002",
    });

    // Assert
    await expect(charge).rejects.toBeInstanceOf(TransportError);
    await expect(charge).rejects.toMatchObject({ retryable: false, code: "invalid_request" });
    expect(calls).toBe(0);
  });
});
