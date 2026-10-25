import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import { findForbiddenFields } from "@openpic/contracts";

import { toTransactionDto } from "@/server/services/subscriptions/transactions";

/**
 * Unit contract — the transaction DTO mapper (OP-110 RED, contract §3.4, schema
 * §14.4, §0.15; ADR-0480).
 *
 * `GET /tenants/{tenantId}/billing/transactions` serves the workspace's
 * `billingTransactions` ledger. The stored row is a **§14.4** document, and
 * §14.4's `failure` block is
 * `{code, message, providerCode, category, retryable}` — the vendor's own code
 * included. §3.4 is explicit that this must never reach a client:
 *
 *   "**Clients and dunning copy branch on `category` only** —
 *    `failure.providerCode` is never exposed (schema §14.4)."
 *
 * So the projection is a **never-return boundary**, not a field pick: the
 * served `failure` carries exactly `category`, `message` and `retryable`, and
 * the vendor code is dropped whether it lives under a `providerCode` key or
 * anywhere else the row carries it. {@link toTransactionDto} is the pure
 * function that makes that guarantee, so it is pinnable without Mongo and
 * without HTTP — and the integration suite pins the same rule at the wire.
 *
 * The mapper also owns the two wire-shape conversions §0.13 requires: stored
 * `Date`s become RFC 3339 UTC strings, and the row's `_id` becomes the served
 * `id`.
 */

/** One stored `billingTransactions` row (§14.4) as a case builds it. */
interface StoredRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly subscriptionId: ObjectId;
  readonly kind: string;
  readonly status: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly failure: Record<string, unknown> | null;
  readonly idempotencyKey: string;
  readonly externalRefs: readonly Record<string, unknown>[];
  readonly occurredAt: Date;
  readonly settledAt: Date | null;
  readonly periodCovered: { readonly start: Date; readonly end: Date } | null;
  readonly invoiceNumber: string | null;
  readonly rawPayloadRef: ObjectId | null;
}

/**
 * Build a stored ledger row.
 *
 * @param overrides - Fields to replace on the baseline failed charge.
 * @returns A stored row shaped like the §14.4 document.
 */
function makeStoredRow(overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    _id: new ObjectId(),
    tenantId: new ObjectId().toHexString(),
    subscriptionId: new ObjectId(),
    kind: "charge",
    status: "failed",
    amountMinor: 49_900,
    currency: "INR",
    failure: {
      code: "MANDATE_REVOKED",
      message: "Your bank declined the debit.",
      providerCode: "MANDATE_REVOKED",
      category: "mandate_revoked",
      retryable: false,
    },
    idempotencyKey: "cf:payment_failed:49914527:charge:failed",
    externalRefs: [{ provider: "cashfree", env: "sandbox", kind: "payment", id: "49914527" }],
    occurredAt: new Date("2026-10-01T10:00:00.000Z"),
    settledAt: new Date("2026-10-01T10:00:05.000Z"),
    periodCovered: {
      start: new Date("2026-10-01T00:00:00.000Z"),
      end: new Date("2026-11-01T00:00:00.000Z"),
    },
    invoiceNumber: null,
    rawPayloadRef: new ObjectId(),
    ...overrides,
  };
}

/** The sorted own keys of a JSON object value (§0.15 is a rule about fields). */
function keysOf(value: unknown): string[] {
  return value !== null && typeof value === "object" ? Object.keys(value).sort() : [];
}

describe("toTransactionDto — the §3.4 served shape", () => {
  it("U2: strips providerCode from a failed charge's failure block", () => {
    const stored = makeStoredRow();

    const dto = toTransactionDto(stored);

    // The exact §3.4 key set: nothing else may cross the boundary.
    expect(keysOf(dto.failure)).toEqual(["category", "message", "retryable"]);
    expect(dto.failure).toMatchObject({ category: "mandate_revoked" });
    expect(dto.failure).not.toHaveProperty("providerCode");
    expect(dto.failure).not.toHaveProperty("code");
  });

  it("U2: never returns the vendor's code anywhere in the DTO", () => {
    const stored = makeStoredRow({
      failure: {
        code: "INSUFFICIENT_FUNDS",
        message: "Your bank declined the debit due to insufficient balance.",
        providerCode: "INSUFFICIENT_FUNDS",
        category: "insufficient_funds",
        retryable: true,
      },
    });

    const dto = toTransactionDto(stored);

    expect(JSON.stringify(dto)).not.toContain("INSUFFICIENT_FUNDS");
    // The shared never-return scanner agrees — and the failure block is present,
    // so the scan is not vacuously green.
    expect(dto.failure).not.toBeNull();
    expect(findForbiddenFields(dto, "default")).toEqual([]);
  });

  it("serves the category and a retryable flag the UI can branch on", () => {
    const dto = toTransactionDto(
      makeStoredRow({
        failure: { category: "insufficient_funds", retryable: true },
      })
    );

    expect(dto.failure).toMatchObject({ category: "insufficient_funds", retryable: true });
    expect(typeof dto.failure?.message).toBe("string");
    expect(dto.failure?.message.length).toBeGreaterThan(0);
  });

  it("serves a null failure for a succeeded row", () => {
    const dto = toTransactionDto(makeStoredRow({ status: "succeeded", failure: null }));

    expect(dto.failure).toBeNull();
    expect(findForbiddenFields(dto, "default")).toEqual([]);
  });

  it("serves a null failure when the stored block names no category", () => {
    // A block with no category has nothing for a client to branch on, so it is
    // not served as an untyped object.
    const dto = toTransactionDto(makeStoredRow({ failure: { code: "SOMETHING" } }));

    expect(dto.failure).toBeNull();
  });
});

describe("toTransactionDto — the §0.13 wire conversions", () => {
  it("echoes the row id as the served id", () => {
    const stored = makeStoredRow();

    const dto = toTransactionDto(stored);

    expect(dto.id).toBe(stored._id.toHexString());
  });

  it("converts every stored Date to an RFC 3339 UTC string", () => {
    const dto = toTransactionDto(makeStoredRow());

    expect(dto.occurredAt).toBe("2026-10-01T10:00:00.000Z");
    expect(dto.settledAt).toBe("2026-10-01T10:00:05.000Z");
    expect(dto.periodCovered).toEqual({
      start: "2026-10-01T00:00:00.000Z",
      end: "2026-11-01T00:00:00.000Z",
    });
  });

  it("keeps the nullable fields null rather than inventing values", () => {
    const dto = toTransactionDto(
      makeStoredRow({ settledAt: null, periodCovered: null, invoiceNumber: null, failure: null })
    );

    expect(dto.settledAt).toBeNull();
    expect(dto.periodCovered).toBeNull();
    expect(dto.invoiceNumber).toBeNull();
    expect(dto.failure).toBeNull();
  });

  it("serves exactly the §3.4 keys of one transaction", () => {
    const dto = toTransactionDto(makeStoredRow());

    expect(keysOf(dto)).toEqual([
      "amountMinor",
      "currency",
      "failure",
      "id",
      "invoiceNumber",
      "kind",
      "occurredAt",
      "periodCovered",
      "settledAt",
      "status",
    ]);
    // The stored refs, the idempotency key and the raw-payload pointer are
    // §14.4 storage concerns, never part of the §3.4 served item.
    expect(dto).not.toHaveProperty("externalRefs");
    expect(dto).not.toHaveProperty("idempotencyKey");
    expect(dto).not.toHaveProperty("rawPayloadRef");
    expect(dto).not.toHaveProperty("tenantId");
  });
});
