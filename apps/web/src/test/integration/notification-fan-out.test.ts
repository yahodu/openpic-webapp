import { ObjectId, type Db } from "mongodb";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { memoryMessageTransport } from "@/server/adapters/memory-message-transport";
import { novuTransport } from "@/server/adapters/novu/novu-transport";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { closeMongoClient } from "@/server/db/mongo";
import { runNotificationFanOut, type RecipientRepository } from "@/server/notifications/fan-out";
import type { MessageTransport } from "@/server/notifications/message-transport";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import { SEED_NOTIFICATION_TEMPLATES } from "@/server/notifications/notification-templates.values";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";
import { fixedClock } from "@/server/runtime/clock";

import { makeNovuTriggerResponse } from "../factories/transport";
import {
  createTestDb,
  MONGO_READY_HOOK_TIMEOUT_MS,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";

import { server } from "./setup";

/**
 * Integration / contract — the notification fan-out consumer (OP-94, design §2,
 * §5, §6, §7; schema §19.4–§19.6, §18.3; ADR-0090).
 *
 * The fan-out is the `notifications` consumer of the `domainEvents` outbox: it
 * claims `dispatch.notifications: "pending"` rows, resolves recipients at send
 * time, resolves a channel per (recipient × group), then writes the in-app feed
 * row and the `notificationDispatches` ledger, handing outbound messages to an
 * injected `MessageTransport`.
 *
 * The scenarios below run against a real `MongoMemoryReplSet` and the real seed
 * catalogue (`SEED_NOTIFICATION_TYPES` / `SEED_NOTIFICATION_TEMPLATES`). The
 * outbound provider is either the in-memory transport (I1–I4, I6–I8) or the real
 * Novu adapter intercepted by MSW (I5), so a fan-out failure is provable
 * without a live provider.
 *
 * ## Contract expected of the implementation (module `@/server/notifications/fan-out`)
 *
 * ```ts
 * runNotificationFanOut(options?: {
 *   db?: Db; clock?: Clock; transport: MessageTransport;
 *   recipients: RecipientRepository; batch?: number; claimerId?: string;
 * }): Promise<{ claimed: number; processed: number; failed: number }>
 * ```
 *
 * Stored side effects (schema §19.4–§19.5):
 *   - `notifications`: one row per (recipient, typeKey, groupKey, unread) — the
 *     aggregating upsert increments `groupCount` while `readAt: null`, and a
 *     third event after the row is read starts a fresh row.
 *   - `notification_dispatches`: one row per (recipient, channel) *attempt*,
 *     including skips, with `status`, `skipReason`, `attempts` and `lastError`.
 *
 * ## Assumptions and decisions (ADR-0090)
 *
 * - Recipient resolution reads memberships through an injected
 *   `RecipientRepository` port; this lane stubs it with a deterministic source
 *   (the membership data layer is a separate lane). Contacts (`user`),
 *   `userProfiles` and `notificationPreferences` are read from Mongo.
 * - The dispatch `dedupeKey` is the type's interpolated `dedupe.keyTemplate`
 *   suffixed with the resolved channel, so the schema §19.5 unique index
 *   `{tenantId, dedupeKey}` dedupes per channel rather than across channels.
 * - In-app rows never carry a `dedupeKey`; dedupe is an outbound concern.
 * - `in_app` is never digested: a type with `throttle.strategy: "digest"` still
 *   upserts its feed row (design §6 — "in-app aggregation is separate from
 *   digesting").
 * - Quiet hours are disabled in the seeded preferences so the injected clock
 *   cannot defer a send.
 */

/** The stored outbox collection (schema §18.3). */
const DOMAIN_EVENTS = COLLECTIONS.domainEvents;
/** The Better Auth user collection (schema §13.1). */
const USER = "user";

/** A fixed instant so every stored timestamp is exact, never run-dependent. */
const T0 = "2026-03-01T00:00:00.000Z";

/** The `clocks` used by the consumer under test. */
const clock = fixedClock(T0);

/** The Novu trigger endpoint the real adapter POSTs to (OP-92). */
const NOVU_BASE_URL = "https://api.novu.co";
const NOVU_TRIGGER_URL = `${NOVU_BASE_URL}/v1/events/trigger`;

/** Fields of a stored in-app feed row (schema §19.4). */
interface StoredNotification {
  readonly userId?: unknown;
  readonly typeKey?: unknown;
  readonly readAt?: unknown;
  readonly groupKey?: unknown;
  readonly groupCount?: unknown;
  readonly actionTarget?: {
    readonly kind?: unknown;
    readonly id?: unknown;
    readonly state?: unknown;
  };
  readonly actions?: readonly { readonly key?: unknown; readonly state?: unknown }[];
  readonly title?: unknown;
  readonly body?: unknown;
}

/** Fields of a stored dispatch row (schema §19.5). */
interface StoredDispatch {
  readonly userId?: unknown;
  readonly typeKey?: unknown;
  readonly channel?: unknown;
  readonly channelGroup?: unknown;
  readonly status?: unknown;
  readonly skipReason?: unknown;
  readonly attempts?: unknown;
  readonly lastError?: { readonly retryable?: unknown; readonly status?: unknown };
  readonly dedupeKey?: unknown;
  readonly body?: unknown;
}

/** Fields of a stored outbox row this spec inspects. */
interface StoredEvent {
  readonly dispatch?: { readonly notifications?: unknown };
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

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_notification_fan_out");
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

/** A fresh hex user id (the stored `user._id` / `userId` are ObjectIds). */
function newUserId(): string {
  return new ObjectId().toHexString();
}

/** Per-recipient contact/profile/preference overrides. */
interface RecipientSeed {
  readonly userId: string;
  readonly email?: string | null;
  readonly emailVerified?: boolean;
  readonly phone?: string | null;
  readonly phoneVerified?: boolean;
  readonly whatsappCapable?: boolean | null;
  readonly prefs?: Partial<{
    readonly global: Record<string, string>;
    readonly byType: Record<string, Record<string, string>>;
    readonly byEvent: Record<string, Record<string, string>>;
  }>;
}

/** Insert the `user`, `userProfiles` and `notificationPreferences` trio. */
async function seedRecipient(database: Db, seed: RecipientSeed): Promise<void> {
  const objectId = new ObjectId(seed.userId);
  await database.collection(USER).insertOne({
    _id: objectId,
    email: seed.email ?? `${seed.userId}@example.com`,
    emailVerified: seed.emailVerified ?? true,
    phoneNumber: seed.phone ?? "+919****0000",
    phoneNumberVerified: seed.phoneVerified ?? true,
  });
  await database.collection(COLLECTIONS.userProfiles).insertOne({
    userId: objectId,
    platformRole: "client",
    locale: "en-IN",
    contactCapabilities: {
      whatsappCapable: seed.whatsappCapable ?? null,
      whatsappCheckedAt: null,
    },
  });
  await database.collection(COLLECTIONS.notificationPreferences).insertOne({
    userId: objectId,
    global: { in_app: "on", email: "on", mobile: "on", ...seed.prefs?.global },
    byType: { ...seed.prefs?.byType },
    byEvent: { ...seed.prefs?.byEvent },
    quietHours: { enabled: false, start: "22:00", end: "07:00", timeZone: "Asia/Kolkata" },
    locale: "en-IN",
  });
}

/** Insert a pending outbox row and return its id. */
async function insertEvent(
  database: Db,
  input: {
    readonly eventKey: string;
    readonly tenantId: string;
    readonly actorRef: { readonly kind: string; readonly id: string };
    readonly subjectRef: { readonly kind: string; readonly id: string };
    readonly payload: Record<string, unknown>;
    readonly dedupeKey?: string;
  }
): Promise<ObjectId> {
  const occurredAt = new Date(T0);
  const result = await database.collection(DOMAIN_EVENTS).insertOne({
    eventKey: input.eventKey,
    tenantId: input.tenantId,
    actorRef: input.actorRef,
    subjectRef: input.subjectRef,
    payload: input.payload,
    occurredAt,
    expireAt: new Date(occurredAt.getTime() + 180 * 24 * 60 * 60 * 1000),
    dispatch: { notifications: "pending", analytics: "not_applicable", queue: "not_applicable" },
    ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
  });
  return result.insertedId;
}

/** Wrap a fixed value in a resolved promise (repo methods are async by contract). */
function promised<T>(value: T): () => Promise<T> {
  return () => Promise.resolve(value);
}

/** A deterministic recipient source (the real membership reads are a separate lane). */
function fixedRecipients(overrides: Partial<RecipientRepository> = {}): RecipientRepository {
  return {
    listEventRoleMembers: promised<readonly string[]>([]),
    listIdentifiedAttendeeUserIds: promised<readonly string[]>([]),
    getBillingContactUserId: promised<string | null>(null),
    listPlatformAdminUserIds: promised<readonly string[]>([]),
    ...overrides,
  };
}

/** The fan-out options with the in-memory transport. */
function runOptions(database: Db, transport: MessageTransport, recipients: RecipientRepository) {
  return { db: database, clock, transport, recipients, batch: 10, claimerId: "worker_1" };
}

/** Read every stored feed row. */
async function notificationsOf(database: Db): Promise<readonly StoredNotification[]> {
  return database.collection<StoredNotification>(COLLECTIONS.notifications).find({}).toArray();
}

/** Read every stored dispatch row. */
async function dispatchesOf(database: Db): Promise<readonly StoredDispatch[]> {
  return database.collection<StoredDispatch>(COLLECTIONS.dispatches).find({}).toArray();
}

/** The dispatch rows for one recipient (hex id). */
function dispatchesFor(dispatches: readonly StoredDispatch[], userId: string): StoredDispatch[] {
  return dispatches.filter((dispatch) => String(dispatch.userId) === userId);
}

describe("runNotificationFanOut — collaboration invite (I1)", () => {
  it("collab.invite.sent writes one actionable in-app row and sends email + sms", async () => {
    await withTestDb(async (test) => {
      const tenantId = new ObjectId().toHexString();
      const invitee = newUserId();
      const organizer = newUserId();
      const invitationId = new ObjectId().toHexString();
      await seedRecipient(test.db, { userId: invitee });

      const transport = memoryMessageTransport();
      const eventId = await insertEvent(test.db, {
        eventKey: "collab.invite.sent",
        tenantId,
        actorRef: { kind: "user", id: organizer },
        subjectRef: { kind: "invitation", id: invitationId },
        payload: {
          inviteId: invitationId,
          eventId: new ObjectId().toHexString(),
          eventName: "Rahul & Priya's Wedding",
          actionUrl: "https://app.openpic.in/invitations/abc",
        },
      });

      await runNotificationFanOut(
        runOptions(
          test.db,
          transport,
          fixedRecipients({ listEventRoleMembers: promised([invitee]) })
        )
      );

      const notifications = await notificationsOf(test.db);
      expect(notifications).toHaveLength(1);
      const row = notifications[0];
      expect(String(row?.userId)).toBe(invitee);
      expect(row?.typeKey).toBe("collab.invite.sent");
      expect(row?.readAt ?? null).toBeNull();
      expect(typeof row?.title).toBe("string");
      expect(typeof row?.body).toBe("string");
      expect(row?.actionTarget).toMatchObject({ kind: "invitation", id: invitationId });

      const actionKeys = (row?.actions ?? []).map((action) => action.key);
      expect(actionKeys).toEqual(expect.arrayContaining(["accept", "reject"]));
      expect((row?.actions ?? []).every((action) => action.state === "available")).toBe(true);

      const dispatches = await dispatchesOf(test.db);
      const email = dispatches.find((dispatch) => dispatch.channel === "email");
      const sms = dispatches.find((dispatch) => dispatch.channel === "sms");
      expect(email).toMatchObject({
        typeKey: "collab.invite.sent",
        channelGroup: "email",
        status: "sent",
      });
      expect(sms).toMatchObject({
        typeKey: "collab.invite.sent",
        channelGroup: "mobile",
        status: "sent",
      });
      expect(transport.outbox.map((message) => message.channel)).toEqual(
        expect.arrayContaining(["email", "sms"])
      );

      const storedEvent = await test.db
        .collection<StoredEvent>(DOMAIN_EVENTS)
        .findOne({ _id: eventId });
      expect(storedEvent?.dispatch?.notifications).toBe("done");
    });
  });
});

describe("runNotificationFanOut — preference opt-out (I2)", () => {
  it("skips an opted-out email for a non-transactional type", async () => {
    await withTestDb(async (test) => {
      const tenantId = new ObjectId().toHexString();
      const organizer = newUserId();
      await seedRecipient(test.db, {
        userId: organizer,
        prefs: { byType: { "event.details.updated": { email: "off" } } },
      });

      const transport = memoryMessageTransport();
      await insertEvent(test.db, {
        eventKey: "event.details.updated",
        tenantId,
        actorRef: { kind: "user", id: organizer },
        subjectRef: { kind: "event", id: new ObjectId().toHexString() },
        payload: {
          eventId: new ObjectId().toHexString(),
          actionUrl: "https://app.openpic.in/events/abc",
        },
      });

      await runNotificationFanOut(
        runOptions(
          test.db,
          transport,
          fixedRecipients({ listEventRoleMembers: promised([organizer]) })
        )
      );

      const dispatches = await dispatchesOf(test.db);
      const email = dispatches.find((dispatch) => dispatch.channel === "email");
      expect(email).toMatchObject({
        userId: new ObjectId(organizer),
        typeKey: "event.details.updated",
        status: "skipped",
        skipReason: "user_opt_out",
      });
      expect(transport.outbox.some((message) => message.channel === "email")).toBe(false);
    });
  });
});

describe("runNotificationFanOut — in-app aggregation (I3)", () => {
  it("aggregates two unread match events into one row, then starts a new row after it is read", async () => {
    await withTestDb(async (test) => {
      const tenantId = new ObjectId().toHexString();
      const attendee = newUserId();
      const eventId = new ObjectId().toHexString();
      await seedRecipient(test.db, { userId: attendee });

      const transport = memoryMessageTransport();
      const recipients = fixedRecipients({
        listIdentifiedAttendeeUserIds: promised([attendee]),
      });

      const emit = async (count: number): Promise<void> => {
        await insertEvent(test.db, {
          eventKey: "attendee.matches.new",
          tenantId,
          actorRef: { kind: "system", id: "matcher" },
          subjectRef: { kind: "user", id: attendee },
          payload: { eventId, count },
        });
        await runNotificationFanOut(runOptions(test.db, transport, recipients));
      };

      await emit(3);
      await emit(5);

      let matches = (await notificationsOf(test.db)).filter(
        (row) => row.typeKey === "attendee.matches.new"
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.groupCount).toBe(8);
      expect(String(matches[0]?.groupKey)).toBe(eventId);
      expect(matches[0]?.readAt ?? null).toBeNull();

      // The attendee reads the row; the next arrival must start a fresh counter.
      await test.db
        .collection(COLLECTIONS.notifications)
        .updateOne({ typeKey: "attendee.matches.new" }, { $set: { readAt: new Date(T0) } });

      await emit(2);

      matches = (await notificationsOf(test.db)).filter(
        (row) => row.typeKey === "attendee.matches.new"
      );
      expect(matches).toHaveLength(2);
      const unread = matches.find((row) => (row.readAt ?? null) === null);
      expect(unread?.groupCount).toBe(2);
    });
  });
});

describe("runNotificationFanOut — dedupe (I4)", () => {
  it("skips the second dispatch when the same interpolated dedupeKey is emitted twice", async () => {
    await withTestDb(async (test) => {
      const tenantId = new ObjectId().toHexString();
      const user = newUserId();
      await seedRecipient(test.db, { userId: user });

      const transport = memoryMessageTransport();
      const recipients = fixedRecipients();

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await insertEvent(test.db, {
          eventKey: "auth.signin.new_device",
          tenantId,
          actorRef: { kind: "system", id: "auth" },
          subjectRef: { kind: "user", id: user },
          payload: { deviceId: "device_1", actionUrl: "https://app.openpic.in/sessions" },
        });
        await runNotificationFanOut(runOptions(test.db, transport, recipients));
      }

      const emails = transport.outbox.filter((message) => message.channel === "email");
      expect(emails).toHaveLength(1);

      const emailDispatches = (await dispatchesOf(test.db)).filter(
        (dispatch) => dispatch.typeKey === "auth.signin.new_device" && dispatch.channel === "email"
      );
      expect(emailDispatches).toHaveLength(2);
      expect(emailDispatches.filter((dispatch) => dispatch.status === "sent")).toHaveLength(1);
      expect(emailDispatches.filter((dispatch) => dispatch.skipReason === "deduped")).toHaveLength(
        1
      );
    });
  });
});

describe("runNotificationFanOut — transport failure isolation (I5)", () => {
  it("records a retryable failure for one recipient and still processes the next", async () => {
    await withTestDb(async (test) => {
      const tenantId = new ObjectId().toHexString();
      const failing = newUserId();
      const healthy = newUserId();
      await seedRecipient(test.db, { userId: failing, email: `failing-${failing}@example.com` });
      await seedRecipient(test.db, { userId: healthy, email: `healthy-${healthy}@example.com` });

      const failingEmail = `failing-${failing}@example.com`;

      server.use(
        http.post(NOVU_TRIGGER_URL, async ({ request }) => {
          const body = (await request.json()) as { to?: { email?: string } };
          if (body.to?.email === failingEmail) {
            return new HttpResponse(null, { status: 503 });
          }
          return HttpResponse.json(makeNovuTriggerResponse({ transactionId: "txn-ok" }));
        })
      );

      const transport = novuTransport({
        baseUrl: NOVU_BASE_URL,
        apiKey: "test-key",
        timeoutMs: 2_000,
      });
      const eventId = await insertEvent(test.db, {
        eventKey: "event.details.updated",
        tenantId,
        actorRef: { kind: "user", id: healthy },
        subjectRef: { kind: "event", id: new ObjectId().toHexString() },
        payload: {
          eventId: new ObjectId().toHexString(),
          actionUrl: "https://app.openpic.in/events/abc",
        },
      });

      await runNotificationFanOut(
        runOptions(
          test.db,
          transport,
          fixedRecipients({ listEventRoleMembers: promised([failing, healthy]) })
        )
      );

      const dispatches = await dispatchesOf(test.db);
      const failedEmail = dispatchesFor(dispatches, failing).find(
        (dispatch) => dispatch.channel === "email"
      );
      expect(failedEmail).toMatchObject({
        status: "failed",
        attempts: 1,
      });
      expect(failedEmail?.lastError).toMatchObject({ retryable: true, status: 503 });

      const healthyEmail = dispatchesFor(dispatches, healthy).find(
        (dispatch) => dispatch.channel === "email"
      );
      expect(healthyEmail?.status).toBe("sent");

      // A retryable failure must leave the event claimable for the retry sweep.
      const storedEvent = await test.db
        .collection<StoredEvent>(DOMAIN_EVENTS)
        .findOne({ _id: eventId });
      expect(storedEvent?.dispatch?.notifications).toBe("pending");
    });
  });
});

describe("runNotificationFanOut — secret types (I6)", () => {
  it("sends an otp email but stores no rendered body", async () => {
    await withTestDb(async (test) => {
      const tenantId = new ObjectId().toHexString();
      const requester = newUserId();
      await seedRecipient(test.db, { userId: requester });

      const sentinel = "sentinel-otp-6f4a";
      const transport = memoryMessageTransport();
      await insertEvent(test.db, {
        eventKey: "auth.otp.email.requested",
        tenantId,
        actorRef: { kind: "system", id: "auth" },
        subjectRef: { kind: "user", id: requester },
        payload: { actionUrl: `https://app.openpic.in/otp/${sentinel}` },
      });

      await runNotificationFanOut(runOptions(test.db, transport, fixedRecipients()));

      // Rule 6: an OTP never enters the durable in-app feed.
      const notifications = await notificationsOf(test.db);
      expect(notifications).toHaveLength(0);

      // It is sent...
      const emails = transport.outbox.filter((message) => message.channel === "email");
      expect(emails).toHaveLength(1);
      expect(JSON.stringify(emails[0])).toContain(sentinel);

      // ...but retainBody:false means the rendered copy is not persisted.
      const emailDispatch = (await dispatchesOf(test.db)).find(
        (dispatch) => dispatch.channel === "email"
      );
      expect(emailDispatch?.status).toBe("sent");
      expect(JSON.stringify(emailDispatch)).not.toContain(sentinel);
    });
  });
});

describe("runNotificationFanOut — billing audience guard (I7)", () => {
  it("sends a billing type to the billing contact and never to a co-organizer", async () => {
    await withTestDb(async (test) => {
      const tenantId = new ObjectId().toHexString();
      const billing = newUserId();
      const coOrganizer = newUserId();
      await seedRecipient(test.db, { userId: billing });
      await seedRecipient(test.db, { userId: coOrganizer });

      const transport = memoryMessageTransport();
      await insertEvent(test.db, {
        eventKey: "billing.payment.failed",
        tenantId,
        actorRef: { kind: "system", id: "billing" },
        subjectRef: { kind: "subscription", id: new ObjectId().toHexString() },
        payload: {
          eventId: new ObjectId().toHexString(),
          actionUrl: "https://app.openpic.in/billing",
        },
      });

      await runNotificationFanOut(
        runOptions(
          test.db,
          transport,
          fixedRecipients({
            getBillingContactUserId: promised(billing),
            listEventRoleMembers: promised([coOrganizer]),
          })
        )
      );

      const notifications = await notificationsOf(test.db);
      const dispatches = await dispatchesOf(test.db);

      expect(dispatchesFor(dispatches, billing).length).toBeGreaterThan(0);
      expect(dispatchesFor(dispatches, coOrganizer)).toHaveLength(0);
      expect(notifications.some((row) => String(row.userId) === coOrganizer)).toBe(false);
      expect(notifications.some((row) => String(row.userId) === billing)).toBe(true);
    });
  });
});

describe("runNotificationFanOut — matches once per batch (I8)", () => {
  it("sends one sms across two match batches while the in-app row still aggregates", async () => {
    await withTestDb(async (test) => {
      const tenantId = new ObjectId().toHexString();
      const attendee = newUserId();
      const eventId = new ObjectId().toHexString();
      await seedRecipient(test.db, { userId: attendee });

      const transport = memoryMessageTransport();
      const recipients = fixedRecipients({
        listIdentifiedAttendeeUserIds: promised([attendee]),
      });

      const runBatch = async (newMatches: number): Promise<void> => {
        await insertEvent(test.db, {
          eventKey: "attendee.matches.ready",
          tenantId,
          actorRef: { kind: "system", id: "matcher" },
          subjectRef: { kind: "user", id: attendee },
          payload: { eventId, profileId: "profile_1", actionUrl: "https://app.openpic.in/matches" },
        });
        await insertEvent(test.db, {
          eventKey: "attendee.matches.new",
          tenantId,
          actorRef: { kind: "system", id: "matcher" },
          subjectRef: { kind: "user", id: attendee },
          payload: { eventId, count: newMatches },
        });
        await runNotificationFanOut(runOptions(test.db, transport, recipients));
      };

      await runBatch(2);
      await runBatch(3);

      const sms = transport.outbox.filter((message) => message.channel === "sms");
      expect(sms).toHaveLength(1);

      const smsDispatches = (await dispatchesOf(test.db)).filter(
        (dispatch) => dispatch.typeKey === "attendee.matches.ready" && dispatch.channel === "sms"
      );
      expect(smsDispatches.filter((dispatch) => dispatch.status === "sent")).toHaveLength(1);
      expect(smsDispatches.filter((dispatch) => dispatch.skipReason === "deduped")).toHaveLength(1);

      const matchRows = (await notificationsOf(test.db)).filter(
        (row) => row.typeKey === "attendee.matches.new"
      );
      expect(matchRows).toHaveLength(1);
      expect(matchRows[0]?.groupCount).toBe(5);
    });
  });
});
