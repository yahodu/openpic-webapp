import { ObjectId, type Db } from "mongodb";
import { z } from "zod";

import { buildConsentEvidence } from "@/server/attendee/consent-evidence";
import {
  CONSENT_PURPOSE,
  subjectFilter,
  type ConsentSubject,
} from "@/server/attendee/consent-guard";
import { DELETED_COUNTS_HEADER, formatDeletedCounts } from "@/server/attendee/deleted-counts";
import { findRequestAttendeeSession } from "@/server/attendee/session-resolver";
import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { getRateLimitConfig, getTrustedClientIpHeader } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { requestLogger } from "@/server/logging";
import { createRateLimiter, rateLimitStage, resolveClientIp } from "@/server/rate-limit";
import { platformRepo, tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { sha256Hex } from "@/server/runtime/crypto";
import { getPlatformSettings } from "@/server/settings/platform-settings";

/**
 * `POST` / `DELETE /api/v1/p/events/{slug}/consent` — biometric consent grant
 * and withdrawal (OP-131, contract §6.2, schema §15.3/§15.4/§16.4; ADR-0789,
 * ADR-0790).
 *
 * Consent is the hard precondition of the whole attendee surface (§6.2), so the
 * two methods carry opposite obligations on one resource:
 *
 *   - the **grant** must be *demonstrable* years later — the policy version, a
 *     deterministic digest of the document behind it, the instant, and the
 *     hashed device facts — and it links the caller's profile so the selfie
 *     routes know which consent is in force;
 *   - the **withdrawal** must actually destroy the biometric data — the selfie,
 *     its face vector and every `faceMatches` row of that profile — and report
 *     what it destroyed in `X-Deleted-Counts`, because a `204` has nowhere else
 *     to say it.
 *
 * Both are idempotent in the direction that matters: a second grant writes a
 * second row (the guard reads the latest one), and a repeated `DELETE` answers
 * `204` with zeros rather than failing, so a client can always retry a
 * withdrawal it could not confirm.
 */

/** The §6.2 receipt note for an attendee with no verified contact. */
const RECEIPT_NOTE = "A consent receipt is emailed only to signed-in attendees.";

/** The grant body (contract §6.2). */
const grantBodySchema = z.object({
  purpose: z.literal(CONSENT_PURPOSE),
  policyVersion: z.string().min(1),
  // Only a grant reaches this route; a withdrawal is the `DELETE`.
  granted: z.literal(true),
  // Optional **on purpose** (ADR-0789 §5): a required field would answer the
  // generic `422 validation_failed`, and the age refusal has its own code.
  ageConfirmed: z.boolean().optional(),
});

/** The §6.2 `201` body — exactly six keys. */
const grantResponseSchema = z.object({
  consentId: z.string(),
  purpose: z.string(),
  policyVersion: z.string(),
  grantedAt: z.iso.datetime(),
  receiptSent: z.boolean(),
  receiptNote: z.string(),
});

/** The `204` body placeholder: the pipeline serves no body for this status. */
const noContentSchema = z.null();

/** The `events` fields the slug lookup reads (schema §15.1). */
interface EventRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
}

/** A stored `selfies` row, as the withdrawal counts and deletes it (§16.4). */
interface SelfieRow {
  readonly _id: ObjectId;
  readonly assetId?: ObjectId | null;
  readonly embedding?: unknown;
}

/** A stored `attendeeEventProfiles` row, as the grant links it (schema §15.3). */
interface ProfileRow {
  readonly _id: ObjectId;
  readonly status?: string;
}

/** The event one consent call addresses. */
interface ResolvedEvent {
  readonly db: Db;
  /** The event's tenant (hex, as the event row stores it). */
  readonly tenantKey: string;
  readonly eventId: ObjectId;
}

/** The `{slug}` path segment of the request; `""` when the path has none. */
function slugFromRequest(request: Request): string {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  return segments.at(-2) ?? "";
}

/**
 * Resolve the event a consent call addresses through an **active** access link.
 *
 * @param db - The database to read `events` from.
 * @param slug - The requested slug.
 * @returns The event's tenant and id.
 * @throws {AppError} `not_found` when no active link carries the slug.
 */
async function resolveEvent(db: Db, slug: string): Promise<ResolvedEvent> {
  const event =
    slug === ""
      ? null
      : ((await platformRepo(db)
          .collection(COLLECTIONS.events)
          .findOne(
            { accessLinks: { $elemMatch: { slug, active: true } } },
            { projection: { _id: 1, tenantId: 1 } }
          )) as EventRow | null);
  if (event === null) {
    throw appError("not_found", { details: { resource: "event" } });
  }
  return { db, tenantKey: event.tenantId, eventId: event._id };
}

