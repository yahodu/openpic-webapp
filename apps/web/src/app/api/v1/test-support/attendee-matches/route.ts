import { ObjectId } from "mongodb";
import { z } from "zod";

import { getAppEnv } from "@/server/config/env";
import { isTestOtpRouteEnabled } from "@/server/auth/test-route";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { toErrorEnvelope } from "@/server/http/app-error";
import { appError, isAppError } from "@/server/http/errors";
import { toFieldErrors } from "@/server/http/validation";
import { resolveEventBySlug } from "@/server/attendee/request-event";
import { REQUEST_ID_HEADER, resolveRequestId } from "@/server/runtime/request-context";
import { tenantRepo } from "@/server/repos";
import { sha256Hex } from "@/server/runtime/crypto";
import { systemClock } from "@/server/runtime/clock";

/**
 * Test-only matcher fixture (OP-133, ADR-0794 §9).
 *
 * The e2e run starts `next start` with an in-process MongoDB, so the Playwright
 * process cannot reach the server's database and nothing in the public API can
 * create a `face_matches` row — the worker is a later card. This route stands in
 * for that worker so the attendee journey has photos to browse.
 *
 * It is reachable **only** in `test`/`e2e` (the {@link isTestOtpRouteEnabled}
 * precedent) and answers `404` everywhere else, *before* the body is read: a
 * leaked seeder would be a write primitive on any tenant's library.
 */

/** Node runtime so the route shares the API's database client. */
export const runtime = "nodejs";

/** How many photo pairs one call may create. */
const MAX_COUNT = 50;

/** The fixture body. */
const requestSchema = z.object({
  slug: z.string().min(1),
  profileId: z.string().min(1),
  count: z.number().int().min(1).max(MAX_COUNT),
});

/** The stored shapes the fixture writes (schema §16.1/§16.3/§17.5). */
const THUMBNAIL_FORMAT = "webp";
const ORIGINAL_BYTES = 8_421_310;
const THUMBNAIL_BYTES = 41_200;
const STORED_WIDTH = 4000;
const STORED_HEIGHT = 6000;

/**
 * Build one `media_assets` + `event_images` + `face_matches` triple.
 *
 * @param input - The scope, the sequence and the profile the match belongs to.
 * @returns The three new ids.
 */
async function seedOne(input: {
  readonly db: ReturnType<typeof getDb>;
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly profileId: ObjectId;
  readonly subject: Record<string, unknown>;
  readonly sequence: number;
  readonly now: Date;
}): Promise<{ readonly imageId: ObjectId; readonly matchId: ObjectId }> {
  const tenant = tenantRepo(input.tenantKey, input.db);
  const contentHash = sha256Hex(`${input.eventId.toHexString()}:${String(input.sequence)}`);
  const assetId = new ObjectId();
  const imageId = new ObjectId();
  const matchId = new ObjectId();

  await tenant.collection(COLLECTIONS.mediaAssets).insertOne({
    _id: assetId,
    contentHash,
    kind: "event_image",
    storage: {
      locationKey: "originals",
      objectKey: `images/${contentHash}.jpg`,
      bytes: ORIGINAL_BYTES,
      contentType: "image/jpeg",
      checksum: contentHash,
      storedAt: input.now,
    },
    derivatives: {
      thumbnail: {
        locationKey: "thumbnails",
        objectKey: `thumbnails/${contentHash}.${THUMBNAIL_FORMAT}`,
        bytes: THUMBNAIL_BYTES,
        width: Math.round(STORED_WIDTH / 10),
        height: Math.round(STORED_HEIGHT / 10),
        format: THUMBNAIL_FORMAT,
        processorVersion: 1,
        watermarkVersion: null,
        generatedAt: input.now,
      },
    },
    imageMeta: {
      width: STORED_WIDTH,
      height: STORED_HEIGHT,
      orientation: 1,
      exifCaptureAt: input.now,
      cameraMake: "SONY",
      cameraModel: "ILCE-7M4",
    },
    status: "derivatives_ready",
    refCount: 1,
    createdAt: input.now,
  });

  await tenant.collection(COLLECTIONS.eventImages).insertOne({
    _id: imageId,
    eventId: input.eventId,
    assetId,
    uploadedByUserId: null,
    uploadBatchId: new ObjectId(),
    sequence: input.sequence,
    processing: {
      status: "done",
      priority: "normal",
      attempts: 1,
      maxAttempts: 5,
      leaseExpiresAt: null,
      workerId: "op133-fixture",
      queuedAt: input.now,
      startedAt: input.now,
      finishedAt: input.now,
      durationMs: 0,
      lastError: null,
      modelKeys: { detection: "antelopev2", recognition: "arcface_r100_512" },
    },
    faceCount: 1,
    visibility: "visible",
    createdAt: input.now,
    deletedAt: null,
  });

  await tenant.collection(COLLECTIONS.faceMatches).insertOne({
    _id: matchId,
    eventId: input.eventId,
    profileId: input.profileId,
    subject: input.subject,
    imageId,
    faceIndex: 0,
    selfieId: null,
    similarity: 0.85,
    confidence: "strong",
    spaceKey: "arcface_r100_512",
    modelKey: "antelopev2",
    seenAt: null,
    hiddenAt: null,
    createdAt: input.now,
  });

  return { imageId, matchId };
}

