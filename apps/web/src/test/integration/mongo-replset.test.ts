import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * I2 — proves the integration harness runs MongoDB as a replica set so
 * multi-document transactions behave exactly as in production.
 *
 * The integration `globalSetup` starts a `MongoMemoryReplSet` and publishes
 * its connection string as `MONGO_TEST_URI`; a standalone mongod would reject
 * `withTransaction`, so this test is the regression guard for that wiring.
 */
describe('MongoDB replica-set harness', () => {
  let client: MongoClient;

  beforeAll(async () => {
    const uri = process.env.MONGO_TEST_URI;
    if (!uri) {
      throw new Error(
        'MONGO_TEST_URI is not set — the integration globalSetup must start a MongoMemoryReplSet',
      );
    }
    client = new MongoClient(uri);
    await client.connect();
  });

  afterAll(async () => {
    await client?.close();
  });

  it('commits a multi-document transaction', async () => {
    const accounts = client
      .db('op_test')
      .collection<{ _id: string; balance: number }>('accounts');
    await accounts.deleteMany({});

    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await accounts.insertOne({ _id: 'a', balance: 100 }, { session });
        await accounts.updateOne({ _id: 'a' }, { $inc: { balance: 50 } }, { session });
      });
    } finally {
      await session.endSession();
    }

    const saved = await accounts.findOne({ _id: 'a' });
    expect(saved?.balance).toBe(150);
  });
});
