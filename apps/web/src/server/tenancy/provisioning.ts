import { ObjectId, type Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { platformRepo } from "@/server/repos";
import { systemClock, type Clock } from "@/server/runtime/clock";

import { generateTenantSlug } from "./slug";

/**
 * Tenant provisioning (OP-100, contract §2.1, schema §10.2 + §13.3/§13.4).
 *
 * The user story is *"my workspace is created on my first organizer action … so
 * cost attributes to my tenant automatically"*. Contract §2.1 says a tenant is
 * created "the first time a user takes an organizer action" and forbids
 * `POST /api/v1/tenants` in v1, so the tenant-scoped write path calls
 * {@link ensureTenantForUser} before it applies the write (ADR-0260 D3).
 *
 * The guarantee is exactly two sentences:
 *
 *   - **idempotent** — a second call for the same user returns the existing
 *     workspace and creates nothing;
 *   - **race-safe** — two concurrent calls for one user collapse to one tenant,
 *     one `owner` membership and one `primaryTenantId` (I1).
 *
 * It is expressed as a single MongoDB transaction, so a loser's half-created
 * workspace is rolled back by the server rather than compensated for by
 * application code (ADR-0261).
 */

/**
 * The placeholder name a freshly provisioned workspace carries until the
 * organizer action that triggered it (or a later `PATCH`) names it.
 */
const DEFAULT_TENANT_NAME = "My workspace";

/** The default IANA zone a new workspace inherits (contract §1.1). */
const DEFAULT_TIME_ZONE = "Asia/Kolkata";

/** The single deployment region recorded on every workspace (schema §13.3). */
const DEFAULT_DATA_REGION = "in";

/**
 * How many slugs a single call may try before giving up.
 *
 * A collision needs two of 36^8 draws to coincide; the retry exists so the
 * caller does not have to reason about that, not because it is expected to run.
 */
const MAX_SLUG_ATTEMPTS = 5;

/** MongoDB's duplicate-key server error code. */
const DUPLICATE_KEY = 11000;

/** Options accepted by {@link ensureTenantForUser}. */
export interface EnsureTenantOptions {
  /** The database to provision in; defaults to the process database. */
  readonly db?: Db;
  /** The clock stamping the new documents; defaults to the system clock. */
  readonly clock?: Clock;
}

/** The workspace a call resolved to (created now or already present). */
export interface TenantProvisioningResult {
  /** The workspace id (hex `_id` of the `tenants` row). */
  readonly tenantId: ObjectId;
  /** The workspace's stable, non-sequential slug. */
  readonly slug: string;
}

/**
 * Internal signal that another concurrent call won the claim.
 *
 * Thrown inside the transaction so the server rolls back this attempt's inserts,
 * then handled by the retry loop: the retry re-reads the (now committed)
 * workspace and returns it. It never escapes {@link ensureTenantForUser}.
 */
class ProvisioningRaceError extends Error {
  constructor() {
    super("another provisioning attempt won the claim");
    this.name = "ProvisioningRaceError";
  }
}

/** True when an error is MongoDB's duplicate-key (E11000) refusal. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

/** The `userProfiles` fields provisioning reads (schema §13.2). */
interface ProfileDocument {
  readonly primaryTenantId?: unknown;
}

/** The `tenants` field the idempotent fast path reads back (schema §13.3). */
interface TenantSlugDocument {
  readonly slug?: unknown;
}

/** Read a stored id as an `ObjectId`, or `null` when it is absent/malformed. */
function toObjectIdOrNull(value: unknown): ObjectId | null {
  if (value instanceof ObjectId) {
    return value;
  }
  return null;
}

/**
 * Run one provisioning attempt inside a transaction.
 *
 * @throws {ProvisioningRaceError} when a concurrent attempt committed first.
 * @throws {Error} a driver E11000 when the drawn slug already exists.
 */
async function provisionOnce(
  db: Db,
  clock: Clock,
  userId: ObjectId
): Promise<TenantProvisioningResult> {
  const session = db.client.startSession();
  try {
    let result: TenantProvisioningResult | undefined;

    await session.withTransaction(async () => {
      const repo = platformRepo(db);
      const profiles = repo.collection(COLLECTIONS.userProfiles);
      const tenants = repo.collection(COLLECTIONS.tenants);
      const members = repo.collection(COLLECTIONS.tenantMembers);

      const profile = (await profiles.findOne({ userId }, { session })) as ProfileDocument | null;
      const existingId = toObjectIdOrNull(profile?.primaryTenantId);

      // Idempotent fast path: a workspace already resolves, so create nothing.
      if (existingId !== null) {
        const existing = (await tenants.findOne(
          { _id: existingId },
          { session }
        )) as TenantSlugDocument | null;
        if (existing !== null) {
          result = {
            tenantId: existingId,
            slug: typeof existing.slug === "string" ? existing.slug : "",
          };
          return;
        }
      }

      const now = clock.now();
      const slug = generateTenantSlug();
      const tenantId = new ObjectId();

      await tenants.insertOne(
        {
          _id: tenantId,
          slug,
          name: DEFAULT_TENANT_NAME,
          status: "active",
          ownerUserId: userId,
          billingContactUserId: userId,
          dataRegion: DEFAULT_DATA_REGION,
          counters: {
            eventCount: 0,
            activeEventCount: 0,
            imageCount: 0,
            storageBytes: 0,
            attendeeCount: 0,
            reconciledAt: null,
          },
          settings: {
            defaultTimeZone: DEFAULT_TIME_ZONE,
            brandLogoAssetId: null,
            defaultWatermarkAssetId: null,
          },
          createdAt: now,
          updatedAt: now,
          schemaVersion: 1,
        },
        { session }
      );

      await members.updateOne(
        { tenantId, userId },
        {
          $setOnInsert: {
            tenantId,
            userId,
            role: "owner",
            status: "active",
            joinedAt: now,
            removedAt: null,
          },
        },
        { upsert: true, session }
      );

      // The claim is the serialization point: it only matches while the profile
      // still carries the value this attempt read, so exactly one of two
      // concurrent attempts can win. The loser either write-conflicts (and the
      // driver retries the callback, which then takes the fast path) or matches
      // nothing here.
      const claim = await profiles.updateOne(
        { userId, primaryTenantId: existingId ?? null },
        {
          $set: { primaryTenantId: tenantId, updatedAt: now },
          $setOnInsert: { userId },
        },
        { upsert: true, session }
      );

      if (claim.matchedCount === 0 && claim.upsertedCount === 0) {
        throw new ProvisioningRaceError();
      }

      result = { tenantId, slug };
    });

    if (result === undefined) {
      throw new Error("tenant provisioning transaction produced no result");
    }
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Ensure the user owns a workspace, creating it on first use.
 *
 * Idempotent and race-safe: it returns the user's existing
 * `userProfiles.primaryTenantId` workspace when one resolves, otherwise it
 * creates `tenants` + a `tenantMembers` `owner` row and sets `primaryTenantId`
 * in one transaction. The new workspace's `billingContactUserId` is the owner.
 *
 * @param userId - The owning Better Auth user id.
 * @param options - The database and clock seams (both defaulted).
 * @returns The workspace id and slug the user's primary tenant resolves to.
 * @example
 * const { tenantId } = await ensureTenantForUser(new ObjectId(userId));
 */
export async function ensureTenantForUser(
  userId: ObjectId,
  options: EnsureTenantOptions = {}
): Promise<TenantProvisioningResult> {
  const db = options.db ?? getDb();
  const clock = options.clock ?? systemClock;

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    try {
      return await provisionOnce(db, clock, userId);
    } catch (error) {
      // A slug collision aborts the transaction; a lost race is retried so the
      // caller observes the winner instead of a failure.
      if (error instanceof ProvisioningRaceError || isDuplicateKeyError(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}
