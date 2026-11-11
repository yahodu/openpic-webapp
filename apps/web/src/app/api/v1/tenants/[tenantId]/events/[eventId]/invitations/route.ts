import { ObjectId } from "mongodb";
import { z } from "zod";

import {
  instantOf,
  invitationBodySchema,
  invitationListSchema,
  invitationStatusSchema,
  toInvitationBody,
  type InvitationRow,
} from "@/server/collaboration/invitation-dto";
import {
  callerEmail,
  inviteeEmail,
  projectInvitation,
  resolveInviteeUserId,
} from "@/server/collaboration/invitation-access";
import { deliverInvite } from "@/server/collaboration/invitation-delivery";
import {
  coOrganizerSeats,
  deliveryFor,
  generateInvitationToken,
  hashInvitationToken,
  inviteeFilter,
  normalizeInvitee,
  toSeatMember,
} from "@/server/collaboration/invitations";
import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { withTransaction } from "@/server/db/transaction";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { requireEventRole, requirePrincipal, resolveEventActorRole } from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { created, defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { idempotencyStage, mongoIdempotencyStore } from "@/server/idempotency";
import { getLogger } from "@/server/logging";
import { platformRepo, tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { addDays } from "@/server/runtime/time";
import { checkEntitlement } from "@/server/services/entitlements";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantIdFromRequest, tenantStage } from "@/server/tenancy/route-stage";

/**
 * `POST` / `GET /api/v1/tenants/{tenantId}/events/{eventId}/invitations` —
 * invite a co-organizer, and list the event's invitations (OP-120, contract
 * §2.3, schema §13.6; ADR-0661).
 *
 * ## Create
 *
 * The **organizer** invites by user id, email or phone, so a co-organizer can
 * help upload even before they have an account. The endpoint is
 * idempotency-required (§0.9): a client that cannot name its attempt is refused
 * with `400 idempotency_key_required` — and writes nothing — rather than mailed
 * twice on a retry.
 *
 * The refusals are ordered **self → member → plan limit** (ADR-0660 A11): an
 * organizer inviting their own account gets `422 cannot_invite_self` (not the
 * `409` their own `event_organizers` row would otherwise earn), an invitee who
 * is already an active co-organizer gets `409 already_member` (not the `403`
 * the seat count would otherwise produce), and only a genuinely new invitee
 * consumes a seat. A duplicate **live** invite is `409
 * invitation_already_pending`: one redeemable link per invitee per event, so a
 * retry cannot double-mail.
 *
 * The seat is metered by `coorganizers.per_event` and counts active event
 * members **plus** live pending invitations — a pending invite already owns the
 * seat, or an organizer could mail out unbounded invitations that all accept
 * later (§2.3).
 *
 * The raw token is generated here and **never persisted**: the row keeps only
 * `sha256(token)`, the `201` carries no token-shaped key at all, and the raw
 * value exists solely inside the rendered invitation link the invitee receives.
 * Delivery therefore uses the **synchronous** transactional seam rather than the
 * outbox: the outbox fan-out resolves recipients from accounts, and an
 * email/phone invitee has none to resolve, while the rendered copy must carry
 * the link (this is the ADR-0660 A9 correction, ADR-0661 D3). The
 * `collab.invite.sent` domain event is still emitted — it is the in-app feed
 * fan-out and the audit fact — and it carries the invitation id only.
 *
 * ## List
 *
 * Any **event member** (organizer or co-organizer) reads this event's
 * invitations, newest first (§2.3), optionally filtered by `?status=`. The read
 * is event-scoped: another event's invitation is never in the result, and the
 * §0.13 masked invitee is the only contact fact on the wire.
 */

/** The invitation schema version stamped on every row (schema §13.6). */
const INVITATION_SCHEMA_VERSION = 1;

/** The invitation lifetime (schema §13.6 "Default 14 days"). */
const INVITATION_TTL_DAYS = 14;

/** The upgrade offer the plan-limit refusal carries (§0.14). */
const UPGRADE_PATH = "/api/v1/tenants/current/billing/upgrade";

/** MongoDB's duplicate-key server error code. */
const DUPLICATE_KEY = 11000;

/** A 24-hex `ObjectId`, the only shape a tenant segment may take. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/** True when an error is MongoDB's duplicate-key (E11000) refusal. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

/** The invitee as the client sends it — the normalizer names its own refusals. */
const inviteeBodySchema = z.object({
  kind: z.string(),
  userId: z.string().optional(),
  email: z.string().optional(),
  phoneE164: z.string().optional(),
});

/** The create body: one invitee plus the role to grant on acceptance. */
const createInvitationBodySchema = z.object({
  invitee: inviteeBodySchema,
  role: z.literal("co_organizer").default("co_organizer"),
});

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/invitations",
  body: createInvitationBodySchema,
  response: invitationBodySchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  idempotency: idempotencyStage({ store: mongoIdempotencyStore(), required: true }),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    const db = getDb();
    const config = getConfig();
    const now = systemClock.now();
    const tenantKey = scope.tenantId.toHexString();
    const actor = scope.userId;
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 2 });

    const event = await tenantRepo(tenantKey, db)
      .collection(COLLECTIONS.events)
      .findOne({ _id: eventId });
    if (event === null) {
      throw appError("not_found");
    }

    // Organizer-only: a related caller without the role is refused with `403`,
    // a caller with no relationship to the event with `404` (never an oracle).
    await requireEventRole(db, eventId, tenantKey, actor, ["organizer"]);

    const normalized = normalizeInvitee(ctx.body.invitee);
    if (!normalized.ok) {
      throw appError("validation_failed", {
        details: {
          fields: [
            {
              path: normalized.field,
              code: normalized.code,
              message: `The invitee is not usable as supplied (${normalized.code}).`,
            },
          ],
        },
      });
    }
    const invitee = normalized.invitee;
    const accountEmail = await inviteeEmail(db, invitee);

    // ── refusal precedence: self → member → plan limit (A11) ──
    const selfEmail = await callerEmail(db, actor);
    const invitedSelf =
      (invitee.kind === "user" && invitee.userId === actor) ||
      (invitee.kind === "email" && selfEmail !== null && invitee.email === selfEmail);
    if (invitedSelf) {
      throw appError("cannot_invite_self");
    }

    const inviteeUserId = await resolveInviteeUserId(db, invitee, accountEmail);
    if (inviteeUserId !== null) {
      const existingMember = await platformRepo(db)
        .collection(COLLECTIONS.eventOrganizers)
        .findOne({
          eventId,
          userId: inviteeUserId,
          revokedAt: null,
          role: { $in: ["organizer", "co_organizer"] },
        });
      if (existingMember !== null) {
        throw appError("already_member");
      }
    }

    const [memberRows, pendingRows] = await Promise.all([
      platformRepo(db).collection(COLLECTIONS.eventOrganizers).find({ eventId }).toArray(),
      tenantRepo(tenantKey, db)
        .collection(COLLECTIONS.invitations)
        .find({ eventId, status: "pending" })
        .toArray(),
    ]);
    const seats = coOrganizerSeats({
      members: memberRows.map((row) => toSeatMember(row)),
      invitations: pendingRows.map((row) => ({
        status: String(row.status),
        expiresAt: instantOf(row.expiresAt),
      })),
      now,
    });

    const verdict = await checkEntitlement(
      tenantKey,
      "coorganizers.per_event",
      1,
      {
        counts: seats,
        actorRef: { kind: "user", id: actor },
        subjectRef: { kind: "event", id: eventId.toHexString() },
      },
      { db }
    );
    if (!verdict.allowed) {
      throw appError("plan_limit_exceeded", {
        details: {
          entitlementKey: verdict.entitlementKey,
          limit: verdict.limit,
          used: verdict.used,
          periodKey: verdict.periodKey,
          scope: verdict.scope,
          reason: "plan_limit",
          upgradePath: UPGRADE_PATH,
        },
      });
    }

    const invitations = tenantRepo(tenantKey, db).collection(COLLECTIONS.invitations);
    const duplicate = (await invitations.findOne({
      eventId,
      status: "pending",
      ...inviteeFilter(invitee),
    })) as { readonly _id?: unknown } | null;
    if (duplicate !== null) {
      throw appError("invitation_already_pending", {
        details: { invitationId: String(duplicate._id) },
      });
    }

    const token = generateInvitationToken();
    const tokenHash = hashInvitationToken(token);
    const invitationId = new ObjectId();
    const invitationIdHex = invitationId.toHexString();
    const eventIdHex = eventId.toHexString();
    const expiresAt = addDays(now, INVITATION_TTL_DAYS);
    const delivery = deliveryFor(invitee, accountEmail);

    try {
      await withTransaction(async (session) => {
        await invitations.insertOne(
          {
            _id: invitationId,
            kind: "event_co_organizer",
            tenantId: tenantKey,
            eventId,
            invitedByUserId: new ObjectId(actor),
            invitee,
            status: "pending",
            role: "co_organizer",
            tokenHash,
            channelsNotified: [...delivery.channels],
            expiresAt,
            expireAt: expiresAt,
            resolvedAt: null,
            resolvedVia: null,
            resolvedByUserId: null,
            revokedAt: null,
            revokedByUserId: null,
            revokeReason: null,
            createdAt: now,
            updatedAt: now,
            schemaVersion: INVITATION_SCHEMA_VERSION,
          },
          { session }
        );

        await emitDomainEvent(
          {
            eventKey: "collab.invite.sent",
            tenantId: tenantKey,
            actorRef: { kind: "user", id: actor },
            subjectRef: { kind: "invitation", id: invitationIdHex },
            payload: {
              invitationId: invitationIdHex,
              eventId: eventIdHex,
              role: "co_organizer",
              kind: "event_co_organizer",
            },
          },
          { db, session }
        );
      });
    } catch (error) {
      // The partial unique index is the race-safe duplicate guard; the pre-check
      // above only makes the common case a clean `409` without a failed write.
      if (isDuplicateKeyError(error)) {
        throw appError("invitation_already_pending");
      }
      throw error;
    }

    // The link is the only place the raw token exists.
    await deliverInvite({
      db,
      invitationId: invitationIdHex,
      email: delivery.email,
      sms: delivery.sms,
      inviteUrl: `${config.app.baseUrl}/invitations/${token}`,
      userId: inviteeUserId,
    });

    getLogger().info("invitation created", {
      event: "collab.invite.created",
      tenantId: tenantKey,
      eventId: eventIdHex,
      invitationId: invitationIdHex,
      channels: delivery.channels,
    });

    return created(
      toInvitationBody(
        {
          _id: invitationId,
          kind: "event_co_organizer",
          eventId,
          role: "co_organizer",
          status: "pending",
          invitee,
          channelsNotified: [...delivery.channels],
          expiresAt,
          createdAt: now,
        },
        invitee,
        accountEmail
      ),
      `/api/v1/tenants/${tenantKey}/events/${eventIdHex}/invitations/${invitationIdHex}`
    );
  },
});

