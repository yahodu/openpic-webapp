import { ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { defineCronJob, type CronJob, type CronRunOutcome } from "@/server/jobs/cron-job";
import { platformRepo } from "@/server/repos";
import { MS_PER_DAY, addMilliseconds } from "@/server/runtime/time";

import type { SweepJobRunOptions } from "./run-options";
import { verificationNudgePoint } from "./sweep-decisions";

/**
 * `verification-nudge` — the hourly incomplete-account ladder (OP-136, contract
 * §10.2 `verification-nudge`, §1.4; ADR-0849 §3).
 *
 * The candidates are Better Auth `user` rows that are not verified and are at
 * least a day old. The ladder is the pure {@link verificationNudgePoint}: T+24h
 * then T+72h, **max two ever**, and a completed account is never nudged again.
 * The count is `userProfiles.verificationNudges`, incremented in the same run
 * that emits the nudge, and each rung's delivery carries its own dedupe key.
 */

/** One day: the age a candidate must have reached before any nudge. */
const MIN_AGE_MS = MS_PER_DAY;

/** The Better Auth user collection (better-auth's own singular name). */
const AUTH_USER_COLLECTION = "user";

/** The stored fields of a Better Auth user row this job reads. */
interface AuthUserRow {
  readonly _id: ObjectId;
  readonly emailVerified?: boolean;
  readonly createdAt: Date;
}

/** Narrow a Better Auth user row, or `null`. */
function asAuthUserRow(value: unknown): AuthUserRow | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Partial<AuthUserRow>;
  if (!(row._id instanceof ObjectId) || !(row.createdAt instanceof Date)) {
    return null;
  }
  return {
    _id: row._id,
    createdAt: row.createdAt,
    ...(row.emailVerified === true ? { emailVerified: true } : {}),
  };
}

/** The stored fields of the `userProfiles` row a nudge is counted on. */
interface NudgeProfileRow {
  readonly _id: ObjectId;
  readonly verificationNudges?: number;
  readonly accountCompletedAt?: Date | null;
}

/** Narrow a stored profile row, or `null`. */
function asNudgeProfileRow(value: unknown): NudgeProfileRow | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Partial<NudgeProfileRow>;
  if (!(row._id instanceof ObjectId)) {
    return null;
  }
  return {
    _id: row._id,
    ...(typeof row.verificationNudges === "number"
      ? { verificationNudges: row.verificationNudges }
      : {}),
    ...(row.accountCompletedAt instanceof Date
      ? { accountCompletedAt: row.accountCompletedAt }
      : {}),
  };
}

/**
 * Deliver at most one rung of the ladder per candidate.
 *
 * @param options - Database/clock/logger seam and the per-run limit.
 * @returns The §10.2 run outcome with `{ nudged }`.
 */
export async function verificationNudge(options: SweepJobRunOptions): Promise<CronRunOutcome> {
  const { db, clock, logger, limit } = options;
  const now = clock.now();
  const platform = platformRepo(db);

  const raw: unknown = await platform
    .collection(AUTH_USER_COLLECTION)
    .find({ emailVerified: { $ne: true }, createdAt: { $lte: addMilliseconds(now, -MIN_AGE_MS) } })
    .limit(limit)
    .toArray();
  const candidates = Array.isArray(raw)
    ? raw.map(asAuthUserRow).filter((row): row is AuthUserRow => row !== null)
    : [];

  let nudged = 0;
  let skipped = 0;

  for (const user of candidates) {
    const profileRaw: unknown = await platform
      .collection(COLLECTIONS.userProfiles)
      .findOne({ userId: user._id });
    const profile = asNudgeProfileRow(profileRaw);
    if (profile === null) {
      skipped += 1;
      continue;
    }

    const point = verificationNudgePoint({
      createdAt: user.createdAt,
      completed: profile.accountCompletedAt !== undefined || user.emailVerified === true,
      nudgesSent: profile.verificationNudges ?? 0,
      now,
    });
    if (point === null) {
      skipped += 1;
      continue;
    }

    const userId = user._id.toHexString();
    const result = await emitDomainEvent(
      {
        eventKey: "account.verification.incomplete",
        tenantId: userId,
        actorRef: { kind: "system", id: "verification-nudge" },
        subjectRef: { kind: "user", id: userId },
        payload: { rung: point },
        dedupeKey: `account.verification.incomplete:${userId}:${point}`,
      },
      { db, clock }
    );
    if (result.deduped) {
      skipped += 1;
      continue;
    }
    await platform
      .collection(COLLECTIONS.userProfiles)
      .updateOne({ _id: profile._id }, { $inc: { verificationNudges: 1 } });
    nudged += 1;
  }

  const scanned = candidates.length;
  logger.info("verification nudge completed", { event: "verification.nudge", nudged });
  return {
    scanned,
    affected: nudged,
    skipped,
    errors: 0,
    hasMore: scanned >= limit,
    details: { nudged },
  };
}

/**
 * `verification-nudge` — hourly (contract §10.2; ADR-0849 §1).
 *
 * Registered in `apps/web/vercel.json`; the run closes over the shared database
 * handle and forwards the framework's clamped limit and injected clock.
 */
export const verificationNudgeJob: CronJob = defineCronJob({
  name: "verification-nudge",
  defaultLimit: 1000,
  maxLimit: 2000,
  run: ({ limit, clock, logger }) => verificationNudge({ db: getDb(), clock, logger, limit }),
});
