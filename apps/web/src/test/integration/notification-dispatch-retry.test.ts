import { ObjectId, type Db } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TransportError } from "@/server/adapters/transport-error";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { closeMongoClient } from "@/server/db/mongo";
import { retryDueDispatches } from "@/server/notifications/dispatch-retry";
import { runNotificationFanOut, type RecipientRepository } from "@/server/notifications/fan-out";
import type {
  MessageTransport,
  OutboundMessage,
  TransportReceipt,
} from "@/server/notifications/message-transport";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import { SEED_NOTIFICATION_TEMPLATES } from "@/server/notifications/notification-templates.values";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";
import { fixedClock } from "@/server/runtime/clock";

import {
  createTestDb,
  MONGO_READY_HOOK_TIMEOUT_MS,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";

/**
 * Integration / contract — the dispatch retry cron (OP-96, contract §10.2
 * `notification-dispatch-retry`; ADR-0100).
 *
 * The fan-out records a transport failure on the `notificationDispatches` row
 * with a classified `lastError.retryable`. The retry cron re-attempts **only**
 * the retryable rows, after their backoff delay, and marks the row `sent` on
 * success. A non-retryable failure (a provider contract violation) is left
 * exactly as it is — retrying it would only delay the inevitable.
 *
 * Runs against a real `MongoMemoryReplSet` and the real seed catalogue. The
 * failed row is produced by the real fan-out against a scripted transport, so
 * the retry exercises whatever the implementation persisted — never a
 * hand-crafted row shape.
 */

/** The `notification_dispatches` collection (schema §12). */
const DISPATCHES = COLLECTIONS.dispatches;
/** The `user` collection (schema §13.1). */
const USER = "user";

/** A fixed instant so every stored timestamp is exact. */
const T0 = "2026-03-01T10:00:00.000Z";

/** Fields of a stored dispatch row this spec inspects (schema §19.5). */
interface StoredDispatch {
  readonly userId?: unknown;
  readonly typeKey?: unknown;
  readonly channel?: unknown;
  readonly status?: unknown;
  readonly attempts?: unknown;
  readonly lastError?: { readonly retryable?: unknown; readonly code?: unknown };
}

/** A scripted transport that fails the first `failures` sends, then succeeds. */
interface ScriptedTransport extends MessageTransport {
  readonly outbox: readonly OutboundMessage[];
  readonly calls: number;
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

/** Build a transport that rejects the first `failures` sends with `retryable`. */
function scriptedTransport(failures: number, retryable: boolean): ScriptedTransport {
  const outbox: OutboundMessage[] = [];
  let calls = 0;

  return {
    get outbox(): readonly OutboundMessage[] {
      return outbox;
    },
    get calls(): number {
      return calls;
    },
    send(message: OutboundMessage): Promise<TransportReceipt> {
      calls += 1;
      if (calls <= failures) {
        return Promise.reject(
          new TransportError("scripted provider failure", {
            retryable,
            code: "http",
            status: retryable ? 503 : 400,
          })
        );
      }
      outbox.push(message);
      return Promise.resolve({ providerMessageId: `stub-${String(calls)}` });
    },
  };
}

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_notification_retry");
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

/** Insert the `user`, `userProfiles` and `notificationPreferences` trio. */
async function seedRecipient(database: Db, userId: string): Promise<void> {
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
    quietHours: { enabled: false, start: "22:00", end: "07:00", timeZone: "UTC" },
    locale: "en-IN",
  });
}

/** Insert a pending `event.details.updated` outbox row and run the fan-out. */
async function deliverWith(
  database: Db,
  transport: MessageTransport,
  recipient: string,
  actor: string
): Promise<void> {
  const occurredAt = new Date(T0);
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
    clock: fixedClock(T0),
    transport,
    recipients,
    batch: 10,
    claimerId: "worker_retry",
  });
}

/** Read the email dispatch row for a type. */
async function emailDispatch(database: Db, typeKey: string): Promise<StoredDispatch | undefined> {
  const rows = await database.collection<StoredDispatch>(DISPATCHES).find({ typeKey }).toArray();
  return rows.find((row: StoredDispatch): boolean => row.channel === "email");
}

describe("notification-dispatch-retry (I4)", () => {
  it("I4: re-sends a failed-retryable dispatch once and marks it sent", async () => {
    await withTestDb(async (test) => {
      const recipient = newUserId();
      const actor = newUserId();
      await seedRecipient(test.db, recipient);

      const transport = scriptedTransport(1, true);
      await deliverWith(test.db, transport, recipient, actor);

      const failed = await emailDispatch(test.db, "event.details.updated");
      expect(failed).toMatchObject({ status: "failed", attempts: 1 });
      expect(failed?.lastError).toMatchObject({ retryable: true, status: 503 });
      expect(transport.calls).toBe(1);

      // Run the retry after the backoff has elapsed (base 60s).
      const outcome = await retryDueDispatches({
        db: test.db,
        clock: fixedClock("2026-03-01T10:02:00.000Z"),
        transport,
        limit: 100,
      });

      expect(outcome.affected).toBe(1);
      expect(transport.calls).toBe(2);
      expect(transport.outbox).toHaveLength(1);

      const retried = await emailDispatch(test.db, "event.details.updated");
      expect(retried).toMatchObject({ status: "sent", attempts: 2 });
    });
  });

  it("I4: leaves a non-retryable failure untouched", async () => {
    await withTestDb(async (test) => {
      const recipient = newUserId();
      const actor = newUserId();
      await seedRecipient(test.db, recipient);

      const transport = scriptedTransport(1, false);
      await deliverWith(test.db, transport, recipient, actor);

      const failed = await emailDispatch(test.db, "event.details.updated");
      expect(failed).toMatchObject({ status: "failed", attempts: 1 });
      expect(failed?.lastError).toMatchObject({ retryable: false });

      const outcome = await retryDueDispatches({
        db: test.db,
        clock: fixedClock("2026-03-01T10:10:00.000Z"),
        transport,
        limit: 100,
      });

      expect(outcome.affected).toBe(0);
      // The transport is never called for a non-retryable row.
      expect(transport.calls).toBe(1);

      const untouched = await emailDispatch(test.db, "event.details.updated");
      expect(untouched).toMatchObject({ status: "failed", attempts: 1 });
      expect(untouched?.lastError).toMatchObject({ retryable: false });
    });
  });
});
