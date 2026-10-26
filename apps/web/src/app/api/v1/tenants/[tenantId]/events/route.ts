import { ObjectId } from "mongodb";
import { z } from "zod";

import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { withTransaction } from "@/server/db/transaction";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { normalizeInstantToUtc } from "@/server/events/dates";
import { eventDtoSchema, toEventDto } from "@/server/events/dto";
import { generateAccessLinkSlug } from "@/server/events/slug";
import {
  computeDurationDays,
  computeRetentionExpiresAt,
  computeUploadWindowEndsAt,
} from "@/server/events/windows";
import { created, defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { eventETag } from "@/server/http/etag";
import { idempotencyStage, mongoIdempotencyStore } from "@/server/idempotency";
import { getLogger } from "@/server/logging";
import { tenantRepo } from "@/server/repos";
import { checkEntitlement, consumeEntitlement } from "@/server/services/entitlements";
import { systemClock } from "@/server/runtime/clock";
import { MS_PER_DAY } from "@/server/runtime/time";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `POST /api/v1/tenants/{tenantId}/events` — create an event with
 * materialised windows (OP-115, contract §4.1, schema §15.1/§15.2/§14.2;
 * ADR-0520).
 *
 * The organizer (owner|admin|member — the reusable tenant stage admits any
 * active membership) names the event and its dates; the server materialises
 * `uploadWindowEndsAt = endAt + events.post_upload_days` and
 * `retentionExpiresAt = endAt + gallery.retention_days` from the plan's
 * entitlements, draws an 8-char unambiguous access-link slug, and — **in one
 * transaction** — consumes `events.active`, inserts the `events` row (embedded
 * `accessLinks`, zeroed `counters`, the initialised `sequence`) and the single
 * `event_organizers` row (`role: "organizer"`, `revokedAt: null`), and emits
 * the `event.created` outbox event. A refusal at any point persists nothing:
 * the entitlement denial aborts the transaction, and every 4xx validation
 * runs before it opens.
 *
 * The caller may override the upload window with `postUploadDays` (0 up to the
 * entitlement; an explicit `null` is legal only on an unlimited entitlement
 * and materialises `uploadWindowEndsAt: null`). `publish: true` creates the
 * event `published`, anything else `draft`.
 *
 * The response is `201` with `Location`, a quoted `ETag` and the full Event
 * DTO; idempotency is required (§0.9), so a replay under the same
 * `Idempotency-Key` answers `200` with the stored body.
 */

/** The events schema version stamped on every row (schema §15.1). */
const EVENT_SCHEMA_VERSION = 1;

/** The upgrade offer the plan-limit refusals carry (§0.14). */
const UPGRADE_PATH = "/api/v1/tenants/current/billing/upgrade";

/** How many slugs a single create may try before giving up (I5). */
const MAX_SLUG_ATTEMPTS = 5;

/** MongoDB's duplicate-key server error code (the slug-collision signal). */
const DUPLICATE_KEY = 11000;

/** The `displayTimeZone` must be a real IANA name (contract §4.1). */
function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Strip HTML tags to inert plain text (OP-115 I9, §5).
 *
 * Tags are removed; the remaining text stays inert — the stored and returned
 * description must never carry angle brackets. Whether the inner text of a
 * stripped `<script>` survives is deliberately unpinned (ADR-0520).
 */
function sanitizeDescription(input: string): string {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when an error is MongoDB's duplicate-key (E11000) refusal. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

/** The create-event request body (contract §4.1). */
const createEventBodySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  startAt: z.string(),
  endAt: z.string(),
  displayTimeZone: z.string(),
  logoAssetId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .nullable()
    .default(null),
  watermarkAssetId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .nullable()
    .default(null),
  publish: z.boolean().default(false),
  postUploadDays: z.number().int().min(0).nullable().optional(),
});

