import type { Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { platformRepo, type RepositoryCollection } from "@/server/repos";

/**
 * The idempotency persistence port (API contract §0.9).
 *
 * The stage depends on this narrow interface rather than the driver, so the
 * concurrency-safe claim/find/complete/release cycle can be tested against any
 * store. {@link mongoIdempotencyStore} is the production adapter over the
 * `idempotency_keys` collection; its unique index (`{key, scope, principalId}`)
 * is what makes the claim atomic.
 */

/** A stored response, replayed verbatim (a `201` is rewritten to `200`). */
export interface IdempotencySnapshot {
  /** The status the original response was served with. */
  readonly status: number;
  /** The serialized response body. */
  readonly body: unknown;
  /** The response headers to replay (e.g. `location`). */
  readonly headers: Record<string, string>;
}

/** The lifecycle state of a keyed request. */
export type IdempotencyRecordStatus = "in_progress" | "completed";

/** The lookup that uniquely identifies a keyed request. */
export interface IdempotencyLookup {
  /** The `Idempotency-Key` header value. */
  readonly key: string;
  /** `METHOD + " " + route template`. */
  readonly scope: string;
  /** The acting principal the key is scoped to. */
  readonly principalId: string;
}

/** One persisted idempotency record. */
export interface IdempotencyRecord extends IdempotencyLookup {
  /** `sha256(canonicalJson(body) + "\n" + tenantId + "\n" + userId)`. */
  readonly requestHash: string;
  /** Whether the request is still running or has a stored response. */
  readonly status: IdempotencyRecordStatus;
  /** The stored response, present once `status` is `completed`. */
  readonly responseSnapshot?: IdempotencySnapshot;
  /** When the record was claimed. */
  readonly createdAt: Date;
  /** TTL field: when the record expires (24h after creation). */
  readonly expireAt: Date;
}

/** The operations the idempotency stage needs from a store. */
export interface IdempotencyStore {
  /** Find the record for a lookup, or `undefined` when absent. */
  find(lookup: IdempotencyLookup): Promise<IdempotencyRecord | undefined>;
  /**
   * Atomically claim a key by inserting an `in_progress` record.
   *
   * @returns `true` when this caller won the claim; `false` when another
   *   writer already holds the key (the unique index rejects the insert).
   */
  claim(record: IdempotencyRecord): Promise<boolean>;
  /** Store the response and mark the record `completed`. */
  complete(lookup: IdempotencyLookup, snapshot: IdempotencySnapshot): Promise<void>;
  /** Delete the record so the client may retry (after a 5xx or a throw). */
  release(lookup: IdempotencyLookup): Promise<void>;
}

/** MongoDB's duplicate-key server error code. */
const DUPLICATE_KEY = 11000;

/** True when `error` is MongoDB's duplicate-key error (code 11000). */
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === DUPLICATE_KEY
  );
}

/** Narrow a stored value to an {@link IdempotencyRecord}, or `undefined`. */
function toRecord(doc: unknown): IdempotencyRecord | undefined {
  if (typeof doc !== "object" || doc === null) {
    return undefined;
  }
  const source = doc as Record<string, unknown>;
  const snapshot = source.responseSnapshot;
  return {
    key: String(source.key),
    scope: String(source.scope),
    principalId: String(source.principalId),
    requestHash: String(source.requestHash),
    status: source.status === "completed" ? "completed" : "in_progress",
    ...(snapshot === undefined || snapshot === null
      ? {}
      : { responseSnapshot: snapshot as IdempotencySnapshot }),
    createdAt: toDate(source.createdAt),
    expireAt: toDate(source.expireAt),
  };
}

/** Coerce a stored value to a `Date` (the TTL monitor requires a real date). */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/**
 * Build the MongoDB-backed idempotency store.
 *
 * `idempotency_keys` is a platform-scope collection (keyed by principal, not
 * tenant), so it is opened through `platformRepo`; the atomic claim relies on
 * the unique index `{key, scope, principalId}` declared in `db/indexes.ts`.
 *
 * @param db - The database handle; omitted means the shared client, resolved
 *   lazily on first use so importing a route never reads config.
 * @returns An {@link IdempotencyStore}.
 */
export function mongoIdempotencyStore(db?: Db): IdempotencyStore {
  let handle: RepositoryCollection | undefined;
  const collection = (): RepositoryCollection => {
    handle ??= platformRepo(db ?? getDb()).collection(COLLECTIONS.idempotencyKeys);
    return handle;
  };

  return {
    async find(lookup) {
      return toRecord(await collection().findOne({ ...lookup }));
    },
    async claim(record) {
      try {
        await collection().insertOne({ ...record });
        return true;
      } catch (error: unknown) {
        if (isDuplicateKey(error)) {
          return false;
        }
        throw error;
      }
    },
    async complete(lookup, snapshot) {
      await collection().updateOne(
        { ...lookup },
        { $set: { status: "completed", responseSnapshot: snapshot } }
      );
    },
    async release(lookup) {
      await collection().deleteOne({ ...lookup });
    },
  };
}
