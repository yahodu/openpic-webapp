import { createHash } from "node:crypto";

import { ObjectId } from "mongodb";

import * as gallerySeenRouteModule from "@/app/api/v1/p/events/[slug]/gallery:seen/route";
import * as galleryRouteModule from "@/app/api/v1/p/events/[slug]/gallery/route";
import * as downloadRequestRouteModule from "@/app/api/v1/p/events/[slug]/downloads/route";
import * as originalUrlRouteModule from "@/app/api/v1/p/events/[slug]/images/[imageId]/original-url/route";
import * as previewUrlRouteModule from "@/app/api/v1/p/events/[slug]/images/[imageId]/preview-url/route";
import * as participationRouteModule from "@/app/api/v1/p/events/[slug]/me/route";
import * as hideMatchRouteModule from "@/app/api/v1/p/matches/[matchId]/hide/route";
import * as downloadStatusRouteModule from "@/app/api/v1/p/downloads/[downloadId]/route";
import * as seedMatchesRouteModule from "@/app/api/v1/test-support/attendee-matches/route";
import { COLLECTIONS } from "@/server/db/collections";
import { createMediaSigner } from "@/server/media/signer";
import type { Entitlement } from "@/server/plans/plans";

import { makeEnv } from "../factories/env";
import { makeSubscription } from "../factories/entitlements";
import { makeEntitlement, makePlan } from "../factories/plan";

import type { TestApp } from "./authed-app";
import {
  createAttendeeSession,
  grantConsent,
  nextIp,
  requireHandler,
  seedTenant,
  type AttendeeSession,
  type SeededEvent,
} from "./selfie-flow";

/**
 * Shared fixture flow for the OP-133 gallery, participation and download
 * suites (`apps/web/src/test/integration/attendee-*.test.ts`; contract §6.4–§6.6,
 * §5.6; schema §15.3, §16.1, §16.3, §17.5; ADR-0793).
 *
 * Every case in the three specs needs the same handles: a published event with
 * an active access link, a real attendee credential, a granted biometric
 * consent and the `attendeeEventProfiles` row that consent created, a library of
 * `event_images` with real `media_assets` rows, and `face_matches` rows the
 * gallery can page. Building them once keeps each spec about the behaviour it
 * pins and keeps the stored shapes the ones the pipeline itself writes, never a
 * hand-rolled document that could drift from the real write path.
 *
 * Nothing here asserts: a helper that cannot build its fixture throws with the
 * step it failed at, so a spec never mistakes a broken fixture for a refusal.
 *
 * Route modules are reached by their **intended paths** (they do not exist until
 * the GREEN lands), so a missing module is an honest load failure and a missing
 * export is named explicitly by {@link requireHandler}.
 */

/* ───────────────────────────── route handlers ────────────────────────────── */

/** The routes these suites drive, resolved once. */
export const galleryHandlers = {
  participation: requireHandler(
    participationRouteModule,
    "GET",
    "/api/v1/p/events/:slug/me — the participation poll"
  ),
  gallery: requireHandler(galleryRouteModule, "GET", "/api/v1/p/events/:slug/gallery"),
  markSeen: requireHandler(gallerySeenRouteModule, "POST", "/api/v1/p/events/:slug/gallery:seen"),
  hideMatch: requireHandler(hideMatchRouteModule, "POST", "/api/v1/p/matches/:matchId/hide"),
  originalUrl: requireHandler(
    originalUrlRouteModule,
    "POST",
    "/api/v1/p/events/:slug/images/:imageId/original-url"
  ),
  previewUrl: requireHandler(
    previewUrlRouteModule,
    "POST",
    "/api/v1/p/events/:slug/images/:imageId/preview-url"
  ),
  createDownload: requireHandler(
    downloadRequestRouteModule,
    "POST",
    "/api/v1/p/events/:slug/downloads"
  ),
  downloadStatus: requireHandler(
    downloadStatusRouteModule,
    "GET",
    "/api/v1/p/downloads/:downloadId"
  ),
  /** The test-only matcher fixture the e2e journey cannot reach otherwise. */
  seedMatches: requireHandler(
    seedMatchesRouteModule,
    "POST",
    "/api/v1/test-support/attendee-matches"
  ),
} as const;

