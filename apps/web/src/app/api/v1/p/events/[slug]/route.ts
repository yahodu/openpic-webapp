import type { Db } from "mongodb";
import { ObjectId } from "mongodb";
import { z } from "zod";

import {
  formatStartAtLocal,
  resolvePublicEventOutcome,
  type PublicEventRefusal,
  type PublicEventStatus,
} from "@/server/attendee/public-event";
import { attendeeTokenFrom } from "@/server/attendee/session-resolver";
import { hashAttendeeSessionToken } from "@/server/attendee/session-token";
import { getConfig, getRateLimitConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { createMediaSigner } from "@/server/media/signer";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";
import { platformRepo, tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { checkEntitlement } from "@/server/services/entitlements";
import { getPlatformSettings } from "@/server/settings/platform-settings";

/**
 * `GET /api/v1/p/events/{slug}` — the attendee landing page (OP-130, contract
 * §6.1, schema §15.1/§15.3; ADR-0784).
 *
 * The platform's widest public read: no account, no session, one round trip.
 * The slug alone addresses the event, and the whole risk is the refusal
 * surface — so the five documented states are decided by the pure
 * `resolvePublicEventOutcome` table and this handler only *reads* the facts and
 * *projects* the envelope:
 *
 *   - the slug resolves through `accessLinks[].slug` where the link is
 *     **active** (the schema §21 partial index), never `accessLinks[0]`; a slug
 *     that names a revoked link is `410 access_link_revoked`, a slug that names
 *     nothing is `404 not_found`;
 *   - a `draft` answers exactly like an unknown slug, and every refusal body is
 *     the bare §10.4 envelope — no event name, no event id;
 *   - the body is the six §6.1 sections and nothing else: `logoUrl` is signed
 *     here, `startAtLocal` is pre-rendered here, and no internal identifier ever
 *     leaves (§0.15).
 */

/** The §6.1 refusal message for a rotated link, quoted verbatim by the contract. */
const REVOKED_MESSAGE = "This QR code is no longer valid. Ask the organizer for the current link.";

/** The §6.1 cache policy: a private 30-second cache for the landing call. */
const CACHE_CONTROL = "private, max-age=30";

/** The one consent purpose the attendee surface asks for (contract §6.2). */
const BIOMETRIC_PURPOSE = "biometric_processing";

/** The entitlement a plan gates the selfie attempt budget on (schema §14.1). */
const SELFIE_ATTEMPTS_KEY = "selfies.per_attendee";

/** Every `events.status` value (schema §15.1), shared with the state table. */
const eventStatusSchema = z.enum([
  "draft",
  "published",
  "live",
  "ended",
  "archived",
  "deleting",
] satisfies readonly PublicEventStatus[]);

/** The §6.1 `event` section. */
const eventSectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  // The landing page renders the description (ADR-0784 §3); the create route
  // stores `""` for an event created without one, so this is never null.
  description: z.string(),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime(),
  displayTimeZone: z.string(),
  startAtLocal: z.string(),
  logoUrl: z.string().nullable(),
  organizerDisplayName: z.string(),
  status: eventStatusSchema,
});

/** The §6.1 `gallery` section; `expiredAt` exists only once retention elapsed. */
const gallerySectionSchema = z.object({
  open: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
  expiredAt: z.iso.datetime().optional(),
  imageCount: z.number().int().nonnegative(),
  indexingComplete: z.boolean(),
});

/** The §6.1 `selfie` section — the rules the attendee must satisfy. */
const selfieSectionSchema = z.object({
  acceptedMimeTypes: z.array(z.string()),
  maxBytes: z.number().int().positive(),
  livenessRequired: z.boolean(),
  attemptsAllowed: z.number().int().positive(),
  attemptsUsed: z.number().int().nonnegative(),
});

/** The §6.1 `consent` section — the current biometric policy spec. */
const consentSectionSchema = z.object({
  required: z.boolean(),
  purpose: z.string(),
  policyVersion: z.string(),
  policyUrl: z.string(),
  granted: z.boolean(),
});

/** The §6.1 `session` hint the page uses to skip an already-done selfie flow. */
const sessionSectionSchema = z.object({
  kind: z.literal("anonymous"),
  hasProfile: z.boolean(),
  canClaimByLogin: z.boolean(),
});

/** The §6.1 `PublicEvent` envelope — the six sections and nothing else. */
const publicEventResponseSchema = z.object({
  slug: z.string(),
  event: eventSectionSchema,
  gallery: gallerySectionSchema,
  selfie: selfieSectionSchema,
  consent: consentSectionSchema,
  session: sessionSectionSchema,
});

/** The stored `events` row fields this route reads (schema §15.1). */
interface EventRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly name: string;
  readonly description?: string;
  readonly status: PublicEventStatus;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly displayTimeZone: string;
  readonly retentionExpiresAt?: Date | null;
  readonly logoAssetId?: ObjectId | null;
  readonly counters: {
    readonly imageCount: number;
    readonly processedImageCount: number;
    readonly failedImageCount: number;
  };
}

