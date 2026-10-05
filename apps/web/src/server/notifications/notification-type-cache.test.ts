import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import {
  getEnabledNotificationTypeKeys,
  invalidateNotificationTypeCache,
  NOTIFICATION_TYPE_CACHE_TTL_MS,
} from "@/server/notifications/notification-type-cache";
import type { Clock } from "@/server/runtime/clock";

import { makeNotificationType } from "../../test/factories/notification";
import { makeFakeMongo, type FakeMongo } from "../../test/helpers/fake-mongo";

/**
 * Unit contract — the `notification_types` enabled-set read cache (OP-88
 * follow-up, finding 1 / decision D1).
 *
 * The outbox writer needs to know which `typeKey`s are enabled on every emit.
 * A per-emit `findOne` turns a hot write path into one extra round-trip per
 * event; this accessor replaces it with a clock-once TTL cache mirroring
 * `getPlatformSettings` (`@/server/settings/platform-settings`).
 *
 * Contract expected of the implementation
 * (`@/server/notifications/notification-type-cache`):
 *
 *   NOTIFICATION_TYPE_CACHE_TTL_MS = 30_000
 *   getEnabledNotificationTypeKeys(options?: {
 *     db?: Db; clock?: Clock; ttlMs?: number;
 *   }): Promise<ReadonlySet<string>>
 *   invalidateNotificationTypeCache(): void
 *
 * Semantics (identical to `getPlatformSettings`):
 *   - one bounded `find({}, { projection: { typeKey: 1, enabled: 1 } })` per
 *     TTL window against `COLLECTIONS.notificationTypes`, deriving the enabled
 *     set in code (`enabled === true`);
 *   - the injected `clock` is read exactly once per call;
 *   - a hit returns while `nowMs < expiresAt` (strict `<`); at/after expiry the
 *     next call re-reads;
 *   - `invalidateNotificationTypeCache()` forces the next call to re-read.
 *
 * The cache is process-wide, so every spec invalidates it around itself.
 */

/** A fixed instant so a window boundary is exact, not run-dependent. */
const T0 = "2026-03-01T00:00:00.000Z";

/** Epoch millis for an ISO instant plus an offset, kept readable in specs. */
function at(iso: string, plusMs = 0): string {
  return new Date(Date.parse(iso) + plusMs).toISOString();
}

/**
 * A controllable clock that counts how many times it is read.
 *
 * `set`/`advance` move the cursor; `reads()` reports the number of `now()`
 * calls, which is how the "clock read exactly once per call" rule is pinned.
 */
function controllableClock(start: string): {
  readonly clock: Clock;
  set(iso: string): void;
  advance(ms: number): void;
  reads(): number;
} {
  let cursor = Date.parse(start);
  let readCount = 0;
  const clock: Clock = {
    now: () => {
      readCount += 1;
      return new Date(cursor);
    },
  };
  return {
    clock,
    set: (iso) => {
      cursor = Date.parse(iso);
    },
    advance: (ms) => {
      cursor += ms;
    },
    reads: () => readCount,
  };
}

/** How many reads the fake recorded against the `notification_types` collection. */
function notificationTypeReads(fake: FakeMongo): number {
  return fake.calls.filter(
    (call) =>
      call.collection === COLLECTIONS.notificationTypes &&
      (call.method === "find" || call.method === "findOne")
  ).length;
}

beforeEach(() => {
  invalidateNotificationTypeCache();
});

afterEach(() => {
  invalidateNotificationTypeCache();
});

describe("getEnabledNotificationTypeKeys — the enabled set", () => {
  it("returns the enabled type keys, excluding disabled and missing-enabled rows", async () => {
    const fake = makeFakeMongo();
    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "collab.invite.accepted", enabled: true }),
      makeNotificationType({ typeKey: "billing.payment.succeeded", enabled: false }),
      { typeKey: "analytics.only", enabled: undefined },
    ]);

    const keys = await getEnabledNotificationTypeKeys({
      db: fake.db,
      clock: controllableClock(T0).clock,
    });

    expect([...keys].sort()).toEqual(["collab.invite.accepted"]);
  });

  it("reads the set with one bounded find against the injected db, never a per-key findOne", async () => {
    const fake = makeFakeMongo();
    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "collab.invite.accepted", enabled: true }),
    ]);

    await getEnabledNotificationTypeKeys({
      db: fake.db,
      clock: controllableClock(T0).clock,
    });

    const reads = fake.calls.filter((call) => call.collection === COLLECTIONS.notificationTypes);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.method).toBe("find");
    // Platform scope: no tenant filter, so the whole catalogue is read once.
    expect(reads[0]?.args[0]).toEqual({});
    expect(fake.calls.some((call) => call.method === "findOne")).toBe(false);
  });

  it("reads the clock exactly once per call, even on a cache hit", async () => {
    const fake = makeFakeMongo();
    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "collab.invite.accepted", enabled: true }),
    ]);
    const time = controllableClock(T0);

    await getEnabledNotificationTypeKeys({ db: fake.db, clock: time.clock });
    await getEnabledNotificationTypeKeys({ db: fake.db, clock: time.clock });

    expect(time.reads()).toBe(2);
  });
});

