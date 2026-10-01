import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * Integration globalSetup: boots a single-node MongoDB replica set so that
 * multi-document transactions work exactly as in production, and publishes the
 * connection string as `MONGO_TEST_URI` for test workers.
 */
let replSet: MongoMemoryReplSet | undefined;

export async function setup(): Promise<void> {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGO_TEST_URI = replSet.getUri();
}

export async function teardown(): Promise<void> {
  await replSet?.stop();
}