/** The stored `media_assets` fields the logo URL is minted from (schema §16.1). */
interface LogoAssetRow {
  readonly contentHash: string;
  readonly derivatives?: {
    readonly thumbnail?: { readonly format?: string };
  } | null;
}

/** The `{slug}` path segment of the request; `""` when the path has none. */
function slugFromRequest(request: Request): string {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  return segments.at(-1) ?? "";
}

/**
 * Resolve a landing slug to the event it addresses and the state of its link.
 *
 * The active lookup runs first because the schema §21 partial index only serves
 * a query that *asserts* `active: true`; the second probe runs only for a slug
 * that matched no active link, so a rotated slug and a slug that never existed
 * stay distinguishable without a second query on the hot path.
 *
 * @param db - The database to read `events` from.
 * @param slug - The requested slug.
 * @returns The active event row, or the revoked/unknown link state.
 */
async function resolveSlug(
  db: Db,
  slug: string
): Promise<
  { readonly link: "active"; readonly event: EventRow } | { readonly link: "revoked" | "unknown" }
> {
  const events = platformRepo(db).collection(COLLECTIONS.events);
  if (slug !== "") {
    const active = (await events.findOne({
      accessLinks: { $elemMatch: { slug, active: true } },
    })) as EventRow | null;
    if (active !== null) {
      return { link: "active", event: active };
    }
  }

  const revoked =
    slug === ""
      ? null
      : await events.findOne({ "accessLinks.slug": slug }, { projection: { _id: 1 } });
  return { link: revoked === null ? "unknown" : "revoked" };
}

/**
 * Throw the §6.1 refusal. A revoked link carries the contract sentence so the
 * page can render "ask for the current link"; no other refusal carries content.
 *
 * @param refusal - The refusal the state table resolved.
 */
function throwRefusal(refusal: PublicEventRefusal): never {
  if (refusal.code === "access_link_revoked") {
    throw appError("access_link_revoked", { details: { message: REVOKED_MESSAGE } });
  }
  throw appError(refusal.code);
}

/**
 * The signed `thumbnail` URL of an event's logo, or `null` when there is none.
 *
 * @param db - The database to read `mediaAssets` from.
 * @param tenantKey - The owning tenant (the asset scope).
 * @param assetId - The event's `logoAssetId`.
 * @returns The signed URL, or `null` when the asset row is gone.
 */
async function logoUrlFor(db: Db, tenantKey: string, assetId: ObjectId): Promise<string | null> {
  const asset = (await tenantRepo(tenantKey, db)
    .collection(COLLECTIONS.mediaAssets)
    .findOne(
      { _id: assetId },
      { projection: { contentHash: 1, derivatives: 1 } }
    )) as LogoAssetRow | null;
  if (asset === null) {
    return null;
  }

  const config = getConfig();
  const signer = createMediaSigner({
    currentSecret: config.media.signingSecretCurrent,
    ...(config.media.signingSecretPrevious === undefined
      ? {}
      : { previousSecret: config.media.signingSecretPrevious }),
  });
  return signer.sign({
    kind: "thumbnail",
    contentHash: asset.contentHash,
    // The pipeline records the derivative's format; a photo thumbnail is webp.
    ext: asset.derivatives?.thumbnail?.format ?? "webp",
  }).url;
}

/**
 * The attendee session the request's `op_att` cookie or header names, if any.
 *
 * Expiry is deliberately **not** judged here: §6.1 declares the route `public`
 * and its error table has no `401`, so a lapsed cookie is a hint that resolves
 * to a profile or to nothing — never a refusal.
 *
 * @param db - The database to read `attendeeSessions` from.
 * @param request - The inbound request.
 * @returns The stored session id, or `null` when no session matches.
 */
async function attendeeSessionIdFor(db: Db, request: Request): Promise<string | null> {
  const token = attendeeTokenFrom(request);
  if (token === null) {
    return null;
  }
  const row = (await platformRepo(db)
    .collection(COLLECTIONS.attendeeSessions)
    .findOne({ tokenHash: hashAttendeeSessionToken(token) }, { projection: { _id: 1 } })) as {
    readonly _id: ObjectId;
  } | null;
  return row === null ? null : String(row._id);
}

/**
 * Whether this caller already has a profile on **this** event (schema §15.3).
 *
 * The lookup is scoped by the event id, never by the tenant: one organizer may
 * run several events in one tenant, and a tenant-scoped lookup would tell an
 * attendee who scanned a different QR "you are already in this event"
 * (ADR-0784 §3, review findings F1).
 *
 * @param db - The database to read `attendeeEventProfiles` from.
 * @param tenantKey - The event's tenant (the profile scope).
 * @param eventId - The event being rendered.
 * @param sessionId - The caller's attendee session id, when it presented one.
 * @returns `true` only for a profile of this event and this session.
 */
