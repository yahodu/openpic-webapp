import { ObjectId, type Db } from "mongodb";

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
import { waitForCommitted } from "@/server/db/retry-wait";
import { isTransactionRetryLimitError, withTransaction } from "@/server/db/transaction";
import { emitDomainEvent, matchesNewDedupeKey } from "@/server/domain/domain-events";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { tenantRepo, platformRepo, type RepositoryCollection } from "@/server/repos";
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
 * The confirmation is the **only publisher in this repo** (§7.6, ADR-0806): it
 * announces the rows this selfie produced, once per selfie. No shipped path
 * re-issues it after the worker finishes — the `200` body's `pollUrl` is a
 * read-only `GET …/me` — so a worker result that lands after the activation is
 * announced only by a second, client-initiated confirm. The settled owner of
 * that late result is the **pipeline**, not this route: the worker's
 * `POST /api/v1/internal/domain-events` with the same `dedupeKey` (OP-135 §1,
 * not shipped yet); the dedupe read inside the transaction below is what keeps
 * the two mutually exclusive (ADR-0808 §1/§3).
 */

/** The §6.3 answer the confirm returns with `status: "ready"` once published. */
const confirmResponseSchema = SELFIE_ENVELOPE_SCHEMA;

/**
 * The confirmation's transaction attempt budget (§6.3; ADR-0823).
 *
 * The §15.3 watermark and the outbox insert must commit as one unit, so a racer
 * that loses the contending write is retried whole: a burst of `N` confirms for
 * one selfie costs the unluckiest racer one attempt per rival commit (`N - 1`),
 * and one spare absorbs an abort that produces no commit at all (two rivals
 * aborting each other, which makes no progress). Five covers the pinned burst of
 * four; a racer that still spends all five answers only once the row shows the
 * outcome it owed ({@link confirmOutcomeCommitted}), and otherwise keeps its
 * `500` (ADR-0877).
 */
const CONFIRM_MAX_ATTEMPTS = 5;

/** The `attendeeEventProfiles` fields the confirm reads (§15.3). */
interface ProfileRow {
  readonly _id: ObjectId;
  /** The §15.3 "fires exactly once" watermark; `null` until the first delivery. */
  readonly firstMatchNotifiedAt?: Date | null;
}

/** The `attendeeEventProfiles` fields a settled confirm must show (§15.3/§6.4). */
interface SettledProfileRow {
  readonly activeSelfieId?: ObjectId | null;
  readonly status?: string;
  readonly matchCount?: number;
}

/** What this confirm owed the profile and the outbox (§6.3/§6.4, §10.3.2). */
interface ConfirmedOutcome {
  readonly db: Db;
  readonly profiles: RepositoryCollection;
  readonly profileId: ObjectId;
  readonly selfieId: ObjectId;
  readonly status: "processing" | "ready";
  readonly matchCount: number;
  readonly dedupeKey: string;
  readonly announceDue: boolean;
}

/**
 * Wait, bounded, for the winner of a confirm burst to commit this request's
 * outcome.
 *
 * A burst of `N` confirms writes the same profile document, so the unluckiest
 * racer can spend its whole attempt budget on rivals' commits and still lose the
 * last attempt to a rival that has not committed yet. Nothing of the loser's
 * attempt was written, so it answers only once the row carries **everything this
 * request owed** — the activation pointer, the §6.4 cached total, the status,
 * and, when it had something to announce, the §10.3.2 outbox row. A repeat
 * confirm whose selfie is already active must therefore still see its own
 * `matchCount`/status/announcement land, or it keeps its `500`; the pointer
 * alone would answer a success for a write that never happened.
 *
 * The wait is the shared settled re-read ADR-0877 records, the shape the
 * invitation accept uses.
 *
 * @param outcome - The request's facts and what its commit must leave behind.
 * @returns `true` once the row shows all of it, `false` when the wait ran out (a
 *   race nobody settled stays the original `500`).
 */
async function confirmOutcomeCommitted(outcome: ConfirmedOutcome): Promise<boolean> {
  const events = platformRepo(outcome.db).collection(COLLECTIONS.domainEvents);
  return waitForCommitted(
    async () => ({
      activation: (await outcome.profiles.findOne(
        { _id: outcome.profileId },
        { projection: { activeSelfieId: 1, status: 1, matchCount: 1 } }
      )) as SettledProfileRow | null,
      announced:
        !outcome.announceDue ||
        (await events.countDocuments({ dedupeKey: outcome.dedupeKey }, { limit: 1 })) > 0,
    }),
    ({ activation, announced }) =>
      announced &&
      activation?.activeSelfieId?.equals(outcome.selfieId) === true &&
      activation.status === outcome.status &&
      activation.matchCount === outcome.matchCount
  );
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
    // happened. The lookup runs **inside** the transaction with its session
    // (ADR-0817): a read taken before the transaction lets both racers of a
    // double-tap see `0`, and the loser's insert then collides on the outbox's
    // unique partial index and aborts its transaction.
    const dedupeKey = matchesNewDedupeKey(
      event.eventId.toHexString(),
      profile._id.toHexString(),
      selfieId.toHexString()
    );
    // §15.3's watermark is stamped by the first delivery and never moved.
    const firstDelivery =
      profile.firstMatchNotifiedAt === undefined || profile.firstMatchNotifiedAt === null;

    await withTransaction(
      async (session) => {
        const alreadyPublished =
          newMatches > 0 &&
          (await platformRepo(db)
            .collection(COLLECTIONS.domainEvents)
            .countDocuments({ dedupeKey }, { limit: 1, session })) > 0;
        const willPublish = newMatches > 0 && !alreadyPublished;
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
      },
      { maxAttempts: CONFIRM_MAX_ATTEMPTS }
    ).catch(async (error: unknown) => {
      // Losing the burst can spend the whole budget while a rival's commit is
      // still in flight. Nothing of the loser's attempt was written, so answer
      // only when the row shows this request's outcome — the activation, the
      // cached total, the status and its announcement (§6.3/§6.4); a race
      // nobody settled stays the original `500` (ADR-0877).
      if (
        !isTransactionRetryLimitError(error) ||
        !(await confirmOutcomeCommitted({
          db,
          profiles,
          profileId: profile._id,
          selfieId,
          status: published ? "ready" : "processing",
          matchCount: matched,
          dedupeKey,
          announceDue: newMatches > 0,
        }))
      ) {
        throw error;
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
