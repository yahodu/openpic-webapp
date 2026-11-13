import { ObjectId } from "mongodb";
import { z } from "zod";

import { attendeeRateLimitStage } from "@/server/attendee/attendee-rate-limit";
import { requireAttendeeScope, requireRetentionOpen } from "@/server/attendee/request-event";
import { subjectFilter } from "@/server/attendee/consent-guard";
import {
  decideLivenessChallenge,
  type LivenessChallengeFailureReason,
} from "@/server/attendee/liveness-challenge";
import { selfieAttemptBudget } from "@/server/attendee/selfie-attempts";
import {
  SELFIE_ENVELOPE_SCHEMA,
  SELFIE_LOCATION_KEY,
  chargeSelfieAttempt,
  enqueueSelfie,
  selfieEnvelope,
  selfieObjectKey,
} from "@/server/attendee/selfie-submit";
import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError, isAppError } from "@/server/http/errors";
import { idempotencyStage, mongoIdempotencyStore } from "@/server/idempotency";
import { requestLogger } from "@/server/logging";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { getObjectStorage } from "@/server/storage/get-object-storage";

/**
 * `POST /api/v1/p/events/{slug}/selfies` — submit one selfie (OP-132, contract
 * §6.2/§6.3, §10.4, §14.1, Appendix A row 3587; schema §15.3/§16.4/§18.2;
 * ADR-0792).
 *
 * The selfie is the write that turns an anonymous visitor into a matching data
 * subject, so the order is fixed by the contract:
 *
 *   1. consent (§6.2's hard precondition — nothing else is looked at before it);
 *   2. the object exists, because the bytes went straight to storage;
 *   3. the liveness challenge is the caller's own, unspent and unexpired, and
 *      the evidence echoes its nonce (§6.3, Appendix A row 3587);
 *   4. the attempt budget (`selfies.per_attendee`, §14.1).
 *
 * The write is one transaction — the profile upsert, the queued `selfies` row
 * and the challenge's `usedAt` — so a refusal can never spend an attempt or a
 * challenge; the budget is resolved inside the same per-profile critical
 * section, so two concurrent submits cannot both take the last attempt
 * (`chargeSelfieAttempt`, ADR-0804). Only then is the `q:selfie` pointer
 * published (§10.4/§18.1).
 *
 * Publication is **not** part of this step: the selfie is `queued` and inactive
 * until `POST …/selfies/{selfieId}/confirm` activates it, which is what keeps a
 * provisional match invisible, uncounted and unnotified (green card §5).
 */

/** A 64-lowercase-hex SHA-256 — the content hash's only admitted shape (§5.1). */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** The §6.3 submit body: the object, the challenge and the evidence. */
const submitBodySchema = z.object({
  hash: z.string().regex(HASH_PATTERN),
  challengeId: z.string().min(1),
  livenessEvidence: z.object({
    nonce: z.string().min(1),
    frameHashes: z.array(z.string().min(1)).min(1),
  }),
});

/** A stored challenge element of the caller's profile (schema §15.3). */
interface StoredChallengeRow {
  readonly challengeId?: unknown;
  readonly nonce: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

/** The profile fields the submit reads. */
interface SubmitProfileRow {
  readonly _id: ObjectId;
  readonly livenessChallenges?: readonly StoredChallengeRow[];
}

/**
 * The `409 liveness_challenge_invalid` refusal (Appendix A row 3587).
 *
 * @param reason - Why the presented challenge is not usable.
 * @returns The error `appError` builds the transport for.
 */
function livenessChallengeInvalid(reason: LivenessChallengeFailureReason): Error {
  return appError("liveness_challenge_invalid", { details: { reason } });
}

export const POST = defineRoute({
  route: "/api/v1/p/events/:slug/selfies",
  body: submitBodySchema,
  response: SELFIE_ENVELOPE_SCHEMA,
  auth: (ctx, request) =>
    requireAuth("attendee", { auth: getAuth(), database: getDb() })(ctx, request),
  rateLimitIdentity: attendeeRateLimitStage("selfie.submit"),
  idempotency: idempotencyStage({ store: mongoIdempotencyStore(), required: true }),
  handler: async (ctx) => {
    const { db, slug, event, subject } = await requireAttendeeScope(ctx);

    // §6.3: the window is checked before the object, the challenge and the
    // budget, so an expired event writes, charges and mints nothing.
    const now = systemClock.now();
    requireRetentionOpen(event, now);

    const { hash, challengeId, livenessEvidence } = ctx.body;

    // §6.3: the object the client uploaded must be there before anything is
    // charged against the attendee's budget. The port's `not_found` is reshaped
    // here so the refusal names the resource, as the confirm route does for the
    // same selfie; any other throw is a real failure and stays one.
    try {
      await getObjectStorage().headObject(SELFIE_LOCATION_KEY, selfieObjectKey(hash));
    } catch (error) {
      if (!isAppError(error) || error.code !== "not_found") {
        throw error;
      }
      throw appError("not_found", { details: { resource: "selfie" } });
    }

    const profiles = tenantRepo(event.tenantKey, db).collection(COLLECTIONS.attendeeEventProfiles);
    const profile = (await profiles.findOne(
      { eventId: event.eventId, ...subjectFilter(subject) },
      { projection: { _id: 1, livenessChallenges: 1 } }
    )) as SubmitProfileRow | null;

    // A challenge the caller does not hold cannot be validated at all, which is
    // the same observable as evidence bound to another challenge.
    const challenge =
      profile === null
        ? undefined
        : profile.livenessChallenges?.find((row) => String(row.challengeId) === challengeId);
    if (challenge === undefined) {
      throw livenessChallengeInvalid("mismatch");
    }
    const decision = decideLivenessChallenge({
      challenge: {
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
        usedAt: challenge.usedAt,
      },
      now,
      evidenceNonce: livenessEvidence.nonce,
    });
    if (!decision.valid) {
      throw livenessChallengeInvalid(decision.reason);
    }

    const challengeObjectId = new ObjectId(challengeId);
    const submitted = await chargeSelfieAttempt({
      db,
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      subject,
      contentHash: hash,
      now,
      retentionExpiresAt: event.retentionExpiresAt,
      // Single-use: the conditional update is what makes a replay impossible,
      // even when two submits present the same challenge concurrently.
      commit: async (session, attempt) => {
        const spent = await profiles.updateOne(
          {
            _id: attempt.profileId,
            livenessChallenges: { $elemMatch: { challengeId: challengeObjectId, usedAt: null } },
          },
          { $set: { "livenessChallenges.$.usedAt": now } },
          { session }
        );
        if (spent.modifiedCount === 0) {
          throw livenessChallengeInvalid("already_used");
        }
      },
    });

    await enqueueSelfie({
      db,
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      selfieId: submitted.selfieId,
      traceId: ctx.requestId,
      logger: requestLogger(ctx.request, { route: ctx.route }),
    });

    requestLogger(ctx.request, { route: ctx.route }).info("selfie submitted", {
      event: "selfie.submitted",
      selfieId: submitted.selfieId.toHexString(),
      profileId: submitted.profileId.toHexString(),
    });

    return {
      status: 202,
      body: selfieEnvelope({
        selfieId: submitted.selfieId,
        profileId: submitted.profileId,
        slug,
        status: "processing",
        budget: selfieAttemptBudget({
          used: submitted.attempts.used + 1,
          allowed: submitted.attempts.allowed,
        }),
      }),
    };
  },
});
