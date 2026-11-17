import { ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineCronJob, type CronJob, type CronRunOutcome } from "@/server/jobs/cron-job";
import { platformRepo } from "@/server/repos";
import { getObjectStorage } from "@/server/storage/get-object-storage";
import { isStorageLocationKey } from "@/server/storage/locations";
import type { ObjectStorage } from "@/server/storage/object-storage";

import { ERASE_DONE, nextEraseStep, type RetentionStep } from "./sweep-decisions";
import type { SweepJobRunOptions } from "./run-options";

/**
 * `retention-purge` — the daily ordered erase (OP-136, contract §10.2
 * `retention-purge`, schema §22; ADR-0849 §4).
 *
 * The erase is **ordered, counted and resumable**, and it is never a TTL: the
 * per-step `retention.purge.step` line is the DSR evidence, and `event.purge`
 * carries the last completed step so an interrupted run resumes on the next one
 * with its earlier counts intact. It handles every event whose retention has
 * elapsed **or** whose delete is scheduled (a user-initiated delete is never
 * gated on the retention clock), then two job-level legs: unconfirmed selfies
 * past their own TTL and expired anonymous sessions.
 *
 * Consents are evidence: the `consents` collection is never touched here.
 */

/** The `event.purge` progress marker (ADR-0849 §4). */
interface PurgeMarker {
  readonly step?: string | null;
  readonly counts?: Readonly<Record<string, number>>;
  readonly imageAssetIds?: readonly string[];
}

/** The event fields this job reads. */
interface RetentionEventRow {
  readonly _id: ObjectId;
  readonly purge?: PurgeMarker;
}

/** Everything one event's erase needs. */
interface EraseContext {
  readonly db: SweepJobRunOptions["db"];
  readonly logger: SweepJobRunOptions["logger"];
  readonly eventId: ObjectId;
  readonly imageAssetIds: readonly string[];
  readonly storage: ObjectStorage;
}

/** Narrow a stored event, or `null`. */
function asRetentionEventRow(value: unknown): RetentionEventRow | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Partial<RetentionEventRow>;
  if (!(row._id instanceof ObjectId)) {
    return null;
  }
  const purge = (value as { readonly purge?: unknown }).purge;
  const marker = typeof purge === "object" && purge !== null ? (purge as PurgeMarker) : undefined;
  return { _id: row._id, ...(marker === undefined ? {} : { purge: marker }) };
}

/** Read one stored key off a raw media asset, when it is a string. */
function keyOf(value: unknown, ...path: readonly string[]): string | null {
  let cursor: unknown = value;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null) {
      return null;
    }
    cursor = Object.entries(cursor).find(([key]) => key === segment)?.[1];
  }
  return typeof cursor === "string" ? cursor : null;
}

/** The id of a raw document's `_id`, when it is an `ObjectId`. */
function objectIdOf(value: unknown): ObjectId | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const id = (value as { readonly _id?: unknown })._id;
  return id instanceof ObjectId ? id : null;
}

/**
 * Delete one logical object, tolerating a store that has already lost it.
 *
 * @returns `1`, so the caller can tally objects without a second read.
 */
async function deleteObject(
  storage: ObjectStorage,
  locationKey: unknown,
  objectKey: string | null
): Promise<number> {
  if (objectKey === null || typeof locationKey !== "string" || !isStorageLocationKey(locationKey)) {
    return 0;
  }
  await storage.deleteObject(locationKey, objectKey);
  return 1;
}

/**
 * Run one erase step and return how many rows or objects it removed.
 *
 * @param step - The step to run.
 * @param context - The event, its image assets and the storage port.
 * @returns The step's count.
 */
