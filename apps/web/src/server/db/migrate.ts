/**
 * Lazy schema migration for stored documents (OP-75, §3; schema §26).
 *
 * Documents carry a `schemaVersion` and are evolved by a chain of single-step
 * migrations (`from -> to`, typically `n -> n + 1`). `migrateDoc` walks a
 * document from its current version to the latest one the chain knows about,
 * applying each step in ascending order.
 */

/** One single-step migration from a document version to the next. */
export interface SchemaMigration<T> {
  readonly from: number;
  readonly to: number;
  readonly migrate: (doc: T) => T;
}

/** A document that participates in schema versioning. */
interface Versioned {
  readonly schemaVersion: number;
}

/**
 * Upgrade `doc` to the latest version reachable through `migrations`.
 *
 * Every step whose `from` matches the document's current version is applied in
 * order; a document already at the latest version is returned unchanged. The
 * input document is never mutated — each step is expected to return a new
 * object.
 *
 * @param doc - The stored document.
 * @param migrations - The single-step migration chain.
 * @returns A document at the latest reachable version.
 */
export function migrateDoc<T extends Versioned>(
  doc: T,
  migrations: readonly SchemaMigration<T>[]
): T {
  const byFrom = new Map<number, SchemaMigration<T>>();
  for (const migration of migrations) {
    byFrom.set(migration.from, migration);
  }

  let current = doc;
  let next = byFrom.get(current.schemaVersion);

  while (next !== undefined) {
    current = next.migrate(current);
    next = byFrom.get(current.schemaVersion);
  }

  return current;
}
