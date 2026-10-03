import type { Db } from "mongodb";

import { getDb } from "../db/mongo";

import { collectionHandle, type RepositoryCollection } from "./collection";

/**
 * Platform-scope repository entry point (OP-77, schema §10.2).
 *
 * Collections that are deliberately NOT tenant-scoped (`plans`, `faceModels`,
 * `platformSettings`, Better Auth's `user`/`session`, …) live outside the
 * tenant boundary and carry no `tenantId`. `platformRepo` is the sanctioned
 * door to them, kept distinct from {@link tenantRepo} so opting out of the
 * scope is an explicit, reviewable choice rather than an omission.
 */

/** A repository over platform-scope collections (no tenant injection). */
export interface PlatformRepository {
  /**
   * Open a handle on a platform-scope collection.
   *
   * @param name - The collection name.
   * @returns A handle that passes queries through without a tenant scope.
   */
  collection(name: string): RepositoryCollection;
}

/**
 * Build a repository over platform-scope collections.
 *
 * @param db - The database handle; defaults to the shared client (OP-75).
 * @returns A {@link PlatformRepository}.
 */
export function platformRepo(db: Db = getDb()): PlatformRepository {
  return {
    collection: (name) => collectionHandle(db, name),
  };
}
