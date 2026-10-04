import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixedClock } from "@/server/runtime/clock";

import {
  checkSettingBound,
  getPlatformSettings,
  invalidatePlatformSettings,
  PLATFORM_SETTINGS_DEFAULTS,
  SETTING_BOUNDS,
  validateReminderDays,
  type PlatformSettings,
} from "@/server/settings/platform-settings";

import { makeFakeMongo } from "../../test/helpers/fake-mongo";

/**
 * Unit contract — the `platformSettings` singleton tunables (OP-82, schema
 * §20.4 / contract §9.10).
 *
 * `platformSettings` is the home of every runtime knob: the acceptance rule is
 * "no hard-coded tunables", so the values an operator can change without a
 * deploy are validated here, and a failed validation names the offending key
 * together with the legal range (`{ key, min, max }`, the `422
 * setting_out_of_range` details in Appendix A.2).
 *
 * These specs pin, at the smallest observable surface:
 *
 *   SETTING_BOUNDS: SettingBound[]
 *     where SettingBound = { key: string; min: number; max: number }
 *   checkSettingBound(key, value): SettingOutOfRange | null
 *     where SettingOutOfRange = { key: string; min: number; max: number }
 *   validateReminderDays(reminderDays, gracePeriodDays): ReminderDaysViolation[]
 *     where ReminderDaysViolation =
 *       { key: "dunning.reminderDays"; index: number; day: number;
 *         problem: "not_strictly_increasing" | "not_before_grace" }
 *   getPlatformSettings({ db?, clock?, ttlMs? }): Promise<PlatformSettings>
 *   invalidatePlatformSettings(): void
 *
 * The cache reads the injected `clock` exactly once per call, so the TTL is
 * deterministic under `fixedClock(start, stepMs)`.
 */
describe("platform settings numeric guards", () => {
  it("U1: exposes a guard for every bounded scalar tunable in the contract", () => {
    expect(SETTING_BOUNDS.map((bound) => bound.key).sort()).toEqual(
      [
        "dunning.gracePeriodDays",
        "notifications.pollIntervalSeconds",
        "pipeline.leaseMinutes",
      ].sort()
    );
  });

  it.each(SETTING_BOUNDS)(
    "U1: rejects $key below its minimum with the guard's key/min/max",
    (bound) => {
      expect(checkSettingBound(bound.key, Number(bound.min) - 1)).toEqual({
        key: bound.key,
        min: bound.min,
        max: bound.max,
      });
    }
  );

  it.each(SETTING_BOUNDS)(
    "U1: rejects $key above its maximum with the guard's key/min/max",
    (bound) => {
      expect(checkSettingBound(bound.key, Number(bound.max) + 1)).toEqual({
        key: bound.key,
        min: bound.min,
        max: bound.max,
      });
    }
  );

  it.each(SETTING_BOUNDS)("U1: accepts $key at its inclusive bounds", (bound) => {
    expect(checkSettingBound(bound.key, bound.min)).toBeNull();
    expect(checkSettingBound(bound.key, bound.max)).toBeNull();
  });
});

describe("platform settings reminderDays guard", () => {
  it("U2: rejects a duplicated reminder day as not strictly increasing", () => {
    expect(validateReminderDays([1, 5, 5], 14)).toEqual([
      { key: "dunning.reminderDays", index: 2, day: 5, problem: "not_strictly_increasing" },
    ]);
  });

  it("U2: rejects a reminder day that is not before the grace period", () => {
    expect(validateReminderDays([1, 5, 20], 14)).toEqual([
      { key: "dunning.reminderDays", index: 2, day: 20, problem: "not_before_grace" },
    ]);
  });

  it("U2: rejects a reminder day equal to the grace period (strictly before is required)", () => {
    expect(validateReminderDays([1, 5, 14], 14)).toEqual([
      { key: "dunning.reminderDays", index: 2, day: 14, problem: "not_before_grace" },
    ]);
  });

  it("U2: accepts the documented default schedule when the grace period is 14", () => {
    expect(validateReminderDays([1, 5, 7, 11, 13], 14)).toEqual([]);
  });
});

/** Build a stored singleton document whose only varied tunable is a grace period. */
function storedSettings(gracePeriodDays: number, updatedAt: string): PlatformSettings {
  return {
    _id: "singleton",
    ...PLATFORM_SETTINGS_DEFAULTS,
    dunning: { ...PLATFORM_SETTINGS_DEFAULTS.dunning, gracePeriodDays },
    updatedAt,
    updatedByUserId: null,
  };
}

describe("getPlatformSettings cache", () => {
  beforeEach(() => {
    invalidatePlatformSettings();
  });

  afterEach(() => {
    invalidatePlatformSettings();
  });

  it("U3: returns the same object within the TTL and refetches once it has expired", async () => {
    const fake = makeFakeMongo();
    // Each `now()` read advances 1000 ms; `getPlatformSettings` reads once per call.
    const clock = fixedClock("2026-01-01T00:00:00.000Z", 1000);
    const ttlMs = 2500;

    fake.seed("platformSettings", [storedSettings(14, "2026-01-01T00:00:00.000Z")]);

    const first = await getPlatformSettings({ db: fake.db, clock, ttlMs });
    expect(first.dunning.gracePeriodDays).toBe(14);

    // The operator changes the singleton behind the cache's back.
    fake.seed("platformSettings", [storedSettings(30, "2026-01-02T00:00:00.000Z")]);

    const second = await getPlatformSettings({ db: fake.db, clock, ttlMs });
    const third = await getPlatformSettings({ db: fake.db, clock, ttlMs });

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(third.dunning.gracePeriodDays).toBe(14);

    const afterExpiry = await getPlatformSettings({ db: fake.db, clock, ttlMs });

    expect(afterExpiry).not.toBe(first);
    expect(afterExpiry.dunning.gracePeriodDays).toBe(30);
  });

  it("U3: reads the singleton document by its fixed _id", async () => {
    const fake = makeFakeMongo();
    fake.seed("platformSettings", [storedSettings(14, "2026-01-01T00:00:00.000Z")]);

    await getPlatformSettings({
      db: fake.db,
      clock: fixedClock("2026-01-01T00:00:00.000Z"),
      ttlMs: 2500,
    });

    expect(fake.lastCall("findOne")?.collection).toBe("platformSettings");
    expect(fake.lastCall("findOne")?.args[0]).toEqual({ _id: "singleton" });
  });

  it("U3: invalidate forces the very next read to hit the database", async () => {
    const fake = makeFakeMongo();
    const clock = fixedClock("2026-01-01T00:00:00.000Z");
    fake.seed("platformSettings", [storedSettings(14, "2026-01-01T00:00:00.000Z")]);

    await getPlatformSettings({ db: fake.db, clock, ttlMs: 60_000 });
    fake.seed("platformSettings", [storedSettings(30, "2026-01-02T00:00:00.000Z")]);

    invalidatePlatformSettings();
    const reloaded = await getPlatformSettings({ db: fake.db, clock, ttlMs: 60_000 });

    expect(reloaded.dunning.gracePeriodDays).toBe(30);
  });
});
