import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { retentionPurgeJob } from "@/server/jobs/retention-purge";
import { RETENTION_STEPS } from "@/server/jobs/sweep-decisions";
import { fixedClock } from "@/server/runtime/clock";
import { getObjectStorage } from "@/server/storage/get-object-storage";

import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { startTestApp, type TestApp } from "../helpers/authed-app";
import { recordingLogger, type RecordingLogger } from "../helpers/recording-logger";

/**
 * Integration / contract — `retention-purge`, the daily erase (OP-136,
 * contract §10.2 `retention-purge`; schema §22; ADR-0849).
 *
 * The user story: *as the data controller I want the erase to be ordered,
 * counted and resumable, so the deletion is provable evidence rather than a
 * TTL that may or may not have run.*
 *
 * ## The contract this file pins
 *
 * - `@/server/jobs/retention-purge` exports `retentionPurgeJob` (a
 *   `defineCronJob` declaration), and it handles every event whose
 *   `retentionExpiresAt < now` **or** whose `status` is `deleting`.
 * - The per-event erase follows `RETENTION_STEPS` exactly — storage objects →
 *   `imageFaces` → `faceMatches` → `eventImages` → `mediaAssets` → `selfies` →
 *   `profiles` — and each step writes one `retention.purge.step` info line
 *   carrying its `count`, which is the DSR evidence.
 * - The event's `purge` marker is `{ step, counts }`: `step` names the last
 *   completed step (so an interrupted run resumes on the next one) and
 *   `counts` is the per-step tally **removed or erased**; the final marker is
 *   `step: "done"` with a `completedAt`.
 * - A `mediaAssets` row that still holds another reference (`refCount > 1`)
 *   is **not** erased and its object is **not** deleted; the reference count is
 *   decremented instead.
 * - Consents are evidence and are never deleted by this job.
 * - Two further phases run after the events, each a `retention.purge.step`
 *   line: `expiredSelfies` (an unconfirmed selfie past its own `expireAt`, with
 *   its embedding, provisional `face_matches` and `mediaAssets` reference) and
 *   `anonymousSessions` (an expired anonymous session's profiles and selfies).
 * - `CronResult.details` carries `{ events, expiredSelfies, anonymousSessions }`.
 */

const DAY_MS = 86_400_000;

/** The instant every run in this file is timed at. */
const NOW = new Date("2026-11-17T09:00:00.000Z");

let app: TestApp;

/** A sha256-shaped content hash for a fixture's bytes. */
function contentHash(seed: string): string {
  return seed.padEnd(64, "0").slice(0, 64);
}

/** One tenant key shared inside a case. */
function newTenant(): string {
  return new ObjectId().toHexString();
}

/** Seed one event. */
async function seedEvent(
  tenantKey: string,
  extra: Record<string, unknown> = {}
): Promise<ObjectId> {
  const eventId = new ObjectId();
  await app.db.collection(COLLECTIONS.events).insertOne({
    _id: eventId,
    tenantId: tenantKey,
    name: `event-${eventId.toHexString()}`,
    status: "published",
    startAt: new Date(NOW.getTime() - 40 * DAY_MS),
    endAt: new Date(NOW.getTime() - 39 * DAY_MS),
    displayTimeZone: "Asia/Kolkata",
    uploadWindowEndsAt: new Date(NOW.getTime() - 30 * DAY_MS),
    retentionExpiresAt: new Date(NOW.getTime() - DAY_MS),
    accessLinks: [],
    counters: { imageCount: 0, processedImageCount: 0, failedImageCount: 0 },
    createdAt: new Date(NOW.getTime() - 60 * DAY_MS),
    ...extra,
  });
  return eventId;
}

/** One seeded media asset's observable facts. */
interface SeededAsset {
  readonly assetId: ObjectId;
  readonly objectKey: string;
  readonly thumbnailKey: string;
}

/** Seed one `media_assets` row and write both of its objects. */
async function seedImageAsset(
  tenantKey: string,
  hash: string,
  refCount: number
): Promise<SeededAsset> {
  const assetId = new ObjectId();
  const objectKey = `images/${hash}.jpg`;
  const thumbnailKey = `thumbnails/${hash}.webp`;
  await app.db.collection(COLLECTIONS.mediaAssets).insertOne({
    _id: assetId,
    tenantId: tenantKey,
    contentHash: hash,
    kind: "event_image",
    storage: {
      locationKey: "originals",
      objectKey,
      bytes: 1_024,
      contentType: "image/jpeg",
      checksum: hash,
      storedAt: NOW,
    },
    derivatives: {
      thumbnail: {
        locationKey: "thumbnails",
        objectKey: thumbnailKey,
        bytes: 64,
        width: 400,
        height: 600,
        format: "webp",
        processorVersion: 1,
        watermarkVersion: null,
        generatedAt: NOW,
      },
    },
    status: "derivatives_ready",
    refCount,
    createdAt: NOW,
  });
  await getObjectStorage().putObject("originals", objectKey, new Uint8Array([1]), "image/jpeg");
  await getObjectStorage().putObject("thumbnails", thumbnailKey, new Uint8Array([2]), "image/webp");
  return { assetId, objectKey, thumbnailKey };
}

