import { ObjectId, type Db, type Document } from "mongodb";
import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { buildCursorPage, type Cursor } from "@/server/http/cursor";
import { appError } from "@/server/http/errors";
import { formatEntitlementDisplay } from "@/server/plans/plan-display";
import {
  enforcementSchema,
  entitlementScopeSchema,
  planSchema,
  resetPeriodSchema,
} from "@/server/plans/plans";
import { platformRepo, tenantRepo } from "@/server/repos";

import { effectiveLimit, isGrantActive, periodKey } from "./policy";
import {
  blockReasonFor,
  blockReasonSchema,
  resetsAtFor,
  subscriptionStatusSchema,
  type EntitlementQuota,
} from "./read-model";
import type { EntitlementSpec } from "./types";

/**
 * The entitlements and usage read view (OP-104, contract §3.5, schema
 * §14.2/§14.3; ADR-0360).
 *
 * {@link readEntitlementsView} answers the §3.5 single-resource body — the
 * advisory view that powers every quota bar and disabled button — and
 * {@link readUsageCounters} answers the raw `usageCounters` rows for support
 * and reconciliation. Both are **reads**: the advisory view performs no write
 * (§0.14; the server re-checks at write time).
 *
 * The body is projected through the schemas declared here, so a field the route
 * forgets to serve — or one it must never serve — is a validation failure
 * rather than a silent wire detail.
 */

/** An RFC 3339 UTC timestamp; the route serializes one for every instant. */
const isoDateTimeSchema = z.string();

/** One served grant on a metered entitlement row (contract §3.5). */
const servedGrantSchema = z.object({
  delta: z.number().int(),
  source: z.string(),
  validUntil: isoDateTimeSchema.nullable(),
});

/** One entitlement row of the §3.5 body. */
export const entitlementStateSchema = z.object({
  key: z.string(),
  limit: z.number().int().nullable(),
  effectiveLimit: z.number().int().nullable(),
  used: z.number().int().optional(),
  remaining: z.number().int().nullable().optional(),
  enabled: z.boolean().optional(),
  periodKey: z.string().optional(),
  resetPeriod: resetPeriodSchema,
  resetsAt: isoDateTimeSchema.nullable(),
  scope: entitlementScopeSchema,
  enforcement: enforcementSchema,
  unlimited: z.boolean(),
  grants: z.array(servedGrantSchema).optional(),
  thresholdCrossed: z.union([z.literal(80), z.literal(95), z.literal(100), z.null()]),
  display: z.string(),
});

/** The §3.5 single-resource body (contract §0.5 — returned bare). */
export const entitlementsSchema = z.object({
  activePlanKey: z.string(),
  subscribedPlanKey: z.string(),
  subscriptionStatus: subscriptionStatusSchema,
  blockReason: blockReasonSchema,
  entitlements: z.array(entitlementStateSchema),
  computedAt: isoDateTimeSchema,
});

/** One raw `usageCounters` row, as `/usage` serves it (never the `_id`). */
const servedUsageRowSchema = z.object({
  entitlementKey: z.string(),
  periodKey: z.string(),
  value: z.number(),
  updatedAt: isoDateTimeSchema.optional(),
});

/** The `page` object of a `{ data, page }` collection envelope (contract §0.8). */
const usagePageSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  limit: z.number().int(),
});

/** The `{ data, page }` collection envelope of the raw usage rows (contract §0.5, §0.8). */
export const usageCountersSchema = z.object({
  data: z.array(servedUsageRowSchema),
  page: usagePageSchema,
});

/** A served entitlement row. */
export type EntitlementState = z.infer<typeof entitlementStateSchema>;

/** The served §3.5 body. */
export type EntitlementsBody = z.infer<typeof entitlementsSchema>;

/** The served raw usage list. */
export type UsageCountersBody = z.infer<typeof usageCountersSchema>;

/**
 * The stored fields of a live `subscriptions` row this view reads.
 *
 * Schema §14.3 marks both plan keys **required**, so neither carries a default:
 * a partial (corrupt) row fails the parse and the route answers `500
 * internal_error` instead of laundering the tenant into the free tier.
 */
const storedSubscriptionSchema = z.object({
  activePlanKey: z.string(),
  subscribedPlanKey: z.string(),
  status: subscriptionStatusSchema,
});