/**
 * The consent subject behind the request: the anonymous attendee session, or the
 * signed-in user who satisfies the same `attendee` label.
 *
 * @param db - The database to read `attendeeSessions` from.
 * @param request - The inbound request.
 * @param principal - The authenticated user id, when the caller is signed in.
 * @returns The subject the consent belongs to.
 * @throws {AppError} `authentication_required` when neither credential resolves.
 */
async function subjectFor(
  db: Db,
  request: Request,
  principal: string | undefined
): Promise<ConsentSubject> {
  const session = await findRequestAttendeeSession({ database: db }, request);
  if (session !== null) {
    return { kind: "anonymous", attendeeSessionId: session._id.toHexString() };
  }
  if (principal !== undefined) {
    return { kind: "user", userId: new ObjectId(principal) };
  }
  throw appError("authentication_required");
}

/**
 * The digest of the policy document one consent was given against (schema
 * §15.4).
 *
 * The settings pair names one immutable document — the version and its URL move
 * together — so the digest is deterministic per version: two attendees granting
 * the same version store the same value, which is what makes the evidence
 * verifiable.
 *
 * @param policyVersion - The current `legal.biometricPolicyVersion`.
 * @param policyUrl - The current `legal.biometricPolicyUrl`.
 * @returns `sha256:<64 hex>`.
 */
function policyDocumentHash(policyVersion: string, policyUrl: string): string {
  return `sha256:${sha256Hex(`${policyVersion}\u0000${policyUrl}`)}`;
}

/**
 * Link the grant to the caller's `attendeeEventProfiles` row (schema §15.3).
 *
 * The profile is created with `status: "selfie_pending"` — the documented member
 * of the schema's closed `status` union (ADR-0789 §5). An existing profile keeps
 * its own status, except a `withdrawn` one, whose biometric data a previous
 * withdrawal deleted, so it starts over.
 *
 * @param event - The resolved event (tenant scope + id).
 * @param subject - The subject the profile belongs to.
 * @param consentId - The consent row just written.
 * @param now - The instant of the grant.
 * @returns The profile's id.
 */
