import { ObjectId } from "mongodb";
import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { isTransactionRetryLimitError, withTransaction } from "@/server/db/transaction";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { requireEventRole } from "@/server/events/access";
import { eventIdAfterEventsSegment } from "@/server/events/event-id";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { platformRepo, tenantRepo, type RepositoryCollection } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `DELETE /api/v1/tenants/{tenantId}/events/{eventId}/members/{userId}` — remove
 * an accepted co-organizer (OP-121, contract §2.3, schema §15.2).
 *
 * Only the **organizer** curates the team (a co-organizer is `403 forbidden`),
 * and the organizer themself is protected with `409 cannot_remove_organizer` —
 * the event must always keep exactly one organizer.
 *
 * The removal is **structural**, so access really ends: the `event_organizers`
 * row gets `status: "removed"` **and** `revokedAt` (the admission seam filters
 * on `revokedAt: null`, so one without the other would leave the removed member
 * admitted), and the invitation that granted the seat moves to `revoked` so the
 * row cannot be accepted again. Requiring `revokedAt: null` in the removal's
 * predicate is safe for a member who is removed and later re-invited: the
 * accept arm writes `status: "active"` and `revokedAt: null` back onto the
 * same row, so the next removal matches it again. Those two writes and the two
 * `collab.member.removed` / `.ack` emits run in one transaction, so a failed
 * removal moves neither row and stays replayable. The removed member and the
 * organizer are both notified, and the answer is `204` with no body — also for
 * the loser of a concurrent pair whose retry budget ran out before the winner
 * committed.
 */

/** A 24-hex `ObjectId`, the only accepted `{userId}` shape. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/** The `204` body placeholder: the pipeline serves no body for this status. */
const noContentSchema = z.null();

/**
 * The `{userId}` segment of the matched path; a malformed id denies `404`.
 *
 * @param request - The inbound request.
 * @returns The target member's user id.
 */
function targetUserIdFromRequest(request: Request): ObjectId {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const raw = String(segments.at(-1));
  if (!OBJECT_ID_HEX.test(raw)) {
    throw appError("not_found");
  }
  return new ObjectId(raw);
}

/**
 * How long a loser of the removal race waits for the winner's commit, in ms.
 *
 * shortcut: a fixed ceiling, not the winner's own duration; a removal
 * transaction taking longer than this answers `500` as before. Upgrade to a
 * shared per-member removal lock if a bounded wait proves too short.
 */
const RIVAL_COMMIT_TIMEOUT_MS = 1_000;

/** Poll interval while waiting for the winner's committed removal, in ms. */
const RIVAL_COMMIT_POLL_MS = 25;

/** Resolve after `ms`, for the bounded wait below. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Wait, bounded, for a concurrent removal of the same member to commit.
 *
 * Two `DELETE`s of one member collide on the same document inside their
 * transactions. The loser's bounded retry budget is spent **before** the
 * winner commits (measured: three attempts inside the winner's open
 * transaction), so the row still reads `revokedAt: null` at that moment and a
 * single re-read would answer `500`. Poll until the winner's commit is
 * visible instead (ADR-0664 §Amendment).
 *
 * @param members - The `event_organizers` collection.
 * @param memberId - The row the pre-transaction lookup resolved.
 * @returns `true` once the rival's removal is committed, `false` when the wait
 *   ran out without it.
 */
async function rivalRemovalCommitted(
  members: RepositoryCollection,
  memberId: unknown
): Promise<boolean> {
  for (let waited = 0; waited <= RIVAL_COMMIT_TIMEOUT_MS; waited += RIVAL_COMMIT_POLL_MS) {
    const row = (await members.findOne({ _id: memberId })) as {
      readonly revokedAt?: unknown;
    } | null;
    if (row?.revokedAt !== null && row?.revokedAt !== undefined) {
      return true;
    }
    await sleep(RIVAL_COMMIT_POLL_MS);
  }
  return false;
}

export const DELETE = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/members/:userId",
  response: noContentSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    const db = getDb();
    const now = systemClock.now();
    const tenantKey = scope.tenantId.toHexString();
    const eventId = eventIdAfterEventsSegment(ctx.request);
    const eventIdHex = eventId.toHexString();

    // Organizer-only: a related caller without the role is `403`, a caller with
    // no relationship to the event `404` (never an oracle).
    await requireEventRole(db, eventId, tenantKey, scope.userId, ["organizer"]);

    const targetUserId = targetUserIdFromRequest(ctx.request);
    const targetHex = targetUserId.toHexString();
    const members = platformRepo(db).collection(COLLECTIONS.eventOrganizers);
    // `event_organizers.userId` is the Better Auth id as a hex string (§15.2).
    // Identity only: an already-removed row must still resolve, so a repeat
    // answers `204` (an already-terminal transition is success, §0.7) instead
    // of the `404` reserved for a member that never existed here.
    const member = (await members.findOne({
      tenantId: tenantKey,
      eventId,
      userId: targetHex,
    })) as { readonly _id?: unknown; readonly role?: unknown } | null;
    if (member === null) {
      throw appError("not_found");
    }
    if (member.role === "organizer") {
      throw appError("cannot_remove_organizer", {
        details: { transferOwnershipUrl: `/events/${eventIdHex}/settings/transfer-ownership` },
      });
    }

    const removed = await withTransaction(async (session) => {
      // The predicate decides the winner: two `DELETE`s that both passed the
      // lookup above race here, and only the one that flips `revokedAt` from
      // null performs the removal (and therefore notifies). The loser answers
      // the same `204`, so a double click stays one effect, one notification.
      const removal = await members.updateOne(
        { _id: member._id, revokedAt: null },
        { $set: { status: "removed", revokedAt: now, updatedAt: now } },
        { session }
      );
      if (removal.matchedCount === 0) {
        return false;
      }

      // Revoke the invitation that granted the seat, so it cannot be re-accepted.
      await tenantRepo(tenantKey, db)
        .collection(COLLECTIONS.invitations)
        .updateMany(
          { eventId, status: "accepted", "invitee.userId": targetHex },
          { $set: { status: "revoked", revokedAt: now, updatedAt: now } },
          { session }
        );

      for (const eventKey of ["collab.member.removed", "collab.member.removed.ack"] as const) {
        await emitDomainEvent(
          {
            eventKey,
            tenantId: tenantKey,
            actorRef: { kind: "user", id: scope.userId },
            subjectRef: { kind: "user", id: targetHex },
            payload: { eventId: eventIdHex, userId: targetHex },
          },
          { db, session }
        );
      }

      return true;
    }).catch(async (error: unknown) => {
      // Losing the race can spend the whole retry budget while the winner's
      // transaction is still open. Nothing of the loser's attempt was written,
      // so wait for the winner's commit and report the same `204` it does
      // (§0.7); a removal that never lands stays a `500`.
      if (!isTransactionRetryLimitError(error)) {
        throw error;
      }
      if (!(await rivalRemovalCommitted(members, member._id))) {
        throw error;
      }
      return false;
    });

    // Only the winner removed anything, so only the winner reports a removal.
    if (removed) {
      getLogger().info("event member removed", {
        event: "collab.member.removed",
        tenantId: tenantKey,
        eventId: eventIdHex,
        userId: targetHex,
      });
    }

    return { status: 204, body: null };
  },
});
