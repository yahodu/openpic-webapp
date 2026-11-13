import { ObjectId, type Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { platformRepo, tenantRepo } from "@/server/repos";
import { systemClock, type Clock } from "@/server/runtime/clock";

import { decideClaim, type ClaimSkipReason } from "./claim-decision";
import { findAttendeeSession } from "./session-resolver";

/**
 * Claim an anonymous attendee session for a signed-in account (OP-134, contract
 * §6.7, schema §13.5/§15.3; ADR-0815).
 *
 * The whole value of the operation is that it **moves no data**: each profile
 * row keeps its `_id`, its `matchCount`, its `selfies` and its `faceMatches`,
 * and only `subject` changes, in one atomic write per profile. The matcher is
 * never re-armed, so a sign-in costs no face embedding.
 *
 * Two callers share this service — the explicit `POST
 * /me/attendee-sessions:claim` route and the session-created identity hook —
 * because they must behave identically and run in either order.
 *
 * The walk keys on `subject.attendeeSessionId`, not on
 * `attendeeSessions.eventIds`: a profile can exist for an event the session was
 * never explicitly bound to (the attendee reached that event's page holding the
 * cookie she already had).
 */

/** One event whose profile was re-pointed to the caller. */
export interface ClaimedEvent {
  readonly eventId: string;
  readonly eventName: string;
  readonly profileId: string;
  readonly matchCount: number;
  readonly galleryUrl: string;
}

/** One event the caller already owned. */
export interface SkippedEvent {
  readonly eventId: string;
  readonly reason: ClaimSkipReason;
}

/** What a claim did. */
export type ClaimOutcome =
  | {
      readonly outcome: "claimed";
      readonly claimed: readonly ClaimedEvent[];
      readonly skipped: readonly SkippedEvent[];
    }
  | { readonly outcome: "conflict" };

/** Inputs for {@link claimAttendeeSession}. */
export interface ClaimAttendeeSessionOptions {
  /** The database holding the session, the profiles and the outbox. */
  readonly db: Db;
  /** The signed-in caller's user id (hex). */
  readonly userId: string;
  /** The raw `opat_…` token the caller presented. */
  readonly token: string;
  /** The clock stamping `claimedAt`; defaults to the system clock. */
  readonly clock?: Clock;
}

/** The stored `attendee_event_profiles` fields the claim reads (§15.3). */
interface ProfileRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly eventId: ObjectId;
  readonly status?: string;
  readonly activeSelfieId?: ObjectId | null;
  readonly matchCount?: number;
}

/** The stored `events` fields the claim's answer and event need (§15.1). */
interface EventRow {
  readonly _id: ObjectId;
  readonly name?: string;
  readonly accessLinks?: readonly { readonly slug?: string; readonly active?: boolean }[];
}

/** The `attendee_event_profiles` collection, shared by every read and write here. */
const profilesOf = (db: Db) => platformRepo(db).collection(COLLECTIONS.attendeeEventProfiles);

/** Narrow a string to a usable ObjectId, or `null` when it is malformed. */
function toObjectId(value: string): ObjectId | null {
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
}

/** Read one selfie's `createdAt`, or `null` when the profile has no selfie. */
async function selfieCreatedAt(
  db: Db,
  selfieId: ObjectId | null | undefined
): Promise<Date | null> {
  if (selfieId === null || selfieId === undefined) {
    return null;
  }
  const row = (await platformRepo(db)
    .collection(COLLECTIONS.selfies)
    .findOne({ _id: selfieId }, { projection: { createdAt: 1 } })) as {
    readonly createdAt?: unknown;
  } | null;
  return row?.createdAt instanceof Date ? row.createdAt : null;
}

/** Read one event inside its own tenant, or `null` when it is gone. */
async function readEvent(db: Db, tenantKey: string, eventId: ObjectId): Promise<EventRow | null> {
  return (await tenantRepo(tenantKey, db)
    .collection(COLLECTIONS.events)
    .findOne({ _id: eventId }, { projection: { name: 1, accessLinks: 1 } })) as EventRow | null;
}

/** The gallery path of an event's active access link (contract §6.5). */
function galleryUrlOf(event: EventRow | null): string {
  const slug = event?.accessLinks?.find((link) => link.active === true)?.slug;
  return slug === undefined ? "" : `/e/${slug}/gallery`;
}

