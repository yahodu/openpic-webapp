import { ObjectId } from "mongodb";

import { projectProviderWebhookEvent } from "@/server/billing/webhook-projection";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import type { CronRunOutcome } from "@/server/jobs/cron-job";
import { getLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { addMilliseconds } from "@/server/runtime/time";

import type { BillingJobRunOptions } from "./run-options";

/**
 * The webhook-projection sweep (OP-111, contract §10.2
 * `webhook-projection-sweep`, §10.1 step 6; schema §18.4; ADR-0500).
 *
 * The inbox route answers the provider and defers the projection, so a
 * projection that fails — a crash, a transient write error, a poisoned ledger —
 * leaves the row at `processedAt: null` with `processResult: "error"`. This job
 * is what heals that: it re-runs {@link projectProviderWebhookEvent}, the very
 * seam the route deferred, over rows that have been unprocessed for longer than
 * the documented grace. The grace exists so an **in-flight** projection is never
 * raced by the sweep.
 */

/** How long an unprocessed inbox row waits before the sweep retries it. */
const SWEEP_GRACE_MS = 60 * 1000;

/** The stored fields the sweep reads off a candidate inbox row. */
interface InboxCandidate {
  readonly _id: ObjectId;
}

/** Narrow an unknown stored value to an inbox candidate, or `null`. */
function asInboxCandidate(value: unknown): InboxCandidate | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { _id } = value as { _id?: unknown };
  return _id instanceof ObjectId ? { _id } : null;
}

/**
 * Re-project unprocessed inbox rows older than the sweep's grace, bounded by
 * `limit`.
 *
 * The selection is `processedAt: null` **and** `receivedAt < now - 60 s`;
 * `projectProviderWebhookEvent` re-reads, re-parses, orders and applies the
 * event in one transaction and settles the row, so a row that still fails keeps
 * `processedAt: null` and is counted in `errors` (the repeated-failure signal
 * `admin.provider.failing` is raised from — the job itself emits no alert
 * inline, contract §10.2 rule 3).
 *
 * @param options - Database/clock seams and the per-run limit.
 * @returns The §10.2 run outcome (`hasMore` when the candidate window filled).
 */
export async function runWebhookProjectionSweep(
  options: BillingJobRunOptions
): Promise<CronRunOutcome> {
  const db = options.db ?? getDb();
  const clock = options.clock ?? systemClock;
  const now = clock.now();
  const inbox = platformRepo(db).collection(COLLECTIONS.providerWebhookEvents);

  const raw: unknown = await inbox
    .find({ processedAt: null, receivedAt: { $lt: addMilliseconds(now, -SWEEP_GRACE_MS) } })
    .sort({ receivedAt: 1 })
    .limit(options.limit)
    .toArray();
  const candidates = Array.isArray(raw)
    ? raw.map(asInboxCandidate).filter((row): row is InboxCandidate => row !== null)
    : [];

  let affected = 0;
  let errors = 0;

  for (const row of candidates) {
    await projectProviderWebhookEvent(row._id.toHexString(), { db, clock });

    const settled: unknown = await inbox.findOne({ _id: row._id });
    const processedAt =
      typeof settled === "object" && settled !== null
        ? (settled as { processedAt?: unknown }).processedAt
        : null;
    if (processedAt instanceof Date) {
      affected += 1;
    } else {
      errors += 1;
    }
  }

  const scanned = candidates.length;
  const outcome: CronRunOutcome = {
    scanned,
    affected,
    skipped: 0,
    errors,
    hasMore: scanned === options.limit,
  };

  getLogger().info("webhook projection sweep completed", {
    event: "billing.webhook_projection_sweep",
    ...outcome,
    limit: options.limit,
  });

  return outcome;
}
