import type { Db, ObjectId } from "mongodb";
import { z } from "zod";

import {
  eventIndexingComplete,
  nextPollAfter,
  pollIntervalMs,
} from "@/server/attendee/poll-policy";
import { attendeeMediaSigner } from "@/server/attendee/attendee-media";
import { encodeWatermark } from "@/server/attendee/gallery-projection";
import { requireAttendeeProfile } from "@/server/attendee/request-event";
import { selfieAttemptBudget } from "@/server/attendee/selfie-attempts";
import { resolveStatus } from "@/server/attendee/status-detail";
import type { TenantRepository } from "@/server/repos";
import { getRateLimitConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { defineRoute } from "@/server/http/define-route";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";
import { platformRepo, tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { checkEntitlement } from "@/server/services/entitlements";
import { getPlatformSettings } from "@/server/settings/platform-settings";

/**
 * `GET /api/v1/p/events/{slug}/me` — the attendee's participation poll (OP-133,
 * contract §6.4, schema §15.3/§16.4/§17.5; ADR-0794 §1, §3, §10).
 *
 * The single polling endpoint of the whole attendee experience, so it carries
 * three load-bearing properties and nothing else:
 *
 *   - the cadence is the server's (`pollIntervalMs`/`nextPollAfter`), never a
 *     client constant, so the page is cheap while a selfie processes and cheap
 *     in a different way once the gallery settles;
 *   - a `GET` never clears the "New" badges — only `POST …/gallery:seen` stamps
 *     `seenAt`, so a prefetch is harmless;
 *   - `latestMatchCursor` is the watermark a client hands back as
 *     `?newerThan=`, which is what makes the poll cheap after the first load.
 *
 * `matchCount` and `newMatchCount` are cache/partial-index reads, never an
 * aggregation over the profile's rows.
 */

/** The `events` fields the poll reads (§15.1). */
interface EventRow {
  readonly counters: { readonly imageCount: number; readonly processedImageCount: number };
  readonly retentionExpiresAt?: Date | null;
}

/** The `selfies` fields the summary projects (§16.4). */
interface SelfieRow {
  readonly _id: ObjectId;
  readonly assetId?: ObjectId | null;
  readonly liveness?: { readonly required?: boolean; readonly passed?: boolean } | null;
  readonly quality?: {
    readonly accepted?: boolean;
    readonly rejectionReason?: string | null;
  } | null;
}

/** The `media_assets` fields a selfie preview is signed from (§16.1). */
interface AssetRow {
  readonly contentHash: string;
  readonly derivatives?: { readonly thumbnail?: { readonly format?: string } } | null;
}

/** The newest match's watermark half (§17.5). */
interface NewestMatchRow {
  readonly _id: ObjectId;
  readonly createdAt: Date;
}

/** The entitlement that caps an attendee's selfie attempts (§14.1). */
const SELFIE_ATTEMPTS_KEY = "selfies.per_attendee";

/** The selfie summary §6.4 answers, or `null` when no selfie is active. */
const selfieSummarySchema = z.object({
  id: z.string(),
  accepted: z.boolean(),
  previewUrl: z.string().nullable(),
  liveness: z.object({ required: z.boolean(), passed: z.boolean() }),
  quality: z.object({ accepted: z.boolean(), rejectionReason: z.string().nullable() }),
  attemptsUsed: z.number().int().nonnegative(),
  attemptsRemaining: z.number().int().nonnegative(),
});

/** The §6.4 body: its fourteen keys plus the client's `latestMatchCursor`. */
const participationSchema = z.object({
  profileId: z.string(),
  // Never the stored subject: the session id and the user id are internal.
  subject: z.object({
    kind: z.enum(["anonymous", "user"]),
    canClaimByLogin: z.boolean(),
  }),
  status: z.string(),
  statusDetail: z
    .object({
      code: z.string(),
      message: z.string(),
      remedy: z.string(),
      canRetry: z.boolean(),
    })
    .nullable(),
  selfie: selfieSummarySchema.nullable(),
  matchCount: z.number().int().nonnegative(),
  newMatchCount: z.number().int().nonnegative(),
  lastMatchRunAt: z.iso.datetime().nullable(),
  indexingComplete: z.boolean(),
  galleryUrl: z.string(),
  galleryExpiresAt: z.iso.datetime().nullable(),
  pollIntervalMs: z.number().int().positive(),
  nextPollAfter: z.iso.datetime(),
  latestMatchCursor: z.string().nullable(),
});

/**
 * The event facts the poll and the gallery summary read (§15.1).
 *
 * @param db - The database to read `events` from.
 * @param eventId - The addressed event.
 * @returns The counters and retention instant, or `null` for a vanished row.
 */
async function readEventRow(db: Db, eventId: ObjectId): Promise<EventRow | null> {
  return (await platformRepo(db)
    .collection(COLLECTIONS.events)
    .findOne(
      { _id: eventId },
      { projection: { counters: 1, retentionExpiresAt: 1 } }
    )) as EventRow | null;
}

/**
 * The active selfie's stored facts (§16.4).
 *
 * @param tenant - The event's tenant repository.
 * @param selfieId - The profile's `activeSelfieId`, when it has one.
 * @returns The row, or `null` when the profile has no active selfie.
 */
async function readActiveSelfie(
  tenant: TenantRepository,
  selfieId: ObjectId | null | undefined
): Promise<SelfieRow | null> {
  if (selfieId === null || selfieId === undefined) {
    return null;
  }
  return (await tenant
    .collection(COLLECTIONS.selfies)
    .findOne(
      { _id: selfieId },
      { projection: { _id: 1, assetId: 1, liveness: 1, quality: 1 } }
    )) as SelfieRow | null;
}

/**
 * The newest match the client already has — the `latestMatchCursor` source.
 *
 * One row on the §17.5 `{profileId, createdAt}` index, not a scan of the
 * profile's matches.
 *
 * @param tenant - The event's tenant repository.
 * @param profileId - The caller's profile.
 * @returns The newest row, or `null` when the profile has no matches.
 */
async function readNewestMatch(
  tenant: TenantRepository,
  profileId: ObjectId
): Promise<NewestMatchRow | null> {
  const rows = (await tenant
    .collection(COLLECTIONS.faceMatches)
    .find(
      { profileId },
      { projection: { _id: 1, createdAt: 1 }, sort: { createdAt: -1, _id: -1 }, limit: 1 }
    )
    .toArray()) as unknown as NewestMatchRow[];
  return rows.at(0) ?? null;
}

/**
 * The signed thumbnail of a stored selfie, for the "your photo" tile (§6.4).
 *
 * @param tenant - The event's tenant repository.
 * @param assetId - The selfie's asset id, when it has one.
 * @returns The signed URL, or `null` when there is no asset to sign.
 */
async function selfiePreviewUrl(
  tenant: TenantRepository,
  assetId: ObjectId | null | undefined
): Promise<string | null> {
  if (assetId === null || assetId === undefined) {
    return null;
  }
  const asset = (await tenant
    .collection(COLLECTIONS.mediaAssets)
    .findOne(
      { _id: assetId },
      { projection: { contentHash: 1, derivatives: 1 } }
    )) as AssetRow | null;
  if (asset === null) {
    return null;
  }
  return attendeeMediaSigner().sign({
    kind: "thumbnail",
    contentHash: asset.contentHash,
    ext: asset.derivatives?.thumbnail?.format ?? "webp",
  }).url;
}

export const GET = defineRoute({
  route: "/api/v1/p/events/:slug/me",
  response: participationSchema,
  // §0.11 `read.hot`: the poll is the hottest read on the attendee surface.
  rateLimit: rateLimitStage({
    classKey: "read.hot",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  handler: async (ctx) => {
    const scope = await requireAttendeeProfile(ctx);
    const { db, event, profile } = scope;
    const tenant = tenantRepo(event.tenantKey, db);
    const now = systemClock.now();

    const [eventRow, selfieRow, attemptsUsed, newMatchCount, newestMatch, settings] =
      await Promise.all([
        readEventRow(db, event.eventId),
        readActiveSelfie(tenant, profile.activeSelfieId),
        tenant.collection(COLLECTIONS.selfies).countDocuments({ profileId: profile._id }),
        tenant
          .collection(COLLECTIONS.faceMatches)
          .countDocuments({ profileId: profile._id, seenAt: null }),
        readNewestMatch(tenant, profile._id),
        getPlatformSettings({ db }),
      ]);

    const indexingComplete = eventIndexingComplete(
      eventRow?.counters ?? { imageCount: 0, processedImageCount: 0 }
    );
    // §15.3's stored union has no `no_selfie`: a profile that has never submitted
    // a selfie is stored `selfie_pending` (the consent route's choice, pinned by
    // OP-131), and §6.4 names that state `no_selfie` on the wire.
    const wireStatus =
      profile.status === "selfie_pending" && attemptsUsed === 0 ? "no_selfie" : profile.status;
    const resolved = resolveStatus({
      status: wireStatus,
      matchCount: profile.matchCount,
      rejectionReason: selfieRow?.quality?.rejectionReason ?? null,
    });
    const intervalMs = pollIntervalMs({ status: resolved.status, indexingComplete });

    let selfie = null;
    if (selfieRow !== null) {
      // Read-only verdict: `amount = 0` asks "how many are allowed", so a poll
      // can never consume an attendee's budget.
      const entitlement = await checkEntitlement(event.tenantKey, SELFIE_ATTEMPTS_KEY, 0, {}, { db });
      const budget = selfieAttemptBudget({
        used: attemptsUsed,
        allowed: entitlement.effectiveLimit ?? settings.selfie.attemptsAllowed,
      });
      selfie = {
        id: selfieRow._id.toHexString(),
        accepted: selfieRow.quality?.accepted === true,
        previewUrl: await selfiePreviewUrl(tenant, selfieRow.assetId),
        liveness: {
          required: selfieRow.liveness?.required === true,
          passed: selfieRow.liveness?.passed === true,
        },
        quality: {
          accepted: selfieRow.quality?.accepted === true,
          rejectionReason: selfieRow.quality?.rejectionReason ?? null,
        },
        attemptsUsed: budget.attemptsUsed,
        attemptsRemaining: budget.attemptsRemaining,
      };
    }

    return {
      body: {
        profileId: profile._id.toHexString(),
        subject: {
          kind: scope.subject.kind,
          canClaimByLogin: scope.subject.kind === "anonymous",
        },
        status: resolved.status,
        statusDetail: resolved.statusDetail,
        selfie,
        matchCount: profile.matchCount,
        newMatchCount,
        lastMatchRunAt:
          profile.lastMatchRunAt === undefined || profile.lastMatchRunAt === null
            ? null
            : profile.lastMatchRunAt.toISOString(),
        indexingComplete,
        // The page's own address (contract §6.4).
        galleryUrl: `/e/${scope.slug}/gallery`,
        galleryExpiresAt:
          eventRow?.retentionExpiresAt === undefined || eventRow.retentionExpiresAt === null
            ? null
            : eventRow.retentionExpiresAt.toISOString(),
        pollIntervalMs: intervalMs,
        nextPollAfter: nextPollAfter(now, intervalMs).toISOString(),
        latestMatchCursor:
          newestMatch === null
            ? null
            : encodeWatermark({
                createdAt: newestMatch.createdAt,
                matchId: newestMatch._id.toHexString(),
              }),
      },
    };
  },
});
