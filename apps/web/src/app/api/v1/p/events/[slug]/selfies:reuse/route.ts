import { ObjectId } from "mongodb";
import { z } from "zod";

import { requireAttendeeScope } from "@/server/attendee/request-event";
import { subjectFilter } from "@/server/attendee/consent-guard";
import { attendeeRateLimitStage } from "@/server/attendee/attendee-rate-limit";
import { selfieAttemptBudget } from "@/server/attendee/selfie-attempts";
import {
  SELFIE_ENVELOPE_SCHEMA,
  chargeSelfieAttempt,
  enqueueSelfie,
  selfieEnvelope,
} from "@/server/attendee/selfie-submit";
import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";

/**
 * `POST /api/v1/p/events/{slug}/selfies:reuse` — reuse a previous selfie on
 * another event (OP-132, contract §6.3/§6.2; ADR-0792).
 *
 * Reuse is the PRD's "the attendee already proved liveness" promise: no upload
 * and no challenge, just a new attempt on the addressed event. It is also the
 * most dangerous endpoint in the lane, because a selfie is biometric data of one
 * data subject on one event, so the precedence is strict:
 *
 *   1. consent **for the addressed event** (§6.2 is per event — a selfie made
 *      under event A's consent cannot be processed under event B's without it);
 *   2. ownership of the source selfie — a foreign id and a missing one are the
 *      same observable, `404` (§6.3 reuse I5), never `403`;
 *   3. the source selfie still exists (a withdrawal deleted it for good).
 *
 * The new row belongs to the calling subject on this event; the bytes are
 * re-processed by the worker rather than carried across as a vector. A reuse is
 * an **attempt** of `selfies.per_attendee`, the §14.1 hard cap: it is charged
 * through the same `chargeSelfieAttempt` critical section as a submit, so a spent
 * budget refuses with the same `403 plan_limit_exceeded` and mints nothing
 * (ADR-0804). Reuse is a selfie write, so it mounts the same post-auth
 * attendee-keyed `selfie.submit` class as `POST …/selfies`, the class every
 * selfie endpoint in this lane already declares.
 */

/** The §6.3 reuse body. */
const reuseBodySchema = z.object({
  selfieId: z.string().regex(/^[0-9a-f]{24}$/),
});

/** The §6.3 answer — the same seven keys as a submit. */
const reuseResponseSchema = SELFIE_ENVELOPE_SCHEMA;

/** The source `selfies` fields the reuse reads (§16.4). */
interface SourceSelfieRow {
  readonly _id: ObjectId;
  readonly contentHash?: string;
}

export const POST = defineRoute({
  route: "/api/v1/p/events/:slug/selfies:reuse",
  body: reuseBodySchema,
  response: reuseResponseSchema,
  auth: (ctx, request) =>
    requireAuth("attendee", { auth: getAuth(), database: getDb() })(ctx, request),
  rateLimitIdentity: attendeeRateLimitStage("selfie.submit"),
  handler: async (ctx) => {
    const { db, slug, event, subject } = await requireAttendeeScope(ctx);

    const source = (await tenantRepo(event.tenantKey, db)
      .collection(COLLECTIONS.selfies)
      .findOne(
        { _id: new ObjectId(ctx.body.selfieId), isActive: true, ...subjectFilter(subject) },
        { projection: { _id: 1, contentHash: 1 } }
      )) as SourceSelfieRow | null;
    if (source === null || typeof source.contentHash !== "string") {
      // A foreign or destroyed selfie must be indistinguishable from a missing
      // one: the id itself is data about another subject.
      throw appError("not_found", { details: { resource: "selfie" } });
    }

    const now = systemClock.now();
    const contentHash = source.contentHash;
    const reused = await chargeSelfieAttempt({
      db,
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      subject,
      contentHash,
      now,
      retentionExpiresAt: event.retentionExpiresAt,
    });

    await enqueueSelfie({
      db,
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      selfieId: reused.selfieId,
      traceId: ctx.requestId,
    });

    return {
      status: 202,
      body: selfieEnvelope({
        selfieId: reused.selfieId,
        profileId: reused.profileId,
        slug,
        status: "processing",
        budget: selfieAttemptBudget({
          used: reused.attempts.used + 1,
          allowed: reused.attempts.allowed,
        }),
      }),
    };
  },
});