/** The stored fields of an `entitlementGrants` row. */
const storedGrantSchema = z.object({
  entitlementKey: z.string(),
  delta: z.number(),
  overrideLimit: z.number().nullable(),
  validFrom: z.date(),
  validUntil: z.date().nullable(),
  source: z.object({ kind: z.string() }),
});

/** The stored fields of a `usageCounters` row. */
const storedCounterSchema = z.object({
  _id: z.instanceof(ObjectId),
  entitlementKey: z.string(),
  periodKey: z.string(),
  value: z.number(),
  updatedAt: z.date().optional(),
});

/**
 * Project one stored entitlement spec onto a §3.5 row.
 *
 * `used`/`remaining`/`periodKey` are served only for a `tenant`-scoped row: the
 * counter is tenant-scoped and an `event`/`attendee` row's per-event
 * consumption belongs to `GET /events/{eventId}` (§4.1). `grants[]` carries
 * exactly the active grants counted into `effectiveLimit`.
 *
 * @param key - The entitlement key.
 * @param spec - The stored entitlement spec.
 * @param grants - Every grant row for this key.
 * @param counters - Every usage counter row for this tenant.
 * @param now - The instant the read reasons about.
 * @returns The served row.
 */
function toEntitlementState(
  key: string,
  spec: EntitlementSpec,
  grants: readonly z.infer<typeof storedGrantSchema>[],
  counters: readonly z.infer<typeof storedCounterSchema>[],
  now: Date
): EntitlementState {
  const keyGrants = grants.filter((grant) => grant.entitlementKey === key);
  const active = keyGrants.filter((grant) => isGrantActive(grant, now));
  const effective = effectiveLimit(spec, keyGrants, now);
  const resetsAt = resetsAtFor(spec.resetPeriod, now);

  const row: EntitlementState = {
    key,
    limit: spec.limit,
    effectiveLimit: effective,
    resetPeriod: spec.resetPeriod,
    resetsAt: resetsAt === null ? null : resetsAt.toISOString(),
    scope: spec.scope,
    enforcement: spec.enforcement,
    unlimited: effective === null,
    ...(spec.enabled === undefined ? {} : { enabled: spec.enabled }),
    ...(active.length === 0
      ? {}
      : {
          grants: active.map((grant) => ({
            delta: grant.delta,
            source: grant.source.kind,
            validUntil: grant.validUntil === null ? null : grant.validUntil.toISOString(),
          })),
        }),
    // The threshold latch (`usage.*.threshold`) is not modelled yet, so the
    // field is served correctly empty (ADR-0360; the latch story owns it).
    thresholdCrossed: null,
    display: formatEntitlementDisplay(key, spec),
  };

  if (spec.scope !== "tenant") {
    return row;
  }

  const period = periodKey(spec.resetPeriod, now);
  const used = counters.find(
    (counter) => counter.entitlementKey === key && counter.periodKey === period
  )?.value;
  const current = used ?? 0;
  return {
    ...row,
    periodKey: period,
    used: current,
    remaining: effective === null ? null : effective - current,
  };
}

/**
 * Read the §3.5 advisory entitlements view for one workspace.
 *
 * The live subscription (defaulting to `free` with status `none` when the
 * tenant has no document, schema §14.3) picks the plan; the plan, its grants
 * and this tenant's counters are then read **in parallel**. Nothing is written
 * (§0.14).
 *
 * @param db - The database handle.
 * @param tenantId - The workspace id (string, as OP-103 established).
 * @param now - The instant the view reasons about.
 * @returns The §3.5 body.
 */
