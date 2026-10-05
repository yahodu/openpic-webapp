import { randomUUID } from "node:crypto";

import type { Db } from "mongodb";

import { getMongoClient } from "@/server/db/mongo";

import { makeEnv, toProcessEnv, type EnvInput } from "../factories/env";

/**
 * Test database utility (OP-75, §6), plus the shared MongoDB readiness guard.
 *
 * Gives each Vitest worker a uniquely-named database on the shared client pool
 * so parallel integration tests never collide, and drops it afterwards.
 *
 * The readiness helpers below are the shared, cross-suite form of the guard
 * introduced for `notification-seed.test.ts` (ADR-0037): every integration
 * suite that touches the driver pays TCP connect, handshake, replica-set
 * discovery and primary election on its first operation, so that cost must be
 * paid in a hook — never inside a timed spec.
 */

/** A throwaway database and the cleanup that drops it. */
export interface TestDb {
  readonly db: Db;
  cleanup(): Promise<void>;
}

/** How long {@link waitForMongoReady} keeps retrying before it gives up, in ms. */
export const MONGO_READY_TIMEOUT_MS = 30_000;

/**
 * Hook budget for a `beforeAll` that awaits {@link setupMongoTestEnv}.
 *
 * Comfortably exceeds {@link MONGO_READY_TIMEOUT_MS} so the readiness wait can
 * never itself race Vitest's hook timeout and fail for the wrong reason.
 */
export const MONGO_READY_HOOK_TIMEOUT_MS = MONGO_READY_TIMEOUT_MS + 5_000;

/** Delay between readiness probes; short enough to react promptly to a late primary. */
const MONGO_READY_RETRY_MS = 250;

/**
 * Read the connection string the integration `globalSetup` published.
 *
 * @returns `MONGO_TEST_URI`, the replica-set URI for this run.
 * @throws If the URI is absent — i.e. the suite ran without the globalSetup.
 */
export function requireMongoTestUri(): string {
  const uri = process.env.MONGO_TEST_URI;
  if (!uri) {
    throw new Error(
      "MONGO_TEST_URI is not set — the integration globalSetup must start a MongoMemoryReplSet"
    );
  }
  return uri;
}

/**
 * Point this worker's validated config at the shared replica set.
 *
 * `MONGODB_URI` defaults to the published `MONGO_TEST_URI`; every other key
 * comes from the standard test environment and can be overridden per suite.
 *
 * @param overrides - Environment keys a suite needs beyond the defaults.
 * @returns The connection string that was applied.
 */
export function applyMongoTestEnv(overrides: EnvInput = {}): string {
  const uri = requireMongoTestUri();
  Object.assign(
    process.env,
    toProcessEnv(makeEnv({ APP_ENV: "test", MONGODB_URI: uri, ...overrides }))
  );
  return uri;
}

/**
 * Deterministically wait until the shared MongoDB client can reach a writable
 * replica-set primary.
 *
 * `MongoMemoryReplSet.create()` resolves once the set is *initiated*, not once
 * a primary has been elected, and the shared client connects lazily on first
 * use. Waiting here — inside a hook's own budget — removes that cold-start cost
 * from every timed spec, so a run is never lost to a cold connection.
 *
 * The wait is a genuine readiness check, not a fixed sleep: it probes the real
 * driver until it answers, and fails loudly if the server never becomes ready.
 *
 * @param options - Optional `timeoutMs` override (defaults to
 *   {@link MONGO_READY_TIMEOUT_MS}).
 * @throws If no primary answers a ping before the budget is exhausted.
 */
export async function waitForMongoReady(options: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? MONGO_READY_TIMEOUT_MS;
  const client = getMongoClient();
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  for (;;) {
    try {
      await client.db("admin").command({ ping: 1 });
      return;
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= deadline) {
      throw new Error(`MongoDB replica set did not become ready within ${String(timeoutMs)}ms`, {
        cause: lastError,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, MONGO_READY_RETRY_MS));
  }
}

/**
 * Shared `beforeAll` body for every integration suite that uses the database:
 * configure this worker's environment from `MONGO_TEST_URI`, then wait for an
 * elected primary before any spec runs.
 *
 * @param overrides - Environment keys a suite needs beyond the test defaults.
 */
export async function setupMongoTestEnv(overrides: EnvInput = {}): Promise<void> {
  applyMongoTestEnv(overrides);
  await waitForMongoReady();
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
