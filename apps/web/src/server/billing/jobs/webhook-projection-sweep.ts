import { ObjectId } from "mongodb";

import { projectProviderWebhookEvent } from "@/server/billing/webhook-projection";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
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

/**
 * How many consecutive failed sweeps a single row may accumulate before the
 * `admin.provider.failing` escalation is raised (§10.2; ADR-0502). Two failures
 * are the transient tolerance; the third is a pattern.
 */
const FAILURE_ALERT_THRESHOLD = 3;

/** The stored per-row consecutive-failure counter field (absent ⇒ `0`). */
const FAILURE_COUNT_FIELD = "sweepFailureCount";

/**
 * The outbox `tenantId` for a platform-scoped escalation. The inbox row carries
 * no tenant and §10.2 names no subject for `admin.provider.failing`, so the
 * alert is filed against the platform sentinel (ADR-0502 §"Open items").
 */
const PLATFORM_TENANT_ID = "platform";

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
 * `processedAt: null` and is counted in `errors`. A row that keeps failing
 * accumulates a consecutive-failure counter, and once it crosses the repeat
 * threshold the sweep emits one `admin.provider.failing` escalation
 * (deduplicated per row; always mobile — §10.1.2 line 3171; §10.2; ADR-0502).
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
      // The projection's own failure path rewrites only `processedAt`/
      // `processResult`/`processError`, so the sweep carries its own
      // consecutive-failure counter on the row, `$inc`ing it after each failed
      // re-projection (an absent counter reads as 0). The escalation is raised
      // crossing-only, on the sweep that reaches the threshold — sweeps 4+
      // neither re-raise nor re-attempt. The `dedupeKey` is the outbox-side
      // backstop for a racing concurrent sweep (§10.2; ADR-0502).
      const incremented: unknown = await inbox.findOneAndUpdate(
        { _id: row._id },
        { $inc: { [FAILURE_COUNT_FIELD]: 1 } },
        { returnDocument: "after" }
      );
      const failureCount =
        typeof incremented === "object" && incremented !== null
          ? (incremented as { readonly sweepFailureCount?: unknown }).sweepFailureCount
          : undefined;
      if (failureCount === FAILURE_ALERT_THRESHOLD) {
        const eventId = row._id.toHexString();
        await emitDomainEvent(
          {
            eventKey: "admin.provider.failing",
            tenantId: PLATFORM_TENANT_ID,
            actorRef: { kind: "system", id: "webhook-projection-sweep" },
            subjectRef: { kind: "providerWebhookEvent", id: eventId },
            payload: { mobile: true },
            dedupeKey: `admin.provider.failing:${eventId}`,
          },
          { db, clock }
        );
      }
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
