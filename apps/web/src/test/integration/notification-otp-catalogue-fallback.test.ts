import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryMessageTransport } from "@/server/adapters/memory-message-transport";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { closeMongoClient } from "@/server/db/mongo";
import { createLogger, getLogger, memoryTransport, setLogger } from "@/server/logging";
import { sendTransactionalNow } from "@/server/notifications/fan-out";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";

import { MONGO_READY_HOOK_TIMEOUT_MS, createTestDb, setupMongoTestEnv } from "../helpers/db";

/**
 * Integration / contract — the seed-catalogue fallback guard (OP-95 follow-up
 * RED, finding F2; ADR-0102).
 *
 * `sendTransactionalNow` does `storedType ?? seededTypeRow(...)`: when the
 * stored `notificationTypes` catalogue has no row for the requested `typeKey`
 * (absent **or** schema-invalid, both of which `loadTypeRow` maps to `null`),
 * the compile-time seed silently serves the message — in **every**
 * environment, including production, with no log. The seed fallback itself is
 * the sanctioned E1 resolution (ADR-0098 §6) and must stay; what must change is
 * that it is never *silent*.
 *
 * ## Settled behaviour (so the pin is decidable)
 *
 *   - **production** — an empty/invalid catalogue must NOT silently fall back:
 *     the call rejects before inserting a dispatch row or handing a message to
 *     the transport.
 *   - **non-production** (test/e2e/development/staging) — the fallback keeps
 *     working, but records a `warn`-level log with
 *     `event: "notification.catalogue_fallback"` carrying the `typeKey`, so an
 *     operator can see the seed served a production-of-record miss.
 *
 * ## Contract expected of the implementation
 *
 *   - The environment is consulted **at call time** through the existing
 *     uncached reader `getAppEnv()` (`@/server/config/env`), not the memoised
 *     `getConfig()`. A hard guard must reflect the process env when the send
 *     happens, and the cache would otherwise pin the boot-time answer.
 *   - The guard covers the type-row fallback
 *     (`storedType ?? seededTypeRow(input.typeKey)`); the template fallback
 *     (`seededTemplates`) follows the same decision.
 *
 * ## Assumptions
 *
 *   - The F2b spec asserts the fallback still delivers with the seed copy; it
 *     does not re-assert the rendered copy shape (owned by the F1 pins).
 *   - The catalogue is left deliberately empty, so the stored lookup returns
 *     `null`; a schema-invalid row takes the same `loadTypeRow → null` path and
 *     is not separately seeded here.
 */

/** A production-valid environment, so a guard failure cannot be confused with
 * a `ConfigError` from an invalid production config. */