async function eraseStep(step: RetentionStep, context: EraseContext): Promise<number> {
  const platform = platformRepo(context.db);
  const { eventId, storage } = context;
  const assetIds = context.imageAssetIds.map((id) => new ObjectId(id));

  switch (step) {
    case "storage": {
      let count = 0;
      const assets = await platform
        .collection(COLLECTIONS.mediaAssets)
        .find({ _id: { $in: assetIds } })
        .toArray();
      for (const asset of assets) {
        if (asset.refCount > 1) {
          continue;
        }
        count += await deleteObject(
          storage,
          keyOf(asset, "storage", "locationKey"),
          keyOf(asset, "storage", "objectKey")
        );
        count += await deleteObject(
          storage,
          keyOf(asset, "derivatives", "thumbnail", "locationKey"),
          keyOf(asset, "derivatives", "thumbnail", "objectKey")
        );
      }
      // The selfie objects live under their own content-addressed key, so they
      // are erased here rather than from the asset row's storage block.
      const selfieAssets = await platform
        .collection(COLLECTIONS.mediaAssets)
        .find({ kind: "selfie", _id: { $in: await selfieAssetIds(platform, eventId) } })
        .toArray();
      for (const asset of selfieAssets) {
        if (asset.refCount > 1) {
          continue;
        }
        count += await deleteObject(storage, "originals", `selfies/${String(asset.contentHash)}`);
      }
      return count;
    }
    case "imageFaces":
      return (await platform.collection("imageFaces").deleteMany({ eventId })).deletedCount;
    case "faceMatches":
      return (await platform.collection(COLLECTIONS.faceMatches).deleteMany({ eventId }))
        .deletedCount;
    case "eventImages":
      return (await platform.collection(COLLECTIONS.eventImages).deleteMany({ eventId }))
        .deletedCount;
    case "mediaAssets": {
      let count = 0;
      const assets = platform.collection(COLLECTIONS.mediaAssets);
      for (const id of assetIds) {
        const row = (await assets.findOne({ _id: id })) as { readonly refCount?: number } | null;
        if (row === null) {
          continue;
        }
        if ((row.refCount ?? 0) > 1) {
          // Another event still serves these bytes: drop this reference only.
          await assets.updateOne({ _id: id }, { $inc: { refCount: -1 } });
          continue;
        }
        await assets.deleteOne({ _id: id });
        count += 1;
      }
      return count;
    }
    case "selfies": {
      const erased = await platform.collection(COLLECTIONS.selfies).deleteMany({ eventId });
      // The selfie rows own their asset rows; the objects went with the storage
      // step, so only the rows are left to drop here.
      const assetRows = await selfieAssetIds(platform, eventId);
      if (assetRows.length > 0) {
        await platform.collection(COLLECTIONS.mediaAssets).deleteMany({ _id: { $in: assetRows } });
      }
      return erased.deletedCount;
    }
    case "profiles":
      return (await platform.collection(COLLECTIONS.attendeeEventProfiles).deleteMany({ eventId }))
        .deletedCount;
  }
}

/**
 * The `mediaAssets` ids the event's selfies point at.
 *
 * @param platform - The platform repository accessor.
 * @param eventId - The event whose selfies are read.
 * @returns The asset ids, ready for an `$in`.
 */
async function selfieAssetIds(
  platform: ReturnType<typeof platformRepo>,
  eventId: ObjectId
): Promise<ObjectId[]> {
  const selfies = await platform
    .collection(COLLECTIONS.selfies)
    .find({ eventId }, { projection: { assetId: 1 } })
    .toArray();
  return selfies
    .map((selfie) => (selfie as { readonly assetId?: unknown }).assetId)
    .filter((assetId): assetId is ObjectId => assetId instanceof ObjectId);
}

/**
 * Erase one event, resuming on the step after its stored marker.
 *
 * @param row - The event and its current marker.
 * @param options - The seam and the run instant.
 * @returns `true` when the erase reached its terminal marker.
 */
