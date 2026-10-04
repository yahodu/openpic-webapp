import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { apiErrorSchema } from "@openpic/contracts";

import { closeMongoClient } from "../../server/db/mongo";
import { ensureIndexes } from "../../server/db/indexes";
import { created, defineRoute, type RouteHandler } from "../../server/http/define-route";
import {
  idempotencyStage,
  mongoIdempotencyStore,
  requestHash,
  type IdempotencyStore,
} from "../../server/idempotency";
import { makeEnv, toProcessEnv } from "../factories/env";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * Integration contract — the idempotency stage inside the `defineRoute`
 * pipeline (API contract §0.9), against a real MongoDB replica set.
 *
 * Cases: I1 first call 201 + stored; I2 replay identical body + 200 + replay
 * header; I3 concurrency executes the handler exactly once; I4 same key /
 * different body -> 422; I5 missing key on a required route -> 400; I6 a
 * throwing handler releases the key; I7 the TTL index exists; I8 the key is
 * scoped per principal so one principal can never read another's stored body.
 */

/** The collection the stage persists records in (API contract §0.9). */
const IDEMPOTENCY_COLLECTION = "idempotency_keys";

/** The header a client sends to request idempotent handling. */
const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/** The header a replay carries. */
const IDEMPOTENCY_REPLAYED_HEADER = "idempotency-replayed";

const ROUTE = "/api/v1/things";
const URL = `http://localhost${ROUTE}`;

beforeAll(() => {
  const uri = process.env.MONGO_TEST_URI;
  if (!uri) {
    throw new Error(
      "MONGO_TEST_URI is not set — the integration globalSetup must start a MongoMemoryReplSet"
    );
  }

  Object.assign(process.env, toProcessEnv(makeEnv({ APP_ENV: "test", MONGODB_URI: uri })));
});

afterAll(async () => {
  await closeMongoClient();
});

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_idempotency");
  try {
    await fn(test);
  } finally {
    await test.cleanup();
  }
}

/** A promise plus its resolver, for driving a handler into the "in flight" state. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface RouteOptions {
  readonly store: IdempotencyStore;
  readonly required?: boolean;
  readonly userId?: string;
  readonly tenantId?: string;
  readonly handler?: (ctx: { readonly body: { amount: number } }) => {
    status?: number;
    body: { id: string; amount: number };
    headers?: Record<string, string>;
  };
}

/** Build the write route under test with the idempotency stage attached. */
function makeRoute(options: RouteOptions): RouteHandler {
  return defineRoute({
    route: ROUTE,
    body: z.object({ amount: z.number() }),
    response: z.object({ id: z.string(), amount: z.number() }),
    env: "test",
    idempotency: idempotencyStage({
      store: options.store,
      required: options.required ?? false,
      ...(options.userId === undefined ? {} : { userId: options.userId }),
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    }),
    handler: (ctx) =>
      options.handler === undefined
        ? created({ id: "thing-1", amount: ctx.body.amount }, `${ROUTE}/thing-1`)
        : options.handler(ctx),
  });
}

/** Build a JSON POST carrying an optional idempotency key. */
function post(body: unknown, key?: string): Request {
  return new Request(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key === undefined ? {} : { [IDEMPOTENCY_KEY_HEADER]: key }),
    },
    body: JSON.stringify(body),
  });
}

/** Find the TTL index (expireAt, expireAfterSeconds 0) among a collection's indexes. */
function findTtlIndex(indexes: readonly unknown[]): Record<string, unknown> | undefined {
  return indexes.find((index) => {
    if (typeof index !== "object" || index === null) {
      return false;
    }
    const key = (index as { key?: unknown }).key;
    if (typeof key !== "object" || key === null) {
      return false;
    }
    return (
      (key as Record<string, unknown>).expireAt === 1 &&
      (index as { expireAfterSeconds?: unknown }).expireAfterSeconds === 0
    );
  }) as Record<string, unknown> | undefined;
}

/** Find a unique index whose keys include the given field. */
function findUniqueIndexOn(
  indexes: readonly unknown[],
  field: string
): Record<string, unknown> | undefined {
  return indexes.find((index) => {
    if (typeof index !== "object" || index === null) {
      return false;
    }
    if ((index as { unique?: unknown }).unique !== true) {
      return false;
    }
    const key = (index as { key?: unknown }).key;
    if (typeof key !== "object" || key === null) {
      return false;
    }
    return field in (key as Record<string, unknown>);
  }) as Record<string, unknown> | undefined;
}

/** Read a collection's index descriptions, tolerating a missing namespace. */
async function listIndexes(test: TestDb, collection: string): Promise<readonly unknown[]> {
  const raw: unknown = await test.db.collection(collection).listIndexes().toArray();
  return Array.isArray(raw) ? (raw as readonly unknown[]) : [];
}

