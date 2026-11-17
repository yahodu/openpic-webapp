import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import type { CronRunOutcome } from "@/server/jobs/cron-job";
import { getLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { MS_PER_DAY, addDays } from "@/server/runtime/time";
import { getPlatformSettings, type PlatformSettings } from "@/server/settings/platform-settings";

import type { BillingJobRunOptions } from "./run-options";

/**
 * The grace-reminder cron (OP-111, contract §10.2 `dunning-reminders`, schema
 * §14.3; ADR-0500).
 *
 * The whole decision is a pure function of two stored facts — the subscription's
 * `gracePeriodEndsAt` (written by the webhook projection as
 * `failedAt + platformSettings.dunning.gracePeriodDays`) and the operator's
 * `platformSettings.dunning.reminderDays` schedule — plus the instant the run is
 * evaluated at. {@link resolveDueReminderDay} owns that decision so the job
 * cannot re-derive the window inline and disagree with it.
 */

/** What {@link resolveDueReminderDay} needs to decide whether today is a reminder day. */
export interface ReminderDueInput {
  /** `subscriptions.gracePeriodEndsAt` — the instant the grace period ends. */
  readonly gracePeriodEndsAt: Date;
  /** The whole settings singleton, so the schedule and the grace length agree. */
  readonly settings: PlatformSettings;
  /** The instant the run is evaluated at (the job's injected clock). */
  readonly now: Date;
}

/** A grace day the reminder schedule names, and the idempotency token it stores. */
export interface ReminderDue {
  /** The 1-based grace day `now` falls on (day 1 is the first 24 h of the window). */
  readonly day: number;
  /** The `dunning.remindersSent` token for that day — `"d" + day`. */
  readonly key: string;
  /** Whether this is the last day the schedule names (§10.2: mobile only then). */
  readonly isFinal: boolean;
}

/**
 * Resolve the reminder due on `now`, or `null` when nothing is due.
 *
 * The grace window opens at `gracePeriodEndsAt - gracePeriodDays` (the same
 * `settings.dunning.gracePeriodDays` the projection dunned with — never a
 * hard-coded 14) and closes **at** `gracePeriodEndsAt`; the `dunning` job owns
 * the past-grace transition, so this returns `null` at and after the deadline.
 * The day is the 24-hour bucket `floor((now - windowStart) / 24 h) + 1` rather
 * than a calendar day, because the window is derived from an instant and the job
 * runs four times a day (ADR-0500 §"The reminder due-day computation").
 *
 * @param input - The stored grace deadline, the settings and the instant.
 * @returns The due day with its idempotency key, or `null` when no reminder is due.
 * @example
 * resolveDueReminderDay({ gracePeriodEndsAt, settings, now }); // { day: 5, key: "d5", isFinal: false }
 */
export function resolveDueReminderDay(input: ReminderDueInput): ReminderDue | null {
  const { gracePeriodEndsAt, settings, now } = input;
  const { gracePeriodDays, reminderDays } = settings.dunning;

  const windowStartMs = addDays(gracePeriodEndsAt, -gracePeriodDays).getTime();
  const nowMs = now.getTime();
  if (nowMs < windowStartMs || nowMs >= gracePeriodEndsAt.getTime()) {
    return null;
  }

  const day = Math.floor((nowMs - windowStartMs) / MS_PER_DAY) + 1;
  if (!reminderDays.includes(day)) {
    return null;
  }

  return { day, key: `d${String(day)}`, isFinal: day === reminderDays.at(-1) };
}

/** The stored fields the reminder runner reads off a candidate row. */
interface ReminderCandidate {
  readonly _id: unknown;
  readonly tenantId: string;
  readonly gracePeriodEndsAt: Date;
}

/** Narrow an unknown stored value to a reminder candidate, or `null`. */
function asReminderCandidate(value: unknown): ReminderCandidate | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { _id, tenantId, gracePeriodEndsAt } = value as {
    _id?: unknown;
    tenantId?: unknown;
    gracePeriodEndsAt?: unknown;
  };
  if (_id === undefined || typeof tenantId !== "string" || !(gracePeriodEndsAt instanceof Date)) {
    return null;
  }
  return { _id, tenantId, gracePeriodEndsAt };
}

/**
 * Emit one grace reminder per due subscription, bounded by `limit`.
 *
 * Every transition is a conditional `findOneAndUpdate` whose filter carries the
 * prior state (`"dunning.remindersSent": { $ne: key }`), so a retry — or a
 * concurrent run — matches zero documents and is a no-op rather than a second
 * reminder (contract §10.2 rule 1). The job writes only `subscriptions` (the
 * `dunning.remindersSent` token) and the `domain_events` outbox; the fan-out
 * consumer delivers (rule 3).
 *
 * @param options - Database/clock seams and the per-run limit.
 * @returns The §10.2 run outcome (`hasMore` when the candidate window filled).
 */
export async function runDunningReminders(options: BillingJobRunOptions): Promise<CronRunOutcome> {
  const db = options.db ?? getDb();
  const clock = options.clock ?? systemClock;
  const now = clock.now();
  const settings = await getPlatformSettings({ db, clock });
  const subscriptions = platformRepo(db).collection(COLLECTIONS.subscriptions);

  const raw: unknown = await subscriptions
    .find({ status: "past_due", gracePeriodEndsAt: { $gt: now } })
    .sort({ gracePeriodEndsAt: 1 })
    .limit(options.limit)
    .toArray();
  const candidates = Array.isArray(raw)
    ? raw.map(asReminderCandidate).filter((row): row is ReminderCandidate => row !== null)
    : [];

  let affected = 0;
  let skipped = 0;

  for (const row of candidates) {
    const due = resolveDueReminderDay({ gracePeriodEndsAt: row.gracePeriodEndsAt, settings, now });
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
      // Lost the race (or a retry): the token is already stored, so this run is
      // a no-op rather than a duplicate reminder.
      skipped += 1;
      continue;
    }

    affected += 1;
    const subscriptionId = String(row._id);
    await emitDomainEvent(
      {
        eventKey: "billing.grace.reminder",
        tenantId: row.tenantId,
        actorRef: { kind: "system", id: "dunning-reminders" },
        subjectRef: { kind: "subscription", id: subscriptionId },
        payload: { day: due.day, mobile: due.isFinal },
        dedupeKey: `billing.grace.reminder:${subscriptionId}:${due.key}`,
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

  getLogger().info("dunning reminders completed", {
    event: "billing.dunning_reminders",
    ...outcome,
    limit: options.limit,
  });

  return outcome;
}
