import { ObjectId, type ClientSession, type Db } from "mongodb";
import { z } from "zod";

import { subjectFilter, type ConsentSubject } from "./consent-guard";
import { selfieAttemptBudget, type SelfieAttemptBudget } from "./selfie-attempts";

import { COLLECTIONS } from "@/server/db/collections";
import { withTransaction } from "@/server/db/transaction";
import { appError } from "@/server/http/errors";
import type { Logger } from "@/server/logging";
import { enqueueWork } from "@/server/queue/enqueue-work";
import { getWorkQueue } from "@/server/queue/get-work-queue";
import { tenantRepo } from "@/server/repos";
import { addDays } from "@/server/runtime/time";
import { checkEntitlement } from "@/server/services/entitlements";
import { getPlatformSettings } from "@/server/settings/platform-settings";
import type { StorageLocationKey } from "@/server/storage/locations";

/**
 * The selfie submission service (OP-132, contract §6.3/§6.4, §10.4, §14.1;
 * schema §15.3, §16.4, §18.1; ADR-0792).
 *
 * `POST …/selfies`, `POST …/selfies/{id}/confirm` and `…/selfies:reuse` all
 * create or publish one attempt, so the pieces they share live here: the
 * content-addressed object key a presigned PUT and its `headObject` check must
 * agree on, the attempt budget, the `attendeeEventProfiles` upsert, the queued
 * `selfies` row and the `§10.4` pointer that makes a worker pick it up.
 */

/** The §11.2 location selfie objects live in. */
export const SELFIE_LOCATION_KEY: StorageLocationKey = "originals";

/** The §6.3 poll cadence while a selfie is processing. */
export const SELFIE_POLL_INTERVAL_MS = 2000;

/** The §14.1 entitlement the attempt limit comes from. */
export const SELFIE_ATTEMPTS_KEY = "selfies.per_attendee";

/**
 * The schema's selfie retention window, in days (schema §22).
 *
 * No `retention.*` setting names a selfie window, so the 90 days is the
 * schema's own constant; the event's `retentionExpiresAt` can only shorten it.
 */
export const SELFIE_RETENTION_DAYS = 90;

/**
 * The `expireAt` a queued selfie carries (schema §16.4, §22).
 *
 * §22 keeps a selfie for `createdAt + 90 d` **or** the event's own retention,
 * whichever comes first: the probe image has no value after its event is gone.
 * Retention is a property of the row, not of confirmation, so a still-queued
 * selfie already carries its deadline.
 *
 * @param createdAt - The instant the selfie was queued.
 * @param eventRetentionExpiresAt - The event's `retentionExpiresAt`, or `null` when unlimited.
 * @returns The earlier of the two deadlines.
 */
export function selfieExpireAt(createdAt: Date, eventRetentionExpiresAt: Date | null): Date {
  const retention = addDays(createdAt, SELFIE_RETENTION_DAYS);
  return eventRetentionExpiresAt !== null && eventRetentionExpiresAt < retention
    ? eventRetentionExpiresAt
    : retention;
}

/**
 * The content-addressed object key for one selfie (schema §16.1).
 *
 * Keyed by the SHA-256 alone: the submit body names only the hash, so the
 * presign and the `headObject` verification must derive the same key without a
 * declared MIME. The content type travels in the object's metadata.
 *
 * @param contentHash - The lowercase 64-hex SHA-256 of the selfie bytes.
 * @returns `` `selfies/${contentHash}` ``.
 */
export function selfieObjectKey(contentHash: string): string {
  return `selfies/${contentHash}`;
}

/** The seven keys §6.3's submit and confirm answers carry. */
export interface SelfieEnvelope {
  readonly selfieId: string;
  readonly profileId: string;
  readonly status: "processing" | "ready";
  readonly pollUrl: string;
  readonly pollIntervalMs: number;
  readonly attemptsUsed: number;
  readonly attemptsRemaining: number;
}

/**
 * The wire schema of {@link SelfieEnvelope}.
 *
 * Submit, confirm and reuse answer with the same seven keys, so the shape the
 * response is serialized through is declared once: three copies could drift and
 * silently strip a key from one of the three answers.
 */
export const SELFIE_ENVELOPE_SCHEMA = z.object({
  selfieId: z.string(),
  profileId: z.string(),
  status: z.enum(["processing", "ready"]),
  pollUrl: z.string(),
  pollIntervalMs: z.number(),
  attemptsUsed: z.number(),
  attemptsRemaining: z.number(),
});

/**
 * Build the §6.3 answer.
 *
 * @param input - The row ids, the requested slug, the status and the budget.
 * @returns The seven-key envelope.
 */
