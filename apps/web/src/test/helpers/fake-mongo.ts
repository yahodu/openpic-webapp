import { ObjectId } from "mongodb";
import type { Db } from "mongodb";

/**
 * A recording fake for the MongoDB `Db`/`Collection` boundary (OP-77).
 *
 * The tenant-scoped repository layer's whole job is to *transform the query
 * that reaches the driver*: merge `tenantId` into a filter, prepend a
 * `$match` to an aggregate, stamp `$setOnInsert` on an upsert. That transform
 * is the observable behaviour, so a unit test asserts on the arguments the
 * repository hands to the driver, not on the repository's internals.
 *
 * Every method records the arguments it was called with. Return values are
 * canned (and harmless) so the repository can await them; the cursor shim
 * supports the chaining calls a repository may make. Real database behaviour
 * is exercised separately by the integration contract specs.
 */

/** One captured driver call: which collection, which method, which arguments. */
export interface RecordedCall {
  readonly collection: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

/** A cursor-shaped value supporting the chaining a repository may perform. */
export interface FakeCursor {
  toArray(): Promise<Record<string, unknown>[]>;
  sort(): FakeCursor;
  limit(): FakeCursor;
  skip(): FakeCursor;
  project(): FakeCursor;
}

/** The fake database handle and its recorded calls. */
export interface FakeMongo {
  /** Pass as the repository's `db` argument. */
  readonly db: Db;
  /** Every driver call, in order. */
  readonly calls: RecordedCall[];
  /** Seed documents to be returned by `find`/`findOne`/`aggregate`. */
  seed(collection: string, docs: readonly Record<string, unknown>[]): void;
  /** The most recent call to `method`, across all collections. */
  lastCall(method: string): RecordedCall | undefined;
}

function makeCursor(docs: readonly Record<string, unknown>[]): FakeCursor {
  const cursor: FakeCursor = {
    toArray: () => Promise.resolve([...docs]),
    sort: () => cursor,
    limit: () => cursor,
    skip: () => cursor,
    project: () => cursor,
  };
  return cursor;
}

/**
 * Build a recording fake `Db`.
 *
 * @returns The fake, its captured calls, and seed/lookup helpers.
 */
export function makeFakeMongo(): FakeMongo {
  const calls: RecordedCall[] = [];
  const docsByCollection = new Map<string, Record<string, unknown>[]>();

  const collection = (name: string): unknown => {
    const record = (method: string, args: readonly unknown[]): void => {
      calls.push({ collection: name, method, args });
    };

    return {
      find: (filter?: unknown, options?: unknown): FakeCursor => {
        record("find", [filter, options]);
        return makeCursor(docsByCollection.get(name) ?? []);
      },
      findOne: (filter?: unknown, options?: unknown): Promise<Record<string, unknown> | null> => {
        record("findOne", [filter, options]);
        return Promise.resolve(docsByCollection.get(name)?.[0] ?? null);
      },
      findOneAndUpdate: (
        filter?: unknown,
        update?: unknown,
        options?: unknown
      ): Promise<Record<string, unknown> | null> => {
        record("findOneAndUpdate", [filter, update, options]);
        return Promise.resolve(null);
      },
      updateOne: (filter?: unknown, update?: unknown, options?: unknown): Promise<unknown> => {
        record("updateOne", [filter, update, options]);
        return Promise.resolve({
          acknowledged: true,
          matchedCount: 1,
          modifiedCount: 1,
          upsertedCount: 0,
          upsertedId: null,
        });
      },
      updateMany: (filter?: unknown, update?: unknown, options?: unknown): Promise<unknown> => {
        record("updateMany", [filter, update, options]);
        return Promise.resolve({
          acknowledged: true,
          matchedCount: 1,
          modifiedCount: 1,
          upsertedCount: 0,
          upsertedId: null,
        });
      },
      deleteOne: (filter?: unknown, options?: unknown): Promise<unknown> => {
        record("deleteOne", [filter, options]);
        return Promise.resolve({ acknowledged: true, deletedCount: 1 });
      },
      deleteMany: (filter?: unknown, options?: unknown): Promise<unknown> => {
        record("deleteMany", [filter, options]);
        return Promise.resolve({ acknowledged: true, deletedCount: 1 });
      },
      insertOne: (doc?: unknown, options?: unknown): Promise<unknown> => {
        record("insertOne", [doc, options]);
        return Promise.resolve({ acknowledged: true, insertedId: new ObjectId() });
      },
      insertMany: (input?: unknown, options?: unknown): Promise<unknown> => {
        record("insertMany", [input, options]);
        const count = Array.isArray(input) ? input.length : 0;
        return Promise.resolve({ acknowledged: true, insertedCount: count, insertedIds: {} });
      },
      countDocuments: (filter?: unknown, options?: unknown): Promise<number> => {
        record("countDocuments", [filter, options]);
        return Promise.resolve((docsByCollection.get(name) ?? []).length);
      },
      aggregate: (pipeline?: unknown, options?: unknown): FakeCursor => {
        record("aggregate", [pipeline, options]);
        return makeCursor(docsByCollection.get(name) ?? []);
      },
    };
  };

  const db = { collection } as unknown as Db;

  return {
    db,
    calls,
    seed: (name, docs) => {
      docsByCollection.set(name, [...docs]);
    },
    lastCall: (method) => [...calls].reverse().find((call) => call.method === method),
  };
}
