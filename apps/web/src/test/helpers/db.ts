import { randomUUID } from "node:crypto";

import type { Db } from "mongodb";

import { getMongoClient } from "@/server/db/mongo";

/**
 * Test database utility (OP-75, §6).
 *
 * Gives each Vitest worker a uniquely-named database on the shared client pool
 * so parallel integration tests never collide, and drops it afterwards.
 */

/** A throwaway database and the cleanup that drops it. */
export interface TestDb {
  readonly db: Db;
  cleanup(): Promise<void>;
}

/**
 * Create a uniquely-named throwaway database.
 *
 * @param prefix - Name prefix identifying the owning suite.
 * @returns The database handle and a `cleanup()` that drops it.
 */
export function createTestDb(prefix = "openpic_test"): TestDb {
  const worker = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "0";
  const name = `${prefix}_${worker}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const client = getMongoClient();
  const db = client.db(name);

  return {
    db,
    async cleanup(): Promise<void> {
      await db.dropDatabase();
    },
  };
}