export function selfieEnvelope(input: {
  readonly selfieId: ObjectId;
  readonly profileId: ObjectId;
  readonly slug: string;
  readonly status: "processing" | "ready";
  readonly budget: SelfieAttemptBudget;
}): SelfieEnvelope {
  return {
    selfieId: input.selfieId.toHexString(),
    profileId: input.profileId.toHexString(),
    status: input.status,
    pollUrl: `/api/v1/p/events/${input.slug}/me`,
    pollIntervalMs: SELFIE_POLL_INTERVAL_MS,
    attemptsUsed: input.budget.attemptsUsed,
    attemptsRemaining: input.budget.attemptsRemaining,
  };
}

/** The facts the attempt budget is resolved from. */
export interface SelfieAttemptOptions {
  readonly db: Db;
  /** The event's tenant (hex, as the event row stores it). */
  readonly tenantKey: string;
  /** The caller's profile on the event, or `null` before the first submit. */
  readonly profileId: ObjectId | null;
}

/**
 * Resolve the attempt budget for one profile.
 *
 * `used` is the profile's stored `selfies` count (schema §15.3 has no counter)
 * and `allowed` is the tenant's `selfies.per_attendee` limit, falling back to
 * `settings.selfie.attemptsAllowed` — the same value §6.1's `attemptsAllowed`
 * advertises, so the advertised and the enforced budget cannot disagree.
 *
 * @param options - The database, tenant and the caller's profile.
 * @returns The stored count and the resolved limit.
 */
export async function selfieAttemptNumbers(
  options: SelfieAttemptOptions
): Promise<{ readonly used: number; readonly allowed: number }> {
  const settings = await getPlatformSettings({ db: options.db });
  const used =
    options.profileId === null
      ? 0
      : await tenantRepo(options.tenantKey, options.db)
          .collection(COLLECTIONS.selfies)
          .countDocuments({ profileId: options.profileId });
  const verdict = await checkEntitlement(
    options.tenantKey,
    SELFIE_ATTEMPTS_KEY,
    1,
    { counts: used },
    {
      db: options.db,
    }
  );
  return { used, allowed: verdict.effectiveLimit ?? settings.selfie.attemptsAllowed };
}

/** The facts the profile upsert needs. */
export interface ProfileUpsertOptions {
  readonly db: Db;
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly subject: ConsentSubject;
  readonly now: Date;
  /** The caller's transaction, when the write must commit with its siblings. */
  readonly session?: ClientSession;
}

/**
 * Find or create the caller's `attendeeEventProfiles` row for one event.
 *
 * The subject is the profile's identity (§15.3), so the upsert is keyed on it.
 * A submit always leaves the profile `processing`: the worker owns the verdict
 * and the confirmation owns publication.
 *
 * @param options - The database, tenant, event, subject and instant.
 * @returns The profile's id.
 */
export async function upsertProcessingProfile(options: ProfileUpsertOptions): Promise<ObjectId> {
  const profiles = tenantRepo(options.tenantKey, options.db).collection(
    COLLECTIONS.attendeeEventProfiles
  );
  const profile = (await profiles.findOneAndUpdate(
    { eventId: options.eventId, ...subjectFilter(options.subject) },
    {
      $set: { status: "processing", updatedAt: options.now },
      $setOnInsert: {
        _id: new ObjectId(),
        eventId: options.eventId,
        subject: options.subject,
        activeSelfieId: null,
        matchCount: 0,
        lastMatchRunAt: null,
        lastSeenGalleryAt: null,
        firstMatchNotifiedAt: null,
        consentId: null,
        claimedAt: null,
        createdAt: options.now,
      },
    },
    { upsert: true, returnDocument: "after", ...sessionOption(options.session) }
  )) as { readonly _id: ObjectId } | null;
  if (profile === null) {
    // An upsert with `returnDocument: "after"` always answers the document.
    throw new Error("attendee profile upsert returned no document");
  }
  return profile._id;
}

/** The facts one queued selfie row needs. */
export interface QueuedSelfieOptions {
  readonly db: Db;
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly profileId: ObjectId;
  readonly subject: ConsentSubject;
  readonly contentHash: string;
  readonly now: Date;
  /** The event's own retention deadline, or `null` when the plan is unlimited. */
  readonly retentionExpiresAt: Date | null;
  /** The caller's transaction, when the write must commit with its siblings. */
  readonly session?: ClientSession;
}

/**
 * Insert the `selfies` row the worker will embed (schema §16.4, §18.2).
 *
 * It starts `queued`/`high` with no embedding and is **not** active: §6.3's
 * two-step submission makes publication a property of the confirmation, not of
 * the row's arrival. It carries its retention deadline and points at the
 * `mediaAssets` row for its content hash — the owner row the erasure path
 * follows to purge the bytes (§16.1, ADR-0796).
 *
 * @param options - The database, scope, owner, content hash and instant.
 * @returns The new selfie's id.
 */