export const GET = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/invitations",
  response: invitationListSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  handler: async (ctx) => {
    const db = getDb();
    const principal = requirePrincipal(ctx);
    const tenantSegment = tenantIdFromRequest(ctx.request);
    if (!OBJECT_ID_HEX.test(tenantSegment)) {
      throw appError("not_found");
    }
    const tenantKey = new ObjectId(tenantSegment).toHexString();
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 2 });

    // Admission is **event membership**, not workspace membership: a
    // co-organizer commonly holds no `tenantMembers` row, so the reusable
    // `tenantStage()` would refuse the very people the listing exists for
    // (ADR-0641). The tenant-scoped event read is both the tenant check and the
    // existence check, and every denial is the uniform `404` (never an oracle).
    const event = await tenantRepo(tenantKey, db)
      .collection(COLLECTIONS.events)
      .findOne({ _id: eventId });
    if (event === null) {
      throw appError("not_found");
    }

    const role = await resolveEventActorRole(db, eventId, tenantKey, principal);
    if (role === null) {
      throw appError("not_found");
    }
    if (role !== "organizer" && role !== "co_organizer") {
      throw appError("forbidden");
    }

    const status = new URL(ctx.request.url).searchParams.get("status");
    if (status !== null && !invitationStatusSchema.safeParse(status).success) {
      throw appError("validation_failed", {
        details: {
          fields: [
            {
              path: "status",
              code: "invalid_value",
              message: `Must be one of ${invitationStatusSchema.options.join(", ")}.`,
            },
          ],
        },
      });
    }

    const rows = (await tenantRepo(tenantKey, db)
      .collection(COLLECTIONS.invitations)
      .find({ eventId, ...(status === null ? {} : { status }) })
      .sort({ createdAt: -1 })
      .toArray()) as unknown as InvitationRow[];

    const data = await Promise.all(rows.map((row) => projectInvitation(db, row)));
    return { body: { data }, headers: {} };
  },
});
