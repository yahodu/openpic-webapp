import { ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { withTransaction } from "@/server/db/transaction";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { defineCronJob, type CronJob, type CronRunOutcome } from "@/server/jobs/cron-job";
import { platformRepo } from "@/server/repos";

import type { SweepJobRunOptions } from "./run-options";

/**
 * `account-deletion-purge` — the daily account erase (OP-136, contract §10.2
 * `account-deletion-purge`, §1.4; ADR-0849 §5).
 *
 * The candidate predicate is exactly `status: "deletion_pending"` **and**
 * `deletionScheduledAt <= now`, which is what makes the cancellation window a
 * real window. The purge marks the profile `deleted`, stamps `purgeStartedAt`,
 * anonymizes the account, revokes the Better Auth sessions, retains the last
 * known contact in the platform-scope `accountDeletionTombstones` collection and
 * emits one `account.deletion.completed` whose payload carries the user id only:
 * the fan-out resolves the recipient from the tombstone.
 */

/** The Better Auth collections this purge reads and writes. */
const AUTH_USER_COLLECTION = "user";
const AUTH_SESSION_COLLECTION = "session";

/** The platform collection the deleted account's contact is retained in. */
const TOMBSTONE_COLLECTION = "accountDeletionTombstones";

/** The stored fields of a `userProfiles` row this job reads. */
interface DeletionProfileRow {
  readonly _id: ObjectId;
  readonly userId: ObjectId;
}

/** Narrow a stored profile row, or `null`. */
function asDeletionProfileRow(value: unknown): DeletionProfileRow | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as { readonly _id?: unknown; readonly userId?: unknown };
  if (!(row._id instanceof ObjectId) || !(row.userId instanceof ObjectId)) {
    return null;
  }
  return { _id: row._id, userId: row.userId };
}

/**
 * Purge every account whose cancellation window has closed.
 *
 * @param options - Database/clock/logger seam and the per-run limit.
 * @returns The §10.2 run outcome with `{ purged }`.
 */
export async function accountDeletionPurge(options: SweepJobRunOptions): Promise<CronRunOutcome> {
  const { db, clock, logger, limit } = options;
  const now = clock.now();
  const platform = platformRepo(db);
  const profiles = platform.collection(COLLECTIONS.userProfiles);

  const raw: unknown = await profiles
    .find({ status: "deletion_pending", deletionScheduledAt: { $lte: now } })
    .limit(limit)
    .toArray();
  const candidates = Array.isArray(raw)
    ? raw.map(asDeletionProfileRow).filter((row): row is DeletionProfileRow => row !== null)
    : [];

  let purged = 0;
  let errors = 0;

  for (const profile of candidates) {
    try {
      // One transaction: the claim, the erase, the tombstone and the receipt
      // commit together, so a failure at any step rolls the claim back and the
      // next run still finds the account `deletion_pending` and finishes it.
      const finished = await withTransaction(async (session) => {
        // The expected prior state is in the filter, so a second run is a no-op.
        const claimed = await profiles.findOneAndUpdate(
          { _id: profile._id, status: "deletion_pending", deletionScheduledAt: { $lte: now } },
          {
            $set: {
              status: "deleted",
              purgeStartedAt: now,
              displayName: null,
              avatarAssetId: null,
              updatedAt: now,
            },
          },
          { session }
        );
        if (claimed === null) {
          return false;
        }

        const userId = profile.userId.toHexString();
        const userRow = (await platform
          .collection(AUTH_USER_COLLECTION)
          .findOne({ _id: profile.userId }, { session })) as { readonly email?: unknown } | null;
        const email = typeof userRow?.email === "string" ? userRow.email : null;

        // Anonymize the account: the Better Auth row keeps no contact of its own.
        await platform
          .collection(AUTH_USER_COLLECTION)
          .updateOne({ _id: profile.userId }, { $unset: { email: "", name: "" } }, { session });

        await platform
          .collection(AUTH_SESSION_COLLECTION)
          .deleteMany({ userId: { $in: [userId, profile.userId] } }, { session });

        if (email !== null) {
          await platform.collection(TOMBSTONE_COLLECTION).updateOne(
            { userId },
            {
              $set: { email },
              $setOnInsert: { userId, deletedAt: now },
            },
            { upsert: true, session }
          );
        }

        await emitDomainEvent(
          {
            eventKey: "account.deletion.completed",
            tenantId: userId,
            actorRef: { kind: "system", id: "account-deletion-purge" },
            subjectRef: { kind: "user", id: userId },
            payload: { userId },
            dedupeKey: `account.deletion.completed:${userId}`,
          },
          { db, clock, session }
        );
        return true;
      });
      if (finished) {
        purged += 1;
      }
    } catch (error) {
      errors += 1;
      logger.error("account deletion purge failed", {
        event: "account.deletion.purge_failed",
        profileId: profile._id.toHexString(),
        err: error,
      });
    }
  }

  const scanned = candidates.length;
  logger.info("account deletion purge completed", {
    event: "account.deletion.purge",
    purged,
  });
  return {
    scanned,
    affected: purged,
    skipped: scanned - purged - errors,
    errors,
    hasMore: scanned >= limit,
    details: { purged },
  };
}

/**
 * `account-deletion-purge` — daily, 50 accounts by default (contract §10.2;
 * ADR-0849 §1).
 *
 * Registered in `apps/web/vercel.json`; the run closes over the shared database
 * handle and forwards the framework's clamped limit and injected clock.
 */
export const accountDeletionPurgeJob: CronJob = defineCronJob({
  name: "account-deletion-purge",
  defaultLimit: 50,
  maxLimit: 100,
  run: ({ limit, clock, logger }) => accountDeletionPurge({ db: getDb(), clock, logger, limit }),
});
