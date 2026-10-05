import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeMongoClient } from "@/server/db/mongo";
import {
  getPlatformSettings,
  invalidatePlatformSettings,
  PLATFORM_SETTINGS_DEFAULTS,
  seedPlatformSettings,
} from "@/server/settings/platform-settings";

import {
  MONGO_READY_HOOK_TIMEOUT_MS,
  createTestDb,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";

/**
 * Integration contract — the `platformSettings` singleton against a real
 * MongoDB (OP-82, schema §20.4 / contract §9.10, Appendix F "Seed
 * `platformSettings` singleton").
 *
 * The singleton is written once and read everywhere, so two properties matter
 * at the database boundary and can only be proven there:
 *
 *   1. seeding is idempotent and create-only — running it twice must leave a
 *      single document and must never reset an operator's tuned values;
 *   2. the read path is cached, and `invalidatePlatformSettings()` is the
 *      single sanctioned way to make the very next read observe a change.
 *
 *   seedPlatformSettings({ db?, clock?, updatedByUserId? }): Promise<PlatformSettings>
 *   getPlatformSettings({ db?, clock?, ttlMs? }): Promise<PlatformSettings>
 *   invalidatePlatformSettings(): void
 */

beforeAll(async () => {
  await setupMongoTestEnv();
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await closeMongoClient();
});

beforeEach(() => {
  invalidatePlatformSettings();
});

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_platform_settings");
  try {
    await fn(test);
  } finally {
    await test.cleanup();
  }
}

/** The stored singleton, narrowed to the fields these specs inspect. */
interface StoredSettings {
  readonly _id: string;
  readonly dunning: { readonly gracePeriodDays: number };
  readonly notifications: { readonly pollIntervalSeconds: number };
}

/** Open the singleton collection with its string `_id` typed. */
function settingsCollection(test: TestDb) {
  return test.db.collection<StoredSettings>("platformSettings");
}

describe("seedPlatformSettings idempotency", () => {
  it("I1: a first seed writes exactly one singleton carrying the documented defaults", async () => {
    await withTestDb(async (test) => {
      const seeded = await seedPlatformSettings({ db: test.db });

      expect(seeded._id).toBe("singleton");
      expect(seeded.dunning).toEqual(PLATFORM_SETTINGS_DEFAULTS.dunning);
      expect(seeded.notifications).toEqual(PLATFORM_SETTINGS_DEFAULTS.notifications);

      const raw = settingsCollection(test);
      expect(await raw.countDocuments({})).toBe(1);
      const stored = await raw.findOne({ _id: "singleton" });
      expect(stored?.dunning.gracePeriodDays).toBe(
        PLATFORM_SETTINGS_DEFAULTS.dunning.gracePeriodDays
      );
    });
  });

  it("I1: seeding twice leaves one document and does not overwrite an operator's values", async () => {
    await withTestDb(async (test) => {
      await seedPlatformSettings({ db: test.db });
      await seedPlatformSettings({ db: test.db });

      const raw = settingsCollection(test);
      expect(await raw.countDocuments({})).toBe(1);

      // An operator tunes a value, then the seeder runs again (cron / deploy).
      await raw.updateOne({ _id: "singleton" }, { $set: { "dunning.gracePeriodDays": 30 } });
      await seedPlatformSettings({ db: test.db });

      const stored = await raw.findOne({ _id: "singleton" });
      expect(await raw.countDocuments({})).toBe(1);
      expect(stored?._id).toBe("singleton");
      expect(stored?.dunning.gracePeriodDays).toBe(30);
    });
  });
});

describe("getPlatformSettings reflects the stored singleton", () => {
  it("I2: a read after invalidate observes a database change", async () => {
    await withTestDb(async (test) => {
      await seedPlatformSettings({ db: test.db });

      const before = await getPlatformSettings({ db: test.db });
      expect(before.notifications.pollIntervalSeconds).toBe(
        PLATFORM_SETTINGS_DEFAULTS.notifications.pollIntervalSeconds
      );

      await settingsCollection(test).updateOne(
        { _id: "singleton" },
        { $set: { "notifications.pollIntervalSeconds": 60 } }
      );

      // The cache still answers within its TTL…
      const cached = await getPlatformSettings({ db: test.db });
      expect(cached.notifications.pollIntervalSeconds).toBe(
        PLATFORM_SETTINGS_DEFAULTS.notifications.pollIntervalSeconds
      );

      // …until the sanctioned invalidation makes the next read hit the database.
      invalidatePlatformSettings();
      const reloaded = await getPlatformSettings({ db: test.db });
      expect(reloaded.notifications.pollIntervalSeconds).toBe(60);
    });
  });
});