describe("getEnabledNotificationTypeKeys — the TTL window", () => {
  it("serves a second call within the window from cache without touching the database", async () => {
    const fake = makeFakeMongo();
    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "collab.invite.accepted", enabled: true }),
    ]);
    const time = controllableClock(T0);

    const first = await getEnabledNotificationTypeKeys({ db: fake.db, clock: time.clock });
    time.advance(10_000);
    const second = await getEnabledNotificationTypeKeys({ db: fake.db, clock: time.clock });

    expect(second).toBe(first);
    expect(notificationTypeReads(fake)).toBe(1);
  });

  it("honours a ttlMs override: a hit before the override, a re-read after it", async () => {
    const fake = makeFakeMongo();
    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "a.enabled", enabled: true }),
    ]);
    const time = controllableClock(T0);
    const ttlMs = 2500;

    const first = await getEnabledNotificationTypeKeys({ db: fake.db, clock: time.clock, ttlMs });
    expect([...first]).toEqual(["a.enabled"]);

    // Inside the overridden window: still cached.
    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "b.enabled", enabled: true }),
    ]);
    time.advance(2000);
    const second = await getEnabledNotificationTypeKeys({ db: fake.db, clock: time.clock, ttlMs });
    expect([...second]).toEqual(["a.enabled"]);
    expect(notificationTypeReads(fake)).toBe(1);

    // At/after the overridden window: re-read and observe the new state.
    time.advance(1);
    const third = await getEnabledNotificationTypeKeys({ db: fake.db, clock: time.clock, ttlMs });
    expect([...third]).toEqual(["b.enabled"]);
    expect(notificationTypeReads(fake)).toBe(2);
  });

  it("expires exactly at expiresAt — a read at the boundary re-reads (strict <)", async () => {
    const fake = makeFakeMongo();
    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "a.enabled", enabled: true }),
    ]);
    const time = controllableClock(T0);
    const ttlMs = 30_000;

    const first = await getEnabledNotificationTypeKeys({ db: fake.db, clock: time.clock, ttlMs });
    expect([...first]).toEqual(["a.enabled"]);

    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "b.enabled", enabled: true }),
    ]);
    // Exactly `expiresAt`: the cache must NOT serve this read.
    time.set(at(T0, ttlMs));

    const boundary = await getEnabledNotificationTypeKeys({
      db: fake.db,
      clock: time.clock,
      ttlMs,
    });
    expect([...boundary]).toEqual(["b.enabled"]);
    expect(notificationTypeReads(fake)).toBe(2);
  });

  it("defaults to a 30 000 ms window when ttlMs is omitted", async () => {
    const fake = makeFakeMongo();
    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "a.enabled", enabled: true }),
    ]);
    const time = controllableClock(T0);

    expect(NOTIFICATION_TYPE_CACHE_TTL_MS).toBe(30_000);

    await getEnabledNotificationTypeKeys({ db: fake.db, clock: time.clock });
    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "b.enabled", enabled: true }),
    ]);

    // One millisecond before the documented window: still cached.
    time.advance(NOTIFICATION_TYPE_CACHE_TTL_MS - 1);
    const cached = await getEnabledNotificationTypeKeys({ db: fake.db, clock: time.clock });
    expect([...cached]).toEqual(["a.enabled"]);
    expect(notificationTypeReads(fake)).toBe(1);

    // At the documented window: re-read and observe the change.
    time.advance(1);
    const reloaded = await getEnabledNotificationTypeKeys({ db: fake.db, clock: time.clock });
    expect([...reloaded]).toEqual(["b.enabled"]);
    expect(notificationTypeReads(fake)).toBe(2);
  });
});

describe("invalidateNotificationTypeCache", () => {
  it("forces the very next call to re-read, even inside the window", async () => {
    const fake = makeFakeMongo();
    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "a.enabled", enabled: true }),
    ]);
    const time = controllableClock(T0);

    await getEnabledNotificationTypeKeys({ db: fake.db, clock: time.clock });
    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "b.enabled", enabled: true }),
    ]);

    time.advance(1000);
    invalidateNotificationTypeCache();
    const reloaded = await getEnabledNotificationTypeKeys({ db: fake.db, clock: time.clock });

    expect([...reloaded]).toEqual(["b.enabled"]);
    expect(notificationTypeReads(fake)).toBe(2);
  });
});