/* ──────────────────────────────── seeding ────────────────────────────────── */

/** The image one gallery case can see: its ids, its ordering key and its meta. */
export interface SeededImage {
  readonly imageId: ObjectId;
  readonly assetId: ObjectId;
  readonly contentHash: string;
  /** `event_images.sequence` — the stable "newest first" ordering (§16.3). */
  readonly sequence: number;
  /** The stored `imageMeta` pair, before the EXIF transposition. */
  readonly width: number;
  readonly height: number;
  readonly orientation: number;
}

/** What a case may vary about one stored image. */
export interface SeedImageOptions {
  readonly sequence: number;
  readonly width?: number;
  readonly height?: number;
  readonly orientation?: number;
  /** `event_images.visibility` — the **organizer** hide (§16.3). */
  readonly visibility?: "visible" | "hidden";
  readonly deletedAt?: Date | null;
}

/** The fixed instant seeded rows carry, so no case depends on the wall clock. */
export const SEED_INSTANT = new Date("2026-11-01T09:00:00.000Z");

/** The thumbnail derivative's format (§16.1). */
const THUMBNAIL_FORMAT = "webp";

/** The stored byte counts, so an asset row is schema-shaped. */
const ORIGINAL_BYTES = 8_421_310;
const THUMBNAIL_BYTES = 41_200;

/**
 * Insert one `media_assets` row plus its `event_images` join row (schema
 * §16.1/§16.3).
 *
 * @param app - The booted test app.
 * @param scope - The tenant and event the image belongs to.
 * @param options - The sequence, the stored meta and the organizer visibility.
 * @returns The image's ids, ordering key and stored meta.
 */
export async function seedImage(
  app: TestApp,
  scope: { readonly tenantKey: string; readonly eventId: ObjectId },
  options: SeedImageOptions
): Promise<SeededImage> {
  const width = options.width ?? 4000;
  const height = options.height ?? 6000;
  const orientation = options.orientation ?? 1;
  const contentHash = createHash("sha256")
    .update(`op133:${scope.eventId.toHexString()}:${String(options.sequence)}`)
    .digest("hex");
  const assetId = new ObjectId();
  const imageId = new ObjectId();

  await app.db.collection(COLLECTIONS.mediaAssets).insertOne({
    _id: assetId,
    tenantId: scope.tenantKey,
    contentHash,
    kind: "event_image",
    storage: {
      locationKey: "originals",
      objectKey: `images/${contentHash}.jpg`,
      bytes: ORIGINAL_BYTES,
      contentType: "image/jpeg",
      checksum: contentHash,
      storedAt: SEED_INSTANT,
    },
    derivatives: {
      thumbnail: {
        locationKey: "thumbnails",
        objectKey: `thumbnails/${contentHash}.${THUMBNAIL_FORMAT}`,
        bytes: THUMBNAIL_BYTES,
        width: Math.round(width / 10),
        height: Math.round(height / 10),
        format: THUMBNAIL_FORMAT,
        processorVersion: 1,
        watermarkVersion: null,
        generatedAt: SEED_INSTANT,
      },
    },
    imageMeta: {
      width,
      height,
      orientation,
      exifCaptureAt: SEED_INSTANT,
      cameraMake: "SONY",
      cameraModel: "ILCE-7M4",
    },
    status: "derivatives_ready",
    refCount: 1,
    createdAt: SEED_INSTANT,
  });

  await app.db.collection(COLLECTIONS.eventImages).insertOne({
    _id: imageId,
    tenantId: scope.tenantKey,
    eventId: scope.eventId,
    assetId,
    uploadedByUserId: new ObjectId(),
    uploadBatchId: new ObjectId(),
    sequence: options.sequence,
    processing: {
      status: "done",
      priority: "normal",
      attempts: 1,
      maxAttempts: 5,
      leaseExpiresAt: null,
      workerId: "op133-fixture",
      queuedAt: SEED_INSTANT,
      startedAt: SEED_INSTANT,
      finishedAt: SEED_INSTANT,
      durationMs: 1_200,
      lastError: null,
      modelKeys: { detection: "antelopev2", recognition: "arcface_r100_512" },
    },
    faceCount: 1,
    visibility: options.visibility ?? "visible",
    createdAt: SEED_INSTANT,
    deletedAt: options.deletedAt ?? null,
  });

  return { imageId, assetId, contentHash, sequence: options.sequence, width, height, orientation };
}