/**
 * Seed `count` matches for one attendee, oldest first.
 *
 * @param request - The inbound request.
 * @returns `201 {matchIds, imageIds}`; `404` outside `test`/`e2e`.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isTestOtpRouteEnabled(getAppEnv())) {
    return new Response(null, { status: 404 });
  }

  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
  try {
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw appError("validation_failed", {
        details: { fields: toFieldErrors(parsed.error) },
      });
    }

    const db = getDb();
    const event = await resolveEventBySlug(db, parsed.data.slug);
    const profileId = new ObjectId(parsed.data.profileId);
    const tenant = tenantRepo(event.tenantKey, db);

    const profile = (await tenant
      .collection(COLLECTIONS.attendeeEventProfiles)
      .findOne({ _id: profileId, eventId: event.eventId })) as {
      readonly subject?: Record<string, unknown>;
    } | null;
    if (profile === null) {
      throw appError("not_found", { details: { resource: "profile" } });
    }

    const lastImage = (await tenant
      .collection(COLLECTIONS.eventImages)
      .find({ eventId: event.eventId }, { projection: { sequence: 1 }, sort: { sequence: -1 }, limit: 1 })
      .toArray()) as unknown as { readonly sequence?: number }[];
    const base = lastImage.at(0)?.sequence ?? 0;

    const now = systemClock.now();
    const imageIds: string[] = [];
    const matchIds: string[] = [];
    for (let index = 1; index <= parsed.data.count; index += 1) {
      const seeded = await seedOne({
        db,
        tenantKey: event.tenantKey,
        eventId: event.eventId,
        profileId,
        subject: profile.subject ?? {},
        sequence: base + index,
        // Oldest first: the gallery serves them newest first, so the ids come
        // back in the reverse of this order.
        now: new Date(now.getTime() + index),
      });
      imageIds.push(seeded.imageId.toHexString());
      matchIds.push(seeded.matchId.toHexString());
    }

    await tenant
      .collection(COLLECTIONS.attendeeEventProfiles)
      .updateOne(
        { _id: profileId },
        {
          $inc: { matchCount: parsed.data.count },
          $set: { status: "ready", lastMatchRunAt: now, updatedAt: now },
        }
      );

    return Response.json({ imageIds, matchIds }, { status: 201 });
  } catch (error: unknown) {
    const status = isAppError(error) ? error.status : 500;
    return Response.json(toErrorEnvelope(error, requestId), { status });
  }
}