async function eraseEvent(
  row: RetentionEventRow,
  options: SweepJobRunOptions,
  now: Date
): Promise<boolean> {
  const { db, logger } = options;
  const platform = platformRepo(db);
  const events = platform.collection(COLLECTIONS.events);
  const counts = new Map<string, number>(Object.entries(row.purge?.counts ?? {}));

  // The image assets are read before the image rows are erased; the marker
  // carries them so a resume that begins after `eventImages` can still erase
  // the assets it no longer has rows for.
  let imageAssetIds = row.purge?.imageAssetIds ?? [];
  if (row.purge?.imageAssetIds === undefined) {
    const images = await platform
      .collection(COLLECTIONS.eventImages)
      .find({ eventId: row._id }, { projection: { assetId: 1 } })
      .toArray();
    imageAssetIds = images
      .map((image) => objectIdOf({ _id: (image as { readonly assetId?: unknown }).assetId }))
      .filter((id): id is ObjectId => id !== null)
      .map((id) => id.toHexString());
    await events.updateOne({ _id: row._id }, { $set: { "purge.imageAssetIds": imageAssetIds } });
  }

  const context: EraseContext = {
    db,
    logger,
    eventId: row._id,
    imageAssetIds,
    storage: getObjectStorage(),
  };

  let step = nextEraseStep(row.purge);
  while (step !== null) {
    let count: number;
    try {
      count = await eraseStep(step, context);
    } catch (error) {
      logger.error("retention purge step failed", {
        event: "retention.purge.failed",
        eventId: row._id.toHexString(),
        step,
        err: error,
      });
      return false;
    }
    counts.set(step, count);
    logger.info("retention purge step", {
      event: "retention.purge.step",
      eventId: row._id.toHexString(),
      step,
      count,
    });
    await events.updateOne(
      { _id: row._id },
      { $set: { "purge.step": step, "purge.counts": Object.fromEntries(counts) } }
    );
    step = nextEraseStep({ step });
  }

  await events.updateOne(
    { _id: row._id },
    {
      $set: {
        "purge.step": ERASE_DONE,
        "purge.completedAt": now,
        "purge.counts": Object.fromEntries(counts),
      },
    }
  );
  return true;
}

/**
 * The `expiredSelfies` leg: unconfirmed selfies past their own `expireAt`.
 *
 * @returns The line's counts, and `null` when nothing was due.
 */
async function purgeExpiredSelfies(
  options: SweepJobRunOptions,
  now: Date
): Promise<{ readonly counts: Record<string, number>; readonly erased: number }> {
  const { db, limit } = options;
  const platform = platformRepo(db);
  const storage = getObjectStorage();
  const selfies = platform.collection(COLLECTIONS.selfies);

  const due = await selfies
    .find({ isActive: false, expireAt: { $lt: now } })
    .limit(limit)
    .toArray();
  if (due.length === 0) {
    return { counts: { selfies: 0, embeddings: 0, matches: 0 }, erased: 0 };
  }

  let erased = 0;
  let embeddings = 0;
  let matches = 0;
  for (const selfie of due) {
    const selfieId = objectIdOf(selfie);
    if (selfieId === null) {
      continue;
    }
    const assetId = (selfie as { readonly assetId?: unknown }).assetId;
    if (typeof (selfie as { readonly contentHash?: unknown }).contentHash === "string") {
      await deleteObject(storage, "originals", `selfies/${String(selfie.contentHash)}`);
    }
    if (assetId instanceof ObjectId) {
      await platform.collection(COLLECTIONS.mediaAssets).deleteOne({ _id: assetId });
    }
    matches += (await platform.collection(COLLECTIONS.faceMatches).deleteMany({ selfieId }))
      .deletedCount;
    const removed = await selfies.deleteOne({ _id: selfieId });
    if (removed.deletedCount === 1) {
      erased += 1;
      if ((selfie as { readonly embedding?: unknown }).embedding !== undefined) {
        embeddings += 1;
      }
    }
  }
  return { counts: { selfies: erased, embeddings, matches }, erased };
}

/**
 * The `anonymousSessions` leg: an expired, unclaimed anonymous session's
 * profiles and selfies.
 *
 * @returns The line's counts, and `null` when nothing was due.
 */
