import { ObjectId, type Db } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TransportError } from "@/server/adapters/transport-error";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { closeMongoClient } from "@/server/db/mongo";
import { retryDueDispatches } from "@/server/notifications/dispatch-retry";
import { sendTransactionalNow } from "@/server/notifications/fan-out";
import type {
  MessageTransport,
  OutboundMessage,
  TransportReceipt,
} from "@/server/notifications/message-transport";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import { SEED_NOTIFICATION_TEMPLATES } from "@/server/notifications/notification-templates.values";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";
import { invalidatePlatformSettings } from "@/server/settings/platform-settings";
import { fixedClock } from "@/server/runtime/clock";

import {
  createTestDb,
  MONGO_READY_HOOK_TIMEOUT_MS,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";

/**
 * Integration / contract — a body-less dispatch is never re-sent empty
 * (OP-96 follow-up RED, review finding F4, ADR-0128 §3).
 *
 * The defect: `buildRedeliveryMessage` maps `body: null` to `""`. `fan-out.ts`
 * persists `body: null` for a `retainBody:false` type (the one-time code must
 * never reach the durable ledger), and the only seeded one is
 * `auth.otp.email.requested` — so the `notification-dispatch-retry` sweep
 * re-sends a retryable OTP failure as a **subject-only email with an empty
 * body**.
 *
 * The pinned outcome: after a retryable OTP failure the retry sweep must not
 * deliver an empty-body message. The row reaches a terminal, distinct
 * non-retryable classification (it leaves the sweep forever, mirroring the
 * `no_destination` classification in `dispatch-redelivery.ts`).
 *
 * Runs against a real `MongoMemoryReplSet` and the real seed catalogue, driven
 * through the real synchronous transactional sender + the real retry job.
 */

/** The `notification_dispatches` collection (schema §12). */
const DISPATCHES = COLLECTIONS.dispatches;
/** The Better Auth user collection (schema §13.1). */
const USER = "user";

/** The only seeded `retainBody:false` type (schema §4.1). */
const TYPE_KEY = "auth.otp.email.requested";

/** A fixed instant so every stored timestamp is exact. */
const T0 = "2026-03-01T10:00:00.000Z";

/** Fields of a stored dispatch row this spec inspects (schema §19.5). */
interface StoredDispatch {
  readonly userId?: unknown;
  readonly typeKey?: unknown;
  readonly channel?: unknown;
  readonly status?: unknown;
  readonly attempts?: unknown;
  readonly body?: unknown;
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
  invalidatePlatformSettings();
});

afterEach(() => {
  invalidatePlatformSettings();
});

/** Build a transport that rejects the first `failures` sends retryably. */
function scriptedTransport(failures: number): ScriptedTransport {
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
            retryable: true,
            code: "http",
            status: 503,
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
  const test = createTestDb("openpic_notification_redelivery_body");
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

/** Seed a verified account holder; returns its hex id and email. */
async function seedAccount(
  database: Db
): Promise<{ readonly userId: string; readonly email: string }> {
  const userId = new ObjectId();
  const email = `${userId.toHexString()}@example.com`;
  await database.collection(USER).insertOne({
    _id: userId,
    email,
    emailVerified: true,
    phoneNumber: null,
    phoneNumberVerified: false,
  });
  await database.collection(COLLECTIONS.userProfiles).insertOne({
    userId,
    platformRole: "client",
    locale: "en-IN",
    contactCapabilities: { whatsappCapable: null, whatsappCheckedAt: null },
  });
  return { userId: userId.toHexString(), email };
}

/** The one stored dispatch row for the OTP type. */
async function otpDispatch(database: Db): Promise<StoredDispatch | undefined> {
  const rows = await database
    .collection<StoredDispatch>(DISPATCHES)
    .find({ typeKey: TYPE_KEY })
    .toArray();
  return rows[0];
}

describe("a retried body-less dispatch is never sent empty (F4)", () => {
  it("F4: a retryable OTP failure is not re-sent as an empty-body email", async () => {
    await withTestDb(async (test) => {
      const { userId, email } = await seedAccount(test.db);

      // The transport fails the first (synchronous) OTP send, then would succeed.
      const transport = scriptedTransport(1);

      await expect(
        sendTransactionalNow({
          db: test.db,
          clock: fixedClock(T0),
          transport,
          typeKey: TYPE_KEY,
          channel: "email",
          destination: email,
          payload: { code: "123456", actionUrl: "https://app.openpic.in/otp" },
          userId,
        })
      ).rejects.toBeInstanceOf(TransportError);

      // A retryable failure is recorded with no retained body.
      const failed = await otpDispatch(test.db);
      expect(failed).toMatchObject({
        typeKey: TYPE_KEY,
        channel: "email",
        status: "failed",
        attempts: 1,
        body: null,
      });
      expect(failed?.lastError).toMatchObject({ retryable: true, status: 503 });
      expect(transport.calls).toBe(1);
      expect(transport.outbox).toHaveLength(0);

      // The retry sweep must not deliver a subject-only / empty-body message.
      const retry = await retryDueDispatches({
        db: test.db,
        clock: fixedClock("2026-03-01T10:02:00.000Z"),
        transport,
        limit: 100,
      });

      expect(retry.affected).toBe(0);
      expect(transport.calls).toBe(1);
      expect(transport.outbox).toHaveLength(0);

      const emptyBodyEmails = transport.outbox.filter(
        (message) =>
          message.channel === "email" && (message.text ?? "") === "" && (message.html ?? "") === ""
      );
      expect(emptyBodyEmails).toHaveLength(0);

      // The row reached a terminal, non-retryable classification.
      const terminal = await otpDispatch(test.db);
      expect(terminal?.status).toBe("failed");
      expect(terminal?.lastError).toMatchObject({ retryable: false });

      // A following tick still leaves it alone.
      const nextTick = await retryDueDispatches({
        db: test.db,
        clock: fixedClock("2026-03-01T10:10:00.000Z"),
        transport,
        limit: 100,
      });
      expect(nextTick.affected).toBe(0);
      expect(transport.calls).toBe(1);
      expect(transport.outbox).toHaveLength(0);
    });
  });
});
