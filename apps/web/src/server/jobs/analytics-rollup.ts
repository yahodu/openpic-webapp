import type { Db, ObjectId } from "mongodb";
import { ObjectId as ObjectIdValue } from "mongodb";

import { dateKeySchema } from "@openpic/contracts";

import type { AnalyticsMetrics } from "@/server/analytics/totals";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineCronJob, type CronJob, type CronRunOutcome } from "@/server/jobs/cron-job";
import { platformRepo } from "@/server/repos";
import type { Clock } from "@/server/runtime/clock";
import type { Logger } from "@/server/logging";

/**
 * `analytics-rollup` — the nightly `analyticsDaily` writer (OP-139, contract
 * §10.2, §4.5; schema §20.1; ADR-0918, ADR-0919).
 *
 * `GET /tenants/{tenantId}/analytics` reads **only** `analyticsDaily`
 * (ADR-0642), so this job is the whole writer of the dashboard's numbers: one
 * row per `{ scope, dateKey }` for the `tenant`, `event` and `platform` scopes,
 * upserted on `{ "scope.kind", "scope.id", dateKey }` so a rerun of the same day
 * rewrites the same documents instead of appending.
 *
 * The day is the **Asia/Kolkata** calendar day (a fixed `+05:30`): a UTC day
 * would cut a Bangalore evening in half. `?date=YYYY-MM-DD` re-runs any day;
 * absent, the run rolls up the IST day that just closed, so the 02:00 run never
 * rolls up the two hours of the day it is standing in (ADR-0918 §A5).
 */

/** The zone every tenant's calendar day is bucketed in (contract §10.2). */
export const ROLLUP_TIME_ZONE = "Asia/Kolkata";

/** The calendar parts of one instant, in one time zone. */
interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/**
 * Read one instant's wall-clock parts in a time zone.
 *
 * @param instant - The instant to read (never mutated).
 * @param timeZone - The IANA zone to read it in.
 * @returns The zone's own year, month, day, hour, minute and second.
 */
function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** Pad a calendar field to its two-digit form. */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * The `YYYY-MM-DD` calendar day an instant falls in, in a time zone.
 *
 * @param instant - The instant to bucket (read only).
 * @param timeZone - The IANA zone whose calendar day is wanted.
 * @returns The day key, e.g. `"2026-11-18"`.
 */