async function hasProfileFor(
  db: Db,
  tenantKey: string,
  eventId: ObjectId,
  sessionId: string | null
): Promise<boolean> {
  if (sessionId === null) {
    return false;
  }
  const profile = await tenantRepo(tenantKey, db)
    .collection(COLLECTIONS.attendeeEventProfiles)
    .findOne(
      { eventId: eventId.toHexString(), "subject.attendeeSessionId": sessionId },
      { projection: { _id: 1 } }
    );
  return profile !== null;
}

export const GET = defineRoute({
  route: "/api/v1/p/events/:slug",
  response: publicEventResponseSchema,
  // §0.11 `public.gallery`: the only class whose `ip` rule is 600/min, and an
  // unauthenticated landing call has no attendee identity to key on.
  rateLimit: rateLimitStage({
    classKey: "public.gallery",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  handler: async (ctx) => {
    const db = getDb();
    const slug = slugFromRequest(ctx.request);
    const resolved = await resolveSlug(db, slug);

    const outcome = resolvePublicEventOutcome({
      link: resolved.link,
      status: resolved.link === "active" ? resolved.event.status : null,
      now: systemClock.now(),
      retentionExpiresAt:
        resolved.link === "active" ? (resolved.event.retentionExpiresAt ?? null) : null,
    });
    if (outcome.kind === "error") {
      throwRefusal(outcome);
    }
    if (resolved.link !== "active") {
      // The state table refuses every non-active link, so reaching this point is
      // a table regression, not a request the client can fix.
      throw appError("internal_error");
    }

    const event = resolved.event;
    const settings = await getPlatformSettings({ db });
    const tenant = (await platformRepo(db)
      .collection(COLLECTIONS.tenants)
      .findOne({ _id: new ObjectId(event.tenantId) }, { projection: { name: 1 } })) as {
      readonly name?: string;
    } | null;

    const sessionId = await attendeeSessionIdFor(db, ctx.request);
    const [logoUrl, hasProfile, selfieEntitlement] = await Promise.all([
      event.logoAssetId === null || event.logoAssetId === undefined
        ? null
        : logoUrlFor(db, event.tenantId, event.logoAssetId),
      hasProfileFor(db, event.tenantId, event._id, sessionId),
      // Read-only verdict: `amount = 0` asks "how many are allowed", so a
      // public GET can never consume an attendee's budget.
      checkEntitlement(event.tenantId, SELFIE_ATTEMPTS_KEY, 0, {}, { db }),
    ]);

    const retentionExpiresAt = event.retentionExpiresAt ?? null;

    return {
      body: {
        slug,
        event: {
          id: event._id.toHexString(),
          name: event.name,
          description: event.description ?? "",
          startAt: event.startAt.toISOString(),
          endAt: event.endAt.toISOString(),
          displayTimeZone: event.displayTimeZone,
          startAtLocal: formatStartAtLocal(event.startAt, event.displayTimeZone),
          logoUrl,
          organizerDisplayName: tenant?.name ?? "",
          status: event.status,
        },
        gallery: {
          open: outcome.galleryOpen,
          expiresAt: retentionExpiresAt === null ? null : retentionExpiresAt.toISOString(),
          ...(outcome.galleryExpiredAt === null
            ? {}
            : { expiredAt: outcome.galleryExpiredAt.toISOString() }),
          imageCount: event.counters.imageCount,
          indexingComplete:
            event.counters.processedImageCount + event.counters.failedImageCount >=
            event.counters.imageCount,
        },
        selfie: {
          acceptedMimeTypes: settings.upload.supportedMimeTypes,
          maxBytes: settings.upload.maxFileBytes,
          // §6.3 makes the liveness challenge a precondition of every selfie.
          livenessRequired: true,
          attemptsAllowed: selfieEntitlement.effectiveLimit ?? settings.selfie.attemptsAllowed,
          // A caller with no profile has used none of them. Attributing a
          // non-zero count needs the `selfies` rows OP-131 owns (ADR-0784 §3).
          attemptsUsed: 0,
        },
        consent: {
          required: true,
          purpose: BIOMETRIC_PURPOSE,
          policyVersion: settings.legal.biometricPolicyVersion,
          policyUrl: settings.legal.biometricPolicyUrl,
          // `POST /p/events/{slug}/consent` (§6.2) is the only writer.
          granted: false,
        },
        session: {
          // The landing call resolves only the attendee credential; claiming a
          // profile by login is a §6.2 flow this read does not observe.
          kind: "anonymous" as const,
          hasProfile,
          canClaimByLogin: true,
        },
      },
      headers: { "cache-control": CACHE_CONTROL },
    };
  },
});