export async function readEntitlementsView(
  db: Db,
  tenantId: string,
  now: Date
): Promise<EntitlementsBody> {
  const subscriptionRow = await tenantRepo(tenantId, db)
    .collection(COLLECTIONS.subscriptions)
    .findOne({ status: { $ne: "cancelled" } });
  const subscription =
    subscriptionRow === null ? null : storedSubscriptionSchema.parse(subscriptionRow);

  const planKey = subscription === null ? "free" : subscription.activePlanKey;

  const [planRow, grantRows, counterRows] = await Promise.all([
    platformRepo(db).collection(COLLECTIONS.plans).findOne({ key: planKey }),
    tenantRepo(tenantId, db).collection(COLLECTIONS.entitlementGrants).find().toArray(),
    tenantRepo(tenantId, db).collection(COLLECTIONS.usageCounters).find().toArray(),
  ]);

  const specs = planRow === null ? {} : planSchema.parse(planRow).entitlements;
  const grants = grantRows.map((row) => storedGrantSchema.parse(row));
  const counters = counterRows.map((row) => storedCounterSchema.parse(row));

  const entitlements = Object.entries(specs).map(([key, spec]) =>
    toEntitlementState(key, spec, grants, counters, now)
  );

  const subscriptionStatus = subscription === null ? "none" : subscription.status;
  const quotas: EntitlementQuota[] = entitlements.map((row) => ({
    enforcement: row.enforcement,
    effectiveLimit: row.effectiveLimit,
    ...(row.used === undefined ? {} : { used: row.used }),
  }));
  return {
    activePlanKey: planKey,
    subscribedPlanKey: subscription === null ? "free" : subscription.subscribedPlanKey,
    subscriptionStatus,
    blockReason: blockReasonFor(subscriptionStatus, quotas),
    entitlements,
    computedAt: now.toISOString(),
  };
}

/** A 24-hex ObjectId, the only accepted `_id` tiebreaker in a cursor. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/**
 * The keyset filter that follows `cursor` on a `periodKey`-desc list (§0.8).
 *
 * The compound `(periodKey, _id)` key keeps rows that share a period from being
 * skipped or repeated at a page boundary.
 *
 * @param cursor - The decoded cursor, or `null` on the first page.
 * @returns The filter fragment, or the empty object.
 * @throws {AppError} `invalid_cursor` (400) when the `_id` half is not a hex id.
 */
function cursorFilterFor(cursor: Cursor | null): Document {
  if (cursor === null) {
    return {};
  }
  if (!OBJECT_ID_HEX.test(cursor.i)) {
    throw appError("invalid_cursor");
  }
  return {
    $or: [
      { periodKey: { $lt: cursor.c } },
      { periodKey: cursor.c, _id: { $lt: new ObjectId(cursor.i) } },
    ],
  };
}

/**
 * Read one cursor page of the raw `usageCounters` rows for one workspace.
 *
 * Answers the §0.5 collection envelope as `{ data, page }` (§0.8): the rows are
 * sorted `periodKey` descending then `_id` descending, at most `limit` per page,
 * and the page's `nextCursor` follows the same compound key. The driver's `_id`
 * is never served.
 *
 * @param db - The database handle.
 * @param tenantId - The workspace id (string).
 * @param query - The bounded page query: the `periodKey` filter (or `null`) and
 *   the `limit`/`cursor` `parsePageQuery` produced.
 * @returns The §0.5 `{ data, page }` envelope.
 * @throws {AppError} `invalid_cursor` (400) when the cursor's `_id` is malformed.
 */
export async function readUsageCounters(
  db: Db,
  tenantId: string,
  query: {
    readonly periodKey: string | null;
    readonly limit: number;
    readonly cursor: Cursor | null;
  }
): Promise<UsageCountersBody> {
  const filter: Document = {
    ...(query.periodKey === null ? {} : { periodKey: query.periodKey }),
    ...cursorFilterFor(query.cursor),
  };
  const rows = await tenantRepo(tenantId, db)
    .collection(COLLECTIONS.usageCounters)
    .find(filter)
    .sort({ periodKey: -1, _id: -1 })
    .limit(query.limit + 1)
    .toArray();

  const page = buildCursorPage(rows, query.limit, (row) => {
    const counter = storedCounterSchema.parse(row);
    return { c: counter.periodKey, i: counter._id.toHexString() };
  });

  return {
    data: page.items.map((row) => {
      const counter = storedCounterSchema.parse(row);
      return {
        entitlementKey: counter.entitlementKey,
        periodKey: counter.periodKey,
        value: counter.value,
        ...(counter.updatedAt === undefined ? {} : { updatedAt: counter.updatedAt.toISOString() }),
      };
    }),
    page: { nextCursor: page.nextCursor, hasMore: page.hasMore, limit: query.limit },
  };
}
