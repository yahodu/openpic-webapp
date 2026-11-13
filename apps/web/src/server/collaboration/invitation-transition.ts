import { ObjectId, type ClientSession, type Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { isTransactionRetryLimitError, withTransaction } from "@/server/db/transaction";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { platformRepo, type RepositoryCollection } from "@/server/repos";
import { decideTerminalOutcome } from "./invitation-decision";
import { hexId, type InvitationDecisionBody, type InvitationRow } from "./invitation-dto";

/**
 * The terminal transition of one invitation decision (OP-121, contract §2.3
 * rules 1–3, schema §13.6).
 *
 * A decision is **one** conditional write filtered on `status: "pending"` and
 * `expiresAt > now`. When it matches, the invitation is resolved, the in-app
 * affordance closes in every channel and `collab.invite.*` is emitted — all in
 * one transaction, so a failed decision is still pending and never half done.
 * When it matches nothing the row is already terminal and
 * {@link decideTerminalOutcome} answers from the row's current state — a
 * repeated or cross-channel decision is never a `409`.
 *
 * The accept transaction also carries the `event_organizers` insert (§23), so a
 * membership and its invitation can never disagree.
 */

/** Which decision the caller asked for. */
export type InvitationDecision = "accept" | "reject";

/** The channel a decision arrived on (contract §4.6). */
export type DecisionChannel = "in_app" | "email" | "sms";

/** The decision instant and the caller who made it. */
export interface DecisionContext {
  readonly db: Db;
  readonly decision: InvitationDecision;
  readonly via: DecisionChannel;
  readonly userId: string;
  readonly now: Date;
}

/** An invitation row as the decision paths read it. */
export interface DecisionInvitationRow extends InvitationRow {
  readonly tenantId?: unknown;
  readonly resolvedVia?: unknown;
  readonly resolvedAt?: unknown;
  readonly revokedAt?: unknown;
}

/** How many times a lost race is re-read before giving up. */
const RACE_ATTEMPTS = 3;

/**
 * How long a loser of the decision race waits for the winner's commit, in ms.
 *
 * shortcut: a fixed ceiling, not the winner's own duration; a decision
 * transaction taking longer than this answers `500` as before. Upgrade to a
 * shared per-invitation decision lock if a bounded wait proves too short.
 */
const RIVAL_COMMIT_TIMEOUT_MS = 1_000;

/** Poll interval while waiting for the winner's committed decision, in ms. */
const RIVAL_COMMIT_POLL_MS = 25;

/** Resolve after `ms`, for the bounded wait below. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Wait, bounded, for a concurrent decision on the same invitation to commit.
 *
 * Two accepts of one invitation collide on the same document inside their
 * transactions. The loser's bounded retry budget is spent **before** the winner
 * commits (measured: three attempts inside the winner's open transaction), so
 * the row still reads `pending` at that moment and a single re-read would
 * answer `500`. Poll until the winner's commit is visible instead (ADR-0667,
 * the shape ADR-0664 §Amendment gave the concurrent member removal).
 *
 * @param invitations - The `invitations` collection.
 * @param invitationId - The invitation both callers decided.
 * @returns `true` once the invitation is terminal, `false` when the wait ran
 *   out without it.
 */
async function rivalDecisionCommitted(
  invitations: RepositoryCollection,
  invitationId: ObjectId
): Promise<boolean> {
  for (let waited = 0; waited <= RIVAL_COMMIT_TIMEOUT_MS; waited += RIVAL_COMMIT_POLL_MS) {
    const row = (await invitations.findOne({
      _id: invitationId,
    })) as DecisionInvitationRow | null;
    if (row !== null && row.status !== "pending") {
      return true;
    }
    await sleep(RIVAL_COMMIT_POLL_MS);
  }
  return false;
}

/** The status one terminal transition writes. */
function terminalStatus(decision: InvitationDecision): "accepted" | "rejected" {
  return decision === "accept" ? "accepted" : "rejected";
}

/**
 * Close the in-app affordance for one invitation (§2.3 rule 3).
 *
 * @param db - The database handle.
 * @param invitationId - The invitation's hex id.
 * @param now - The instant of the decision.
 * @param via - The channel that decided it, when a decision caused the closure.
 * @param session - The caller's transaction; the write joins it when supplied.
 */
export async function closeInvitationAffordance(
  db: Db,
  invitationId: string,
  now: Date,
  via?: DecisionChannel,
  session?: ClientSession
): Promise<void> {
  await platformRepo(db)
    .collection(COLLECTIONS.notifications)
    .updateMany(
      { "actionTarget.kind": "invitation", "actionTarget.id": invitationId },
      {
        $set: {
          "actions.$[].state": "unavailable",
          "actionTarget.state": "resolved",
          ...(via === undefined ? {} : { actionResolvedVia: via, actionResolvedAt: now }),
          updatedAt: now,
        },
      },
      session === undefined ? {} : { session }
    );
}

/**
 * Attempt the one conditional transition for a decision.
 *
 * The status write, the affordance closure and the emit are one transaction on
 * both arms, so a failed decision leaves the invitation pending and every
 * in-app action usable — the decision is still to do, never half done.
 *
 * @param ctx - The decision, its channel and the caller.
 * @param invitationId - The invitation's `_id`.
 * @returns `true` when this call performed the transition, `false` when the row
 *   was already terminal (or its window had closed).
 */
async function transition(ctx: DecisionContext, invitationId: ObjectId): Promise<boolean> {
  const { db, decision, via, userId, now } = ctx;
  const status = terminalStatus(decision);
  const invitations = platformRepo(db).collection(COLLECTIONS.invitations);
  const filter = { _id: invitationId, status: "pending", expiresAt: { $gt: now } };
  const update = {
    $set: {
      status,
      resolvedVia: via,
      resolvedAt: now,
      resolvedByUserId: new ObjectId(userId),
      updatedAt: now,
    },
  };

  return withTransaction(async (session) => {
    const written = await invitations.findOneAndUpdate(filter, update, { session });
    if (written === null) {
      return false;
    }

    const row = written as DecisionInvitationRow;
    const invitationHex = invitationId.toHexString();
    const tenantHex = hexId(row.tenantId);

    await closeInvitationAffordance(db, invitationHex, now, via, session);

    if (decision === "reject") {
      await emitDomainEvent(
        {
          eventKey: "collab.invite.rejected",
          tenantId: tenantHex,
          actorRef: { kind: "user", id: userId },
          subjectRef: { kind: "invitation", id: invitationHex },
          dedupeKey: `collab.invite.rejected:${invitationHex}`,
          payload: { invitationId: invitationHex, eventId: hexId(row.eventId) },
        },
        { db, session }
      );

      return true;
    }

    // `event_organizers.userId` is the Better Auth id as a hex string (§15.2),
    // the same form the admission seam reads.
    await platformRepo(db)
      .collection(COLLECTIONS.eventOrganizers)
      .updateOne(
        { eventId: row.eventId, userId },
        {
          $set: {
            tenantId: tenantHex,
            eventId: row.eventId,
            userId,
            role: "co_organizer",
            status: "active",
            revokedAt: null,
            updatedAt: now,
          },
          $setOnInsert: { uploadedImageCount: 0, createdAt: now, schemaVersion: 1 },
        },
        { upsert: true, session }
      );

    await emitDomainEvent(
      {
        eventKey: "collab.invite.accepted",
        tenantId: tenantHex,
        actorRef: { kind: "user", id: userId },
        subjectRef: { kind: "invitation", id: invitationHex },
        dedupeKey: `collab.invite.accepted:${invitationHex}`,
        payload: {
          invitationId: invitationHex,
          eventId: hexId(row.eventId),
          role: "co_organizer",
        },
      },
      { db, session }
    );

    return true;
  });
}

/**
 * Build the §2.3 decision body from a resolved invitation row.
 *
 * @param row - The row in its terminal state.
 * @param decision - The decision the caller asked for.
 * @param alreadyResolved - `true` when another call made the decision first.
 * @returns The closed-key decision body.
 */
function decisionBody(
  row: DecisionInvitationRow,
  decision: InvitationDecision,
  alreadyResolved: boolean
): InvitationDecisionBody {
  const status = row.status === "accepted" ? "accepted" : "rejected";
  const eventId = hexId(row.eventId);
  const resolvedVia = typeof row.resolvedVia === "string" ? row.resolvedVia : "in_app";
  const resolvedAt = row.resolvedAt instanceof Date ? row.resolvedAt : new Date();

  return {
    id: hexId(row._id),
    status,
    resolvedAt: resolvedAt.toISOString(),
    resolvedVia,
    alreadyResolved,
    ...(decision === "accept" && status === "accepted"
      ? {
          membership: { eventId, role: "co_organizer" as const },
          redirectUrl: `/events/${eventId}/images`,
        }
      : {}),
  };
}

/**
 * Map a terminal outcome onto the answer its decision endpoint must give.
 *
 * @param row - The row in its current state.
 * @param decision - The decision the caller asked for.
 * @returns The `200` body, or `undefined` when the row is still live.
 * @throws `410 invitation_revoked` / `410 invitation_expired` for the two
 *   structurally unacceptable states.
 */
function answerTerminal(
  row: DecisionInvitationRow,
  decision: InvitationDecision,
  now: Date
): InvitationDecisionBody | undefined {
  const outcome = decideTerminalOutcome(row, now);
  switch (outcome.kind) {
    case "pending":
      return undefined;
    case "already_resolved":
      return decisionBody(row, decision, true);
    case "revoked":
      throw appError("invitation_revoked", {
        details: { revokedAt: outcome.revokedAt?.toISOString() ?? null },
      });
    case "expired":
      throw appError("invitation_expired", {
        details: { expiredAt: outcome.expiredAt?.toISOString() ?? null },
      });
  }
}

/**
 * Decide one invitation and answer the §2.3 body.
 *
 * @param ctx - The decision, its channel, the caller and the instant.
 * @param invitationId - The invitation's `_id`.
 * @returns The decision body (`alreadyResolved` names a replay).
 * @throws `410` for a revoked or expired invitation.
 * @throws The original failure when a lost race finds no settled invitation
 *   within the bounded wait ({@link rivalDecisionCommitted}).
 */
export async function decideInvitation(
  ctx: DecisionContext,
  invitationId: ObjectId
): Promise<InvitationDecisionBody> {
  const invitations = platformRepo(ctx.db).collection(COLLECTIONS.invitations);

  for (let attempt = 0; attempt < RACE_ATTEMPTS; attempt += 1) {
    let performed: boolean;
    try {
      performed = await transition(ctx, invitationId);
    } catch (error) {
      // Losing the race can spend the whole retry budget while the winner's
      // transaction is still open. Nothing of the loser's attempt was written,
      // so wait for the winner's commit and answer the same settled body it
      // answers (§0.7); a race nobody settled stays the original `500`.
      if (
        !isTransactionRetryLimitError(error) ||
        !(await rivalDecisionCommitted(invitations, invitationId))
      ) {
        throw error;
      }
      performed = false;
    }

    if (performed) {
      const row = (await invitations.findOne({
        _id: invitationId,
      })) as DecisionInvitationRow | null;
      if (row === null) {
        throw appError("not_found");
      }

      getLogger().info("invitation resolved", {
        event: "invitation.resolved",
        invitationId: invitationId.toHexString(),
        via: ctx.via,
        outcome: row.status,
        alreadyResolved: false,
      });

      return decisionBody(row, ctx.decision, false);
    }

    const row = (await invitations.findOne({ _id: invitationId })) as DecisionInvitationRow | null;
    if (row === null) {
      throw appError("not_found");
    }
    const answer = answerTerminal(row, ctx.decision, ctx.now);
    if (answer !== undefined) {
      getLogger().info("invitation resolved", {
        event: "invitation.resolved",
        invitationId: invitationId.toHexString(),
        via: ctx.via,
        outcome: row.status,
        alreadyResolved: true,
      });
      return answer;
    }
  }

  // A live pending row after every attempt means a concurrent writer kept
  // winning the race without committing a decision: retryable, never a `409`.
  throw appError("conflict");
}
