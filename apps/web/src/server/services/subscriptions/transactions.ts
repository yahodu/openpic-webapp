import { z } from "zod";

/**
 * The `billingTransactions` ledger projection (OP-110, contract §3.4, schema
 * §14.4, §0.13; ADR-0480 §2).
 *
 * `GET /tenants/{tenantId}/billing/transactions` serves the workspace's ledger.
 * The stored row is a §14.4 document whose `failure` block carries the vendor's
 * own code; §3.4 is explicit that this must never reach a client — *clients and
 * dunning copy branch on `category` only*. {@link toTransactionDto} is therefore
 * a **never-return boundary**, not a field pick: it **builds** the served object,
 * so a vendor code cannot ride along under a renamed key.
 */

/** The stored `_id` the mapper echoes as the served `id`. */
export interface StoredTransactionId {
  /** The hex representation of the row's `_id`. */
  toHexString(): string;
}

/**
 * The `billingTransactions` fields §3.4 serves.
 *
 * Deliberately the fields the projection reads, not the whole §14.4 document: a
 * stored row carries `externalRefs`, an `idempotencyKey` and a `rawPayloadRef`,
 * none of which may cross the wire.
 */
export interface StoredTransactionRow {
  readonly _id: StoredTransactionId;
  readonly kind: string;
  readonly status: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** The stored §14.4 failure block, or `null`. Never served verbatim. */
  readonly failure: unknown;
  readonly occurredAt: Date;
  readonly settledAt: Date | null;
  readonly periodCovered: { readonly start: Date; readonly end: Date } | null;
  readonly invoiceNumber: string | null;
}

/** A failure as §3.4 serves it: the category, the copy and a retry hint. */
export interface ServedTransactionFailure {
  readonly category: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** A period as §0.13 serves it: RFC 3339 UTC strings. */
export interface ServedPeriodCovered {
  readonly start: string;
  readonly end: string;
}

/** One ledger item as §3.4 serves it. */
export interface ServedTransaction {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly occurredAt: string;
  readonly settledAt: string | null;
  readonly periodCovered: ServedPeriodCovered | null;
  readonly invoiceNumber: string | null;
  readonly failure: ServedTransactionFailure | null;
}

/**
 * The copy served when a stored failure block carries no message.
 *
 * The message is client-facing dunning copy, not contract, so the mapper's only
 * obligation is that it is always a non-empty string a UI can render.
 */
const DEFAULT_FAILURE_MESSAGE = "The payment could not be completed.";

/** The §3.4 served item schema, so the route's response is projected through it. */
export const servedTransactionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  amountMinor: z.number(),
  currency: z.string(),
  occurredAt: z.string(),
  settledAt: z.string().nullable(),
  periodCovered: z.object({ start: z.string(), end: z.string() }).nullable(),
  invoiceNumber: z.string().nullable(),
  failure: z
    .object({ category: z.string(), message: z.string(), retryable: z.boolean() })
    .nullable(),
});

/** The §3.4 `{ data, page }` envelope. */
export const transactionPageSchema = z.object({
  data: z.array(servedTransactionSchema),
  page: z.object({
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    limit: z.number(),
  }),
});

/** A page of served transactions (contract §3.4 / §0.8). */
export type TransactionPage = z.infer<typeof transactionPageSchema>;

/**
 * Project one stored §14.4 failure block onto the §3.4 served block.
 *
 * A block with no `category` has nothing for a client to branch on, so it is
 * served as `null` rather than as an untyped object. `providerCode` and the
 * internal `code` are never read.
 *
 * @param raw - The stored failure block.
 * @returns The served failure, or `null` when there is nothing to branch on.
 */
function toServedFailure(raw: unknown): ServedTransactionFailure | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const block = raw as Record<string, unknown>;
  const category = block.category;
  if (typeof category !== "string" || category.length === 0) {
    return null;
  }
  const message = block.message;
  return {
    category,
    message: typeof message === "string" && message.length > 0 ? message : DEFAULT_FAILURE_MESSAGE,
    retryable: block.retryable === true,
  };
}

/**
 * Build the §3.4 served item from a stored §14.4 row.
 *
 * The served object is **built**, never spread: the vendor code, the stored
 * refs, the idempotency key and the raw-payload pointer are storage concerns
 * that must not cross the wire (§0.15, §3.4).
 *
 * @param row - The stored ledger row.
 * @returns The served transaction, with every `Date` as an RFC 3339 UTC string.
 */
export function toTransactionDto(row: StoredTransactionRow): ServedTransaction {
  return {
    id: row._id.toHexString(),
    kind: row.kind,
    status: row.status,
    amountMinor: row.amountMinor,
    currency: row.currency,
    occurredAt: row.occurredAt.toISOString(),
    settledAt: row.settledAt === null ? null : row.settledAt.toISOString(),
    periodCovered:
      row.periodCovered === null
        ? null
        : {
            start: row.periodCovered.start.toISOString(),
            end: row.periodCovered.end.toISOString(),
          },
    invoiceNumber: row.invoiceNumber,
    failure: toServedFailure(row.failure),
  };
}
