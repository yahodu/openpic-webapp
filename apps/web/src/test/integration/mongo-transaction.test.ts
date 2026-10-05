import { MongoError, type ClientSession } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeMongoClient, getDb } from "../../server/db/mongo";
import { withTransaction } from "../../server/db/transaction";
import { MONGO_READY_HOOK_TIMEOUT_MS, setupMongoTestEnv } from "../helpers/db";

/**
 * Integration contract — `src/server/db/transaction.ts`.
 *
 * `withTransaction` runs a callback inside a single MongoDB multi-document
 * transaction against the pooled client singleton, committing when the
 * callback resolves and aborting when it rejects:
 *
 *   withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T>
 *
 * These specs run against the `MongoMemoryReplSet` booted by the integration
 * `globalSetup` (a standalone `mongod` cannot do transactions), so this file is
 * the end-to-end guard that the wrapper really commits atomically and really
 * rolls back on failure.
 *
 * The env is pointed at `MONGO_TEST_URI` because the singleton client reads its
 * URI from the validated configuration (`MONGODB_URI`).
 */
const TEST_DB_COLLECTION = "accounts";

beforeAll(async () => {
  await setupMongoTestEnv();
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await closeMongoClient();
});

describe("withTransaction", () => {
  it("I1: commits two inserts together", async () => {
    const accounts = getDb().collection<{ _id: string; balance: number }>(
      `${TEST_DB_COLLECTION}_commit`
    );
    await accounts.deleteMany({});

    await withTransaction(async (session) => {
      await accounts.insertOne({ _id: "alice", balance: 100 }, { session });
      await accounts.insertOne({ _id: "bob", balance: 50 }, { session });
    });

    const saved = await accounts.find({}).sort({ _id: 1 }).toArray();

    expect(saved.map((doc) => doc._id)).toEqual(["alice", "bob"]);
  });

  it("I2: leaves zero documents when the callback throws", async () => {
    const accounts = getDb().collection<{ _id: string }>(`${TEST_DB_COLLECTION}_abort`);
    await accounts.deleteMany({});

    await expect(
      withTransaction(async (session) => {
        await accounts.insertOne({ _id: "ghost" }, { session });
        throw new Error("business rule failed");
      })
    ).rejects.toThrow("business rule failed");

    await expect(accounts.countDocuments()).resolves.toBe(0);
  });

  it("I3: re-runs the transaction when the first attempt is transient", async () => {
    const accounts = getDb().collection<{ _id: string }>(`${TEST_DB_COLLECTION}_retry`);
    await accounts.deleteMany({});

    const transient = new MongoError("transaction aborted by a transient failure");
    transient.addErrorLabel("TransientTransactionError");

    let attempts = 0;
    const body = vi.fn(async (session: ClientSession): Promise<string> => {
      attempts += 1;
      if (attempts === 1) {
        throw transient;
      }
      await accounts.insertOne({ _id: "retried" }, { session });
      return "committed";
    });

    const result = await withTransaction(body);

    expect(result).toBe("committed");
    expect(body).toHaveBeenCalledTimes(2);
    await expect(accounts.countDocuments({ _id: "retried" })).resolves.toBe(1);
  });
});