async function linkProfile(
  event: ResolvedEvent,
  subject: ConsentSubject,
  consentId: ObjectId,
  now: Date
): Promise<ObjectId> {
  const profiles = tenantRepo(event.tenantKey, event.db).collection(
    COLLECTIONS.attendeeEventProfiles
  );
  const filter = { eventId: event.eventId, ...subjectFilter(subject) };
  const existing = (await profiles.findOne(filter, {
    projection: { _id: 1, status: 1 },
  })) as ProfileRow | null;

  if (existing === null) {
    const _id = new ObjectId();
    await profiles.insertOne({
      _id,
      eventId: event.eventId,
      subject,
      status: "selfie_pending",
      activeSelfieId: null,
      matchCount: 0,
      lastMatchRunAt: null,
      lastSeenGalleryAt: null,
      firstMatchNotifiedAt: null,
      consentId,
      claimedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    return _id;
  }

  await profiles.updateOne(
    { _id: existing._id },
    {
      $set: {
        consentId,
        updatedAt: now,
        ...(existing.status === "withdrawn" ? { status: "selfie_pending" } : {}),
      },
    }
  );
  return existing._id;
}

export const POST = defineRoute({
  route: "/api/v1/p/events/:slug/consent",
  body: grantBodySchema,
  response: grantResponseSchema,
  // §0.11 `write.normal`, declared as the coarse stage like every other write.
  rateLimit: rateLimitStage({
    classKey: "write.normal",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  auth: (ctx, request) =>
    requireAuth("attendee", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const db = getDb();
    const settings = await getPlatformSettings({ db });
    const policyVersion = settings.legal.biometricPolicyVersion;

    // §6.2's precedence: a retired policy version is refused before anything
    // else, and neither refusal writes a row.
    if (ctx.body.policyVersion !== policyVersion) {
      throw appError("policy_version_stale", {
        details: {
          currentPolicyVersion: policyVersion,
          policyUrl: settings.legal.biometricPolicyUrl,
        },
      });
    }
    if (ctx.body.ageConfirmed !== true) {
      throw appError("age_confirmation_required");
    }

    const event = await resolveEvent(db, slugFromRequest(ctx.request));
    const subject = await subjectFor(db, ctx.request, ctx.principal);
    const now = systemClock.now();
    const consentId = new ObjectId();

    await tenantRepo(event.tenantKey, db)
      .collection(COLLECTIONS.consents)
      .insertOne({
        _id: consentId,
        eventId: event.eventId,
        subject,
        purpose: CONSENT_PURPOSE,
        policyVersion,
        policyDocumentHash: policyDocumentHash(policyVersion, settings.legal.biometricPolicyUrl),
        grantedAt: now,
        withdrawnAt: null,
        evidence: buildConsentEvidence({
          salt: getRateLimitConfig().salt,
          ip: resolveClientIp(ctx.request.headers, getTrustedClientIpHeader()) ?? null,
          userAgent: ctx.request.headers.get("user-agent"),
          acceptLanguage: ctx.request.headers.get("accept-language"),
        }),
        createdAt: now,
      });

    const profileId = await linkProfile(event, subject, consentId, now);

    requestLogger(ctx.request, { route: ctx.route }).info("consent granted", {
      event: "consent.granted",
      profileId: profileId.toHexString(),
      consentId: consentId.toHexString(),
    });

    return {
      status: 201,
      body: {
        consentId: consentId.toHexString(),
        purpose: CONSENT_PURPOSE,
        policyVersion,
        grantedAt: now.toISOString(),
        // §6.2 emails a receipt only to an identified attendee, whose claim flow
        // OP-132 owns; the anonymous caller's observable fact is `false`.
        receiptSent: false,
        receiptNote: RECEIPT_NOTE,
      },
    };
  },
});

export const DELETE = defineRoute({
  route: "/api/v1/p/events/:slug/consent",
  response: noContentSchema,
  rateLimit: rateLimitStage({
    classKey: "write.normal",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  auth: (ctx, request) =>
    requireAuth("attendee", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const db = getDb();
    const event = await resolveEvent(db, slugFromRequest(ctx.request));
    const subject = await subjectFor(db, ctx.request, ctx.principal);
    const now = systemClock.now();
    const tenant = tenantRepo(event.tenantKey, db);
    const profiles = tenant.collection(COLLECTIONS.attendeeEventProfiles);

    const profile = (await profiles.findOne(
      { eventId: event.eventId, ...subjectFilter(subject) },
      { projection: { _id: 1 } }
    )) as ProfileRow | null;

    let counts = { selfies: 0, embeddings: 0, matches: 0 };
    if (profile !== null) {
      const selfies = tenant.collection(COLLECTIONS.selfies);
      const rows = (await selfies
        .find({ profileId: profile._id }, { projection: { _id: 1, assetId: 1, embedding: 1 } })
        .toArray()) as SelfieRow[];

      // Only a selfie that carried a face vector counts as an embedding: a
      // still-queued selfie has no `embedding` key at all (schema §16.4).
      const embeddings = rows.filter(
        (row) => row.embedding !== undefined && row.embedding !== null
      ).length;
      const assetIds = [...new Set(rows.flatMap((row) => (row.assetId ? [row.assetId] : [])))];

      const [deletedSelfies, deletedMatches] = await Promise.all([
        selfies.deleteMany({ profileId: profile._id }),
        tenant.collection(COLLECTIONS.faceMatches).deleteMany({ profileId: profile._id }),
      ]);
      if (assetIds.length > 0) {
        // The blob is purged once nothing references it (schema §16.1), so the
        // withdrawal only drops the references the deleted selfies held.
        await tenant
          .collection(COLLECTIONS.mediaAssets)
          .updateMany({ _id: { $in: assetIds }, refCount: { $gt: 0 } }, { $inc: { refCount: -1 } });
      }

      await tenant.collection(COLLECTIONS.consents).updateMany(
        {
          eventId: event.eventId,
          purpose: CONSENT_PURPOSE,
          withdrawnAt: null,
          ...subjectFilter(subject),
        },
        { $set: { withdrawnAt: now } }
      );
      await profiles.updateOne(
        { _id: profile._id },
        { $set: { status: "withdrawn", updatedAt: now } }
      );

      counts = {
        selfies: deletedSelfies.deletedCount,
        embeddings,
        matches: deletedMatches.deletedCount,
      };

      requestLogger(ctx.request, { route: ctx.route }).info("consent withdrawn", {
        event: "consent.withdrawn",
        profileId: profile._id.toHexString(),
      });
    }

    return {
      status: 204,
      body: null,
      headers: { [DELETED_COUNTS_HEADER]: formatDeletedCounts(counts) },
    };
  },
});