/**
 * Claim every anonymous profile of a session for one user.
 *
 * @param options - The database, the caller, the presented token and a clock.
 * @returns The claimed and skipped events, or `conflict` when another account
 *   already holds the session.
 * @throws {AppError} `attendee_session_expired` (401) for a lapsed session,
 *   `not_found` for a token that names no row.
 */
export async function claimAttendeeSession(
  options: ClaimAttendeeSessionOptions
): Promise<ClaimOutcome> {
  const { db } = options;
  const userId = toObjectId(options.userId);
  if (userId === null) {
    throw appError("authentication_required");
  }

  const session = await findAttendeeSession({ database: db }, options.token);
  if (session === null) {
    throw appError("not_found");
  }

  const userIdHex = userId.toHexString();
  const sessionIdHex = session._id.toHexString();
  const now = (options.clock ?? systemClock).now();

  // Ownership is decided by this one conditional write, not by the read above:
  // two accounts can pass a read and then both claim. The `$or` makes the
  // write itself the conflict check — the owner's repeat still matches, a
  // different account matches nothing.
  const owned = await platformRepo(db)
    .collection(COLLECTIONS.attendeeSessions)
    .findOneAndUpdate(
      { _id: session._id, $or: [{ claimedByUserId: null }, { claimedByUserId: userId }] },
      { $set: { claimedByUserId: userId, claimedAt: now } },
      { returnDocument: "after", projection: { _id: 1 } }
    );
  if (owned === null) {
    getLogger().warn("attendee claim conflict", {
      event: "attendee.claim_conflict",
      userId: userIdHex,
    });
    return { outcome: "conflict" };
  }

  const claimed: ClaimedEvent[] = [];
  const skipped: SkippedEvent[] = [];

  const anonymousProfiles = (await profilesOf(db)
    .find({ "subject.kind": "anonymous", "subject.attendeeSessionId": sessionIdHex })
    .toArray()) as unknown as ProfileRow[];

  for (const profile of anonymousProfiles) {
    const event = await readEvent(db, profile.tenantId, profile.eventId);
    const existing = (await profilesOf(db).findOne({
      eventId: profile.eventId,
      "subject.kind": "user",
      "subject.userId": userId,
    })) as ProfileRow | null;

    const decision = decideClaim({
      hasExistingUserProfile: existing !== null,
      anonymousSelfieCreatedAt: await selfieCreatedAt(db, profile.activeSelfieId),
      existingSelfieCreatedAt:
        existing === null ? null : await selfieCreatedAt(db, existing.activeSelfieId),
    });

    if (decision.action === "repoint") {
      // Schema §15.3's atomic re-point, verbatim: `_id`, selfies and matches
      // stay put; only `subject` moves.
      const repointed = await profilesOf(db).updateOne(
        {
          _id: profile._id,
          "subject.kind": "anonymous",
          "subject.attendeeSessionId": sessionIdHex,
        },
        {
          $set: { "subject.kind": "user", "subject.userId": userId, claimedAt: now },
          $unset: { "subject.attendeeSessionId": "" },
        }
      );
      // A row this caller did not move is not this call's event to report or
      // to announce; another writer got there first.
      if (repointed.matchedCount === 0) {
        continue;
      }

      claimed.push({
        eventId: profile.eventId.toHexString(),
        eventName: event?.name ?? "",
        profileId: profile._id.toHexString(),
        matchCount: profile.matchCount ?? 0,
        galleryUrl: galleryUrlOf(event),
      });

      await emitDomainEvent(
        {
          eventKey: "attendee.event.linked",
          tenantId: profile.tenantId,
          actorRef: { kind: "user", id: userIdHex },
          subjectRef: { kind: "user", id: userIdHex },
          payload: { eventId: profile.eventId.toHexString() },
        },
        { db }
      );
      continue;
    }

    // The merge arm: the unique partial index forbids a second user profile per
    // event, so the anonymous row is left untouched and only the selfie moves.
    if (decision.adoptAnonymousSelfie && existing !== null) {
      await profilesOf(db).updateOne(
        { _id: existing._id },
        { $set: { activeSelfieId: profile.activeSelfieId ?? null } }
      );
    }
    skipped.push({ eventId: profile.eventId.toHexString(), reason: decision.skipReason });
  }

  getLogger().info("attendee claimed", {
    event: "attendee.claimed",
    userId: userIdHex,
    claimed: claimed.length,
    skipped: skipped.length,
  });

  return { outcome: "claimed", claimed, skipped };
}
