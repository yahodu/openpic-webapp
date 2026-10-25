import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import type { CronRunOutcome } from "@/server/jobs/cron-job";
import { getLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";

import type { BillingJobRunOptions } from "./run-options";

/**
 * The dunning cron (OP-111, contract §10.2 `dunning` / §10.2.1 C6; schema §14.3;
 * ADR-0500).
 *
 * This is **the C6-guarded module**: the single most important rule of the
 * billing lane is that no dunning bug can reach user content, so this file may
 * import only the subscription repository (and the `@/server/repos` barrel that
 * exposes it) — an ESLint `no-restricted-imports` boundary scoped to exactly
 * this path forbids the `events`, `eventImages`, `mediaAssets`, `imageFaces`,
 * `faceMatches` and `selfies` repositories (`eslint.config.mjs`).
 *
 * The job transitions a subscription whose grace has run out:
 * `status: "past_due"` **and** `gracePeriodEndsAt < now` → `status:
 * "downgraded"`, `activePlanKey: "free"`, one appended `statusHistory` entry.
 * It writes **nothing else** — no counter, no ledger row, no content row — and
 * its only other write is the `domain_events` outbox row every §10.2 job writes
 * (rule 3). `docs/Subscription flow.md` §4.3 promises users that a downgrade
 * deletes nothing, and the whole-database diff of the integration suite is what
 * makes that promise structural.
 */

/** The stored fields the dunning runner reads off a candidate row. */
interface DunningCandidate {
  readonly _id: unknown;
  readonly tenantId: string;
}

/** Narrow an unknown stored value to a dunning candidate, or `null`. */
function asDunningCandidate(value: unknown): DunningCandidate | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { _id, tenantId } = value as { _id?: unknown; tenantId?: unknown };
  if (_id === undefined || typeof tenantId !== "string") {
    return null;
  }
  return { _id, tenantId };
}

/**
 * Downgrade every subscription whose grace period has ended, bounded by `limit`.
 *
 * Every transition is a conditional `findOneAndUpdate` whose filter carries the
 * prior state (`status: "past_due"` and `gracePeriodEndsAt < now`), so two
 * concurrent runs transition the row once: the loser matches zero documents and
 * reports it as `skipped` rather than corrupting anything (contract §10.2 rule
 * 1). The run is bounded and reports `hasMore` so the scheduler re-invokes
 * instead of the job looping (rule 2).
 *
 * @param options - Database/clock seams and the per-run limit.
 * @returns The §10.2 run outcome (`hasMore` when the candidate window filled).
 */
export async function runDunning(options: BillingJobRunOptions): Promise<CronRunOutcome> {
  const db = options.db ?? getDb();
  const clock = options.clock ?? systemClock;
  const now = clock.now();
  const subscriptions = platformRepo(db).collection(COLLECTIONS.subscriptions);

  const raw: unknown = await subscriptions
    .find({ status: "past_due", gracePeriodEndsAt: { $lt: now } })
    .sort({ gracePeriodEndsAt: 1 })
    .limit(options.limit)
    .toArray();
  const candidates = Array.isArray(raw)
    ? raw.map(asDunningCandidate).filter((row): row is DunningCandidate => row !== null)
    : [];

  let affected = 0;
  let skipped = 0;

  for (const row of candidates) {
    const updated = await subscriptions.findOneAndUpdate(
      { _id: row._id, status: "past_due", gracePeriodEndsAt: { $lt: now } },
      {
        $set: { status: "downgraded", activePlanKey: "free", updatedAt: now },
        $push: {
          statusHistory: {
            from: "past_due",
            to: "downgraded",
            at: now,
            reason: "grace_expired",
            actor: "system",
          },
        },
      },
      { returnDocument: "after" }
    );
    if (updated === null) {
      // The prior state moved between the read and the write (a concurrent run,
      // or a webhook that reactivated the row): a no-op, never corruption.
      skipped += 1;
      continue;
    }

    affected += 1;
    const subscriptionId = String(row._id);
    await emitDomainEvent(
      {
        eventKey: "billing.subscription.downgraded",
        tenantId: row.tenantId,
        actorRef: { kind: "system", id: "dunning" },
        subjectRef: { kind: "subscription", id: subscriptionId },
        payload: { subscriptionId },
        dedupeKey: `billing.subscription.downgraded:${subscriptionId}`,
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

  getLogger().info("dunning completed", {
    event: "billing.dunning",
    ...outcome,
    limit: options.limit,
  });

  return outcome;
}
