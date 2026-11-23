import type { Db } from "mongodb";
import { ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { defineCronJob, type CronJob, type CronRunOutcome } from "@/server/jobs/cron-job";
import { platformRepo, tenantRepo } from "@/server/repos";
import type { Clock } from "@/server/runtime/clock";
import type { Logger } from "@/server/logging";
import { getPlatformSettings } from "@/server/settings/platform-settings";

import { dateKeyInTimeZone, ROLLUP_TIME_ZONE } from "./analytics-rollup";

/**
 * `counter-reconcile` — the nightly cache correction (OP-139, contract §10.2,
 * §9.10; schema §13.3, §16.1; ADR-0918, ADR-0919).
 *
 * `tenants.counters` advertises itself as `approximate: true` **because** this
 * job recomputes it: every field is re-derived from the collection that owns
 *the row, the correction is written in place, `counters.reconciledAt` stamps
 * the visit and each delta is logged. A drift far enough above the configured
 * threshold also raises one `admin.abuse.flagged`; routine corrections stay
 * quiet because the admin channel is digest-throttled (§7.6).
 */

/**
 * Decide whether a drift is big enough to alert on.
 *
 * The drift is measured **relative to the recomputed value** — the source is
 * the truth — and the comparison is strictly above the threshold, so a drift
 * exactly at it is corrected silently.
 *
 * @param drift - The cached and the recomputed value of one counter.
 * @param thresholdPercent - The configured threshold, in percent.
 * @returns `true` when the drift is above the threshold.
 */
export function isDriftSignificant(
  drift: { readonly cached: number; readonly actual: number },
  thresholdPercent: number
): boolean {
  const { cached, actual } = drift;
  const percent =
    actual === 0 ? (cached === 0 ? 0 : 100) : (Math.abs(cached - actual) / actual) * 100;
  return percent > thresholdPercent;
}

/** One corrected counter, as it is logged and alerted. */
interface Correction {
  readonly collection: string;
  readonly field: string;
  readonly cached: number;
  readonly actual: number;
}

/** A stored `tenants` row, as far as this job reads it. */
interface TenantRow {
  readonly _id?: unknown;
  readonly counters?: Record<string, unknown>;
}

/** A stored `events` row, as far as this job reads it. */
interface EventRow {
  readonly _id?: unknown;
  readonly status?: unknown;
  readonly counters?: Record<string, unknown>;
}

/** A stored `event_images` row, as far as this job reads it. */
interface EventImageRow {
  readonly eventId?: unknown;
  readonly processing?: { readonly status?: unknown };
}

/** A stored `attendee_event_profiles` row, as far as this job reads it. */
interface AttendeeProfileRow {
  readonly _id?: unknown;
  readonly matchCount?: unknown;
}

/** Read a stored counter, defaulting an absent or non-numeric value to zero. */
function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The hex form of a stored id, or `null`. */
function hexOf(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  return null;
}

/** Options for one reconcile invocation. */
interface ReconcileRunOptions {
  /** The database handle. */
  readonly db: Db;
  /** The clock `reconciledAt` and the alert dedupe day come from. */
  readonly clock: Clock;
  /** The logger every corrected delta is written through. */
  readonly logger: Logger;
  /** How many tenants this invocation may examine. */
  readonly limit: number;
}

/** The counters one tenant's events own, grouped by event id. */
interface EventImageCounts {
  total: number;
  processed: number;
  failed: number;
}

/**
 * Recompute and correct one tenant's cached counters from their sources.
 *
 * @param options - The database, clock, logger and tenant budget.
 * @returns The §10.2 run outcome.
 */
export async function counterReconcile(options: ReconcileRunOptions): Promise<CronRunOutcome> {
  const { db, clock, logger, limit } = options;
  const now = clock.now();
  const reconciledAt = now.toISOString();
  const dateKey = dateKeyInTimeZone(now, ROLLUP_TIME_ZONE);
  const settings = await getPlatformSettings({ db, clock });
  const threshold = settings.jobs.counterReconcile.driftThresholdPercent;

  const tenantsCollection = platformRepo(db).collection(COLLECTIONS.tenants);
  // Least-recently-reconciled first, so a population larger than the budget is
  // drained across runs instead of starving its tail (ADR-0918 §A18).
  const tenants = (await tenantsCollection
    .find({}, { sort: { "counters.reconciledAt": 1, _id: 1 }, limit })
    .toArray()) as unknown as TenantRow[];

  let scanned = 0;
  let affected = 0;
  let errors = 0;

  for (const tenant of tenants) {
    const tenantId = hexOf(tenant._id);
    if (tenantId === null) {
      errors += 1;
      continue;
    }
    scanned += 1;

    try {
      const corrections: Correction[] = [];
      const repository = tenantRepo(tenantId, db);

      const events = (await repository
        .collection(COLLECTIONS.events)
        .find({}, { projection: { status: 1, counters: 1 } })
        .toArray()) as unknown as EventRow[];
      const images = (await repository
        .collection(COLLECTIONS.eventImages)
        .find({}, { projection: { eventId: 1, processing: 1 } })
        .toArray()) as unknown as EventImageRow[];
      const profiles = (await repository
        .collection(COLLECTIONS.attendeeEventProfiles)
        .find({}, { projection: { matchCount: 1 } })
        .toArray()) as unknown as AttendeeProfileRow[];

      const imagesByEvent = new Map<string, EventImageCounts>();
      for (const image of images) {
        const eventId = hexOf(image.eventId);
        if (eventId === null) {
          continue;
        }
        const counts = imagesByEvent.get(eventId) ?? { total: 0, processed: 0, failed: 0 };
        counts.total += 1;
        if (image.processing?.status === "processed") {
          counts.processed += 1;
        }
        if (image.processing?.status === "failed") {
          counts.failed += 1;
        }
        imagesByEvent.set(eventId, counts);
      }

      // The tenant's four source-backed counters.
      const storedCounters = tenant.counters ?? {};
      const eventCount = events.length;
      const activeEventCount = events.filter((event) => event.status === "published").length;
      const imageCount = images.length;
      const attendeeCount = profiles.length;
      const reportTenant = (field: string, cached: unknown, actual: number): void => {
        if (toNumber(cached) !== actual) {
          corrections.push({
            collection: COLLECTIONS.tenants,
            field,
            cached: toNumber(cached),
            actual,
          });
        }
      };
      reportTenant("eventCount", storedCounters.eventCount, eventCount);
      reportTenant("activeEventCount", storedCounters.activeEventCount, activeEventCount);
      reportTenant("imageCount", storedCounters.imageCount, imageCount);
      reportTenant("attendeeCount", storedCounters.attendeeCount, attendeeCount);
      // A whole-block write keeps `approximate`/`storageBytes` intact.
      const tenantCounters = {
        ...storedCounters,
        eventCount,
        activeEventCount,
        imageCount,
        attendeeCount,
        reconciledAt,
      };

      // Each event's processing counters.
      const eventUpdates: { readonly _id: unknown; readonly counters: Record<string, unknown> }[] =
        [];
      for (const event of events) {
        const eventId = hexOf(event._id);
        if (eventId === null) {
          continue;
        }
        const counts = imagesByEvent.get(eventId) ?? { total: 0, processed: 0, failed: 0 };
        const stored = event.counters ?? {};
        const drifted =
          toNumber(stored.imageCount) !== counts.total ||
          toNumber(stored.processedImageCount) !== counts.processed ||
          toNumber(stored.failedImageCount) !== counts.failed;
        if (!drifted) {
          continue;
        }
        const reportEvent = (field: string, cached: unknown, actual: number): void => {
          if (toNumber(cached) !== actual) {
            corrections.push({
              collection: COLLECTIONS.events,
              field,
              cached: toNumber(cached),
              actual,
            });
          }
        };
        reportEvent("imageCount", stored.imageCount, counts.total);
        reportEvent("processedImageCount", stored.processedImageCount, counts.processed);
        reportEvent("failedImageCount", stored.failedImageCount, counts.failed);
        eventUpdates.push({
          _id: event._id,
          counters: {
            ...stored,
            imageCount: counts.total,
            processedImageCount: counts.processed,
            failedImageCount: counts.failed,
          },
        });
      }

      // Each attendee profile's published match count.
      const profileUpdates: { readonly _id: unknown; readonly actual: number }[] = [];
      if (profiles.length > 0) {
        const matchCounts = new Map<string, number>();
        const grouped = (await platformRepo(db)
          .collection(COLLECTIONS.faceMatches)
          .aggregate([
            { $match: { profileId: { $in: profiles.map((profile) => profile._id) } } },
            { $group: { _id: "$profileId", matches: { $sum: 1 } } },
          ])
          .toArray()) as unknown as { _id?: unknown; matches?: unknown }[];
        for (const row of grouped) {
          const profileId = hexOf(row._id);
          if (profileId !== null) {
            matchCounts.set(profileId, toNumber(row.matches));
          }
        }
        for (const profile of profiles) {
          const profileId = hexOf(profile._id);
          if (profileId === null) {
            continue;
          }
          const cached = toNumber(profile.matchCount);
          const actual = matchCounts.get(profileId) ?? 0;
          if (cached === actual) {
            continue;
          }
          profileUpdates.push({ _id: profile._id, actual });
          corrections.push({
            collection: COLLECTIONS.attendeeEventProfiles,
            field: "matchCount",
            cached,
            actual,
          });
        }
      }

      await tenantsCollection.updateOne(
        { _id: tenant._id },
        { $set: { counters: tenantCounters } }
      );
      for (const update of eventUpdates) {
        await repository
          .collection(COLLECTIONS.events)
          .updateOne({ _id: update._id }, { $set: { counters: update.counters } });
      }
      for (const update of profileUpdates) {
        await repository
          .collection(COLLECTIONS.attendeeEventProfiles)
          .updateOne({ _id: update._id }, { $set: { matchCount: update.actual } });
      }

      for (const correction of corrections) {
        affected += 1;
        logger.info("counter reconciled", {
          event: "counter.reconcile.corrected",
          collection: correction.collection,
          field: correction.field,
          cached: correction.cached,
          actual: correction.actual,
        });
        if (!isDriftSignificant(correction, threshold)) {
          continue;
        }
        await emitDomainEvent(
          {
            eventKey: "admin.abuse.flagged",
            tenantId,
            actorRef: { kind: "system", id: "counter-reconcile" },
            subjectRef: { kind: "tenant", id: tenantId },
            payload: {
              reason: "counter_drift",
              collection: correction.collection,
              field: correction.field,
              cached: correction.cached,
              actual: correction.actual,
            },
            dedupeKey: `counter.drift:${tenantId}:${correction.collection}:${correction.field}:${dateKey}`,
          },
          { db, clock }
        );
      }
    } catch (error) {
      errors += 1;
      logger.error("counter reconcile failed for one tenant", {
        event: "counter.reconcile.failed",
        tenantId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const unreconciled = await tenantsCollection.countDocuments({ "counters.reconciledAt": null });
  logger.info("counter reconcile completed", {
    event: "counter.reconcile.completed",
    tenants: scanned,
    corrections: affected,
    unreconciled,
  });

  return {
    scanned,
    affected,
    skipped: 0,
    errors,
    hasMore: unreconciled > 0,
    details: { corrections: affected, thresholdPercent: threshold },
  };
}

/**
 * `counter-reconcile` — daily 02:30 IST, 200 tenants per run (contract §10.2;
 * ADR-0918).
 */
export const counterReconcileJob: CronJob = defineCronJob({
  name: "counter-reconcile",
  defaultLimit: 200,
  maxLimit: 1000,
  run: ({ limit, clock, logger }) => counterReconcile({ db: getDb(), clock, logger, limit }),
});