function stubProductionEnv(): void {
  vi.stubEnv("APP_ENV", "production");
  // Providers that are legal in production (no `memory`), per the env factory.
  vi.stubEnv("RATE_LIMIT_PROVIDER", "redis");
  vi.stubEnv("STORAGE_PROVIDER", "s3");
  vi.stubEnv("QUEUE_PROVIDER", "mongo");
  vi.stubEnv("PAYMENT_PROVIDER", "stripe");
  vi.stubEnv("MESSAGE_TRANSPORT", "ses");
  vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "x-real-ip");
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sendTransactionalNow — seed-catalogue fallback guard (F2)", () => {
  it("F2: production refuses to serve the seed catalogue when no type row is stored", async () => {
    const transport = memoryMessageTransport();
    const test = createTestDb("openpic_notification_catalogue_prod");
    try {
      await ensureIndexes(test.db);
      // The catalogue is deliberately NOT seeded.
      stubProductionEnv();

      await expect(
        sendTransactionalNow({
          db: test.db,
          transport,
          typeKey: "auth.otp.email.requested",
          channel: "email",
          destination: "catalogue-prod@example.com",
          payload: { code: "123456" },
          userId: new ObjectId().toHexString(),
        })
      ).rejects.toThrow();

      // Nothing was delivered and no ledger row was written for the phantom send.
      expect(transport.outbox).toHaveLength(0);
      const dispatches = await test.db.collection(COLLECTIONS.dispatches).countDocuments({});
      expect(dispatches).toBe(0);
    } finally {
      await test.cleanup();
    }
  });

  /**
   * F2c (OP-95 follow-up coverage pin, ADR-0104) — the *template-group*
   * production guard. F2 leaves the catalogue fully empty, so the type-row
   * guard (`COLLECTIONS.notificationTypes`) throws first and the template guard
   * (`COLLECTIONS.notificationTemplates`) is never reached. This spec stores a
   * schema-valid `notificationTypes` row — so the type-row guard is skipped —
   * but stores **no** `notificationTemplates` row for the resolved
   * `channelGroup`, isolating the second guard site.
   *
   * Settled behaviour (ADR-0103 F2): production rejects before the dispatch
   * insert and before any transport hand-off — no orphan ledger row, no phantom
   * send.
   */
  it("F2c: production refuses the seeded template group when the type row is stored but its template group is not", async () => {
    const transport = memoryMessageTransport();
    const test = createTestDb("openpic_notification_catalogue_prod_templates");
    try {
      await ensureIndexes(test.db);

      // A schema-valid type row is stored, so the type-row guard is skipped and
      // the template-group guard is the branch actually exercised.
      const storedType = SEED_NOTIFICATION_TYPES.find(
        (type) => type.typeKey === "auth.otp.email.requested"
      );
      if (storedType === undefined) {
        throw new Error("seed is missing auth.otp.email.requested");
      }
      await test.db.collection(COLLECTIONS.notificationTypes).insertOne({ ...storedType });

      // `notificationTemplates` is deliberately left empty; APP_ENV is
      // `production`.
      stubProductionEnv();

      await expect(
        sendTransactionalNow({
          db: test.db,
          transport,
          typeKey: "auth.otp.email.requested",
          channel: "email",
          destination: "catalogue-prod-templates@example.com",
          payload: { code: "123456" },
          userId: new ObjectId().toHexString(),
        })
      ).rejects.toThrow();

      // The rejection is pre-insert and pre-hand-off: nothing delivered, no row.
      expect(transport.outbox).toHaveLength(0);
      const dispatches = await test.db.collection(COLLECTIONS.dispatches).countDocuments({});
      expect(dispatches).toBe(0);
    } finally {
      await test.cleanup();
    }
  });

  it("F2b: outside production the seed fallback still delivers but records a warn-level log", async () => {
    const transport = memoryMessageTransport();
    const previousLogger = getLogger();
    const sink = memoryTransport();
    setLogger(
      createLogger({
        level: "debug",
        transports: [sink],
        service: "openpic-web",
        env: "test",
        version: "test-sha",
      })
    );

    const test = createTestDb("openpic_notification_catalogue_test");
    try {
      await ensureIndexes(test.db);
      // The catalogue is deliberately NOT seeded; APP_ENV is `test`.

      const result = await sendTransactionalNow({
        db: test.db,
        transport,
        typeKey: "auth.otp.email.requested",
        channel: "email",
        destination: "catalogue-test@example.com",
        payload: { code: "123456" },
        userId: null,
      });

      // The fallback keeps working (E1/I1/I2 stay green)...
      expect(result.status).toBe("sent");
      expect(transport.outbox).toHaveLength(1);
      const dispatches = await test.db
        .collection(COLLECTIONS.dispatches)
        .find({ typeKey: "auth.otp.email.requested" })
        .toArray();
      expect(dispatches).toHaveLength(1);

      // ...but it is never silent: a warn-level fallback line is recorded.
      const warn = sink.entries.find(
        (entry) => entry.level === "warn" && entry.event === "notification.catalogue_fallback"
      );
      expect(warn, "the seed fallback must be recorded at warn level").toBeDefined();
      expect(warn).toMatchObject({ typeKey: "auth.otp.email.requested" });
    } finally {
      setLogger(previousLogger);
      await test.cleanup();
    }
  });
});
