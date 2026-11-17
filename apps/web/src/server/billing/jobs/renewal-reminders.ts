import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import type { CronRunOutcome } from "@/server/jobs/cron-job";
import { getLogger } from "@/server/logging";
import type { SubscriptionStatus } from "@/server/payments/payment-provider";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { MS_PER_DAY, addDays } from "@/server/runtime/time";

import type { BillingJobRunOptions } from "./run-options";

/**
 * The renewal-reminder cron (OP-111, contract §10.2 `renewal-reminders`, schema
 * §14.3; ADR-0500).
 *
 * This is the only billing cron whose subject is a **healthy** subscription, so
 * it owns its own window and its own idempotency token:
 * {@link decideRenewalReminder} answers "is a renewal nudge due for this row
 * today, and under which per-cycle token?" without any I/O, so the job cannot
 * re-derive the window inline.
 */

/** The stored subscription facts {@link decideRenewalReminder} reads. */
export interface RenewalWindowInput {
  /** `subscriptions.status` — only `"active"` renews. */
  readonly status: SubscriptionStatus;
  /** `subscriptions.nextChargeAt` — the instant the next charge is due. */
  readonly nextChargeAt: Date | null;
  /** `subscriptions.currentPeriodEnd` — the identity of the cycle being reminded. */
  readonly currentPeriodEnd: Date | null;
  /** `subscriptions.cancelAt` — a period-end cancel suppresses the reminder. */
  readonly cancelAt: Date | null;
  /** `subscriptions.dunning.remindersSent` — the per-cycle idempotency tokens. */
  readonly remindersSent: readonly string[];
  /** The instant the run is evaluated at (the job's injected clock). */
  readonly now: Date;
}

/** A due renewal reminder and the token that makes it once-per-cycle. */
export interface RenewalDue {
  /** The `dunning.remindersSent` token for this cycle — `renewal:<periodEnd ISO>`. */
  readonly key: string;
}

/** How far ahead of the charge a renewal reminder is sent (§10.2: "within 3 days"). */
const RENEWAL_WINDOW_DAYS = 3;

/**
 * Decide whether a renewal reminder is due for one subscription.
 *
 * The window is the **strict future** window `0 < nextChargeAt - now <= 3 days`:
 * at `nextChargeAt === now` the charge instant has arrived and the payment
 * webhook is the signal, so a "renewal is upcoming" nudge would be stale
 * (ADR-0500 §"The renewal window"). Only `status: "active"` renews — a
 * `past_due`, `downgraded`, `cancelled` or `expired` row is dunning's business.
 * A row carrying `cancelAt` will not be charged, and a row with no
 * `currentPeriodEnd` has no cycle to key on, so both answer `null` rather than a
 * reminder that could fire twice.
 *
 * @param input - The stored row's renewal-relevant facts and the instant.
 * @returns The per-cycle token, or `null` when no reminder is due.
 * @example
 * decideRenewalReminder({ ...row, now }); // { key: "renewal:2026-11-01T00:00:00.000Z" }
 */
export function decideRenewalReminder(input: RenewalWindowInput): RenewalDue | null {
  if (input.status !== "active" || input.cancelAt !== null) {
    return null;
  }
  const { nextChargeAt, currentPeriodEnd } = input;
  if (nextChargeAt === null || currentPeriodEnd === null) {
    return null;
  }

  const deltaMs = nextChargeAt.getTime() - input.now.getTime();
  if (deltaMs <= 0 || deltaMs > RENEWAL_WINDOW_DAYS * MS_PER_DAY) {
    return null;
  }

  const key = `renewal:${currentPeriodEnd.toISOString()}`;
  return input.remindersSent.includes(key) ? null : { key };
}

/** The stored fields the renewal runner reads off a candidate row. */
interface RenewalCandidate {
  readonly _id: unknown;
  readonly tenantId: string;
  readonly status: SubscriptionStatus;
  readonly nextChargeAt: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAt: Date | null;
  readonly remindersSent: readonly string[];
}

/** Narrow an unknown stored value to a renewal candidate, or `null`. */
function asRenewalCandidate(value: unknown): RenewalCandidate | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { _id, tenantId, status, nextChargeAt, currentPeriodEnd, cancelAt, dunning } = value as {
    _id?: unknown;
    tenantId?: unknown;
    status?: unknown;
    nextChargeAt?: unknown;
    currentPeriodEnd?: unknown;
    cancelAt?: unknown;
    dunning?: unknown;
  };
  if (_id === undefined || typeof tenantId !== "string" || typeof status !== "string") {
    return null;
  }
  const remindersSent =
    typeof dunning === "object" && dunning !== null
      ? ((dunning as { remindersSent?: unknown }).remindersSent ?? [])
      : [];
  return {
    _id,
    tenantId,
    status: status as SubscriptionStatus,
    nextChargeAt: nextChargeAt instanceof Date ? nextChargeAt : null,
    currentPeriodEnd: currentPeriodEnd instanceof Date ? currentPeriodEnd : null,
    cancelAt: cancelAt instanceof Date ? cancelAt : null,
    remindersSent: Array.isArray(remindersSent)
      ? remindersSent.filter((token): token is string => typeof token === "string")
      : [],
  };
}

/**
 * Send one renewal reminder per due cycle, bounded by `limit`.
 *
 * The transition is a conditional `findOneAndUpdate` whose filter carries the
 * prior state (`"dunning.remindersSent": { $ne: key }`), so a second daily run
 * of the same cycle matches zero documents and emits nothing (contract §10.2
 * rule 1). The job writes only `subscriptions` (the per-cycle token) and the
 * `domain_events` outbox.
 *
 * @param options - Database/clock seams and the per-run limit.
 * @returns The §10.2 run outcome (`hasMore` when the candidate window filled).
 */
export async function runRenewalReminders(options: BillingJobRunOptions): Promise<CronRunOutcome> {
  const db = options.db ?? getDb();
  const clock = options.clock ?? systemClock;
  const now = clock.now();
  const subscriptions = platformRepo(db).collection(COLLECTIONS.subscriptions);

  const raw: unknown = await subscriptions
    .find({ status: "active", nextChargeAt: { $gt: now, $lte: addDays(now, RENEWAL_WINDOW_DAYS) } })
    .sort({ nextChargeAt: 1 })
    .limit(options.limit)
    .toArray();
  const candidates = Array.isArray(raw)
    ? raw.map(asRenewalCandidate).filter((row): row is RenewalCandidate => row !== null)
    : [];

  let affected = 0;
  let skipped = 0;

  for (const row of candidates) {
    const due = decideRenewalReminder({
      status: row.status,
      nextChargeAt: row.nextChargeAt,
      currentPeriodEnd: row.currentPeriodEnd,
      cancelAt: row.cancelAt,
      remindersSent: row.remindersSent,
      now,
    });
    if (due === null) {
      skipped += 1;
      continue;
    }

    const updated = await subscriptions.findOneAndUpdate(
      { _id: row._id, "dunning.remindersSent": { $ne: due.key } },
      { $push: { "dunning.remindersSent": due.key }, $set: { updatedAt: now } },
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
        eventKey: "billing.renewal.upcoming",
        tenantId: row.tenantId,
        actorRef: { kind: "system", id: "renewal-reminders" },
        subjectRef: { kind: "subscription", id: subscriptionId },
        payload: { subscriptionId },
        dedupeKey: `billing.renewal.upcoming:${subscriptionId}:${due.key}`,
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

  getLogger().info("renewal reminders completed", {
    event: "billing.renewal_reminders",
    ...outcome,
    limit: options.limit,
  });

  return outcome;
}
