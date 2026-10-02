import { MongoClient, type Db } from "mongodb";

import { getConfig, getMongoPoolConfig } from "../config/env";

/**
 * The process-wide MongoDB client singleton (OP-75, §1).
 *
 * Serverless safety requires the client to live on a process/global slot, NOT
 * in module scope: a Next.js route module may be evaluated more than once
 * (lambda re-use, hot reload, multiple importers) and the pool must be shared
 * across all of those module instances rather than re-created per evaluation.
 *
 * Importing this module is side-effect free — no connection is opened until the
 * client is actually used.
 */

/** Value reported to the server as the client's application name. */
export const MONGO_APP_NAME = "openpic-web";

/** The globalThis shape carrying the cached client. */
interface MongoGlobal {
  __openpicMongoClient?: MongoClient | undefined;
}

const globalSlot = globalThis as typeof globalThis & MongoGlobal;

/**
 * Return the shared `MongoClient`, building it lazily from validated config.
 *
 * @returns The process-wide client (the same instance on every call).
 */
export function getMongoClient(): MongoClient {
  const existing = globalSlot.__openpicMongoClient;
  if (existing !== undefined) {
    return existing;
  }

  const config = getConfig();
  const pool = getMongoPoolConfig();
  const client = new MongoClient(config.mongo.uri, {
    appName: MONGO_APP_NAME,
    maxPoolSize: pool.maxPoolSize,
    serverSelectionTimeoutMS: pool.serverSelectionTimeoutMS,
    connectTimeoutMS: pool.connectTimeoutMS,
    socketTimeoutMS: pool.socketTimeoutMS,
  });

  globalSlot.__openpicMongoClient = client;
  return client;
}

/**
 * Return a database handle on the shared client.
 *
 * @param name - The database name; omitted means the database named in the
 *   connection string.
 * @returns A `Db` handle (no I/O until an operation runs).
 */
export function getDb(name?: string): Db {
  const client = getMongoClient();
  return name === undefined ? client.db() : client.db(name);
}

/**
 * Close and forget the shared client.
 *
 * Safe to call when no client was ever built. Used by the shutdown hook and by
 * tests that must release the pool.
 */
export async function closeMongoClient(): Promise<void> {
  const client = globalSlot.__openpicMongoClient;
  globalSlot.__openpicMongoClient = undefined;
  if (client !== undefined) {
    await client.close();
  }
}
