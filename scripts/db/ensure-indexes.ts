/**
 * Declarative index bootstrap — one-off admin process (OP-76 §2, §3).
 *
 * Runs the idempotent {@link ensureIndexes} registry against the database named
 * by the environment, logs the diff (created vs. already existing) through the
 * Logger port, prints drop *suggestions* for indexes that exist in the database
 * but are no longer declared — it NEVER drops anything automatically — and
 * optionally creates the Atlas vector-search index when `ATLAS_SEARCH_ENABLED`
 * is true and the process is not running as a test.
 *
 * Twelve-factor: configuration comes only from the environment (read through
 * `src/server/config`), the process is one-off and stateless, and logs go to
 * stdout via the Logger port.
 *
 * Run from the repo root (the resolve hook lets bare Node follow the app's
 * bundler-style extensionless imports):
 *
 *   pnpm db:ensure-indexes
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getAppEnv, getAtlasSearchEnabled } from "../../apps/web/src/server/config/env.ts";
import { COLLECTIONS } from "../../apps/web/src/server/db/collections.ts";
import { ensureIndexes, INDEX_SPECS } from "../../apps/web/src/server/db/indexes.ts";
import { closeMongoClient, getDb } from "../../apps/web/src/server/db/mongo.ts";
import { getLogger } from "../../apps/web/src/server/logging/index.ts";

/** A database handle, inferred from the shared Mongo access module. */
type Database = ReturnType<typeof getDb>;

/** Path to the Atlas vector-search index definition (deployment-specific). */
const ATLAS_INDEX_PATH = fileURLToPath(new URL("./atlas-vector-index.json", import.meta.url));

/** Environments in which the Atlas vector index must not be created. */
const TEST_ENVS: ReadonlySet<string> = new Set(["test", "e2e"]);

/** MongoDB's "namespace does not exist" server error code. */
const NAMESPACE_NOT_FOUND = 26;

/** The Atlas Search index description shape `createSearchIndex` accepts. */
interface AtlasIndexDescription {
  readonly name: string;
  readonly type: string;
  readonly definition: Record<string, unknown>;
}

/** True when `error` is MongoDB's "namespace does not exist" (code 26). */
function isMissingNamespace(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === NAMESPACE_NOT_FOUND
  );
}

/** True when `value` is an index description carrying a string `name`. */
function hasStringName(value: unknown): value is { readonly name: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

/** Index names present on a collection, or an empty list if it does not exist. */
async function listIndexNames(db: Database, collection: string): Promise<string[]> {
  try {
    const raw: unknown = await db.collection(collection).listIndexes().toArray();
    if (!Array.isArray(raw)) {
      return [];
    }
    const names: string[] = [];
    for (const entry of raw as readonly unknown[]) {
      if (hasStringName(entry)) {
        names.push(entry.name);
      }
    }
    return names;
  } catch (error) {
    if (isMissingNamespace(error)) {
      return [];
    }
    throw error;
  }
}

/**
 * Print the names of database indexes that are not declared in
 * {@link INDEX_SPECS}. They are candidates for a deliberate operator drop; the
 * bootstrap never removes them itself.
 */
async function reportUndeclaredIndexes(db: Database): Promise<string[]> {
  const declared = new Set(INDEX_SPECS.map((spec) => spec.name));
  const undeclared: string[] = [];

  for (const collection of Object.values(COLLECTIONS)) {
    const names = await listIndexNames(db, collection);
    for (const name of names) {
      if (name !== "_id_" && !declared.has(name)) {
        undeclared.push(`${collection}.${name}`);
      }
    }
  }

  if (undeclared.length > 0) {
    getLogger().info("db.indexes.drop_suggested", {
      event: "db.indexes.drop_suggested",
      indexes: undeclared,
    });
  }

  return undeclared;
}

/**
 * Create the Atlas vector-search index when the deployment opts in.
 *
 * Skipped unless `ATLAS_SEARCH_ENABLED=true`, and never created in a test/e2e
 * environment (the index is a deployment capability, not a database invariant).
 */
async function ensureAtlasVectorIndex(db: Database): Promise<void> {
  const logger = getLogger();

  if (!getAtlasSearchEnabled()) {
    logger.info("db.atlas.search.skip", { event: "db.atlas.search.skip", reason: "disabled" });
    return;
  }

  if (TEST_ENVS.has(getAppEnv())) {
    logger.info("db.atlas.search.skip", { event: "db.atlas.search.skip", reason: "test-env" });
    return;
  }

  const description = JSON.parse(readFileSync(ATLAS_INDEX_PATH, "utf8")) as AtlasIndexDescription;
  const collection = db.collection(COLLECTIONS.faceMatches);
  const raw: unknown = await collection.listSearchIndexes().toArray();
  const exists =
    Array.isArray(raw) &&
    (raw as readonly unknown[]).some(
      (entry) => hasStringName(entry) && entry.name === description.name
    );
  if (exists) {
    logger.info("db.atlas.search.exists", {
      event: "db.atlas.search.exists",
      indexName: description.name,
    });
    return;
  }

  const created = await collection.createSearchIndex(description);
  logger.info("db.atlas.search.created", { event: "db.atlas.search.created", indexName: created });
}

/** Run the bootstrap, then release the shared Mongo client. */
async function main(): Promise<void> {
  const db = getDb();

  const report = await ensureIndexes(db);
  getLogger().info("db.indexes.bootstrap", {
    event: "db.indexes.bootstrap",
    created: report.created.length,
    existing: report.existing.length,
  });

  await reportUndeclaredIndexes(db);
  await ensureAtlasVectorIndex(db);
}

/**
 * Process entrypoint: run the bootstrap, report any failure, and ALWAYS release
 * the shared Mongo client so the one-off process exits instead of hanging on an
 * open socket.
 */
async function run(): Promise<void> {
  try {
    await main();
  } catch (error: unknown) {
    getLogger().error("db.indexes.bootstrap.failed", {
      event: "db.indexes.bootstrap.failed",
      err: error,
    });
    process.exitCode = 1;
  } finally {
    await closeMongoClient();
  }
}

void run();
