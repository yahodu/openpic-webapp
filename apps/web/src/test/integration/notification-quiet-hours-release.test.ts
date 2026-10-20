import { ObjectId, type Db } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { memoryMessageTransport } from "@/server/adapters/memory-message-transport";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { closeMongoClient } from "@/server/db/mongo";
import { runNotificationFanOut, type RecipientRepository } from "@/server/notifications/fan-out";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import { SEED_NOTIFICATION_TEMPLATES } from "@/server/notifications/notification-templates.values";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";
import { releaseDeferredDispatches } from "@/server/notifications/quiet-hours-release";
import { fixedClock } from "@/server/runtime/clock";

import {
  createTestDb,
  MONGO_READY_HOOK_TIMEOUT_MS,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";

/**
 * Integration / contract — durable quiet-hours deferral and its release cron
 * (OP-96, design §5; contract §10.2 `quiet-hours-release`; ADR-0100).
 *
 * Design §5 says quiet hours **schedule** the send after the window. The fan-out
 * must therefore persist a durable, selectable intent — a `notificationDispatches`
 * row with `status: "deferred"` and `until` = the window end — rather than a
 * terminal `skipped` row (which `runNotificationFanOut` would mark `done` and
 * leave nothing to release). The `quiet-hours-release` cron selects
 * `status: "deferred"` rows whose `until <= now`, sends them and marks the row
 * `sent`/`failed`.
 *
 * Runs against a real `MongoMemoryReplSet` and the real seed catalogue with the
 * seeded `event.details.updated` type (informational, respects quiet hours) and
 * a recipient whose quiet window is 22:00–07:00 UTC.
 */

/** The `notification_dispatches` collection (schema §12). */
const DISPATCHES = COLLECTIONS.dispatches;
/** The `user` collection (schema §13.1). */
const USER = "user";

/** An instant inside the quiet window (23:00 UTC). */
const INSIDE = "2026-03-01T23:00:00.000Z";
/** The window end the deferral must target (07:00 UTC the next day). */
const WINDOW_END = "2026-03-02T07:00:00.000Z";
/** An instant before the window end. */
const BEFORE_END = "2026-03-02T06:00:00.000Z";

/** Fields of a stored dispatch row this spec inspects (schema §19.5). */
interface StoredDispatch {
  readonly userId?: unknown;
  readonly typeKey?: unknown;
  readonly channel?: unknown;
  readonly status?: unknown;
  readonly skipReason?: unknown;
  readonly until?: unknown;
}

beforeAll(async () => {
  await setupMongoTestEnv();
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await closeMongoClient();
});

beforeEach(() => {
  invalidateNotificationTypeCache();
});

/** The ISO instant of a stored date-ish value. */
function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_notification_quiet_hours");
  try {
    await ensureIndexes(test.db);
    await seedCatalogue(test.db);
    await fn(test);
  } finally {
    await test.cleanup();
  }
}

/** Insert the real seed routing catalogue and copy. */
async function seedCatalogue(database: Db): Promise<void> {
  await database.collection(COLLECTIONS.notificationTypes).insertMany([...SEED_NOTIFICATION_TYPES]);
  await database
    .collection(COLLECTIONS.notificationTemplates)
    .insertMany([...SEED_NOTIFICATION_TEMPLATES]);
}

/** A fresh hex user id. */
function newUserId(): string {
  return new ObjectId().toHexString();
}

/** Insert a recipient whose quiet hours are enabled (22:00–07:00 UTC). */
async function seedQuietRecipient(database: Db, userId: string): Promise<void> {
  const objectId = new ObjectId(userId);
  await database.collection(USER).insertOne({
    _id: objectId,
    email: `${userId}@example.com`,
    emailVerified: true,
    phoneNumber: null,
    phoneNumberVerified: false,
  });
  await database.collection(COLLECTIONS.userProfiles).insertOne({
    userId: objectId,
    platformRole: "client",
    locale: "en-IN",
    contactCapabilities: { whatsappCapable: null, whatsappCheckedAt: null },
  });
  await database.collection(COLLECTIONS.notificationPreferences).insertOne({
    userId: objectId,
    global: { in_app: "on", email: "on", mobile: "on" },
    byType: {},
    byEvent: {},
    quietHours: { enabled: true, start: "22:00", end: "07:00", timeZone: "UTC" },
    locale: "en-IN",
  });
}

