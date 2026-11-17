import { ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { defineCronJob, type CronJob, type CronRunOutcome } from "@/server/jobs/cron-job";
import { platformRepo } from "@/server/repos";
import { MS_PER_DAY, addMilliseconds } from "@/server/runtime/time";

import type { SweepJobRunOptions } from "./run-options";

/**
 * `invitation-expiry` — the hourly invitation deadline sweep (OP-136, contract
 * §10.2 `invitation-expiry`, §2.3; ADR-0849 §5).
 *
 * A `pending` invitation past its `expiresAt` becomes `expired` and emits one
 * `collab.invite.expired`; the later accept route answers `410
 * invitation_expired` from the stored status. A still-pending invitation that
 * has lived three days earns one `collab.invite.reminder`, latched on the row.
 */

/** How long a pending invitation waits before it is reminded. */
const REMINDER_AFTER_MS = 3 * MS_PER_DAY;

/** The stored fields of an invitation row this job reads. */
interface InvitationRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly status: string;
}

/** Narrow a stored invitation row, or `null`. */
function asInvitationRow(value: unknown): InvitationRow | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Partial<InvitationRow>;
  if (!(row._id instanceof ObjectId) || typeof row.tenantId !== "string") {
    return null;
  }
  return { _id: row._id, tenantId: row.tenantId, status: row.status ?? "pending" };
}

/**
 * Expire the past-deadline invitations, then remind the ones that have waited.
 *
 * @param options - Database/clock/logger seam and the per-run limit.
 * @returns The §10.2 run outcome with `{ expired, reminded }`.
 */
export async function invitationExpiry(options: SweepJobRunOptions): Promise<CronRunOutcome> {
  const { db, clock, logger, limit } = options;
  const now = clock.now();
  const invitations = platformRepo(db).collection(COLLECTIONS.invitations);

  let expired = 0;
  let reminded = 0;

  const dueRaw: unknown = await invitations
    .find({ status: "pending", expiresAt: { $lt: now } })
    .limit(limit)
    .toArray();
  const due = Array.isArray(dueRaw)
    ? dueRaw.map(asInvitationRow).filter((row): row is InvitationRow => row !== null)
    : [];

  for (const row of due) {
    const invitationHex = row._id.toHexString();
    const claimed = await invitations.findOneAndUpdate(
      { _id: row._id, status: "pending" },
      { $set: { status: "expired", resolvedAt: now, updatedAt: now } }
    );
    if (claimed === null) {
      continue;
    }
    expired += 1;
    await emitDomainEvent(
      {
        eventKey: "collab.invite.expired",
        tenantId: row.tenantId,
        actorRef: { kind: "system", id: "invitation-expiry" },
        subjectRef: { kind: "invitation", id: invitationHex },
        payload: { invitationId: invitationHex, expiredAt: now.toISOString() },
        dedupeKey: `collab.invite.expired:${invitationHex}`,
      },
      { db, clock }
    );
  }

  const staleRaw: unknown = await invitations
    .find({
      status: "pending",
      expiresAt: { $gt: now },
      createdAt: { $lte: addMilliseconds(now, -REMINDER_AFTER_MS) },
      reminderSentAt: null,
    })
    .limit(limit)
    .toArray();
  const stale = Array.isArray(staleRaw)
    ? staleRaw.map(asInvitationRow).filter((row): row is InvitationRow => row !== null)
    : [];

  for (const row of stale) {
    const invitationHex = row._id.toHexString();
    // Emit before the latch: a failed insert must leave `reminderSentAt` unset,
    // or the reminder is lost. The outbox's dedupe key keeps a retry to one row.
    const result = await emitDomainEvent(
      {
        eventKey: "collab.invite.reminder",
        tenantId: row.tenantId,
        actorRef: { kind: "system", id: "invitation-expiry" },
        subjectRef: { kind: "invitation", id: invitationHex },
        payload: { invitationId: invitationHex },
        dedupeKey: `collab.invite.reminder:${invitationHex}`,
      },
      { db, clock }
    );
    // The latch is the conditional write: a retry finds `reminderSentAt` set and
    // matches nothing, so one invitation is reminded at most once.
    const claimed = await invitations.findOneAndUpdate(
      { _id: row._id, status: "pending", reminderSentAt: null },
      { $set: { reminderSentAt: now, updatedAt: now } }
    );
    if (claimed === null) {
      continue;
    }
    reminded += result.deduped ? 0 : 1;
  }

  const scanned = due.length + stale.length;
  logger.info("invitation expiry completed", { event: "invitation.expiry", expired, reminded });
  return {
    scanned,
    affected: expired + reminded,
    skipped: 0,
    errors: 0,
    hasMore: due.length >= limit || stale.length >= limit,
    details: { expired, reminded },
  };
}

/**
 * `invitation-expiry` — hourly (contract §10.2; ADR-0849 §1).
 *
 * Registered in `apps/web/vercel.json`; the run closes over the shared database
 * handle and forwards the framework's clamped limit and injected clock.
 */
export const invitationExpiryJob: CronJob = defineCronJob({
  name: "invitation-expiry",
  defaultLimit: 1000,
  maxLimit: 2000,
  run: ({ limit, clock, logger }) => invitationExpiry({ db: getDb(), clock, logger, limit }),
});
