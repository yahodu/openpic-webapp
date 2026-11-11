import { ObjectId } from "mongodb";
import { z } from "zod";

import { getRateLimitConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { eventActorAdmission, resolveEventActorRole } from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { checkEntitlement, type EntitlementVerdict } from "@/server/services/entitlements";
import { getPlatformSettings } from "@/server/settings/platform-settings";
import { getObjectStorage } from "@/server/storage/get-object-storage";
import { buildObjectKey } from "@/server/storage/object-key";
import type { UploadedPart } from "@/server/storage/object-storage";
import { userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";
import {
  MAX_BATCH_FILES,
  isValidBatchId,
  quotaSufficiency,
  resolutionFor,
  type UploadPolicy,
  type UploadResolution,
} from "@/server/uploads/batch-resolve";

/**
 * `POST /api/v1/tenants/{tenantId}/events/{eventId}/uploads/batch-resolve` —
 * the upload pre-check (OP-123, contract §5.2, schema §16.1–§16.3; ADR-0700,
 * ADR-0701).
 *
 * One round trip for the whole drag-and-drop (up to 500 hashes), answered per
 * hash as `completed` / `in_progress` / `not_found` / `rejected` plus an
 * **advisory** quota block. The decision itself is the pure
 * `@/server/uploads/batch-resolve`; this route only reads.
 *
 * The scoping split is the part that must not be got wrong: the **completed**
 * lookup is tenant-wide (`media_assets` is unique on `{tenantId, contentHash}`,
 * so an organizer and a co-organizer dedupe the same photo), while the
 * **in_progress** lookup additionally names `createdByUserId`, so user B never
 * resumes user A's in-flight multipart upload. Dedupe is never global across
 * tenants. The parts of a resumed multipart upload come only from the storage
 * provider's live `ListParts` — there is no part collection to fall out of
 * sync (schema §16.2) — and an upstream failure is `502 bad_gateway` rather
 * than a guessed `not_found`, which would re-send stored bytes.
 *
 * The pre-check is read-only: it writes no `upload_sessions` row and emits no
 * domain event, so a rejection can never become a per-file notification.
 */

/** A 64-lowercase-hex SHA-256 — the content hash's only admitted shape (§5.1). */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** The streamed part size the uploads lane uses (§5.1). */
const ORIGINALS_LOCATION = "originals" as const;

/** One client claim, as §5.2 carries it. */
const claimSchema = z.object({
  hash: z.string().regex(HASH_PATTERN),
  size: z.number().int().nonnegative(),
  mimeType: z.string().min(1),
  fileName: z.string().min(1).optional(),
});

/** The §5.2 request body. */
const batchResolveBodySchema = z.object({
  batchId: z.string().refine(isValidBatchId),
  files: z.array(claimSchema),
});

/** One resolution, as §5.2 writes it. */
const resolutionSchema = z.union([
  z.object({
    state: z.literal("completed"),
    assetId: z.string(),
    eventImageId: z.string().nullable(),
    linked: z.boolean(),
    bytes: z.number(),
  }),
  z.object({
    state: z.literal("in_progress"),
    uploadId: z.string(),
    mode: z.literal("multipart"),
    uploadedPartNumbers: z.array(z.number()),
    uploadedBytes: z.number(),
  }),
  z.object({ state: z.literal("not_found"), mode: z.enum(["single", "multipart"]) }),
  z.object({ state: z.literal("rejected"), reason: z.string(), message: z.string() }),
]);

/** The §5.2 response body — bare, never wrapped in `data`. */
const batchResolveResponseSchema = z.object({
  batchId: z.string(),
  uploadWindowOpen: z.boolean(),
  resolutions: z.record(z.string(), resolutionSchema),
  quota: z.object({
    storage: z.object({
      remainingBytes: z.number().nullable(),
      requestedBytes: z.number(),
      sufficient: z.boolean(),
    }),
    images: z.object({
      remaining: z.number().nullable(),
      requested: z.number(),
      sufficient: z.boolean(),
    }),
  }),
});

/** The `events` fields the pre-check reads. */
interface EventRow {
  readonly _id: ObjectId;
  readonly uploadWindowEndsAt: Date | null;
  readonly counters: { readonly imageCount: number };
}

/** The `media_assets` fields the pre-check reads (§16.1). */
interface AssetRow {
  readonly _id: ObjectId;
  readonly contentHash: string;
  readonly storage: { readonly bytes: number };
}

/** One `media_assets.externalRefs` entry, of which only the multipart id matters. */
interface SessionRef {
  readonly kind: string;
  readonly id: string;
}

/** The `upload_sessions` fields the pre-check reads (§16.2). */
interface SessionRow {
  readonly contentHash: string;
  readonly mode: "single" | "multipart";
  readonly declaredMimeType: string;
  readonly externalRefs: readonly SessionRef[];
}

/** The `event_images` fields the pre-check reads (§16.3). */
interface EventImageRow {
  readonly _id: ObjectId;
  readonly assetId: ObjectId;
}

/** The canonical extension for a declared MIME, for the resumed object key (A5). */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "image/tiff": "tiff",
};

/** The extension of a declared MIME; an unknown type cannot be resumed (A5). */
function extensionForMime(mimeType: string): string {
  return EXTENSION_BY_MIME[mimeType] ?? "jpg";
}

/** The provider's multipart id from a session row, or `null` when it holds none (A4). */
function uploadIdOf(row: SessionRow): string | null {
  const ref = row.externalRefs.find((candidate) => candidate.kind === "multipart_upload");
  return ref === undefined ? null : ref.id;
}

/** The remaining allowance behind a verdict; `null` stays the unlimited sentinel. */
function remainingOf(verdict: EntitlementVerdict): number | null {
  return verdict.effectiveLimit === null
    ? null
    : Math.max(0, verdict.effectiveLimit - verdict.used);
}

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/uploads/batch-resolve",
  body: batchResolveBodySchema,
  response: batchResolveResponseSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  // `upload.resolve` is a per-user class, so it keys on the authenticated
  // principal after the auth stage, not on the pre-auth IP fallback (§0.11).
  rateLimitIdentity: rateLimitStage({
    classKey: "upload.resolve",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  // The event id sits three segments from the end here, not two (ADR-0700 D3).
  tenant: tenantStage({ admission: eventActorAdmission(3) }),
  handler: async (ctx) => {
    const db = getDb();
    const { tenantId, principal } = ctx;
    if (tenantId === undefined || principal === undefined) {
      // The auth and tenant stages always publish both, or deny.
      throw appError("internal_error");
    }

    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 3 });
    const { batchId, files } = ctx.body;

    if (files.length > MAX_BATCH_FILES) {
      throw appError("payload_too_large", {
        details: { maxItems: MAX_BATCH_FILES, actualItems: files.length },
      });
    }

    const event = (await tenantRepo(tenantId, db)
      .collection(COLLECTIONS.events)
      .findOne({ _id: eventId })) as EventRow | null;
    if (event === null) {
      throw appError("not_found");
    }

    const now = systemClock.now();
    if (event.uploadWindowEndsAt !== null && event.uploadWindowEndsAt.getTime() < now.getTime()) {
      const role = await resolveEventActorRole(db, eventId, tenantId, principal);
      throw appError("upload_window_closed", {
        details: {
          uploadWindowEndsAt: event.uploadWindowEndsAt.toISOString(),
          canExtend: role === "organizer",
        },
      });
    }

    const hashes = [...new Set(files.map((file) => file.hash))];
    // Tenant-wide dedupe, then the caller's own sessions (per-user resume).
    const [assetDocs, sessionDocs] = await Promise.all([
      tenantRepo(tenantId, db)
        .collection(COLLECTIONS.mediaAssets)
        .find({ contentHash: { $in: hashes } })
        .toArray(),
      tenantRepo(tenantId, db)
        .collection(COLLECTIONS.uploadSessions)
        .find({
          createdByUserId: new ObjectId(principal),
          contentHash: { $in: hashes },
          status: { $in: ["pending", "in_progress"] },
        })
        .toArray(),
    ]);
    const assets = assetDocs as unknown as AssetRow[];
    const sessions = sessionDocs as unknown as SessionRow[];

    const assetIds = assets.map((row) => row._id);
    const links =
      assetIds.length === 0
        ? []
        : ((await tenantRepo(tenantId, db)
            .collection(COLLECTIONS.eventImages)
            .find({ eventId, assetId: { $in: assetIds } })
            .toArray()) as unknown as EventImageRow[]);

    const assetByHash = new Map(assets.map((row) => [row.contentHash, row]));
    const sessionByHash = new Map(sessions.map((row) => [row.contentHash, row]));
    const eventImageIdByAssetId = new Map(
      links.map((row) => [row.assetId.toHexString(), row._id.toHexString()])
    );

    // The parts of a resumable upload exist only in the provider: one live
    // `ListParts` per resumed hash, and a failure fails the whole call.
    const partsByHash = new Map<string, readonly UploadedPart[]>();
    await Promise.all(
      files.map(async (file) => {
        const session = sessionByHash.get(file.hash);
        const uploadId = session === undefined ? null : uploadIdOf(session);
        if (uploadId === null) {
          return;
        }
        try {
          const listed = await getObjectStorage().listParts(
            ORIGINALS_LOCATION,
            buildObjectKey(file.hash, extensionForMime(file.mimeType)),
            uploadId
          );
          partsByHash.set(file.hash, listed.parts);
        } catch {
          throw appError("bad_gateway");
        }
      })
    );

    const { upload } = await getPlatformSettings({ db });
    const policy: UploadPolicy = {
      multipartThresholdBytes: upload.multipartThresholdBytes,
      maxFileBytes: upload.maxFileBytes,
      supportedMimeTypes: upload.supportedMimeTypes,
    };

    const resolutions: Record<string, UploadResolution> = {};
    for (const file of files) {
      const asset = assetByHash.get(file.hash);
      const session = sessionByHash.get(file.hash);
      resolutions[file.hash] = resolutionFor({
        claim: file,
        policy,
        asset:
          asset === undefined ? null : { id: asset._id.toHexString(), bytes: asset.storage.bytes },
        eventImageId:
          asset === undefined ? null : (eventImageIdByAssetId.get(asset._id.toHexString()) ?? null),
        session:
          session === undefined ? null : { mode: session.mode, uploadId: uploadIdOf(session) },
        parts: partsByHash.get(file.hash) ?? null,
      });
    }

    // Advisory only (ADR-0340): the completion transaction is the enforcement point.
    let requestedBytes = 0;
    let requestedImages = 0;
    for (const file of files) {
      const state = resolutions[file.hash]?.state;
      if (state === "not_found" || state === "in_progress") {
        requestedBytes += file.size;
        requestedImages += 1;
      }
    }

    const [storageVerdict, imagesVerdict] = await Promise.all([
      checkEntitlement(tenantId, "storage.bytes", 0, {}, { db }),
      checkEntitlement(
        tenantId,
        "images.per_event",
        0,
        {
          counts: event.counters.imageCount,
          subjectRef: { kind: "event", id: eventId.toHexString() },
        },
        { db }
      ),
    ]);
    const storage = quotaSufficiency({
      remaining: remainingOf(storageVerdict),
      requested: requestedBytes,
    });
    const images = quotaSufficiency({
      remaining: remainingOf(imagesVerdict),
      requested: requestedImages,
    });

    const countOf = (state: UploadResolution["state"]): number =>
      Object.values(resolutions).filter((resolution) => resolution.state === state).length;
    getLogger().info("upload batch resolved", {
      event: "upload.batch.resolved",
      tenantId,
      eventId: eventId.toHexString(),
      batchId,
      completed: countOf("completed"),
      inProgress: countOf("in_progress"),
      notFound: countOf("not_found"),
      rejected: countOf("rejected"),
    });

    return {
      body: {
        batchId,
        uploadWindowOpen: true,
        resolutions,
        quota: {
          storage: {
            remainingBytes: storage.remaining,
            requestedBytes: storage.requested,
            sufficient: storage.sufficient,
          },
          images: {
            remaining: images.remaining,
            requested: images.requested,
            sufficient: images.sufficient,
          },
        },
      },
    };
  },
});