export function dateKeyInTimeZone(instant: Date, timeZone: string): string {
  const parts = zonedParts(instant, timeZone);
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Split a `YYYY-MM-DD` key into its numbers, refusing a malformed one. */
function parseDateKey(dateKey: string): { year: number; month: number; day: number } {
  if (!dateKeySchema.safeParse(dateKey).success) {
    throw new RangeError(`invalid date key "${dateKey}": expected YYYY-MM-DD`);
  }
  const [year, month, day] = dateKey.split("-").map(Number);
  return { year: year ?? 0, month: month ?? 0, day: day ?? 0 };
}

/** The zone's offset from UTC at one instant, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  // The formatter answers whole seconds; comparing at that precision keeps the
  // offset exact for every zone whose offset is a whole number of minutes.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant of local midnight on one calendar day, in a zone. */
function startOfDayUtc(dateKey: string, timeZone: string): Date {
  const { year, month, day } = parseDateKey(dateKey);
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  // Two passes: the first lands near midnight, the second re-reads the offset
  // at the instant it points at (a DST transition changes it once).
  for (let pass = 0; pass < 2; pass += 1) {
    guess = target - zoneOffsetMs(new Date(guess), timeZone);
  }
  return new Date(guess);
}

/** The day key one calendar day after the given key. */
function nextDateKey(dateKey: string): string {
  const { year, month, day } = parseDateKey(dateKey);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/** The day key one calendar day before the given key. */
function previousDateKey(dateKey: string): string {
  const { year, month, day } = parseDateKey(dateKey);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/**
 * The half-open UTC window `[start, end)` of one calendar day in a time zone.
 *
 * @param dateKey - The day key (`YYYY-MM-DD`).
 * @param timeZone - The IANA zone the day belongs to.
 * @returns The window's start (inclusive) and end (exclusive), as UTC instants.
 */
export function dayWindowUtc(dateKey: string, timeZone: string): { start: Date; end: Date } {
  return {
    start: startOfDayUtc(dateKey, timeZone),
    end: startOfDayUtc(nextDateKey(dateKey), timeZone),
  };
}

/** The twelve §20.1 counters, every one at zero. */
function emptyMetrics(): AnalyticsMetrics {
  return {
    eventsCreated: 0,
    imagesUploaded: 0,
    imagesProcessed: 0,
    imagesFailed: 0,
    selfiesUploaded: 0,
    matchesCreated: 0,
    uniqueAttendees: 0,
    storageBytesAdded: 0,
    downloads: 0,
    notificationsSent: 0,
    revenueMinor: 0,
    p95ProcessingMs: 0,
  };
}

/** One stored `event_images` row, as far as the rollup reads it. */
interface EventImageRow {
  readonly tenantId?: unknown;
  readonly eventId?: unknown;
  readonly processing?: { readonly status?: unknown };
}

/** One stored `selfies` row, as far as the rollup reads it. */
interface SelfieRow {
  readonly tenantId?: unknown;
  readonly eventId?: unknown;
}

/** One stored `face_matches` row, as far as the rollup reads it. */
interface FaceMatchRow {
  readonly profileId?: unknown;
}

/** One stored `attendee_event_profiles` row, as far as the rollup reads it. */
interface AttendeeProfileRow {
  readonly _id?: unknown;
  readonly tenantId?: unknown;
  readonly eventId?: unknown;
}

/** One stored `notification_dispatches` row, as far as the rollup reads it. */
interface DispatchRow {
  readonly tenantId?: unknown;
  readonly eventId?: unknown;
}

/** One stored `domain_events` row, as far as the rollup reads it. */
interface DomainEventRow {
  readonly tenantId?: unknown;
  readonly subjectRef?: { readonly kind?: unknown; readonly id?: unknown };
}

/** One stored `billing_transactions` row, as far as the rollup reads it. */
interface BillingTransactionRow {
  readonly tenantId?: unknown;
  readonly amountMinor?: unknown;
}

/** The metric counters rolled up so far, keyed by scope. */
interface RollupTotals {
  readonly tenants: Map<string, AnalyticsMetrics>;
  readonly events: Map<string, AnalyticsMetrics>;
  readonly platform: AnalyticsMetrics;
  scanned: number;
}

/** The hex form of an id-shaped value, or `null`. */
function hexOf(value: unknown): string | null {
  if (value instanceof ObjectIdValue) {
    return value.toHexString();
  }
  return typeof value === "string" && /^[0-9a-f]{24}$/i.test(value) ? value.toLowerCase() : null;
}

/** The metrics block of a scope, created on first use. */
function metricsOf(map: Map<string, AnalyticsMetrics>, key: string): AnalyticsMetrics {
  const existing = map.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = emptyMetrics();
  map.set(key, created);
  return created;
}

/**
 * Apply one row's contribution to its tenant, its event and the platform.
 *
 * @param totals - The bucket being filled.
 * @param tenantKey - The row's tenant, or `null` when it carries none.
 * @param eventKey - The row's event, or `null` when it carries none.
 * @param apply - The increments the row contributes, written against a scope's
 *   metrics block (literal fields, so no scope can be miscounted by a key).
 */
function countRow(
  totals: RollupTotals,
  tenantKey: string | null,
  eventKey: string | null,
  apply: (metrics: AnalyticsMetrics) => void
): void {
  if (tenantKey !== null) {
    apply(metricsOf(totals.tenants, tenantKey));
  }
  if (eventKey !== null) {
    apply(metricsOf(totals.events, eventKey));
  }
  apply(totals.platform);
  totals.scanned += 1;
}

/** Upsert one `{ scope, dateKey }` rollup row. */
async function writeRollup(
  db: Db,
  scope: { readonly kind: "tenant" | "event" | "platform"; readonly id: ObjectId | null },
  dateKey: string,
  metrics: AnalyticsMetrics,
  computedAt: Date
): Promise<void> {
  await platformRepo(db)
    .collection(COLLECTIONS.analyticsDaily)
    .updateOne(
      { "scope.kind": scope.kind, "scope.id": scope.id, dateKey },
      { $set: { metrics, computedAt } },
      { upsert: true }
    );
}

/** Options for one rollup invocation. */
interface RollupRunOptions {
  /** The database handle. */
  readonly db: Db;
  /** The clock the run's day key and `computedAt` come from. */
  readonly clock: Clock;
  /** The logger the run's summary is written through. */
  readonly logger: Logger;
  /** The explicit `YYYY-MM-DD` day to re-run, or `undefined` for the closed day. */
  readonly date?: string | undefined;
}

/**
 * Roll one day's activity into `analyticsDaily`.
 *
 * @param options - The database, clock, logger and optional explicit day.
 * @returns The §10.2 run outcome.
 */
export async function analyticsRollup(options: RollupRunOptions): Promise<CronRunOutcome> {
  const { db, clock, logger } = options;
  // The rollup is platform-scope by nature: it reads every tenant's day. The
  // handle is aliased exactly as the shipped cross-tenant sweeps do
  // (ADR-0919 §8).
  const platform = platformRepo(db);
  const dateKey = options.date ?? previousDateKey(dateKeyInTimeZone(clock.now(), ROLLUP_TIME_ZONE));
  const { start, end } = dayWindowUtc(dateKey, ROLLUP_TIME_ZONE);
  const inWindow = { $gte: start, $lt: end };

  const totals: RollupTotals = {
    tenants: new Map(),
    events: new Map(),
    platform: emptyMetrics(),
    scanned: 0,
  };

  const created = (await platform
    .collection(COLLECTIONS.domainEvents)
    .find(
      { eventKey: "event.created", occurredAt: inWindow },
      { projection: { tenantId: 1, subjectRef: 1 } }
    )
    .toArray()) as unknown as DomainEventRow[];
  for (const row of created) {
    const eventKey = row.subjectRef?.kind === "event" ? hexOf(row.subjectRef.id) : null;
    countRow(totals, hexOf(row.tenantId), eventKey, (metrics) => {
      metrics.eventsCreated += 1;
    });
  }

  const images = (await platform
    .collection(COLLECTIONS.eventImages)
    .find({ createdAt: inWindow }, { projection: { tenantId: 1, eventId: 1, processing: 1 } })
    .toArray()) as unknown as EventImageRow[];
  for (const row of images) {
    const tenantKey = hexOf(row.tenantId);
    const eventKey = hexOf(row.eventId);
    countRow(totals, tenantKey, eventKey, (metrics) => {
      metrics.imagesUploaded += 1;
    });
    if (row.processing?.status === "processed") {
      countRow(totals, tenantKey, eventKey, (metrics) => {
        metrics.imagesProcessed += 1;
      });
    }
    if (row.processing?.status === "failed") {
      countRow(totals, tenantKey, eventKey, (metrics) => {
        metrics.imagesFailed += 1;
      });
    }
  }

  const selfies = (await platform
    .collection(COLLECTIONS.selfies)
    .find({ createdAt: inWindow }, { projection: { tenantId: 1, eventId: 1 } })
    .toArray()) as unknown as SelfieRow[];
  for (const row of selfies) {
    countRow(totals, hexOf(row.tenantId), hexOf(row.eventId), (metrics) => {
      metrics.selfiesUploaded += 1;
    });
  }

  // A match row carries only its profile, so the tenant and event it belongs to
  // are read from that profile — one lookup for the whole day's profiles.
  const matches = (await platform
    .collection(COLLECTIONS.faceMatches)
    .find({ createdAt: inWindow }, { projection: { profileId: 1 } })
    .toArray()) as unknown as FaceMatchRow[];
  const profileIds = matches
    .map((row) => row.profileId)
    .filter((id): id is ObjectIdValue => id instanceof ObjectIdValue);
  const profiles =
    profileIds.length === 0
      ? []
      : ((await platform
          .collection(COLLECTIONS.attendeeEventProfiles)
          .find({ _id: { $in: profileIds } }, { projection: { _id: 1, tenantId: 1, eventId: 1 } })
          .toArray()) as unknown as AttendeeProfileRow[]);
  const owners = new Map<string, AttendeeProfileRow>();
  for (const profile of profiles) {
    const id = hexOf(profile._id);
    if (id !== null) {
      owners.set(id, profile);
    }
  }
  for (const row of matches) {
    const owner = owners.get(hexOf(row.profileId) ?? "");
    countRow(totals, hexOf(owner?.tenantId), hexOf(owner?.eventId), (metrics) => {
      metrics.matchesCreated += 1;
    });
  }

  const dispatches = (await platform
    .collection(COLLECTIONS.dispatches)
    .find({ createdAt: inWindow, status: "sent" }, { projection: { tenantId: 1, eventId: 1 } })
    .toArray()) as unknown as DispatchRow[];
  for (const row of dispatches) {
    countRow(totals, hexOf(row.tenantId), hexOf(row.eventId), (metrics) => {
      metrics.notificationsSent += 1;
    });
  }

  // The day's settled revenue. A ledger row names no event, so revenue lands on
  // its tenant and the platform only (ADR-0924 §1).
  const settled = (await platform
    .collection(COLLECTIONS.billingTransactions)
    .find(
      { status: "succeeded", currency: "INR", occurredAt: inWindow },
      { projection: { tenantId: 1, amountMinor: 1 } }
    )
    .toArray()) as unknown as BillingTransactionRow[];
  for (const row of settled) {
    const amountMinor = row.amountMinor;
    if (typeof amountMinor !== "number" || !Number.isFinite(amountMinor)) {
      continue;
    }
    countRow(totals, hexOf(row.tenantId), null, (metrics) => {
      metrics.revenueMinor += amountMinor;
    });
  }

  const computedAt = clock.now();
  let affected = 0;
  for (const [tenantId, metrics] of totals.tenants) {
    await writeRollup(
      db,
      { kind: "tenant", id: new ObjectIdValue(tenantId) },
      dateKey,
      metrics,
      computedAt
    );
    affected += 1;
  }
  for (const [eventId, metrics] of totals.events) {
    await writeRollup(
      db,
      { kind: "event", id: new ObjectIdValue(eventId) },
      dateKey,
      metrics,
      computedAt
    );
    affected += 1;
  }
  // A6: the platform row exists only when the day has activity — a synthetic
  // all-zero row is indistinguishable from "the job did not run".
  if (totals.scanned > 0) {
    await writeRollup(db, { kind: "platform", id: null }, dateKey, totals.platform, computedAt);
    affected += 1;
  }

  logger.info("analytics rollup completed", {
    event: "analytics.rollup.completed",
    dateKey,
    scanned: totals.scanned,
    affected,
  });

  return {
    scanned: totals.scanned,
    affected,
    skipped: 0,
    errors: 0,
    hasMore: false,
    details: { dateKey },
  };
}

/**
 * `analytics-rollup` — daily 02:00 IST (contract §10.2; ADR-0918).
 *
 * The day window is the work bound (the table's default limit is _all_), so
 * `?limit=` does not narrow this job.
 */
export const analyticsRollupJob: CronJob = defineCronJob({
  name: "analytics-rollup",
  defaultLimit: 1,
  maxLimit: 1,
  run: ({ clock, logger, date }) =>
    analyticsRollup({ db: getDb(), clock, logger, ...(date === undefined ? {} : { date }) }),
});