/** What a case may vary about one `face_matches` row (§17.5). */
export interface SeedMatchOptions {
  readonly imageId: ObjectId;
  readonly faceIndex?: number;
  readonly similarity?: number;
  readonly confidence?: "strong" | "normal";
  readonly createdAt?: Date;
  readonly seenAt?: Date | null;
  /** The **attendee** hide (§17.5) — never the organizer's `visibility`. */
  readonly hiddenAt?: Date | null;
}

/**
 * Insert one `face_matches` row (schema §17.5).
 *
 * @param app - The booted test app.
 * @param scope - The tenant, event and profile the match belongs to.
 * @param options - The image, the score and the two hide/seen stamps.
 * @returns The inserted match id.
 */
export async function seedMatch(
  app: TestApp,
  scope: {
    readonly tenantKey: string;
    readonly eventId: ObjectId;
    readonly profileId: ObjectId;
    readonly subject: Record<string, unknown>;
  },
  options: SeedMatchOptions
): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.faceMatches).insertOne({
    _id,
    tenantId: scope.tenantKey,
    eventId: scope.eventId,
    profileId: scope.profileId,
    subject: scope.subject,
    imageId: options.imageId,
    faceIndex: options.faceIndex ?? 0,
    selfieId: new ObjectId(),
    similarity: options.similarity ?? 0.7413,
    confidence: options.confidence ?? "strong",
    spaceKey: "arcface_r100_512",
    modelKey: "antelopev2",
    seenAt: options.seenAt ?? null,
    hiddenAt: options.hiddenAt ?? null,
    createdAt: options.createdAt ?? SEED_INSTANT,
  });
  return _id;
}

/** A stored `attendee_event_profiles` row, as these cases read it (§15.3). */
export interface ProfileRow {
  readonly _id: ObjectId;
  readonly status: string;
  readonly matchCount: number;
  readonly subject: Record<string, unknown>;
  readonly lastSeenGalleryAt?: Date | null;
  readonly activeSelfieId?: ObjectId | null;
}

/**
 * Read the single `attendee_event_profiles` row of a fixture.
 *
 * @param app - The booted test app.
 * @param profileId - The row's id (from the consent route or a seed).
 * @returns The stored row.
 */
export async function readProfile(app: TestApp, profileId: ObjectId): Promise<ProfileRow> {
  const row = (await app.db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .findOne({ _id: profileId })) as unknown as ProfileRow | null;
  if (row === null) {
    throw new Error(`expected the attendee profile ${profileId.toHexString()} to exist`);
  }
  return row;
}

/**
 * Point one seeded event's `counters` at the stated "indexing complete" state.
 *
 * §6.4 derives `indexingComplete` from the event's own progress, so a case
 * states the progress rather than a boolean.
 *
 * @param app - The booted test app.
 * @param eventId - The event to update.
 * @param counts - `imageCount` and how many of them the pipeline finished.
 */
export async function seedIndexingProgress(
  app: TestApp,
  eventId: ObjectId,
  counts: { readonly imageCount: number; readonly processedImageCount: number }
): Promise<void> {
  await app.db.collection(COLLECTIONS.events).updateOne(
    { _id: eventId },
    {
      $set: {
        "counters.imageCount": counts.imageCount,
        "counters.processedImageCount": counts.processedImageCount,
      },
    }
  );
}