/** Emit and fan out one `event.details.updated` at a fixed instant. */
async function fanOutAt(
  database: Db,
  transport: ReturnType<typeof memoryMessageTransport>,
  recipient: string,
  actor: string,
  instant: string
): Promise<void> {
  const occurredAt = new Date(instant);
  await database.collection(COLLECTIONS.domainEvents).insertOne({
    eventKey: "event.details.updated",
    tenantId: new ObjectId().toHexString(),
    actorRef: { kind: "user", id: actor },
    subjectRef: { kind: "event", id: new ObjectId().toHexString() },
    payload: {
      eventId: new ObjectId().toHexString(),
      eventName: "Rahul & Priya's Wedding",
      actionUrl: "https://app.openpic.in/events/abc",
    },
    occurredAt,
    expireAt: new Date(occurredAt.getTime() + 180 * 24 * 60 * 60 * 1000),
    dispatch: { notifications: "pending", analytics: "not_applicable", queue: "not_applicable" },
  });

  const recipients: RecipientRepository = {
    listEventRoleMembers: () => Promise.resolve([recipient]),
    listIdentifiedAttendeeUserIds: () => Promise.resolve([]),
    getBillingContactUserId: () => Promise.resolve(null),
    listPlatformAdminUserIds: () => Promise.resolve([]),
  };

  await runNotificationFanOut({
    db: database,
    clock: fixedClock(instant),
    transport,
    recipients,
    batch: 10,
    claimerId: "worker_quiet",
  });
}

/** The email dispatch row. */
async function emailDispatch(database: Db): Promise<StoredDispatch | undefined> {
  const rows = await database
    .collection<StoredDispatch>(DISPATCHES)
    .find({ typeKey: "event.details.updated" })
    .toArray();
  return rows.find((row: StoredDispatch): boolean => row.channel === "email");
}

describe("quiet-hours deferral is durable (I5)", () => {
  it("I5: a defer inside the window yields a deferred row carrying until, not a terminal skip", async () => {
    await withTestDb(async (test) => {
      const recipient = newUserId();
      const actor = newUserId();
      await seedQuietRecipient(test.db, recipient);

      const transport = memoryMessageTransport();
      await fanOutAt(test.db, transport, recipient, actor, INSIDE);

      const dispatch = await emailDispatch(test.db);
      expect(dispatch).toBeDefined();
      expect(dispatch?.status).toBe("deferred");
      expect(dispatch?.skipReason ?? null).toBeNull();
      expect(iso(dispatch?.until)).toBe(WINDOW_END);

      // Nothing is sent while the window is open.
      expect(transport.outbox).toHaveLength(0);
    });
  });
});

describe("quiet-hours release cron (I5)", () => {
  it("I5: releases a deferred dispatch after 07:00 local (fixedClock) and marks it sent", async () => {
    await withTestDb(async (test) => {
      const recipient = newUserId();
      const actor = newUserId();
      await seedQuietRecipient(test.db, recipient);

      const transport = memoryMessageTransport();
      await fanOutAt(test.db, transport, recipient, actor, INSIDE);

      // The release cron runs before the window ends: nothing is released.
      const early = await releaseDeferredDispatches({
        db: test.db,
        clock: fixedClock(BEFORE_END),
        transport,
        limit: 100,
      });
      expect(early.affected).toBe(0);
      expect(transport.outbox).toHaveLength(0);
      expect((await emailDispatch(test.db))?.status).toBe("deferred");

      // At 07:00 the window has ended and the row is released.
      const onTime = await releaseDeferredDispatches({
        db: test.db,
        clock: fixedClock(WINDOW_END),
        transport,
        limit: 100,
      });
      expect(onTime.affected).toBe(1);
      expect(transport.outbox).toHaveLength(1);
      expect(transport.outbox[0]?.channel).toBe("email");
      expect((await emailDispatch(test.db))?.status).toBe("sent");
    });
  });
});

/**
 * True when a `partialFilterExpression` scopes the index to `status: "deferred"`.
 *
 * Structural rather than literal, so it tolerates MongoDB's normalisation: the
 * literal `{status: "deferred"}`, the normalised `{status: {$eq: "deferred"}}`
 * and the set form `{status: {$in: ["deferred"]}}` all count, and the filter is
 * searched recursively (e.g. through `$and`/`$or`) so a nested expression still
 * counts. A partial filter scoped to any other status (e.g. `"sent"`) returns
 * false: it does not serve the release sweep's `status: "deferred" && until <=
 * now` predicate.
 */
