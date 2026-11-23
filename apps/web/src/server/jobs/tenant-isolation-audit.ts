import type { Db } from "mongodb";
import { ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { TENANT_SCOPED_COLLECTIONS } from "@/server/db/indexes";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { defineCronJob, type CronJob, type CronRunOutcome } from "@/server/jobs/cron-job";
import { platformRepo } from "@/server/repos";
import type { Clock } from "@/server/runtime/clock";
import type { Logger } from "@/server/logging";

import { dateKeyInTimeZone, ROLLUP_TIME_ZONE } from "./analytics-rollup";

/**
 * `tenant-isolation-audit` — the nightly tenancy sweep (OP-139, contract §10.2,
 * §0.4; schema §21 P3; ADR-0918, ADR-0919).
 *
 * A leaked row is the failure mode a tenancy bug has and no request path
 * reports it, so this job reads every tenant-scoped collection after the fact:
 * a document whose `tenantId` does not resolve to a live tenant, or whose
 * `tenantId` disagrees with its parent event's, raises one `admin.abuse.flagged`
 * per `(reason, collection)` per IST day. It never repairs a row — which side is
 * wrong is a human decision — and it reports **counts only**: no id, no field
 * value, no document content leaves the boundary (§0.15).
 */

/** The finding raised for a `tenantId` that resolves to no live tenant. */
const UNRESOLVED_TENANT = "unresolved_tenant";

/** The finding raised for a `tenantId` that disagrees with its parent event's. */
const TENANT_MISMATCH = "tenant_mismatch";

/**
 * The finding raised for a tenant-scoped row that carries no usable `tenantId`.
 * Exclusive of the two above: such a row has no tenant of its own to resolve.
 */
const MISSING_TENANT = "missing_tenant";

/**
 * The platform-scope alerting address, as `webhook-projection-sweep.ts:46`
 * already uses it: a `missing_tenant` row has no tenant to address its event to.
 */
const PLATFORM_TENANT_ID = "platform";

/** One stored tenant-scoped row, as far as the audit reads it. */
interface ScopedRow {
  readonly tenantId?: unknown;
  readonly eventId?: unknown;
}

/** One collection's finding: its count and the id the alert is addressed to. */
interface Finding {
  readonly tenantId: string;
  count: number;
}

/** Options for one audit invocation. */
interface AuditRunOptions {
  /** The database handle. */
  readonly db: Db;
  /** The clock the run's day key comes from. */
  readonly clock: Clock;
  /** The logger the counts-only summary is written through. */
  readonly logger: Logger;
}

/** The hex form of an id-shaped value, or `null`. */
function hexOf(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  return null;
}

/** Ids per parent lookup; bounds one `$in` well below MongoDB's 16 MB limit. */
const PARENT_LOOKUP_BATCH_SIZE = 1_000;

/**
 * Sweep every tenant-scoped collection and raise the day's findings.
 *
 * @param options - The database, clock and logger.
 * @returns The §10.2 run outcome.
 */
export async function tenantIsolationAudit(options: AuditRunOptions): Promise<CronRunOutcome> {
  const { db, clock, logger } = options;
  const dateKey = dateKeyInTimeZone(clock.now(), ROLLUP_TIME_ZONE);

  const liveTenants = new Set<string>();
  for (const tenant of await platformRepo(db)
    .collection(COLLECTIONS.tenants)
    .find({}, { projection: { _id: 1 } })
    .toArray()) {
    const tenantId = hexOf(tenant._id);
    if (tenantId !== null) {
      liveTenants.add(tenantId);
    }
  }

  let scanned = 0;
  const scannedByCollection = new Map<string, number>();
  const unresolved = new Map<string, Finding>();
  const mismatched = new Map<string, Finding>();
  const missing = new Map<string, Finding>();

  for (const collection of TENANT_SCOPED_COLLECTIONS) {
    const projected = { projection: { tenantId: 1, eventId: 1 } };
    const eventIds = new Set<string>();
    let collectionScanned = 0;
    // A cursor, not `toArray()`: a whole collection must not be loaded in memory.
    for await (const row of platformRepo(db)
      .collection(collection)
      .find({}, projected) as unknown as AsyncIterable<ScopedRow>) {
      collectionScanned += 1;
      const tenantId = hexOf(row.tenantId);
      if (tenantId === null) {
        const finding = missing.get(collection) ?? { tenantId: PLATFORM_TENANT_ID, count: 0 };
        finding.count += 1;
        missing.set(collection, finding);
        continue;
      }
      if (!liveTenants.has(tenantId)) {
        const finding = unresolved.get(collection) ?? { tenantId, count: 0 };
        finding.count += 1;
        unresolved.set(collection, finding);
        continue;
      }
      const eventId = hexOf(row.eventId);
      if (eventId !== null) {
        eventIds.add(eventId);
      }
    }

    scannedByCollection.set(collection, collectionScanned);
    scanned += collectionScanned;

    // A12: a document whose parent event is gone is not flagged — there is no
    // parent to disagree with, and that is the retention lane's business.
    if (eventIds.size === 0) {
      continue;
    }
    const parentTenant = new Map<string, string>();
    const parentIds = [...eventIds].map((id) => new ObjectId(id));
    // One `$in` per 1,000 parents: an unbounded list hits MongoDB's 16 MB cap.
    for (let start = 0; start < parentIds.length; start += PARENT_LOOKUP_BATCH_SIZE) {
      for await (const parent of platformRepo(db)
        .collection(COLLECTIONS.events)
        .find(
          { _id: { $in: parentIds.slice(start, start + PARENT_LOOKUP_BATCH_SIZE) } },
          { projection: { tenantId: 1 } }
        ) as unknown as AsyncIterable<{ readonly _id?: unknown; readonly tenantId?: unknown }>) {
        const parentId = hexOf(parent._id);
        const parentTenantId = hexOf(parent.tenantId);
        if (parentId !== null && parentTenantId !== null) {
          parentTenant.set(parentId, parentTenantId);
        }
      }
    }
    for await (const row of platformRepo(db)
      .collection(collection)
      .find({}, projected) as unknown as AsyncIterable<ScopedRow>) {
      const tenantId = hexOf(row.tenantId);
      const eventId = hexOf(row.eventId);
      if (tenantId === null || eventId === null || !liveTenants.has(tenantId)) {
        continue;
      }
      const owner = parentTenant.get(eventId);
      // A11: the reasons are exclusive — a row whose own tenant resolves is
      // reported once, under `tenant_mismatch`, never again as unresolved.
      if (owner === undefined || owner === tenantId) {
        continue;
      }
      const finding = mismatched.get(collection) ?? { tenantId, count: 0 };
      finding.count += 1;
      mismatched.set(collection, finding);
    }
  }

  const findings = [
    ...[...missing].map(([collection, finding]) => ({
      reason: MISSING_TENANT,
      collection,
      ...finding,
    })),
    ...[...unresolved].map(([collection, finding]) => ({
      reason: UNRESOLVED_TENANT,
      collection,
      ...finding,
    })),
    ...[...mismatched].map(([collection, finding]) => ({
      reason: TENANT_MISMATCH,
      collection,
      ...finding,
    })),
  ];

  let affected = 0;
  for (const finding of findings) {
    const result = await emitDomainEvent(
      {
        eventKey: "admin.abuse.flagged",
        tenantId: finding.tenantId,
        actorRef: { kind: "system", id: "tenant-isolation-audit" },
        subjectRef: { kind: "collection", id: finding.collection },
        // Counts only: the payload key set is exactly these three.
        payload: { reason: finding.reason, collection: finding.collection, count: finding.count },
        dedupeKey: `tenant.isolation:${finding.reason}:${finding.collection}:${dateKey}`,
      },
      { db, clock }
    );
    affected += result.deduped ? 0 : 1;
  }

  logger.info("tenant isolation audit completed", {
    event: "tenant.isolation.audit",
    scanned,
    findings: findings.length,
    collections: Object.fromEntries(scannedByCollection),
  });

  return { scanned, affected, skipped: 0, errors: 0, hasMore: false };
}

/** `tenant-isolation-audit` — nightly (contract §10.2; ADR-0918). */
export const tenantIsolationAuditJob: CronJob = defineCronJob({
  name: "tenant-isolation-audit",
  defaultLimit: 1,
  maxLimit: 1,
  run: ({ clock, logger }) => tenantIsolationAudit({ db: getDb(), clock, logger }),
});
