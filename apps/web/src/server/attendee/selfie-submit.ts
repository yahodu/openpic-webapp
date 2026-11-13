import { ObjectId, type ClientSession, type Db } from "mongodb";

import { subjectFilter, type ConsentSubject } from "./consent-guard";
import type { SelfieAttemptBudget } from "./selfie-attempts";

import { COLLECTIONS } from "@/server/db/collections";
import type { Logger } from "@/server/logging";
import { enqueueWork } from "@/server/queue/enqueue-work";
import { getWorkQueue } from "@/server/queue/get-work-queue";
import { tenantRepo } from "@/server/repos";
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
  /** The caller's transaction, when the write must commit with its siblings. */
  readonly session?: ClientSession;
}

/**
 * Insert the `selfies` row the worker will embed (schema §16.4, §18.2).
 *
 * It starts `queued`/`high` with no embedding and is **not** active: §6.3's
 * two-step submission makes publication a property of the confirmation, not of
 * the row's arrival.
 *
 * @param options - The database, scope, owner, content hash and instant.
 * @returns The new selfie's id.
 */
export async function insertQueuedSelfie(options: QueuedSelfieOptions): Promise<ObjectId> {
  const _id = new ObjectId();
  await tenantRepo(options.tenantKey, options.db)
    .collection(COLLECTIONS.selfies)
    .insertOne(
      {
        _id,
        eventId: options.eventId,
        profileId: options.profileId,
        subject: options.subject,
        contentHash: options.contentHash,
        assetId: null,
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
      },
      sessionOption(options.session)
    );
  return _id;
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
