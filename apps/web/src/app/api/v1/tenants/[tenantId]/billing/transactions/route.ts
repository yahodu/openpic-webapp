import { ObjectId, type Document } from "mongodb";
import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { buildCursorPage, parsePageQuery, type Cursor } from "@/server/http/cursor";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { tenantRepo } from "@/server/repos";
import {
  toTransactionDto,
  transactionPageSchema,
  type ServedTransaction,
  type StoredTransactionRow,
} from "@/server/services/subscriptions";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `GET /api/v1/tenants/{tenantId}/billing/transactions` — the billing ledger
 * (OP-110, contract §3.4, schema §14.4, §0.8, §0.15; ADR-0480 §2).
 *
 * Owner **or** admin (§3.4), newest first, paginated with the shared cursor
 * envelope. Every row is projected through {@link toTransactionDto}, which is
 * the never-return boundary: the vendor's own failure code never reaches the
 * wire, whatever key a stored row happens to carry it under.
 *
 * The §3.4 role gate lives **in the handler** — a plain `member` is `403` while
 * a non-member is the tenant stage's uniform `404` — which is the read-side
 * shape §3.4 documents.
 */

/** A 24-hex ObjectId, the only accepted `_id` tiebreaker in a cursor. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/** The stored `billingTransactions` fields this route reads (§14.4). */
const ledgerRowSchema = z.object({
  _id: z.instanceof(ObjectId),
  kind: z.string(),
  status: z.string(),
  amountMinor: z.number(),
  currency: z.string(),
  failure: z.unknown(),
  occurredAt: z.date(),
  settledAt: z.date().nullish(),
  periodCovered: z.object({ start: z.date(), end: z.date() }).nullish(),
  invoiceNumber: z.string().nullish(),
});

/**
 * Revive a cursor's sort value.
 *
 * @param raw - The ISO instant the cursor carried.
 * @returns The instant.
 * @throws {AppError} `invalid_cursor` (400) when the value is not a date.
 */
function cursorInstant(raw: string): Date {
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw appError("invalid_cursor");
  }
  return at;
}

/**
 * Revive a cursor's `_id` tiebreaker.
 *
 * @param raw - The hex id the cursor carried.
 * @returns The id.
 * @throws {AppError} `invalid_cursor` (400) when the value is not a hex id.
 */
function cursorId(raw: string): ObjectId {
  if (!OBJECT_ID_HEX.test(raw)) {
    throw appError("invalid_cursor");
  }
  return new ObjectId(raw);
}

/**
 * The keyset filter that follows `cursor` on an `occurredAt`-desc list (§0.8).
 *
 * The compound `(occurredAt, _id)` key keeps rows that share an instant from
 * being skipped, and both halves are revived to their stored BSON types — a
 * string `_id` would compare unequal to every ObjectId.
 *
 * @param cursor - The decoded cursor, or `null` on the first page.
 * @returns The filter fragment, or the empty object.
 */
function cursorFilterFor(cursor: Cursor | null): Document {
  if (cursor === null) {
    return {};
  }
  const at = cursorInstant(cursor.c);
  return {
    $or: [{ occurredAt: { $lt: at } }, { occurredAt: at, _id: { $lt: cursorId(cursor.i) } }],
  };
}

/** Project one stored row onto the mapper's input shape. */
function toStoredRow(row: z.infer<typeof ledgerRowSchema>): StoredTransactionRow {
  return {
    _id: row._id,
    kind: row.kind,
    status: row.status,
    amountMinor: row.amountMinor,
    currency: row.currency,
    failure: row.failure ?? null,
    occurredAt: row.occurredAt,
    settledAt: row.settledAt ?? null,
    periodCovered: row.periodCovered ?? null,
    invoiceNumber: row.invoiceNumber ?? null,
  };
}

export const GET = defineRoute({
  route: "/api/v1/tenants/:tenantId/billing/transactions",
  response: transactionPageSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    if (scope.role !== "owner" && scope.role !== "admin") {
      throw appError("forbidden");
    }

    const params = new URL(ctx.request.url).searchParams;
    const { limit, cursor } = parsePageQuery(params);
    const kind = params.get("kind");
    const filter: Document = {
      ...(kind === null ? {} : { kind }),
      ...cursorFilterFor(cursor),
    };

    const rows = await tenantRepo(scope.tenantId.toHexString(), getDb())
      .collection(COLLECTIONS.billingTransactions)
      .find(filter)
      .sort({ occurredAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();

    const page = buildCursorPage(rows, limit, (row): Cursor => {
      const stored = ledgerRowSchema.parse(row);
      return { c: stored.occurredAt.toISOString(), i: stored._id.toHexString() };
    });
    const data: ServedTransaction[] = page.items.map((row) =>
      toTransactionDto(toStoredRow(ledgerRowSchema.parse(row)))
    );

    return {
      status: 200,
      body: { data, page: { nextCursor: page.nextCursor, hasMore: page.hasMore, limit } },
    };
  },
});