/** The response schema is the shared Event DTO. */
const responseSchema = eventDtoSchema;

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/events",
  body: createEventBodySchema,
  response: responseSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage({ provisionOnMissing: true }),
  idempotency: idempotencyStage({ store: mongoIdempotencyStore(), required: true }),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    const db = getDb();
    const config = getConfig();
    const now = systemClock.now();
    const tenantKey = scope.tenantId.toHexString();
    const actor = scope.userId;

    // ── instant normalisation (U4 at the wire; a +05:30 input comes back Z) ──
    let startAt: string;
    let endAt: string;
    try {
      startAt = normalizeInstantToUtc(ctx.body.startAt);
      endAt = normalizeInstantToUtc(ctx.body.endAt);
    } catch {
      throw appError("validation_failed", {
        details: {
          fields: [
            { path: "startAt", code: "invalid_instant", message: "must be an RFC 3339 instant" },
            { path: "endAt", code: "invalid_instant", message: "must be an RFC 3339 instant" },
          ],
        },
      });
    }

    if (Date.parse(endAt) <= Date.parse(startAt)) {
      throw appError("invalid_date_range", { details: { startAt, endAt } });
    }

    if (!isValidIanaTimeZone(ctx.body.displayTimeZone)) {
      throw appError("unknown_timezone");
    }

    if (Date.parse(startAt) < now.getTime() - 30 * MS_PER_DAY) {
      throw appError("start_too_far_past");
    }

    // ── duration vs events.duration_days (I11: the 403 carries requestedDays) ──
    const durationDays = computeDurationDays(new Date(startAt), new Date(endAt));
    const durationVerdict = await checkEntitlement(
      tenantKey,
      "events.duration_days",
      durationDays,
      { counts: 0 },
      { db }
    );
    if (!durationVerdict.allowed) {
      if (durationVerdict.reason === "payment_downgrade") {
        throw appError("payment_required", {
          details: {
            entitlementKey: "events.duration_days",
            reason: "payment_downgrade",
            pendingDueMinor: durationVerdict.pendingDueMinor,
            currency: durationVerdict.currency,
            payNowUrl: `/api/v1/tenants/${tenantKey}/billing/retry-charge`,
            gracePeriodEndsAt:
              durationVerdict.gracePeriodEndsAt === null
                ? null
                : durationVerdict.gracePeriodEndsAt.toISOString(),
          },
        });
      }
      throw appError("plan_limit_exceeded", {
        details: {
          entitlementKey: "events.duration_days",
          limit: durationVerdict.limit,
          used: durationVerdict.used,
          periodKey: durationVerdict.periodKey,
          scope: durationVerdict.scope,
          reason: "plan_limit",
          upgradePath: UPGRADE_PATH,
          requestedDays: durationDays,
        },
      });
    }

    // ── postUploadDays vs events.post_upload_days (I12/I13) ──
    const postUploadVerdict = await checkEntitlement(
      tenantKey,
      "events.post_upload_days",
      0,
      { counts: 0 },
      { db }
    );
    const postUploadLimit = postUploadVerdict.effectiveLimit;
    let postUploadDays: number | null;
    if (ctx.body.postUploadDays === null) {
      // An explicit `null` means "no close" and is legal only when unlimited.
      if (postUploadLimit !== null) {
        throw appError("plan_limit_exceeded", {
          details: {
            entitlementKey: "events.post_upload_days",
            limit: postUploadLimit,
            upgradePath: UPGRADE_PATH,
          },
        });
      }
      postUploadDays = null;
    } else {
      postUploadDays =
        ctx.body.postUploadDays ??
        // The default is the entitlement itself (null when unlimited).
        postUploadLimit;
      if (postUploadLimit !== null && postUploadDays !== null && postUploadDays > postUploadLimit) {
        throw appError("plan_limit_exceeded", {
          details: {
            entitlementKey: "events.post_upload_days",
            limit: postUploadLimit,
            upgradePath: UPGRADE_PATH,
          },
        });
      }
    }

    // ── retention vs gallery.retention_days ──
    const retentionVerdict = await checkEntitlement(
      tenantKey,
      "gallery.retention_days",
      0,
      { counts: 0 },
      { db }
    );
    const retentionDays = retentionVerdict.effectiveLimit;

    // ── logo must be a branding asset of this tenant (I8/I8b) ──
    if (ctx.body.logoAssetId !== null) {
      const logo = await tenantRepo(tenantKey, db)
        .collection(COLLECTIONS.mediaAssets)
        .findOne({
          _id: new ObjectId(ctx.body.logoAssetId),
          kind: "event_logo",
        });
      if (logo === null) {
        throw appError("validation_failed", {
          details: {
            fields: [
              {
                path: "logoAssetId",
                code: "not_found",
                message: "must be an event_logo branding asset of this tenant",
              },
            ],
          },
        });
      }
    }

    const description = sanitizeDescription(ctx.body.description);
    const endAtInstant = new Date(endAt);
    const uploadWindowEndsAt = computeUploadWindowEndsAt(endAtInstant, postUploadDays);
    const retentionExpiresAt =
      retentionDays === null ? null : computeRetentionExpiresAt(endAtInstant, retentionDays);

    const eventId = new ObjectId();
    const status = ctx.body.publish ? "published" : "draft";

    // Slug generation joined to the transaction; a duplicate-key rejection
    // (E11000 on the unique accessLinks.slug index) aborts the attempt and the
    // whole transaction — consume, insert, organizer, emit — is retried with a
    // fresh draw, so the counter increments exactly once (I5).
    let slug = generateAccessLinkSlug();
    let attempt = 0;
    for (;;) {
      try {
        await withTransaction(async (session) => {
          await consumeEntitlement(
            session,
            tenantKey,
            "events.active",
            1,
            {
              actorRef: { kind: "user", id: actor },
              subjectRef: { kind: "tenant", id: tenantKey },
            },
            { db }
          );

          await tenantRepo(tenantKey, db)
            .collection(COLLECTIONS.events)
            .insertOne(
              {
                _id: eventId,
                tenantId: tenantKey,
                name: ctx.body.name,
                description,
                status,
                startAt: new Date(startAt),
                endAt: endAtInstant,
                displayTimeZone: ctx.body.displayTimeZone,
                uploadWindowEndsAt,
                retentionExpiresAt,
                accessLinks: [{ slug, active: true, createdAt: now, revokedAt: null }],
                counters: {
                  imageCount: 0,
                  processedImageCount: 0,
                  failedImageCount: 0,
                  attendeeCount: 0,
                  matchCount: 0,
                  storageBytes: 0,
                },
                sequence: 1,
                logoAssetId:
                  ctx.body.logoAssetId === null ? null : new ObjectId(ctx.body.logoAssetId),
                watermarkAssetId:
                  ctx.body.watermarkAssetId === null
                    ? null
                    : new ObjectId(ctx.body.watermarkAssetId),
                createdByUserId: actor,
                schemaVersion: EVENT_SCHEMA_VERSION,
                createdAt: now,
                updatedAt: now,
              },
              { session }
            );

          await tenantRepo(tenantKey, db).collection(COLLECTIONS.eventOrganizers).insertOne(
            {
              tenantId: tenantKey,
              eventId,
              userId: actor,
              role: "organizer",
              revokedAt: null,
              createdAt: now,
              updatedAt: now,
              schemaVersion: EVENT_SCHEMA_VERSION,
            },
            { session }
          );

          await emitDomainEvent(
            {
              eventKey: "event.created",
              tenantId: tenantKey,
              actorRef: { kind: "user", id: actor },
              subjectRef: { kind: "event", id: eventId.toHexString() },
              payload: { eventId: eventId.toHexString() },
            },
            { db, session }
          );
        });
        break;
      } catch (error) {
        attempt += 1;
        if (isDuplicateKeyError(error) && attempt < MAX_SLUG_ATTEMPTS) {
          slug = generateAccessLinkSlug();
          continue;
        }
        throw error;
      }
    }

    getLogger().info("event created", {
      event: "event.created",
      tenantId: tenantKey,
      eventId: eventId.toHexString(),
    });

    const dto = toEventDto(
      {
        _id: eventId,
        name: ctx.body.name,
        status,
        startAt: new Date(startAt),
        endAt: endAtInstant,
        displayTimeZone: ctx.body.displayTimeZone,
        description,
        uploadWindowEndsAt,
        retentionExpiresAt,
        accessLinks: [{ slug, active: true }],
        createdAt: now,
      },
      config.app.baseUrl
    );
    if (dto === null) {
      throw appError("internal_error");
    }

    const location = `/api/v1/tenants/${tenantKey}/events/${eventId.toHexString()}`;
    const response = created(dto, location);
    return {
      ...response,
      headers: { ...response.headers, etag: eventETag(now, EVENT_SCHEMA_VERSION) },
    };
  },
});