/**
 * The media signer the app mints its URLs with, so a gallery item's
 * `thumbnailUrl` can be **verified** rather than only pattern-matched (§5.7).
 *
 * @returns A signer bound to the test environment's current secret.
 */
export function mediaSigner() {
  return createMediaSigner({
    currentSecret: makeEnv().MEDIA_SIGNING_SECRET_CURRENT ?? "",
  });
}

/** The `originals.download` entitlement with the stated gate (§14.1). */
function originalsEntitlement(enabled: boolean): Entitlement {
  return makeEntitlement({
    limit: null,
    resetPeriod: "none",
    scope: "event",
    enforcement: "feature",
    enabled,
  });
}

/**
 * Activate a plan for one tenant whose `originals.download` gate is the stated
 * value (§6.6, §14.1).
 *
 * @param app - The booted test app.
 * @param tenantKey - The tenant (hex) to subscribe.
 * @param enabled - Whether attendee original downloads are granted.
 */
export async function seedOriginalsPlan(
  app: TestApp,
  tenantKey: string,
  enabled: boolean
): Promise<void> {
  const key = enabled ? "op133-originals-on" : "op133-originals-off";
  const existing = await app.db.collection(COLLECTIONS.plans).findOne({ key });
  if (existing === null) {
    await app.db
      .collection(COLLECTIONS.plans)
      .insertOne(
        makePlan({ key, entitlements: { "originals.download": originalsEntitlement(enabled) } })
      );
  }
  await app.db.collection(COLLECTIONS.subscriptions).insertOne(
    makeSubscription({
      tenantId: tenantKey,
      subscribedPlanKey: key,
      activePlanKey: key,
      status: "active",
    })
  );
}

/* ───────────────────────────── composite fixtures ────────────────────────── */

/** One attendee's whole gallery world. */
export interface GalleryWorld {
  readonly tenantKey: string;
  readonly event: SeededEvent;
  readonly profileId: ObjectId;
  readonly subject: Record<string, unknown>;
  /** The `op_att` cookie for an anonymous attendee, or the user session cookie. */
  readonly cookie: string;
  readonly session: AttendeeSession | null;
  readonly images: readonly SeededImage[];
  readonly matchIds: readonly ObjectId[];
}

/** What a gallery fixture case states. */
export interface GalleryWorldOptions {
  /** How many matches the profile holds (`profile.matchCount` follows). */
  readonly matches: number;
  /** How many distinct images to seed (defaults to `matches`). */
  readonly images?: number;
  /** The stored meta every seeded image carries. */
  readonly orientation?: number;
}

/**
 * Build an **anonymous** attendee's gallery: tenant, event, `op_att` session,
 * granted consent, a ready profile and one match per image.
 *
 * @param app - The booted test app.
 * @param prefix - The suite-local identity/slug prefix.
 * @param options - How many matches, over how many images.
 * @returns The world a gallery case reads and mutates.
 */
export async function seedAnonymousGallery(
  app: TestApp,
  prefix: string,
  options: GalleryWorldOptions
): Promise<GalleryWorld> {
  const { tenantKey, events } = await seedTenant(app, prefix);
  const event = events[0];
  if (event === undefined) {
    throw new Error("expected one seeded event");
  }
  const session = await createAttendeeSession(app, nextIp());
  await grantConsent(event.slug, { cookie: session.cookie, ip: nextIp() });
  const profileId = await singleProfileId(app);
  return buildGallery(app, {
    tenantKey,
    event,
    profileId,
    cookie: session.cookie,
    session,
    options,
  });
}

/**
 * Build an **identified** (signed-in) attendee's gallery: tenant, event, a user
 * session, granted consent, a ready profile and one match per image.
 *
 * §6.4/§6.5 key the anonymous truncation off the subject kind, so the only way
 * to pin "a logged-in user gets full pagination" is a real user credential.
 *
 * @param app - The booted test app.
 * @param prefix - The suite-local identity/slug prefix.
 * @param options - How many matches, over how many images.
 * @returns The world a gallery case reads and mutates.
 */
