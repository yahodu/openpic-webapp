import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import { MONGO_READY_RETRY_MS, MONGO_READY_TIMEOUT_MS, pollReady } from "../helpers/poll-ready";

/**
 * Integration globalSetup: boots a single-node MongoDB replica set so that
 * multi-document transactions work exactly as in production, and publishes the
 * connection string as `MONGO_TEST_URI` for test workers.
 *
 * `MongoMemoryReplSet.create()` resolves once the set is *initiated*, not once
 * a primary has been elected. A readiness probe then waits for a real ping to
 * answer, so every worker starts against an elected primary and no worker pays
 * replica-set discovery / primary election inside a timed spec. See ADR-0037.
 */
let replSet: MongoMemoryReplSet | undefined;

/** Per-attempt server-selection window; short so a failed probe retries promptly. */
const PROBE_SERVER_SELECTION_TIMEOUT_MS = 2_000;

/**
 * Probe the just-started replica set until a primary answers `ping`, then fail
 * loudly if it never does. A genuine readiness check, not a fixed sleep.
 *
 * @param uri - The replica-set connection string.
 * @throws If no primary answers before {@link MONGO_READY_TIMEOUT_MS}.
 */
async function waitForPrimary(uri: string): Promise<void> {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: PROBE_SERVER_SELECTION_TIMEOUT_MS,
  });

  try {
    await pollReady({
      ping: () => client.db("admin").command({ ping: 1 }),
      timeoutMs: MONGO_READY_TIMEOUT_MS,
      retryMs: MONGO_READY_RETRY_MS,
      timeoutMessage: (timeoutMs) =>
        `MongoDB replica set did not elect a primary within ${String(timeoutMs)}ms`,
    });
  } finally {
    await client.close();
  }
}

export async function setup(): Promise<void> {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri();
  process.env.MONGO_TEST_URI = uri;
  await waitForPrimary(uri);
}

export async function teardown(): Promise<void> {
  await replSet?.stop();
}
