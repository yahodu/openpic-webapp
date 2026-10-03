import type { Db } from "mongodb";

import { getDb } from "../db/mongo";

import { collectionHandle, type RepositoryCollection } from "./collection";

/**
 * Tenant-scoped repository entry point (OP-77, schema §10.2).
 *
 * `tenantRepo(tenantId)` is the only sanctioned way to reach a tenant-scoped
 * collection: the scope is captured once, structurally, and every query it
 * produces is stamped with that `tenantId` (see {@link collectionHandle}).
 */

/** A repository bound to one tenant; every collection it hands out is scoped. */
export interface TenantRepository {
  /**
   * Open a tenant-scoped handle on a collection.
   *
   * @param name - The collection name.
   * @returns A handle whose every operation carries the repository's `tenantId`.
   */
  collection(name: string): RepositoryCollection;
}

/**
 * Build a repository scoped to one tenant.
 *
 * @param tenantId - The tenant every query is confined to.
 * @param db - The database handle; defaults to the shared client (OP-75).
 * @returns A {@link TenantRepository}.
 * @example
 * ```ts
 * const events = tenantRepo(tenantId).collection(COLLECTIONS.events);
 * await events.findOne({ _id: eventId }); // scoped to tenantId already
 * ```
 */
export function tenantRepo(tenantId: string, db: Db = getDb()): TenantRepository {
  return {
    collection: (name) => collectionHandle(db, name, { tenantId }),
  };
}