async function purgeAnonymousSessions(
  options: SweepJobRunOptions,
  now: Date
): Promise<{ readonly counts: Record<string, number>; readonly erased: number }> {
  const { db, limit } = options;
  const platform = platformRepo(db);
  const storage = getObjectStorage();

  const sessions = await platform
    .collection(COLLECTIONS.attendeeSessions)
    .find({ claimedByUserId: null, expireAt: { $lt: now } })
    .limit(limit)
    .toArray();
  if (sessions.length === 0) {
    return { counts: { sessions: 0, selfies: 0, profiles: 0 }, erased: 0 };
  }

  let sessionCount = 0;
  let selfieCount = 0;
  let profileCount = 0;
  for (const session of sessions) {
    const sessionId = objectIdOf(session);
    if (sessionId === null) {
      continue;
    }
    const subject = { "subject.attendeeSessionId": sessionId.toHexString() };
    const selfieRows = await platform.collection(COLLECTIONS.selfies).find(subject).toArray();
    for (const selfie of selfieRows) {
      if (typeof (selfie as { readonly contentHash?: unknown }).contentHash === "string") {
        await deleteObject(storage, "originals", `selfies/${String(selfie.contentHash)}`);
      }
      const assetId = (selfie as { readonly assetId?: unknown }).assetId;
      if (assetId instanceof ObjectId) {
        await platform.collection(COLLECTIONS.mediaAssets).deleteOne({ _id: assetId });
      }
    }
    selfieCount += (await platform.collection(COLLECTIONS.selfies).deleteMany(subject))
      .deletedCount;
    profileCount += (
      await platform.collection(COLLECTIONS.attendeeEventProfiles).deleteMany(subject)
    ).deletedCount;
    sessionCount += 1;
  }
  return {
    counts: { sessions: sessionCount, selfies: selfieCount, profiles: profileCount },
    erased: sessionCount,
  };
}

/**
 * Erase every due event, then run the two job-level legs.
 *
 * @param options - Database/clock/logger seam and the per-run limit.
 * @returns The §10.2 run outcome with `{ events, expiredSelfies, anonymousSessions }`.
 */
export async function retentionPurge(options: SweepJobRunOptions): Promise<CronRunOutcome> {
  const { db, clock, logger, limit } = options;
  const now = clock.now();
  const events = platformRepo(db).collection(COLLECTIONS.events);

  const raw: unknown = await events
    .find({
      "purge.step": { $ne: ERASE_DONE },
      $or: [{ retentionExpiresAt: { $lt: now } }, { status: "deleting" }],
    })
    .limit(limit)
    .toArray();
  const candidates = Array.isArray(raw)
    ? raw.map(asRetentionEventRow).filter((row): row is RetentionEventRow => row !== null)
    : [];

  let affected = 0;
  let errors = 0;
  for (const row of candidates) {
    if (await eraseEvent(row, options, now)) {
      affected += 1;
    } else {
      errors += 1;
    }
  }

  const expired = await purgeExpiredSelfies(options, now);
  if (expired.erased > 0) {
    logger.info("retention purge step", {
      event: "retention.purge.step",
      step: "expiredSelfies",
      counts: expired.counts,
    });
  }
  const anonymous = await purgeAnonymousSessions(options, now);
  if (anonymous.erased > 0) {
    logger.info("retention purge step", {
      event: "retention.purge.step",
      step: "anonymousSessions",
      counts: anonymous.counts,
    });
  }

  const scanned = candidates.length;
  logger.info("retention purge completed", {
    event: "retention.purge.completed",
    events: affected,
    expiredSelfies: expired.erased,
    anonymousSessions: anonymous.erased,
  });
  return {
    scanned,
    affected,
    skipped: scanned - affected - errors,
    errors,
    hasMore: scanned >= limit,
    details: {
      events: affected,
      expiredSelfies: expired.erased,
      anonymousSessions: anonymous.erased,
    },
  };
}

/**
 * `retention-purge` — daily, 50 events by default (contract §10.2; ADR-0849 §1).
 *
 * Registered in `apps/web/vercel.json`; the run closes over the shared database
 * handle and forwards the framework's clamped limit and injected clock.
 */
export const retentionPurgeJob: CronJob = defineCronJob({
  name: "retention-purge",
  defaultLimit: 50,
  maxLimit: 100,
  run: ({ limit, clock, logger }) => retentionPurge({ db: getDb(), clock, logger, limit }),
});