export async function insertQueuedSelfie(options: QueuedSelfieOptions): Promise<ObjectId> {
  const _id = new ObjectId();
  const tenant = tenantRepo(options.tenantKey, options.db);
  // A withdrawal claims the asset row `purged` before it deletes the object
  // (ADR-0798). Taking a reference in that window would outlive the bytes, so
  // the claim is refused until the purge completes.
  const claimed = await tenant
    .collection(COLLECTIONS.mediaAssets)
    .findOne(
      { contentHash: options.contentHash, kind: "selfie", status: "purged", purgedAt: null },
      { projection: { _id: 1 }, ...sessionOption(options.session) }
    );
  if (claimed !== null) {
    throw appError("conflict", { details: { reason: "selfie_purged" } });
  }
  // One asset row per (tenant, kind, content hash): the unique index is the
  // arbiter and `$inc` makes a re-submitted hash a second reference, not a
  // second row. `kind` is in the filter for the same reason it is in the index:
  // an organizer's row for these bytes is a different asset (ADR-0801).
  const asset = (await tenant.collection(COLLECTIONS.mediaAssets).findOneAndUpdate(
    { contentHash: options.contentHash, kind: "selfie" },
    {
      $setOnInsert: {
        _id: new ObjectId(),
        tenantId: options.tenantKey,
        contentHash: options.contentHash,
        kind: "selfie",
        status: "stored",
        createdAt: options.now,
      },
      $inc: { refCount: 1 },
    },
    {
      upsert: true,
      returnDocument: "after",
      projection: { _id: 1 },
      ...sessionOption(options.session),
    }
  )) as { readonly _id: ObjectId } | null;
  if (asset === null) {
    // An upsert with `returnDocument: "after"` always answers the document.
    throw new Error("media asset upsert returned no document");
  }

  await tenant.collection(COLLECTIONS.selfies).insertOne(
    {
      _id,
      eventId: options.eventId,
      profileId: options.profileId,
      subject: options.subject,
      contentHash: options.contentHash,
      assetId: asset._id,
      liveness: { required: true, challengeKind: "gesture" },
      processing: {
        status: "queued",
        priority: "high",
        attempts: 0,
        maxAttempts: 5,
        leaseExpiresAt: null,
        workerId: null,
        queuedAt: options.now,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        lastError: null,
        queueRef: null,
      },
      isActive: false,
      createdAt: options.now,
      expireAt: selfieExpireAt(options.now, options.retentionExpiresAt),
    },
    sessionOption(options.session)
  );
  return _id;
}

/** The scope one attempt is charged to: one profile on one event (schema §15.3). */
export interface AttemptScope {
  readonly db: Db;
  /** The event's tenant (hex, as the event row stores it). */
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly subject: ConsentSubject;
}

/** The facts one attempt's charge needs. */
export interface ChargeAttemptOptions extends AttemptScope {
  readonly contentHash: string;
  readonly now: Date;
  /** The event's own retention deadline, or `null` when the plan is unlimited. */
  readonly retentionExpiresAt: Date | null;
  /** Work that must commit with the attempt (the challenge's single-use spend). */
  readonly commit?: (
    session: ClientSession,
    attempt: { readonly profileId: ObjectId; readonly selfieId: ObjectId }
  ) => Promise<void>;
}

/** The attempt one charge committed, and the budget it was read against. */
export interface ChargedAttempt {
  readonly selfieId: ObjectId;
  readonly profileId: ObjectId;
  /** The budget as it stood **before** this attempt was written. */
  readonly attempts: { readonly used: number; readonly allowed: number };
}

/**
 * In-process serialization of attempt charges, keyed by the profile's identity.
 *
 * The budget is a count of `selfies` rows (schema §15.3 has no counter), so a
 * read followed by an insert is a write skew: snapshot isolation does not
 * conflict on two inserts into different documents, and moving the read inside
 * the transaction does not close it. Serializing the read-and-write per profile
 * does, and it also keeps the racers out of `withTransaction`, whose three-attempt
 * budget their own concurrent `upsertProcessingProfile` writes would exhaust.
 *
 * shortcut: the queue is per process; several instances can still overshoot by
 * one each. Upgrade to an atomic conditional claim on the profile when the cap
 * must hold across instances.
 */
const attemptQueues = new Map<string, Promise<void>>();

/**
 * The lock key of one profile: the event plus the subject `subjectFilter` keys on.
 *
 * @param scope - The database, tenant, event and subject.
 * @returns A key two callers of the same profile share.
 */
function attemptLockKey(scope: AttemptScope): string {
  const subject =
    scope.subject.kind === "user"
      ? `user:${scope.subject.userId.toHexString()}`
      : `anonymous:${scope.subject.attendeeSessionId}`;
  return `${scope.tenantKey}\u0000${scope.eventId.toHexString()}\u0000${subject}`;
}

