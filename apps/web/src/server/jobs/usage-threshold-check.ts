import { getDb } from "@/server/db/mongo";
import { COLLECTIONS } from "@/server/db/collections";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { defineCronJob, type CronJob, type CronRunOutcome } from "@/server/jobs/cron-job";
import { platformRepo } from "@/server/repos";
import { checkEntitlement, type EntitlementVerdict } from "@/server/services/entitlements";

import type { SweepJobRunOptions } from "./run-options";
import { usageThresholdsToNotify } from "./sweep-decisions";

/**
 * `usage-threshold-check` — the hourly allowance warning sweep (OP-136,
 * contract §10.2 `usage-threshold-check`, §9.10; ADR-0849 §3).
 *
 * The latch is the counter row's own `thresholdsNotified`, and a counter row's
 * identity is `{ tenantId, entitlementKey, periodKey }`, so a new period is a new
 * row with an empty latch: a delete-then-re-cross inside one period notifies
 * nothing, and the same crossing in the next period notifies once.
 */

/** The two metered keys that have a warning type, and the type each emits. */
const THRESHOLD_EVENT_KEYS: Readonly<Record<string, string>> = {
  "storage.bytes": "usage.storage.threshold",
  "events.active": "usage.events.threshold",
};

/** The stored fields of a `usageCounters` row this job reads. */
interface UsageCounterRow {
  readonly _id: unknown;
  readonly tenantId: string;
  readonly entitlementKey: string;
  readonly periodKey: string;
  readonly value: number;
  readonly thresholdsNotified?: readonly number[];
}

/** Narrow a stored counter row, or `null`. */
function asUsageCounterRow(value: unknown): UsageCounterRow | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Partial<UsageCounterRow>;
  if (
    typeof row.tenantId !== "string" ||
    typeof row.entitlementKey !== "string" ||
    typeof row.periodKey !== "string" ||
    typeof row.value !== "number"
  ) {
    return null;
  }
  return {
    _id: row._id,
    tenantId: row.tenantId,
    entitlementKey: row.entitlementKey,
    periodKey: row.periodKey,
    value: row.value,
    ...(Array.isArray(row.thresholdsNotified)
      ? { thresholdsNotified: row.thresholdsNotified.filter((t) => typeof t === "number") }
      : {}),
  };
}

/**
 * Warn once per crossed, un-latched threshold of every current counter row.
 *
 * @param options - Database/clock/logger seam and the per-run limit.
 * @returns The §10.2 run outcome with `{ notified }`.
 */
export async function usageThresholdCheck(options: SweepJobRunOptions): Promise<CronRunOutcome> {
  const { db, clock, logger, limit } = options;
  const counters = platformRepo(db).collection(COLLECTIONS.usageCounters);

  const raw: unknown = await counters.find({}).limit(limit).toArray();
  const candidates = Array.isArray(raw)
    ? raw.map(asUsageCounterRow).filter((row): row is UsageCounterRow => row !== null)
    : [];

  let scanned = 0;
  let notified = 0;
  let skipped = 0;

  // One resolution per `(tenantId, entitlementKey)` per run: the plan, the
  // overrides and the grants are the same for every counter row of that key,
  // and a run can reach up to `limit` rows (ADR-0863).
  const verdicts = new Map<string, EntitlementVerdict>();
  const verdictFor = async (row: UsageCounterRow): Promise<EntitlementVerdict> => {
    const key = `${row.tenantId}:${row.entitlementKey}`;
    const cached = verdicts.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const verdict = await checkEntitlement(row.tenantId, row.entitlementKey, 0, {}, { db, clock });
    verdicts.set(key, verdict);
    return verdict;
  };

  for (const row of candidates) {
    scanned += 1;
    const eventKey = THRESHOLD_EVENT_KEYS[row.entitlementKey];
    const verdict = await verdictFor(row);
    // A counter row from an elapsed period is not this period's usage; the
    // service resolves the key's own current period, and only that row is live.
    if (eventKey === undefined || verdict.periodKey !== row.periodKey) {
      skipped += 1;
      continue;
    }
    const effectiveLimit = verdict.effectiveLimit;
    if (effectiveLimit === null || effectiveLimit <= 0) {
      skipped += 1;
      continue;
    }

    const percent = Math.floor((row.value / effectiveLimit) * 100);
    const thresholds = usageThresholdsToNotify({
      percent,
      latched: row.thresholdsNotified ?? [],
    });
    if (thresholds.length === 0) {
      skipped += 1;
      continue;
    }

    let delivered = 0;
    for (const threshold of thresholds) {
      const result = await emitDomainEvent(
        {
          eventKey,
          tenantId: row.tenantId,
          actorRef: { kind: "system", id: "usage-threshold-check" },
          subjectRef: { kind: "tenant", id: row.tenantId },
          payload: { entitlementKey: row.entitlementKey, threshold, percent },
          dedupeKey: `usage.threshold:${row.tenantId}:${row.entitlementKey}:${row.periodKey}:${String(threshold)}`,
        },
        { db, clock }
      );
      delivered += result.deduped ? 0 : 1;
    }
    if (delivered > 0) {
      await counters.updateOne(
        { _id: row._id },
        { $addToSet: { thresholdsNotified: { $each: [...thresholds] } } }
      );
    }
    notified += delivered;
  }

  logger.info("usage threshold check completed", {
    event: "usage.threshold_check",
    notified,
  });
  return {
    scanned,
    affected: notified,
    skipped,
    errors: 0,
    hasMore: scanned >= limit,
    details: { notified },
  };
}

/**
 * `usage-threshold-check` — hourly (contract §10.2; ADR-0849 §1).
 *
 * Registered in `apps/web/vercel.json`; the run closes over the shared database
 * handle and forwards the framework's clamped limit and injected clock.
 */
export const usageThresholdCheckJob: CronJob = defineCronJob({
  name: "usage-threshold-check",
  defaultLimit: 2000,
  maxLimit: 4000,
  run: ({ limit, clock, logger }) => usageThresholdCheck({ db: getDb(), clock, logger, limit }),
});
