import { ObjectId } from "mongodb";

import { subjectFilter } from "@/server/attendee/consent-guard";
import { pathSegmentFromRequest, requireAttendeeScope } from "@/server/attendee/request-event";
import { selfieAttemptBudget } from "@/server/attendee/selfie-attempts";
import {
  SELFIE_ENVELOPE_SCHEMA,
  selfieAttemptNumbers,
  selfieEnvelope,
} from "@/server/attendee/selfie-submit";
import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { withTransaction } from "@/server/db/transaction";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { tenantRepo, platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";

/**
 * `POST /api/v1/p/events/{slug}/selfies/{selfieId}/confirm` — activate one
 * submitted selfie (OP-132, contract §6.3/§6.4; schema §15.3/§16.4/§17.5;
 * ADR-0792 §2).
 *
 * The second half of the two-step submission. Until this call the worker's
 * result is provisional: the profile is not `ready`, `activeSelfieId` is unset,
 * `matchCount` stays `0` and nothing is notified. The confirmation is the
 * **only** place those four facts become true, which is what makes "before
 * confirmation nothing is visible, counted or notified" a property of the API
 * rather than of the worker's timing.
 *
 * One attempt stays one attempt: the row the submit created is activated, never
 * a second row (schema §15.3 has no counter), and the queue pointer already
 * exists — the confirm never enqueues a second job.
 *
 * The confirmation is also the **only publisher** (§7.6, ADR-0806): it announces
 * the rows this selfie produced, once. Because it is the publisher, it is also
 * the recovery path for a worker result that lands after the activation — the
 * client's poll re-issues the confirm (contract §6.4) and the delivery happens
 * then, never twice.
 */

/** The §6.3 answer the confirm returns with `status: "ready"` once published. */
const confirmResponseSchema = SELFIE_ENVELOPE_SCHEMA;

/** The `attendeeEventProfiles` fields the confirm reads (§15.3). */
interface ProfileRow {
  readonly _id: ObjectId;
  /** The §15.3 "fires exactly once" watermark; `null` until the first delivery. */
  readonly firstMatchNotifiedAt?: Date | null;
}

/** The `selfies` fields the confirm reads (§16.4). */
interface SelfieRow {
  readonly _id: ObjectId;
  readonly embedding?: unknown;
}

export const POST = defineRoute({
  route: "/api/v1/p/events/:slug/selfies/:selfieId/confirm",
  response: confirmResponseSchema,
  auth: (ctx, request) =>
    requireAuth("attendee", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const { db, slug, event, subject } = await requireAttendeeScope(ctx, { slugFromEnd: 4 });

    const selfieIdHex = pathSegmentFromRequest(ctx.request, 2);
    const selfieId = ObjectId.isValid(selfieIdHex) ? new ObjectId(selfieIdHex) : null;
    if (selfieId === null) {
      throw appError("not_found", { details: { resource: "selfie" } });
    }

    const tenant = tenantRepo(event.tenantKey, db);
    const profiles = tenant.collection(COLLECTIONS.attendeeEventProfiles);
    const selfies = tenant.collection(COLLECTIONS.selfies);

    const profile = (await profiles.findOne(
      { eventId: event.eventId, ...subjectFilter(subject) },
      { projection: { _id: 1, firstMatchNotifiedAt: 1 } }
    )) as ProfileRow | null;
    // Ownership is the same observable as absence: another subject's selfie id
    // never resolves (§6.3, reuse I5).
    const selfie =
      profile === null
        ? null
        : ((await selfies.findOne(
            { _id: selfieId, profileId: profile._id },
            { projection: { _id: 1, embedding: 1 } }
          )) as SelfieRow | null);
    if (profile === null || selfie === null) {
      throw appError("not_found", { details: { resource: "selfie" } });
    }

    const now = systemClock.now();
    // The worker writes the vector; its presence is what makes the result
    // publishable. Without it the confirmation still activates the row, and the
    // eventual worker result is what the attendee polls for.
    const published = selfie.embedding !== undefined && selfie.embedding !== null;
    const faceMatches = tenant.collection(COLLECTIONS.faceMatches);
    const matched = published ? await faceMatches.countDocuments({ profileId: profile._id }) : 0;
    // A delivery announces only the rows this selfie produced (§7.6 "additional
    // matches later"), never the profile's total, so a second selfie does not
    // re-announce the first's photos.
    const newMatches = published
      ? await faceMatches.countDocuments({ profileId: profile._id, selfieId })
      : 0;
    // One delivery per activation result: `dedupeKey` names this selfie's
    // announcement (§10.3.2) and an existing row is the record that it already
    // happened. The row is read first because a colliding insert would abort the
    // transaction below (E11000), not silently dedupe.
    const dedupeKey = `attendee.matches.new:${event.eventId.toHexString()}:${profile._id.toHexString()}:${selfieId.toHexString()}`;
    const willPublish =
      newMatches > 0 &&
      (await platformRepo(db)
        .collection(COLLECTIONS.domainEvents)
        .countDocuments({ dedupeKey }, { limit: 1 })) === 0;
    // §15.3's watermark is stamped by the first delivery and never moved.
    const firstDelivery =
      profile.firstMatchNotifiedAt === undefined || profile.firstMatchNotifiedAt === null;

    await withTransaction(async (session) => {
      await selfies.updateMany(
        { profileId: profile._id, _id: { $ne: selfieId } },
        { $set: { isActive: false } },
        { session }
      );
      await selfies.updateOne({ _id: selfieId }, { $set: { isActive: true } }, { session });
      await profiles.updateOne(
        { _id: profile._id },
        {
          $set: {
            activeSelfieId: selfieId,
            status: published ? "ready" : "processing",
            matchCount: matched,
            updatedAt: now,
            ...(willPublish && firstDelivery ? { firstMatchNotifiedAt: now } : {}),
          },
        },
        { session }
      );

      if (willPublish) {
        await emitDomainEvent(
          {
            eventKey: "attendee.matches.new",
            tenantId: event.tenantKey,
            actorRef: { kind: "attendee", id: profile._id.toHexString() },
            subjectRef: { kind: "event", id: event.eventId.toHexString() },
            payload: { eventId: event.eventId.toHexString(), count: newMatches },
            dedupeKey,
          },
          { db, session }
        );
      }
    });

    const attempts = await selfieAttemptNumbers({
      db,
      tenantKey: event.tenantKey,
      profileId: profile._id,
    });

    return {
      body: selfieEnvelope({
        selfieId,
        profileId: profile._id,
        slug,
        status: published ? "ready" : "processing",
        budget: selfieAttemptBudget(attempts),
      }),
    };
  },
});