describe("idempotency stage in the pipeline (MongoDB)", () => {
  it("I1: the first call executes the handler, returns 201 and stores a completed record", async () => {
    await withTestDb(async (test) => {
      await ensureIndexes(test.db);
      const store = mongoIdempotencyStore(test.db);
      const route = makeRoute({ store, userId: "user-a", tenantId: "tenant-1" });
      const key = "11111111-1111-4111-8111-111111111111";
      const body = { amount: 42 };

      const response = await route(post(body, key));

      expect(response.status).toBe(201);
      expect(response.headers.get("location")).toBe(`${ROUTE}/thing-1`);
      expect(response.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
      await expect(response.json()).resolves.toEqual({ id: "thing-1", amount: 42 });

      const stored = await test.db.collection(IDEMPOTENCY_COLLECTION).find({ key }).toArray();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.status).toBe("completed");
      expect(stored[0]?.scope).toBe("POST /api/v1/things");
      expect(stored[0]?.requestHash).toBe(
        requestHash({ body, tenantId: "tenant-1", userId: "user-a" })
      );
      expect(stored[0]?.responseSnapshot).toBeDefined();
      expect(stored[0]?.expireAt).toBeInstanceOf(Date);
    });
  });

  it("I2: a replay returns the identical body with 200 and the replay header", async () => {
    await withTestDb(async (test) => {
      await ensureIndexes(test.db);
      const store = mongoIdempotencyStore(test.db);
      const route = makeRoute({ store, userId: "user-a", tenantId: "tenant-1" });
      const key = "22222222-2222-4222-8222-222222222222";
      const body = { amount: 7 };

      const first = await route(post(body, key));
      expect(first.status).toBe(201);
      const firstBody = await first.json();

      const second = await route(post(body, key));

      expect(second.status).toBe(200);
      expect(second.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe("true");
      await expect(second.json()).resolves.toEqual(firstBody);

      // The replay reuses the stored record rather than writing a second one.
      const stored = await test.db.collection(IDEMPOTENCY_COLLECTION).find({ key }).toArray();
      expect(stored).toHaveLength(1);
    });
  });

  it("I3: concurrent identical calls execute the handler once; the loser gets 409 and a later call replays", async () => {
    await withTestDb(async (test) => {
      await ensureIndexes(test.db);
      const store = mongoIdempotencyStore(test.db);
      const key = "33333333-3333-4333-8333-333333333333";
      const body = { amount: 7 };
      let calls = 0;
      const gate = deferred();
      const started = deferred();

      const route = makeRoute({
        store,
        userId: "user-a",
        tenantId: "tenant-1",
        handler: () => {
          calls += 1;
          started.resolve();
          return {
            status: 201,
            body: { id: "thing-1", amount: 7 },
            headers: { location: `${ROUTE}/thing-1` },
          };
        },
      });

      // Kick off the first call without awaiting; it holds the key in
      // `in_progress` while the handler is parked on the gate.
      const first = route(post(body, key));
      await started.promise;

      const concurrent = await route(post(body, key));

      expect(concurrent.status).toBe(409);
      expect(concurrent.headers.get("retry-after")).toBe("2");
      const concurrentBody = await concurrent.json();
      expect(concurrentBody.error.code).toBe("idempotency_in_progress");
      expect(concurrentBody.error.retryable).toBe(true);
      expect(apiErrorSchema.safeParse(concurrentBody).success).toBe(true);

      gate.resolve();
      const firstResponse = await first;
      expect(firstResponse.status).toBe(201);

      const replay = await route(post(body, key));
      expect(replay.status).toBe(200);
      expect(replay.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe("true");

      expect(calls).toBe(1);
    });
  });

  it("I4: the same key with a different body is rejected with 422 idempotency_key_reuse", async () => {
    await withTestDb(async (test) => {
      await ensureIndexes(test.db);
      const store = mongoIdempotencyStore(test.db);
      const route = makeRoute({ store, userId: "user-a", tenantId: "tenant-1" });
      const key = "44444444-4444-4444-8444-444444444444";

      const first = await route(post({ amount: 1 }, key));
      expect(first.status).toBe(201);

      const second = await route(post({ amount: 2 }, key));

      expect(second.status).toBe(422);
      const body = await second.json();
      expect(body.error.code).toBe("idempotency_key_reuse");
      expect(apiErrorSchema.safeParse(body).success).toBe(true);
      expect(body.error.details?.originalRequestAt).toBeDefined();
      expect(Number.isNaN(Date.parse(String(body.error.details?.originalRequestAt)))).toBe(false);
    });
  });

  it("I5: a required route rejects a missing Idempotency-Key with 400 idempotency_key_required", async () => {
    await withTestDb(async (test) => {
      await ensureIndexes(test.db);
      const store = mongoIdempotencyStore(test.db);
      let calls = 0;
      const route = makeRoute({
        store,
        required: true,
        userId: "user-a",
        tenantId: "tenant-1",
        handler: () => {
          calls += 1;
          return { status: 201, body: { id: "thing-1", amount: 1 }, headers: {} };
        },
      });

      const response = await route(post({ amount: 1 }));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe("idempotency_key_required");
      expect(apiErrorSchema.safeParse(body).success).toBe(true);
      expect(calls).toBe(0);
    });
  });

  it("I5: an optional route accepts a request with no Idempotency-Key", async () => {
    await withTestDb(async (test) => {
      await ensureIndexes(test.db);
      const store = mongoIdempotencyStore(test.db);
      const route = makeRoute({ store, userId: "user-a", tenantId: "tenant-1" });

      const response = await route(post({ amount: 3 }));

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual({ id: "thing-1", amount: 3 });
    });
  });

  it("I5: rejects a malformed (non-UUIDv4) Idempotency-Key with 422 validation_failed", async () => {
    await withTestDb(async (test) => {
      await ensureIndexes(test.db);
      const store = mongoIdempotencyStore(test.db);
      const route = makeRoute({ store, userId: "user-a", tenantId: "tenant-1" });

      const response = await route(post({ amount: 1 }, "not-a-uuid"));

      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.error.code).toBe("validation_failed");
      expect(apiErrorSchema.safeParse(body).success).toBe(true);
    });
  });

  it("I6: a handler that throws releases the key so a retry executes again", async () => {
    await withTestDb(async (test) => {
      await ensureIndexes(test.db);
      const store = mongoIdempotencyStore(test.db);
      const key = "66666666-6666-4666-8666-666666666666";
      let calls = 0;
      const route = makeRoute({
        store,
        userId: "user-a",
        tenantId: "tenant-1",
        handler: () => {
          calls += 1;
          if (calls === 1) {
            throw new Error("boom");
          }
          return { status: 201, body: { id: "thing-1", amount: 5 }, headers: {} };
        },
      });

      const first = await route(post({ amount: 5 }, key));
      expect(first.status).toBe(500);

      const afterFailure = await test.db.collection(IDEMPOTENCY_COLLECTION).find({ key }).toArray();
      expect(afterFailure).toHaveLength(0);

      const retry = await route(post({ amount: 5 }, key));
      expect(retry.status).toBe(201);
      expect(calls).toBe(2);
    });
  });

  it("I7: ensureIndexes builds a TTL index on expireAt and a unique index on the key", async () => {
    await withTestDb(async (test) => {
      await ensureIndexes(test.db);

      const indexes = await listIndexes(test, IDEMPOTENCY_COLLECTION);

      const ttl = findTtlIndex(indexes);
      expect(ttl).toBeDefined();
      expect(ttl?.expireAfterSeconds).toBe(0);

      const unique = findUniqueIndexOn(indexes, "key");
      expect(unique).toBeDefined();
      expect(Object.keys(unique?.key as Record<string, unknown>)).toContain("scope");
    });
  });

  it("I8: a different principal reusing the same key executes fresh and never sees the first principal's body", async () => {
    await withTestDb(async (test) => {
      await ensureIndexes(test.db);
      const store = mongoIdempotencyStore(test.db);
      const key = "88888888-8888-4888-8888-888888888888";
      const body = { amount: 1 };
      const routeA = makeRoute({
        store,
        userId: "user-a",
        tenantId: "tenant-1",
        handler: () => ({ status: 201, body: { id: "a", amount: 1 }, headers: {} }),
      });
      const routeB = makeRoute({
        store,
        userId: "user-b",
        tenantId: "tenant-1",
        handler: () => ({ status: 201, body: { id: "b", amount: 1 }, headers: {} }),
      });

      const first = await routeA(post(body, key));
      const bodyA = await first.json();
      expect(first.status).toBe(201);

      const responseB = await routeB(post(body, key));
      expect(responseB.status).toBe(201);
      const bodyB = await responseB.json();

      expect(bodyB).toEqual({ id: "b", amount: 1 });
      expect(bodyB).not.toEqual(bodyA);

      // The key is scoped per principal, so both records coexist and neither
      // principal's stored body can surface in the other's response.
      const stored = await test.db.collection(IDEMPOTENCY_COLLECTION).find({ key }).toArray();
      expect(stored).toHaveLength(2);
      expect(JSON.stringify(bodyB)).not.toContain('"id":"a"');
    });
  });
});
