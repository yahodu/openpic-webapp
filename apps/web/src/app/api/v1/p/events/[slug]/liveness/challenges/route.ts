import { ObjectId } from "mongodb";
import { z } from "zod";

import { attendeeRateLimitStage } from "@/server/attendee/attendee-rate-limit";
import { requireConsent, subjectFilter } from "@/server/attendee/consent-guard";
import { createLivenessChallenge } from "@/server/attendee/liveness-challenge";
import { resolveEventBySlug, slugFromRequest } from "@/server/attendee/request-event";
import { subjectForRequest } from "@/server/attendee/subject";
import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";

/**
 * `POST /api/v1/p/events/{slug}/liveness/challenges` — issue one liveness
 * challenge (OP-132, contract §6.3, Appendix A row 3587; ADR-0792).
 *
 * The challenge is a gesture sequence the attendee performs on camera; the
 * submit route then verifies that the evidence it receives echoes the
 * challenge's `nonce`, so a client cannot replay a liveness result against
 * another challenge. Consent is a hard precondition (§6.2), so it is resolved
 * before anything is written.
 *
 * The challenge lives on the caller's `attendeeEventProfiles` row (schema §15.3
 * has no challenge collection and none is added): a small recently-issued list,
 * so a re-issue does not invalidate a challenge still on screen, capped so the
 * document cannot grow without bound. Only `usedAt` marks a challenge spent —
 * that is what makes it single-use.
 */

/** How many issued challenges a profile keeps; older ones can never be replayed. */
const KEPT_CHALLENGES = 5;

/** The §6.3 `201` body. */
const challengeResponseSchema = z.object({
  challengeId: z.string(),
  challengeKind: z.literal("gesture"),
  spec: z.object({
    sequence: z.array(z.string()),
    timeoutMs: z.number(),
  }),
  nonce: z.string(),
  expiresAt: z.string(),
});

export const POST = defineRoute({
  route: "/api/v1/p/events/:slug/liveness/challenges",
  response: challengeResponseSchema,
  auth: (ctx, request) =>
    requireAuth("attendee", { auth: getAuth(), database: getDb() })(ctx, request),
  rateLimitIdentity: attendeeRateLimitStage("liveness.challenge"),
  handler: async (ctx) => {
    const db = getDb();
    const slug = slugFromRequest(ctx.request, 3);
    const event = await resolveEventBySlug(db, slug);
    const subject = await subjectForRequest(db, ctx.request, ctx.principal);
    const { consentId } = await requireConsent({
      db,
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      subject,
    });

    const now = systemClock.now();
    const challengeId = new ObjectId();
    const created = createLivenessChallenge({ now });

    await tenantRepo(event.tenantKey, db)
      .collection(COLLECTIONS.attendeeEventProfiles)
      .updateOne(
        { eventId: event.eventId, ...subjectFilter(subject) },
        {
          $push: {
            livenessChallenges: {
              $each: [{ challengeId, usedAt: null, ...created }],
              $slice: -KEPT_CHALLENGES,
            },
          },
          $set: { updatedAt: now },
          $setOnInsert: {
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
          },
        },
        { upsert: true }
      );

    return {
      status: 201,
      body: {
        challengeId: challengeId.toHexString(),
        challengeKind: created.challengeKind,
        spec: {
          sequence: [...created.spec.sequence],
          timeoutMs: created.spec.timeoutMs,
        },
        nonce: created.nonce,
        expiresAt: created.expiresAt.toISOString(),
      },
    };
  },
});