function scopesStatusToDeferred(filter: unknown): boolean {
  if (filter === null || typeof filter !== "object") {
    return false;
  }
  if (Array.isArray(filter)) {
    return filter.some(scopesStatusToDeferred);
  }
  const record = filter as Record<string, unknown>;
  const status = record.status;
  if (status === "deferred") {
    return true;
  }
  if (status !== null && typeof status === "object") {
    const operator = status as Record<string, unknown>;
    if (operator.$eq === "deferred") {
      return true;
    }
    if (Array.isArray(operator.$in) && operator.$in.includes("deferred")) {
      return true;
    }
  }
  return Object.values(record).some(scopesStatusToDeferred);
}

describe("the deferred-dispatch index (I5)", () => {
  it("I5: the dispatches collection carries a partial index on {status, until} for the release sweep", async () => {
    await withTestDb(async (test) => {
      const indexes = await test.db.collection(DISPATCHES).listIndexes().toArray();

      const sweepIndex = indexes.find((index: unknown) => {
        const key = (index as { readonly key?: Record<string, unknown> }).key;
        return key !== undefined && "status" in key && "until" in key;
      }) as { readonly partialFilterExpression?: unknown } | undefined;

      expect(sweepIndex).toBeDefined();
      // ADR-0100 requires a *partial* index scoped to the rows the release sweep
      // selects (`status: "deferred"` and `until <= now`). A plain compound index
      // — or one scoped to any other status — would silently drop the sweep's
      // index support, so the filter must reference `status` as `"deferred"`
      // (tolerating MongoDB's `{$eq: "deferred"}` normalisation).
      expect(scopesStatusToDeferred(sweepIndex?.partialFilterExpression)).toBe(true);
    });
  });
});

describe("quiet-hours release is bounded by `limit` (I11)", () => {
  it("I11: releases exactly `limit` due rows and reports hasMore while a backlog remains", async () => {
    await withTestDb(async (test) => {
      const recipient = newUserId();
      const actor = newUserId();
      await seedQuietRecipient(test.db, recipient);
      const transport = memoryMessageTransport();

      // Three deferred email rows, all targeting the same window end.
      for (let index = 0; index < 3; index += 1) {
        await fanOutAt(test.db, transport, recipient, actor, INSIDE);
      }
      expect(await test.db.collection(DISPATCHES).countDocuments({ status: "deferred" })).toBe(3);

      const first = await releaseDeferredDispatches({
        db: test.db,
        clock: fixedClock(WINDOW_END),
        transport,
        limit: 2,
      });

      // A backlog larger than `limit`: exactly `limit` released, more remains.
      expect(first.affected).toBe(2);
      expect(first.hasMore).toBe(true);
      expect(transport.outbox).toHaveLength(2);

      // The backlog now fits under `limit`: the remainder releases, nothing is left.
      const rest = await releaseDeferredDispatches({
        db: test.db,
        clock: fixedClock(WINDOW_END),
        transport,
        limit: 2,
      });

      expect(rest.affected).toBe(1);
      expect(rest.hasMore).toBe(false);
      expect(transport.outbox).toHaveLength(3);
    });
  });
});

describe("quiet-hours release is idempotent (I12)", () => {
  it("I12: each deferred row is released once and a second run re-sends nothing", async () => {
    await withTestDb(async (test) => {
      const recipient = newUserId();
      const actor = newUserId();
      await seedQuietRecipient(test.db, recipient);
      const transport = memoryMessageTransport();

      // Two deferred rows for the same recipient: each must be sent exactly once.
      await fanOutAt(test.db, transport, recipient, actor, INSIDE);
      await fanOutAt(test.db, transport, recipient, actor, INSIDE);

      const first = await releaseDeferredDispatches({
        db: test.db,
        clock: fixedClock(WINDOW_END),
        transport,
        limit: 100,
      });
      expect(first.affected).toBe(2);
      expect(transport.outbox).toHaveLength(2);

      // The rows are `sent` now: a second run selects nothing and re-sends nothing.
      const second = await releaseDeferredDispatches({
        db: test.db,
        clock: fixedClock(WINDOW_END),
        transport,
        limit: 100,
      });
      expect(second.affected).toBe(0);
      expect(transport.outbox).toHaveLength(2);
      expect(await test.db.collection(DISPATCHES).countDocuments({ status: "deferred" })).toBe(0);
      expect(await test.db.collection(DISPATCHES).countDocuments({ status: "sent" })).toBe(2);
    });
  });
});
