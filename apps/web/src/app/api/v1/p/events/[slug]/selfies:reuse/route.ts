import { ObjectId } from "mongodb";
import { z } from "zod";

import { requireConsent, subjectFilter } from "@/server/attendee/consent-guard";
import { resolveEventBySlug, slugFromRequest } from "@/server/attendee/request-event";
import { selfieAttemptBudget } from "@/server/attendee/selfie-attempts";
import {
  enqueueSelfie,
  insertQueuedSelfie,
  selfieAttemptNumbers,
  selfieEnvelope,
  upsertProcessingProfile,
} from "@/server/attendee/selfie-submit";
import { subjectForRequest } from "@/server/attendee/subject";
import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { withTransaction } from "@/server/db/transaction";
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
 * re-processed by the worker rather than carried across as a vector.
 */

/** The §6.3 reuse body. */
const reuseBodySchema = z.object({
  selfieId: z.string().regex(/^[0-9a-f]{24}$/),
});

/** The §6.3 answer — the same seven keys as a submit. */
const reuseResponseSchema = z.object({
  selfieId: z.string(),
  profileId: z.string(),
  status: z.enum(["processing", "ready"]),
  pollUrl: z.string(),
  pollIntervalMs: z.number(),
  attemptsUsed: z.number(),
  attemptsRemaining: z.number(),
});

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
  handler: async (ctx) => {
    const db = getDb();
    const slug = slugFromRequest(ctx.request);
    const event = await resolveEventBySlug(db, slug);
    const subject = await subjectForRequest(db, ctx.request, ctx.principal);
    await requireConsent({
      db,
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      subject,
    });

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
    const reused = await withTransaction(async (session) => {
      const profileId = await upsertProcessingProfile({
        db,
        tenantKey: event.tenantKey,
        eventId: event.eventId,
        subject,
        now,
        session,
      });
      const selfieId = await insertQueuedSelfie({
        db,
        tenantKey: event.tenantKey,
        eventId: event.eventId,
        profileId,
        subject,
        contentHash,
        now,
        session,
      });
      return { selfieId, profileId };
    });

    await enqueueSelfie({
      db,
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      selfieId: reused.selfieId,
      traceId: ctx.requestId,
    });

    const attempts = await selfieAttemptNumbers({
      db,
      tenantKey: event.tenantKey,
      profileId: reused.profileId,
    });

    return {
      status: 202,
      body: selfieEnvelope({
        selfieId: reused.selfieId,
        profileId: reused.profileId,
        slug,
        status: "processing",
        budget: selfieAttemptBudget(attempts),
      }),
    };
  },
});