/**
 * Run `task` after every charge already queued for the same profile.
 *
 * @param scope - The profile the charge belongs to.
 * @param task - The read-and-write to run exclusively.
 * @returns The task's result, once every earlier queued charge has settled.
 */
function withAttemptLock<T>(scope: AttemptScope, task: () => Promise<T>): Promise<T> {
  const key = attemptLockKey(scope);
  const previous = attemptQueues.get(key) ?? Promise.resolve();
  const result = previous.then(task, task);
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  // Keep only the charges actually in flight: a long-lived process must not
  // accumulate one entry per profile it has ever served.
  void settled.finally(() => {
    if (attemptQueues.get(key) === settled) {
      attemptQueues.delete(key);
    }
  });
  attemptQueues.set(key, settled);
  return result;
}

/**
 * Charge one attempt: resolve the budget, refuse an exhausted one, and write
 * the profile, the queued selfie and any `commit` work in one transaction.
 *
 * The check and the write are one critical section per profile, so concurrent
 * callers cannot both observe the last free attempt (§14.1's hard cap is not
 * bypassable by a race). A refusal writes nothing, and no attempt is charged
 * when `commit` (e.g. the challenge's single-use spend) fails.
 *
 * @param options - The scope, the content hash, the instant, retention and the
 *   extra work to commit.
 * @returns The committed ids and the budget the attempt was charged against.
 * @throws {AppError} `plan_limit_exceeded` (403) when no attempt is left.
 */
export async function chargeSelfieAttempt(options: ChargeAttemptOptions): Promise<ChargedAttempt> {
  return withAttemptLock(options, async () => {
    const attempts = await selfieAttemptNumbers({
      db: options.db,
      tenantKey: options.tenantKey,
      profileId: await findProfileId(options),
    });
    if (selfieAttemptBudget(attempts).exhausted) {
      throw appError("plan_limit_exceeded", {
        details: { entitlementKey: SELFIE_ATTEMPTS_KEY },
      });
    }

    const written = await withTransaction(async (session) => {
      const profileId = await upsertProcessingProfile({
        db: options.db,
        tenantKey: options.tenantKey,
        eventId: options.eventId,
        subject: options.subject,
        now: options.now,
        session,
      });
      const selfieId = await insertQueuedSelfie({
        db: options.db,
        tenantKey: options.tenantKey,
        eventId: options.eventId,
        profileId,
        subject: options.subject,
        contentHash: options.contentHash,
        now: options.now,
        retentionExpiresAt: options.retentionExpiresAt,
        session,
      });
      await options.commit?.(session, { profileId, selfieId });
      return { selfieId, profileId };
    });

    return { ...written, attempts };
  });
}

/**
 * The caller's profile id on the event, or `null` before the first attempt.
 *
 * @param scope - The database, tenant, event and subject.
 * @returns The stored profile's id, or `null`.
 */
async function findProfileId(scope: AttemptScope): Promise<ObjectId | null> {
  const profile = (await tenantRepo(scope.tenantKey, scope.db)
    .collection(COLLECTIONS.attendeeEventProfiles)
    .findOne(
      { eventId: scope.eventId, ...subjectFilter(scope.subject) },
      { projection: { _id: 1 } }
    )) as { readonly _id: ObjectId } | null;
  return profile?._id ?? null;
}

/** The facts one `q:selfie` pointer needs. */
export interface EnqueueSelfieOptions {
  readonly db: Db;
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly selfieId: ObjectId;
  readonly traceId: string;
  readonly logger?: Logger;
}

/**
 * The driver options that carry a transaction, if any.
 *
 * @param session - The caller's session.
 * @returns `{ session }`, or an empty object outside a transaction.
 */
function sessionOption(session: ClientSession | undefined): { session?: ClientSession } {
  return session === undefined ? {} : { session };
}

/**
 * Publish the §10.4 pointer that makes a worker claim the selfie.
 *
 * A failed enqueue is never a failed request: the row stays `queued` and the
 * sweep re-enqueues it (§18.1), which is `enqueueWork`'s own contract.
 *
 * @param options - The database, scope, selfie id and trace id.
 */
export async function enqueueSelfie(options: EnqueueSelfieOptions): Promise<void> {
  const settings = await getPlatformSettings({ db: options.db });
  await enqueueWork({
    db: options.db,
    queue: getWorkQueue(),
    collection: COLLECTIONS.selfies,
    work: {
      kind: "selfie",
      id: options.selfieId.toHexString(),
      tenantId: options.tenantKey,
      eventId: options.eventId.toHexString(),
      spaceKey: settings.face.activeSpaceKey,
      traceId: options.traceId,
      priority: "high",
    },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}
