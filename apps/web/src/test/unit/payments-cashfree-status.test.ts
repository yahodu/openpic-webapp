import { describe, expect, it } from "vitest";

import { createCashfreeProvider } from "@/server/adapters/cashfree/cashfree-provider";
import { UpstreamContractError } from "@/server/adapters/transport-error";
import type { FailureCategory, NormalizedStatus } from "@/server/payments/payment-provider";

import { makePaymentProviderConfig } from "../factories/payment";

/**
 * U1/U2 — the Cashfree status vocabulary, pinned at the port boundary (OP-105).
 *
 * These are the two "vendor strings never leave the adapter" functions
 * (`docs/API Contract.md` §10.1.1, `docs/Diagrams.md` §15 S1): `normalizeStatus`
 * turns a Cashfree `subscription_status` into the `{status, mandateStatus}`
 * pair schema §14.3 stores, and `normalizeFailureCategory` turns a Cashfree
 * failure code into the four-category taxonomy business rules branch on.
 *
 * ## The table is the contract of record
 *
 * §10.1.2 fixes only the rows it names (`BANK_APPROVAL_PENDING` → mandate
 * `pending`; `ACTIVE` → status `active` + mandate `active`; `CUSTOMER_CANCELLED`
 * → status `cancelled`; `ON_HOLD` → mandate `paused`; `EXPIRED` → mandate
 * `expired`) and the design doc fixes the value sets (schema §14.3). Every
 * other row is fixed here, in the executable contract, and recorded in
 * ADR-0380 — the same way ADR-0340 fixed the entitlement contract its card left
 * open. The GREEN implements this table; it does not re-decide it.
 *
 * `mandateStatus` is a *separate* axis from `status` (§14.3: "a revoked mandate
 * on a paid-up period is `active` + `revoked`"), so the function returns both.
 */

const provider = createCashfreeProvider(makePaymentProviderConfig());

/** One row of the vendor-status table. */
type StatusCase = readonly [vendor: string, expected: NormalizedStatus];

/**
 * Every Cashfree subscription status (`INITIALIZED`, `BANK_APPROVAL_PENDING`,
 * `ACTIVE`, `ON_HOLD`, `PAUSED`, `CUSTOMER_PAUSED`, `CUSTOMER_CANCELLED`,
 * `CANCELLED`, `EXPIRED`, `LINK_EXPIRED`, `COMPLETED`, `CARD_EXPIRED`) and the
 * normalized pair it maps to.
 */
const STATUS_TABLE: ReadonlyArray<StatusCase> = [
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
];

/** One row of the vendor-failure-code table. */
type CategoryCase = readonly [code: string, expected: FailureCategory];

/** The vendor codes that reach each of the four §14.4 categories. */
const CATEGORY_TABLE: ReadonlyArray<CategoryCase> = [
  ["INSUFFICIENT_FUNDS", "insufficient_funds"],
  ["MANDATE_REVOKED", "mandate_revoked"],
  ["AUTHENTICATION_FAILED", "auth_required"],
  ["TECHNICAL_ERROR", "technical"],
];

describe("Cashfree normalizeStatus", () => {
  it.each(STATUS_TABLE)("maps the vendor status %s to the normalized pair", (vendor, expected) => {
    // Act
    const normalized = provider.normalizeStatus(vendor);

    // Assert
    expect(normalized).toEqual(expected);
  });

  it("throws a non-retryable UpstreamContractError for a status outside the pinned table", () => {
    // Act
    const normalize = (): NormalizedStatus => provider.normalizeStatus("SOME_NEW_VENDOR_STATUS");

    // Assert
    expect(normalize).toThrow(UpstreamContractError);
    expect(normalize).toThrow(/SOME_NEW_VENDOR_STATUS/);
  });
});

describe("Cashfree normalizeFailureCategory", () => {
  it.each(CATEGORY_TABLE)("maps the vendor code %s onto the %s category", (code, expected) => {
    // Act
    const category = provider.normalizeFailureCategory(code);

    // Assert
    expect(category).toBe(expected);
  });

  it("matches the vendor code case-insensitively", () => {
    // Act + Assert
    expect(provider.normalizeFailureCategory("insufficient_funds")).toBe("insufficient_funds");
  });

  it("falls back to the technical category for an unrecognized vendor code", () => {
    // Act + Assert
    expect(provider.normalizeFailureCategory("WHO_KNOWS_WHAT_THIS_IS")).toBe("technical");
  });

  it("falls back to the technical category for an empty vendor code", () => {
    // Act + Assert
    expect(provider.normalizeFailureCategory("")).toBe("technical");
  });
});
