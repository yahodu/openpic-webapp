import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { NotificationSeverity } from "@/server/notifications/notification-types";
import type { NotificationType } from "@/server/notifications/notification-types";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";
import { SEED_NOTIFICATION_TEMPLATES } from "@/server/notifications/notification-templates.values";
import {
  seedNotificationTemplates,
  seedNotificationTypes,
} from "@/server/notifications/seed-notification-types";

import { makeEnv, toProcessEnv } from "../factories/env";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * Integration contract — the notification routing seed against a real MongoDB
 * (schema §19.1–§19.2, contract §7.6).
 *
 * Two properties can only be proven at the database boundary:
 *
 *   1. seeding is idempotent — a deploy/cron re-run leaves exactly the 81
 *      contract types and one template per `(typeKey, channel, locale)`;
 *   2. seeding reconciles routing **without spurious version churn** — a changed
 *      type bumps `version` exactly once, and a re-run that changes nothing
 *      leaves every `version` untouched. `version` is what an audit trail reads
 *      to answer "why did this notification route differently?", so an extra
 *      bump would falsely imply the matrix changed.
 *
 * Contract expected of the implementation:
 *
 *   seedNotificationTypes({ db?, types?, clock? }): Promise<readonly NotificationType[]>
 *   seedNotificationTemplates({ db?, templates?, clock? }): Promise<readonly NotificationTemplate[]>
 *     `types` / `templates` default to the seeded constants; the spec injects a
 *     mutated set to simulate a matrix change shipped in a deploy.
 */

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
  const { closeMongoClient } = await import("@/server/db/mongo");
  await closeMongoClient();
});

/** The stored type document, narrowed to the fields these specs inspect. */
interface StoredType {
  readonly typeKey: string;
  readonly severity: string;
  readonly version: number;
}

/** The stored template document, narrowed to the fields these specs inspect. */
interface StoredTemplate {
  readonly typeKey: string;
  readonly channel: string;
  readonly locale: string;
  readonly version: number;
}

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_notification_seed");
  try {
    await fn(test);
  } finally {
    await test.cleanup();
  }
}

/** Every stored type as `[typeKey, version]` pairs, sorted for a stable comparison. */
async function typeVersionsByKey(test: TestDb): Promise<Array<[string, number]>> {
  const rows = await test.db.collection<StoredType>("notification_types").find({}).toArray();
  return rows
    .map((row): [string, number] => [row.typeKey, row.version])
    .sort((left, right) => left[0].localeCompare(right[0]));
}

/**
 * The canonical catalogue with `attendee.matches.ready`'s severity flipped to a
 * value that provably differs from the current one — the shape of a matrix edit
 * shipped in a deploy.
 */
function withChangedMatchesSeverity(): {
  readonly types: readonly NotificationType[];
  readonly changedSeverity: NotificationSeverity;
} {
  const ready = SEED_NOTIFICATION_TYPES.find((type) => type.typeKey === "attendee.matches.ready");
  if (ready === undefined) {
    throw new Error("SEED_NOTIFICATION_TYPES has no attendee.matches.ready");
  }

  const changedSeverity: NotificationSeverity =
    ready.severity === "critical" ? "informational" : "critical";

  const types = SEED_NOTIFICATION_TYPES.map((type) =>
    type.typeKey === ready.typeKey ? { ...type, severity: changedSeverity } : type
  );

  return { types, changedSeverity };
}

describe("seedNotificationTypes idempotency", () => {
  it("I1: seeding twice leaves exactly the 81 contract types, one document per key", async () => {
    await withTestDb(async (test) => {
      await seedNotificationTypes({ db: test.db });
      await seedNotificationTypes({ db: test.db });

      const rows = await test.db.collection<StoredType>("notification_types").find({}).toArray();

      expect(rows).toHaveLength(81);
      expect(rows.map((row) => row.typeKey).sort()).toEqual(
        SEED_NOTIFICATION_TYPES.map((type) => type.typeKey).sort()
      );
    });
  });

  it("I1: a re-run with an unchanged matrix leaves every version untouched", async () => {
    await withTestDb(async (test) => {
      await seedNotificationTypes({ db: test.db });
      const before = await typeVersionsByKey(test);

      await seedNotificationTypes({ db: test.db });

      expect(await typeVersionsByKey(test)).toEqual(before);
    });
  });

  it("I1: a changed type bumps its version exactly once across re-runs", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection<StoredType>("notification_types");

      await seedNotificationTypes({ db: test.db });
      const before = await raw.findOne({ typeKey: "attendee.matches.ready" });
      expect(before).not.toBeNull();

      const { types, changedSeverity } = withChangedMatchesSeverity();

      // Guard against a vacuous fixture: the injected severity must differ from
      // the seeded one, or the version-bump assertion below proves nothing.
      expect(changedSeverity).not.toBe(before?.severity);

      await seedNotificationTypes({ db: test.db, types });
      const afterFirst = await raw.findOne({ typeKey: "attendee.matches.ready" });

      expect(afterFirst?.version).toBe((before?.version ?? 0) + 1);
      expect(afterFirst?.severity).toBe(changedSeverity);

      await seedNotificationTypes({ db: test.db, types });
      const afterSecond = await raw.findOne({ typeKey: "attendee.matches.ready" });

      expect(afterSecond?.version).toBe(afterFirst?.version);
    });
  });
});

describe("seedNotificationTemplates idempotency", () => {
  it("I1: seeding twice leaves one template per (typeKey, channel, locale) with stable versions", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection<StoredTemplate>("notification_templates");

      await seedNotificationTemplates({ db: test.db });
      const before = (await raw.find({}).toArray())
        .map((row): [string, string, string, number] => [
          row.typeKey,
          row.channel,
          row.locale,
          row.version,
        ])
        .sort();

      await seedNotificationTemplates({ db: test.db });
      const after = (await raw.find({}).toArray())
        .map((row): [string, string, string, number] => [
          row.typeKey,
          row.channel,
          row.locale,
          row.version,
        ])
        .sort();

      expect(after).toHaveLength(SEED_NOTIFICATION_TEMPLATES.length);
      expect(after).toEqual(before);

      for (const row of await raw.find({}).toArray()) {
        expect(row.locale).toBe("en-IN");
      }
    });
  });
});