/** Seed one `event_images` row that references an asset. */
async function seedImage(
  tenantKey: string,
  eventId: ObjectId,
  assetId: ObjectId
): Promise<ObjectId> {
  const imageId = new ObjectId();
  await app.db.collection(COLLECTIONS.eventImages).insertOne({
    _id: imageId,
    tenantId: tenantKey,
    eventId,
    assetId,
    uploadedByUserId: null,
    uploadBatchId: new ObjectId(),
    sequence: 1,
    processing: {
      status: "done",
      priority: "normal",
      attempts: 1,
      maxAttempts: 5,
      leaseExpiresAt: null,
      workerId: null,
      queuedAt: NOW,
      startedAt: NOW,
      finishedAt: NOW,
      durationMs: 0,
      lastError: null,
    },
    faceCount: 1,
    visibility: "visible",
    createdAt: NOW,
    deletedAt: null,
  });
  return imageId;
}

/** Seed one `selfies` row plus its asset and object. */
async function seedSelfie(
  tenantKey: string,
  eventId: ObjectId,
  profileId: ObjectId,
  options: { readonly isActive: boolean; readonly expireAt: Date }
): Promise<{ readonly selfieId: ObjectId; readonly hash: string; readonly assetId: ObjectId }> {
  const selfieId = new ObjectId();
  const hash = contentHash(selfieId.toHexString());
  const assetId = new ObjectId();
  await app.db.collection(COLLECTIONS.mediaAssets).insertOne({
    _id: assetId,
    tenantId: tenantKey,
    contentHash: hash,
    kind: "selfie",
    status: "stored",
    purgedAt: null,
    refCount: 1,
    createdAt: NOW,
  });
  await getObjectStorage().putObject(
    "originals",
    `selfies/${hash}`,
    new Uint8Array([3]),
    "image/jpeg"
  );
  await app.db.collection(COLLECTIONS.selfies).insertOne({
    _id: selfieId,
    tenantId: tenantKey,
    eventId,
    profileId,
    subject: { kind: "anonymous", attendeeSessionId: new ObjectId().toHexString() },
    contentHash: hash,
    assetId,
    liveness: { required: true, challengeKind: "gesture" },
    processing: {
      status: "done",
      priority: "high",
      attempts: 1,
      maxAttempts: 5,
      leaseExpiresAt: null,
      workerId: null,
      queuedAt: NOW,
      startedAt: NOW,
      finishedAt: NOW,
      durationMs: 0,
      lastError: null,
    },
    isActive: options.isActive,
    embedding: [0.11, 0.22, 0.33],
    quality: { faceCount: 1, accepted: true },
    createdAt: new Date(NOW.getTime() - 100 * DAY_MS),
    expireAt: options.expireAt,
  });
  return { selfieId, hash, assetId };
}

/** Seed one `attendeeEventProfiles` row. */
async function seedProfile(
  tenantKey: string,
  eventId: ObjectId,
  subject: Record<string, unknown> = {
    kind: "anonymous",
    attendeeSessionId: new ObjectId().toHexString(),
  }
): Promise<ObjectId> {
  const profileId = new ObjectId();
  await app.db.collection(COLLECTIONS.attendeeEventProfiles).insertOne({
    _id: profileId,
    tenantId: tenantKey,
    eventId,
    subject,
    status: "ready",
    activeSelfieId: null,
    matchCount: 0,
    lastMatchRunAt: NOW,
    createdAt: NOW,
  });
  return profileId;
}

/** Seed one `faceMatches` row. */
async function seedMatch(input: {
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly profileId: ObjectId;
  readonly imageId: ObjectId | null;
  readonly selfieId: ObjectId | null;
}): Promise<ObjectId> {
  const matchId = new ObjectId();
  await app.db.collection(COLLECTIONS.faceMatches).insertOne({
    _id: matchId,
    tenantId: input.tenantKey,
    eventId: input.eventId,
    profileId: input.profileId,
    subject: { kind: "anonymous", attendeeSessionId: new ObjectId().toHexString() },
    imageId: input.imageId,
    faceIndex: 0,
    selfieId: input.selfieId,
    similarity: 0.9,
    confidence: "strong",
    spaceKey: "arcface_r100_512",
    modelKey: "antelopev2",
    seenAt: null,
    hiddenAt: null,
    createdAt: NOW,
  });
  return matchId;
}