export async function seedIdentifiedGallery(
  app: TestApp,
  prefix: string,
  options: GalleryWorldOptions
): Promise<GalleryWorld> {
  const { tenantKey, events, owner } = await seedTenant(app, prefix);
  const event = events[0];
  if (event === undefined) {
    throw new Error("expected one seeded event");
  }
  await grantConsent(event.slug, { cookie: owner.cookie, ip: nextIp() });
  const profileId = await singleProfileId(app);
  return buildGallery(app, {
    tenantKey,
    event,
    profileId,
    cookie: owner.cookie,
    session: null,
    options,
  });
}

/** Read the one profile the consent route created for the last caller. */
export async function singleProfileId(app: TestApp): Promise<ObjectId> {
  const rows = await app.db.collection(COLLECTIONS.attendeeEventProfiles).find({}).toArray();
  const row = rows.at(-1);
  if (row === undefined) {
    throw new Error("expected the consent route to create an attendee profile");
  }
  return row._id;
}

/**
 * Mark one profile ready with the cached count a case expects (§15.3).
 *
 * `matchCount` is the cache §6.4/§6.5 read; a fixture that inserts `faceMatches`
 * without it would pin a gallery whose `summary.matchCount` disagrees with its
 * own rows.
 *
 * @param app - The booted test app.
 * @param profileId - The profile to update.
 * @param options - The cached count and, when a case cares, the seen watermark.
 */
export async function markProfileReady(
  app: TestApp,
  profileId: ObjectId,
  options: { readonly matchCount: number; readonly lastSeenGalleryAt?: Date | null }
): Promise<void> {
  await app.db.collection(COLLECTIONS.attendeeEventProfiles).updateOne(
    { _id: profileId },
    {
      $set: {
        status: "ready",
        matchCount: options.matchCount,
        lastSeenGalleryAt: options.lastSeenGalleryAt ?? null,
      },
    }
  );
}

/** Seed the library and the matches of one world, then mark the profile ready. */
async function buildGallery(
  app: TestApp,
  input: {
    readonly tenantKey: string;
    readonly event: SeededEvent;
    readonly profileId: ObjectId;
    readonly cookie: string;
    readonly session: AttendeeSession | null;
    readonly options: GalleryWorldOptions;
  }
): Promise<GalleryWorld> {
  const images: SeededImage[] = [];
  const imageCount = input.options.images ?? input.options.matches;
  for (let index = 0; index < imageCount; index += 1) {
    images.push(
      await seedImage(
        app,
        { tenantKey: input.tenantKey, eventId: input.event.id },
        {
          sequence: index + 1,
          ...(input.options.orientation === undefined
            ? {}
            : { orientation: input.options.orientation }),
        }
      )
    );
  }

  const profile = await app.db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .findOne({ _id: input.profileId });
  if (profile === null) {
    throw new Error("expected the attendee profile to exist");
  }
  const subject = profile.subject as Record<string, unknown>;
  await app.db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .updateOne(
      { _id: input.profileId },
      { $set: { status: "ready", matchCount: input.options.matches, lastSeenGalleryAt: null } }
    );

  const matchIds: ObjectId[] = [];
  for (let index = 0; index < input.options.matches; index += 1) {
    const image = images[index % images.length];
    if (image === undefined) {
      throw new Error("expected at least one seeded image");
    }
    matchIds.push(
      await seedMatch(
        app,
        {
          tenantKey: input.tenantKey,
          eventId: input.event.id,
          profileId: input.profileId,
          subject,
        },
        {
          imageId: image.imageId,
          faceIndex: index,
          createdAt: new Date(SEED_INSTANT.getTime() + index * 1_000),
        }
      )
    );
  }

  return {
    tenantKey: input.tenantKey,
    event: input.event,
    profileId: input.profileId,
    subject,
    cookie: input.cookie,
    session: input.session,
    images,
    matchIds,
  };
}
