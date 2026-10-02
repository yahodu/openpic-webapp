import { MongoClient } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeEnv, toProcessEnv, type EnvInput } from "../../test/factories/env";

/**
 * Contract under test — `src/server/db/mongo.ts`.
 *
 * The Mongo access module owns the process-wide, serverless-safe client
 * singleton:
 *
 *   getMongoClient(): MongoClient   // the shared client, built lazily from config
 *   getDb(name?): Db                // the default (or named) database on that client
 *   closeMongoClient(): Promise<void> // close and forget the singleton (shutdown/tests)
 *
 * Serverless safety requires the client to be cached on a process/global slot,
 * NOT in module scope: a Next.js route module may be evaluated more than once
 * (lambda re-use, hot reload, multiple importers), and the pool must be shared
 * across all of those module instances rather than re-created per evaluation.
 *
 * Importing the module is side-effect free — no connection is opened until the
 * client is actually used.
 */
const ORIGINAL_ENV = process.env;

/** Replace `process.env` with a valid fixture and import a fresh module copy. */
async function loadMongoModule(env: EnvInput = makeEnv()): Promise<typeof import("./mongo")> {
  process.env = toProcessEnv(env);

  return import("./mongo");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("getMongoClient", () => {
  it("builds a MongoClient from the configured connection string", async () => {
    const mongo = await loadMongoModule(makeEnv({ MONGODB_URI: "mongodb://db:27017/openpic" }));

    const client = mongo.getMongoClient();

    expect(client).toBeInstanceOf(MongoClient);

    await mongo.closeMongoClient();
  });

  it("reuses the same client across separate module instances", async () => {
    process.env = toProcessEnv(makeEnv());

    const first = await import("./mongo");
    const clientFromFirstImport = first.getMongoClient();

    // Simulate a second evaluation of the module (serverless re-use / hot
    // reload): the cached client must survive it.
    vi.resetModules();
    const second = await import("./mongo");
    const clientFromSecondImport = second.getMongoClient();

    expect(clientFromSecondImport).toBe(clientFromFirstImport);

    await second.closeMongoClient();
  });

  it("returns the same client on repeated calls", async () => {
    const mongo = await loadMongoModule();

    expect(mongo.getMongoClient()).toBe(mongo.getMongoClient());

    await mongo.closeMongoClient();
  });
});

describe("getDb", () => {
  it("returns the database named in the connection string by default", async () => {
    const mongo = await loadMongoModule(makeEnv({ MONGODB_URI: "mongodb://db:27017/openpic" }));

    const db = mongo.getDb();

    expect(db.databaseName).toBe("openpic");

    await mongo.closeMongoClient();
  });

  it("returns a named database when one is requested", async () => {
    const mongo = await loadMongoModule();

    const db = mongo.getDb("audit");

    expect(db.databaseName).toBe("audit");

    await mongo.closeMongoClient();
  });
});