/** The `retention.purge.step` lines a run recorded, in order. */
function eraseSteps(logger: RecordingLogger): Record<string, unknown>[] {
  return logger.entriesForEvent("retention.purge.step").map((entry) => entry.fields);
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op136-retention-purge" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all(
    [
      COLLECTIONS.events,
      COLLECTIONS.eventImages,
      COLLECTIONS.mediaAssets,
      COLLECTIONS.faceMatches,
      COLLECTIONS.selfies,
      COLLECTIONS.attendeeEventProfiles,
      COLLECTIONS.attendeeSessions,
      COLLECTIONS.domainEvents,
      "imageFaces",
    ].map((name) => app.db.collection(name).deleteMany({}))
  );
});

afterAll(async () => {
  await app.cleanup();
});

describe("retention-purge: an expired event", () => {
  /**
   * Seed one expired event with every kind of row the erase touches, including
   * an asset another event still references.
   */
  async function seedExpiredEvent(): Promise<{
    readonly tenantKey: string;
    readonly eventId: ObjectId;
    readonly ownAsset: SeededAsset;
    readonly sharedAsset: SeededAsset;
    readonly selfieHash: string;
  }> {
    const tenantKey = newTenant();
    const eventId = await seedEvent(tenantKey);

    // An asset this event owns alone, and one it shares with another event.
    const ownAsset = await seedImageAsset(tenantKey, contentHash("a"), 1);
    const sharedAsset = await seedImageAsset(tenantKey, contentHash("b"), 2);
    const ownImage = await seedImage(tenantKey, eventId, ownAsset.assetId);
    const sharedImage = await seedImage(tenantKey, eventId, sharedAsset.assetId);

    // The second event holding the other reference to the shared asset.
    const otherEventId = await seedEvent(tenantKey, {
      name: "other-event",
      retentionExpiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
    });
    await seedImage(tenantKey, otherEventId, sharedAsset.assetId);

    // Face vectors, matches, a selfie and the profile.
    for (const faceIndex of [0, 1, 2]) {
      await app.db.collection("imageFaces").insertOne({
        _id: new ObjectId(),
        tenantId: tenantKey,
        eventId,
        imageId: ownImage,
        faceIndex,
        spaceKey: "arcface_r100_512",
        createdAt: NOW,
      });
    }
    const profileId = await seedProfile(tenantKey, eventId);
    await seedMatch({
      tenantKey,
      eventId,
      profileId,
      imageId: ownImage,
      selfieId: null,
    });
    const selfie = await seedSelfie(tenantKey, eventId, profileId, {
      isActive: true,
      expireAt: new Date(NOW.getTime() + 30 * DAY_MS),
    });
    await seedMatch({
      tenantKey,
      eventId,
      profileId,
      imageId: sharedImage,
      selfieId: selfie.selfieId,
    });

    return {
      tenantKey,
      eventId,
      ownAsset,
      sharedAsset,
      selfieHash: selfie.hash,
    };
  }

  it("I5a: erases in the documented order, counts each step and marks the event done", async () => {
    const world = await seedExpiredEvent();
    const logger = recordingLogger();

    // ── Act ──
    const result = await retentionPurgeJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger,
    });

    // ── Assert: the step order and the per-step counts are the evidence ──
    const eraseLines = eraseSteps(logger).filter(
      (fields) => fields.step !== "expiredSelfies" && fields.step !== "anonymousSessions"
    );

    expect(eraseLines.map((fields) => fields.step)).toEqual([...RETENTION_STEPS]);
    expect(eraseLines.map((fields) => fields.count)).toEqual([
      3, // storage: the owned asset's original + thumbnail, and the selfie object
      3, // imageFaces
      2, // faceMatches
      2, // eventImages
      1, // mediaAssets erased (the shared row is only decremented)
      1, // selfies
      1, // profiles
    ]);
    expect(result.job).toBe("retention-purge");
    expect(result.details?.events).toBe(1);

    // ── Assert: the durable marker ──
    const event = await app.db.collection(COLLECTIONS.events).findOne({ _id: world.eventId });
    const purge = event?.purge as Record<string, unknown>;
    expect(purge.step).toBe("done");
    expect(purge.completedAt).toBeInstanceOf(Date);
    expect(purge.counts).toEqual({
      storage: 3,
      imageFaces: 3,
      faceMatches: 2,
      eventImages: 2,
      mediaAssets: 1,
      selfies: 1,
      profiles: 1,
    });
  });

  it("I5b: never erases an asset another event still references, and keeps its bytes", async () => {
    const world = await seedExpiredEvent();

    // ── Act ──
    await retentionPurgeJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: the shared row survives at refCount 1 with its object readable ──
    const shared = await app.db
      .collection(COLLECTIONS.mediaAssets)
      .findOne({ _id: world.sharedAsset.assetId });
    expect(shared).not.toBeNull();
    expect(shared?.refCount).toBe(1);
    expect(
      await getObjectStorage()
        .getObject("originals", world.sharedAsset.objectKey)
        .then(() => "readable")
        .catch(() => "gone")
    ).toBe("readable");

    // ── Assert: the owned row is gone and both of its objects are too ──
    expect(
      await app.db.collection(COLLECTIONS.mediaAssets).findOne({ _id: world.ownAsset.assetId })
    ).toBeNull();
    await expect(
      getObjectStorage().getObject("originals", world.ownAsset.objectKey)
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      getObjectStorage().getObject("thumbnails", world.ownAsset.thumbnailKey)
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("I5c: resumes at the step after the stored marker and keeps the earlier counts", async () => {
    const tenantKey = newTenant();
    const eventId = await seedEvent(tenantKey, {
      purge: {
        step: "faceMatches",
        counts: {
          storage: 2,
          imageFaces: 3,
          faceMatches: 0,
          eventImages: 0,
          mediaAssets: 0,
          selfies: 0,
          profiles: 0,
        },
      },
    });
    const asset = await seedImageAsset(tenantKey, contentHash("c"), 1);
    await seedImage(tenantKey, eventId, asset.assetId);
    await app.db.collection("imageFaces").insertOne({
      _id: new ObjectId(),
      tenantId: tenantKey,
      eventId,
      imageId: new ObjectId(),
      faceIndex: 0,
      spaceKey: "arcface_r100_512",
      createdAt: NOW,
    });
    const logger = recordingLogger();

    // ── Act ──
    await retentionPurgeJob.run({ requestedLimit: null, clock: fixedClock(NOW), logger });

    // ── Assert: the run starts at eventImages, not at storage ──
    expect(eraseSteps(logger).map((fields) => fields.step)).toEqual([
      "eventImages",
      "mediaAssets",
      "selfies",
      "profiles",
    ]);

    // ── Assert: the earlier tally is preserved, the new steps are added ──
    const event = await app.db.collection(COLLECTIONS.events).findOne({ _id: eventId });
    const purge = event?.purge as Record<string, unknown>;
    expect(purge.step).toBe("done");
    expect(purge.counts).toMatchObject({
      storage: 2,
      imageFaces: 3,
      eventImages: 1,
      mediaAssets: 1,
    });
  });

  it("I12: leaves zero selfies, zero embeddings and zero matches for the purged event", async () => {
    const world = await seedExpiredEvent();

    // ── Act ──
    await retentionPurgeJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: nothing biometric survives the event ──
    expect(
      await app.db.collection(COLLECTIONS.selfies).countDocuments({ eventId: world.eventId })
    ).toBe(0);
    expect(
      await app.db
        .collection(COLLECTIONS.selfies)
        .countDocuments({ eventId: world.eventId, embedding: { $exists: true } })
    ).toBe(0);
    expect(
      await app.db.collection(COLLECTIONS.faceMatches).countDocuments({ eventId: world.eventId })
    ).toBe(0);
    expect(
      await app.db
        .collection(COLLECTIONS.attendeeEventProfiles)
        .countDocuments({ eventId: world.eventId })
    ).toBe(0);
  });
});

describe("retention-purge: expired selfies and anonymous sessions", () => {
  it("I11: erases an unconfirmed selfie past its TTL with its embedding, provisional matches and counts", async () => {
    const tenantKey = newTenant();
    const eventId = await seedEvent(tenantKey, {
      retentionExpiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
    });
    const profileId = await seedProfile(tenantKey, eventId);
    const selfie = await seedSelfie(tenantKey, eventId, profileId, {
      isActive: false,
      expireAt: new Date(NOW.getTime() - DAY_MS),
    });
    await seedMatch({
      tenantKey,
      eventId,
      profileId,
      imageId: null,
      selfieId: selfie.selfieId,
    });
    const logger = recordingLogger();

    // ── Act ──
    const result = await retentionPurgeJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger,
    });

    // ── Assert: the row, its vector, its matches and its bytes are gone ──
    expect(
      await app.db.collection(COLLECTIONS.selfies).findOne({ _id: selfie.selfieId })
    ).toBeNull();
    expect(
      await app.db.collection(COLLECTIONS.faceMatches).countDocuments({ selfieId: selfie.selfieId })
    ).toBe(0);
    expect(
      await app.db.collection(COLLECTIONS.mediaAssets).findOne({ _id: selfie.assetId })
    ).toBeNull();
    await expect(
      getObjectStorage().getObject("originals", `selfies/${selfie.hash}`)
    ).rejects.toMatchObject({ code: "not_found" });

    // ── Assert: the counts are logged as the DSR evidence ──
    const leg = eraseSteps(logger).find((fields) => fields.step === "expiredSelfies");
    expect(leg).toBeDefined();
    expect(leg?.counts).toEqual({ selfies: 1, embeddings: 1, matches: 1 });
    expect(result.details?.expiredSelfies).toBe(1);
  });

  it("keeps a confirmed selfie inside its retention window", async () => {
    const tenantKey = newTenant();
    const eventId = await seedEvent(tenantKey, {
      retentionExpiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
    });
    const profileId = await seedProfile(tenantKey, eventId);
    const selfie = await seedSelfie(tenantKey, eventId, profileId, {
      isActive: true,
      expireAt: new Date(NOW.getTime() + 30 * DAY_MS),
    });

    await retentionPurgeJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    expect(
      await app.db.collection(COLLECTIONS.selfies).findOne({ _id: selfie.selfieId })
    ).not.toBeNull();
  });

  it("I13: erases an expired anonymous session's profiles and selfies", async () => {
    const tenantKey = newTenant();
    const eventId = await seedEvent(tenantKey, {
      retentionExpiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
    });
    const sessionId = new ObjectId();
    await app.db.collection(COLLECTIONS.attendeeSessions).insertOne({
      _id: sessionId,
      tokenHash: contentHash("session"),
      claimedByUserId: null,
      claimedAt: null,
      eventIds: [eventId],
      deviceFingerprint: { uaHash: "ua", ipHash: "ip", acceptLangHash: "lang" },
      createdAt: new Date(NOW.getTime() - 40 * DAY_MS),
      lastSeenAt: new Date(NOW.getTime() - 40 * DAY_MS),
      expireAt: new Date(NOW.getTime() - DAY_MS),
    });
    const subject = { kind: "anonymous", attendeeSessionId: sessionId.toHexString() };
    const profileId = await seedProfile(tenantKey, eventId, subject);
    const selfie = await seedSelfie(tenantKey, eventId, profileId, {
      isActive: false,
      expireAt: new Date(NOW.getTime() + 30 * DAY_MS),
    });
    // The selfie row must carry the same subject for the session leg to find it.
    await app.db
      .collection(COLLECTIONS.selfies)
      .updateOne({ _id: selfie.selfieId }, { $set: { subject } });
    const logger = recordingLogger();

    // ── Act ──
    const result = await retentionPurgeJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger,
    });

    // ── Assert: the session's profile and selfie are gone ──
    expect(
      await app.db.collection(COLLECTIONS.attendeeEventProfiles).findOne({ _id: profileId })
    ).toBeNull();
    expect(
      await app.db.collection(COLLECTIONS.selfies).findOne({ _id: selfie.selfieId })
    ).toBeNull();

    // ── Assert: the leg and its counts are logged ──
    const leg = eraseSteps(logger).find((fields) => fields.step === "anonymousSessions");
    expect(leg).toBeDefined();
    expect(leg?.counts).toMatchObject({ sessions: 1, selfies: 1, profiles: 1 });
    expect(result.details?.anonymousSessions).toBe(1);
  });
});

describe("retention-purge: bounded invocation", () => {
  it("I10: honours ?limit=1 over three due events, reporting affected 1 and hasMore true", async () => {
    const tenantKey = newTenant();
    for (const seed of ["d", "e", "f"]) {
      await seedEvent(tenantKey, { name: `due-${seed}` });
    }

    // ── Act ──
    const result = await retentionPurgeJob.run({
      requestedLimit: "1",
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: one event erased, the backlog signalled, the rest untouched ──
    expect(result.affected).toBe(1);
    expect(result.hasMore).toBe(true);
    expect(
      await app.db.collection(COLLECTIONS.events).countDocuments({ "purge.step": "done" })
    ).toBe(1);
    expect(
      await app.db
        .collection(COLLECTIONS.events)
        .countDocuments({ "purge.step": { $exists: false } })
    ).toBe(2);
  });
});
