import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import type { CronRunOutcome } from "@/server/jobs/cron-job";
import { getLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";

import type { BillingJobRunOptions } from "./run-options";

/**
 * The scheduled-plan-change cron (OP-111, contract §10.2
 * `scheduled-plan-changes`, schema §14.3; ADR-0500).
 *
 * A plan change that cannot take effect immediately (a self-downgrade, §3.3)
 * is stored as `subscriptions.scheduledChange = { toPlanKey, effectiveAt,
 * reason }` rather than applied inline. This job is what makes the promise
 * real: once `effectiveAt <= now` the change is applied and cleared, so the
 * stored row never carries a stale intent.
 */

/** The `scheduledChange` block the job applies (§14.3). */
interface ScheduledChange {
  readonly toPlanKey: string;
  readonly effectiveAt: Date;
  readonly reason: string;
}

/** The stored fields the scheduled-change runner reads off a candidate row. */
interface ScheduledChangeCandidate {
  readonly _id: unknown;
  readonly tenantId: string;
  readonly scheduledChange: ScheduledChange;
}

/** Narrow an unknown stored `scheduledChange` to the §14.3 block, or `null`. */
function asScheduledChange(value: unknown): ScheduledChange | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { toPlanKey, effectiveAt, reason } = value as {
    toPlanKey?: unknown;
    effectiveAt?: unknown;
    reason?: unknown;
  };
  if (typeof toPlanKey !== "string" || !(effectiveAt instanceof Date)) {
    return null;
  }
  return { toPlanKey, effectiveAt, reason: typeof reason === "string" ? reason : "scheduled" };
}

/** Narrow an unknown stored value to a scheduled-change candidate, or `null`. */
function asCandidate(value: unknown): ScheduledChangeCandidate | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { _id, tenantId, scheduledChange } = value as {
    _id?: unknown;
    tenantId?: unknown;
    scheduledChange?: unknown;
  };
  if (_id === undefined || typeof tenantId !== "string") {
    return null;
  }
  const change = asScheduledChange(scheduledChange);
  return change === null ? null : { _id, tenantId, scheduledChange: change };
}

/**
 * Apply and clear every due scheduled plan change, bounded by `limit`.
 *
 * The transition is a conditional `findOneAndUpdate` whose filter carries the
 * prior state (`"scheduledChange.effectiveAt": { $lte: now }`), so a lost race —
 * or a second run after the row was cleared — matches zero documents and is a
 * no-op (contract §10.2 rule 1).
 *
 * @param options - Database/clock seams and the per-run limit.
 * @returns The §10.2 run outcome (`hasMore` when the candidate window filled).
 */
export async function runScheduledPlanChanges(
  options: BillingJobRunOptions
): Promise<CronRunOutcome> {
  const db = options.db ?? getDb();
  const clock = options.clock ?? systemClock;
  const now = clock.now();
  const subscriptions = platformRepo(db).collection(COLLECTIONS.subscriptions);

  const raw: unknown = await subscriptions
    .find({ "scheduledChange.effectiveAt": { $lte: now } })
    .sort({ "scheduledChange.effectiveAt": 1 })
    .limit(options.limit)
    .toArray();
  const candidates = Array.isArray(raw)
    ? raw.map(asCandidate).filter((row): row is ScheduledChangeCandidate => row !== null)
    : [];

  let affected = 0;
  let skipped = 0;

  for (const row of candidates) {
    const { toPlanKey, reason } = row.scheduledChange;
    const updated = await subscriptions.findOneAndUpdate(
      { _id: row._id, "scheduledChange.effectiveAt": { $lte: now } },
      {
        $set: { activePlanKey: toPlanKey, scheduledChange: null, updatedAt: now },
        $push: {
          statusHistory: {
            from: "scheduled_change",
            to: toPlanKey,
            at: now,
            reason,
            actor: "system",
          },
        },
      },
      { returnDocument: "after" }
    );
    if (updated === null) {
      skipped += 1;
      continue;
    }

    affected += 1;
    const subscriptionId = String(row._id);
    await emitDomainEvent(
      {
        eventKey: "billing.plan.downgrade_applied",
        tenantId: row.tenantId,
        actorRef: { kind: "system", id: "scheduled-plan-changes" },
        subjectRef: { kind: "subscription", id: subscriptionId },
        payload: { subscriptionId, toPlanKey },
        dedupeKey: `billing.plan.downgrade_applied:${subscriptionId}:${toPlanKey}`,
      },
      { db, clock }
    );
  }

  const scanned = candidates.length;
  const outcome: CronRunOutcome = {
    scanned,
    affected,
    skipped,
    errors: 0,
    hasMore: scanned === options.limit,
  };

  getLogger().info("scheduled plan changes completed", {
    event: "billing.scheduled_plan_changes",
    ...outcome,
    limit: options.limit,
  });

  return outcome;
}
