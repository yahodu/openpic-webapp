import type { Db } from "mongodb";
import { z } from "zod";

import { getLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";
import { systemClock, type Clock } from "@/server/runtime/clock";

/**
 * The `platformSettings` singleton tunables (OP-82, schema §20.4 / contract
 * §9.10).
 *
 * Every runtime knob that used to be a hard-coded constant — dunning grace,
 * reminder schedule, pipeline lease, upload limits, notification poll cadence —
 * lives in one document so an operator changes a threshold **without a
 * deploy**. This module is the single typed door to that document:
 *
 *   - {@link PLATFORM_SETTINGS_DEFAULTS} — the documented default document;
 *   - {@link SETTING_BOUNDS} / {@link checkSettingBound} — the contract's
 *     bounded scalars and their `{ key, min, max }` violation shape (the
 *     `details` of `422 setting_out_of_range`, Appendix A.2);
 *   - {@link validateReminderDays} — the schedule guard (strictly increasing,
 *     every day before the grace period);
 *   - {@link getPlatformSettings} / {@link invalidatePlatformSettings} — the
 *     cached read path;
 *   - {@link seedPlatformSettings} — the create-only idempotent seed.
 *
 * The read cache reads the injected {@link Clock} exactly once per call, so the
 * TTL is deterministic under `fixedClock(start, stepMs)` (ADR-0007).
 */

/** The collection and singleton identity of the settings document. */
const PLATFORM_SETTINGS_COLLECTION = "platformSettings";
const SINGLETON_ID = "singleton";

/** Recommended cache lifetime; overridable per call and asserted only by shape. */
const DEFAULT_TTL_MS = 30_000;

/** A bounded scalar: the legal, inclusive range for one tunable key. */
export interface SettingBound {
  /** The dotted path of the tunable (e.g. `dunning.gracePeriodDays`). */
  readonly key: string;
  /** The inclusive lower bound. */
  readonly min: number;
  /** The inclusive upper bound. */
  readonly max: number;
}

/** The `details` payload of a `422 setting_out_of_range` refusal (Appendix A.2). */
export interface SettingOutOfRange {
  /** The dotted path of the offending tunable. */
  readonly key: string;
  /** The inclusive lower bound the value fell below. */
  readonly min: number;
  /** The inclusive upper bound the value exceeded. */
  readonly max: number;
}

/** Why a reminder day was rejected. */
export type ReminderDaysProblem = "not_strictly_increasing" | "not_before_grace";

/** One offending entry of a `reminderDays` schedule. */
export interface ReminderDaysViolation {
  /** The tunable the violation belongs to. */
  readonly key: "dunning.reminderDays";
  /** The array index of the offending day. */
  readonly index: number;
  /** The offending day value. */
  readonly day: number;
  /** Which rule the day broke. */
  readonly problem: ReminderDaysProblem;
}

/**
 * The literal ranges fixed by contract §9.10. The bounded scalars are declared
 * once here (pinned by value, not derived at assert time) and both
 * {@link SETTING_BOUNDS} and the Zod schema read from this table so the two can
 * never drift.
 */
const SETTING_RANGES: ReadonlyMap<string, { readonly min: number; readonly max: number }> = new Map(
  [
    ["dunning.gracePeriodDays", { min: 1, max: 60 }],
    ["pipeline.leaseMinutes", { min: 1, max: 60 }],
    ["notifications.pollIntervalSeconds", { min: 10, max: 300 }],
  ]
);

/** The bounded scalars as a flat, enumerable `{ key, min, max }` table. */
export const SETTING_BOUNDS: readonly SettingBound[] = [...SETTING_RANGES].map(([key, range]) => ({
  key,
  min: range.min,
  max: range.max,
}));

/** Look up a declared range by tunable key, tolerating unknown keys. */
function rangeFor(key: string): { min: number; max: number } | undefined {
  return SETTING_RANGES.get(key);
}

/**
 * Check a scalar tunable against its contract range.
 *
 * @param key - The dotted tunable path.
 * @param value - The candidate value.
 * @returns `null` when the value is within (or the key is unbounded), else the
 *   exact `{ key, min, max }` violation the admin route forwards unchanged.
 */
export function checkSettingBound(key: string, value: number): SettingOutOfRange | null {
  const range = rangeFor(key);
  if (range === undefined) {
    return null;
  }
  if (value < range.min || value > range.max) {
    return { key, min: range.min, max: range.max };
  }
  return null;
}

/**
 * Validate a dunning reminder schedule against the contract's two rules: days
 * must be **strictly increasing**, and every day must fall **strictly before**
 * the grace period.
 *
 * Exactly one violation is emitted per offending index, ordered by index. The
 * strict-increase rule is evaluated first, so an index that both fails to
 * increase and is `>= grace` is reported `not_strictly_increasing`.
 *
 * @param reminderDays - The candidate day offsets.
 * @param gracePeriodDays - The grace period the schedule must precede.
 * @returns The violations, newest-last; empty when the schedule is legal.
 */
export function validateReminderDays(
  reminderDays: readonly number[],
  gracePeriodDays: number
): ReminderDaysViolation[] {
  const violations: ReminderDaysViolation[] = [];

  reminderDays.forEach((day, index) => {
    const previous = index > 0 ? reminderDays[index - 1] : undefined;

    if (previous !== undefined && day <= previous) {
      violations.push({
        key: "dunning.reminderDays",
        index,
        day,
        problem: "not_strictly_increasing",
      });
      return;
    }

    if (day >= gracePeriodDays) {
      violations.push({ key: "dunning.reminderDays", index, day, problem: "not_before_grace" });
    }
  });

  return violations;
}

/** Build a bounded, integer Zod number from a declared contract range. */
function boundedInt(key: string): z.ZodNumber {
  const range = rangeFor(key);
  if (range === undefined) {
    throw new Error(`unknown setting bound: ${key}`);
  }
  return z.number().int().min(range.min).max(range.max);
}

/** `dunning` — the grace period, reminder schedule and charge retry ceiling. */
const dunningSchema = z
  .object({
    gracePeriodDays: boundedInt("dunning.gracePeriodDays"),
    reminderDays: z.array(z.number().int().positive()),
    maxChargeRetries: z.number().int().min(0),
  })
  .superRefine((value, ctx) => {
    for (const violation of validateReminderDays(value.reminderDays, value.gracePeriodDays)) {
      ctx.addIssue({
        code: "custom",
        path: ["reminderDays", violation.index],
        message:
          violation.problem === "not_strictly_increasing"
            ? "reminder days must be strictly increasing"
            : "reminder days must fall before the grace period",
      });
    }
  });

/** `retention` — the per-artifact retention windows, in days. */
const retentionSchema = z.object({
  notificationDays: z.number().int().positive(),
  notificationActiveDays: z.number().int().positive(),
  dispatchDays: z.number().int().positive(),
  domainEventDays: z.number().int().positive(),
  webhookDays: z.number().int().positive(),
  attendeeSessionDays: z.number().int().positive(),
  uploadSessionDays: z.number().int().positive(),
});

/** `face` — the active model switch and matching thresholds. */
const faceSchema = z.object({
  activeSpaceKey: z.string().min(1),
  matchLimit: z.number().int().positive(),
  minDetScore: z.number().min(0).max(1),
  exactSearch: z.boolean(),
});

/** `pipeline` — lease, attempt and backlog thresholds for background workers. */
const pipelineSchema = z.object({
  leaseMinutes: boundedInt("pipeline.leaseMinutes"),
  maxAttempts: z.number().int().min(1),
  sweepIntervalSeconds: z.number().int().positive(),
  backlogWarnDepth: z.number().int().positive(),
  backlogWarnAgeMinutes: z.number().int().positive(),
});

/** `upload` — size thresholds and the accepted MIME allow-list. */
const uploadSchema = z.object({
  multipartThresholdBytes: z.number().int().positive(),
  maxFileBytes: z.number().int().positive(),
  supportedMimeTypes: z.array(z.string().min(1)).min(1),
});

/** `notifications` — the poll cadence and digest throttles. */
const notificationsSchema = z.object({
  pollIntervalSeconds: boundedInt("notifications.pollIntervalSeconds"),
  digestQuietMinutes: z.number().int().positive(),
  digestHardFlushHours: z.number().int().positive(),
  maxDigestEmailsPerDay: z.number().int().positive(),
});

/**
 * `account` — account-lifecycle tunables (contract §1.4, ADR-0008).
 *
 * `deletionGraceDays` is the cancel window between a deletion request and the
 * `account-deletion-purge` cron: the request sets
 * `deletionScheduledAt = now + deletionGraceDays`, and the user may cancel
 * until that instant. It is a runtime tunable, never a hard-coded constant
 * (CONVENTIONS §6).
 */
const accountSchema = z.object({
  deletionGraceDays: z.number().int().positive(),
});

/** The full `platformSettings` singleton document (schema §20.4). */
export const platformSettingsSchema = z.object({
  _id: z.literal(SINGLETON_ID),
  dunning: dunningSchema,
  retention: retentionSchema,
  face: faceSchema,
  pipeline: pipelineSchema,
  upload: uploadSchema,
  notifications: notificationsSchema,
  account: accountSchema,
  updatedAt: z.string(),
  updatedByUserId: z.string().nullable(),
});

/** The validated `platformSettings` document. */
export type PlatformSettings = z.infer<typeof platformSettingsSchema>;

/**
 * The document body without its identity and audit stamps — what a seed
 * writes and what a reader falls back to.
 */
export type PlatformSettingsValues = Omit<
  PlatformSettings,
  "_id" | "updatedAt" | "updatedByUserId"
>;

/**
 * The documented default singleton (contract §9.10 / schema §20.4). Seeding
 * writes exactly these values and never overwrites an operator's edits.
 */
export const PLATFORM_SETTINGS_DEFAULTS: PlatformSettingsValues = {
  dunning: {
    gracePeriodDays: 14,
    reminderDays: [1, 5, 7, 11, 13],
    maxChargeRetries: 3,
  },
  retention: {
    notificationDays: 90,
    notificationActiveDays: 30,
    dispatchDays: 180,
    domainEventDays: 180,
    webhookDays: 90,
    attendeeSessionDays: 30,
    uploadSessionDays: 5,
  },
  face: {
    activeSpaceKey: "arcface_r100_512",
    matchLimit: 500,
    minDetScore: 0.55,
    exactSearch: true,
  },
  pipeline: {
    leaseMinutes: 10,
    maxAttempts: 5,
    sweepIntervalSeconds: 120,
    backlogWarnDepth: 5000,
    backlogWarnAgeMinutes: 15,
  },
  upload: {
    multipartThresholdBytes: 8_388_608,
    maxFileBytes: 104_857_600,
    supportedMimeTypes: [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
      "image/avif",
      "image/tiff",
    ],
  },
  notifications: {
    pollIntervalSeconds: 30,
    digestQuietMinutes: 15,
    digestHardFlushHours: 6,
    maxDigestEmailsPerDay: 3,
  },
  account: {
    deletionGraceDays: 14,
  },
};

/** A cached document and the instant its TTL elapses. */
interface SettingsCacheEntry {
  readonly settings: PlatformSettings;
  readonly expiresAt: number;
}

/** The process-wide read cache. Cleared by {@link invalidatePlatformSettings}. */
let cache: SettingsCacheEntry | null = null;

/** Optional seams for {@link getPlatformSettings}. */
export interface GetPlatformSettingsOptions {
  /** The database handle; defaults to the shared client. */
  readonly db?: Db;
  /** The clock used for the TTL; defaults to the system clock. */
  readonly clock?: Clock;
  /** The cache lifetime in milliseconds; defaults to 30 000. */
  readonly ttlMs?: number;
}

/** Read and validate the singleton, falling back to defaults when absent. */
async function loadSettings(db: Db | undefined, now: Date): Promise<PlatformSettings> {
  const stored = await platformRepo(db)
    .collection(PLATFORM_SETTINGS_COLLECTION)
    .findOne({ _id: SINGLETON_ID });

  if (stored === null) {
    // Missing-singleton behaviour is deliberately unspecified by OP-82 (ADR-0007)
    // and pinned by the later admin-route story; the read path degrades to the
    // documented defaults rather than throwing.
    return {
      _id: SINGLETON_ID,
      ...PLATFORM_SETTINGS_DEFAULTS,
      updatedAt: now.toISOString(),
      updatedByUserId: null,
    };
  }

  return platformSettingsSchema.parse(stored);
}

/**
 * Read the `platformSettings` singleton, cached for `ttlMs`.
 *
 * The injected clock is read exactly once per call, so the cache expiry is
 * deterministic. A hit returns the same object reference; once the TTL lapses
 * (or after {@link invalidatePlatformSettings}) the very next call re-reads the
 * database.
 *
 * @param options - The database/clock/TTL seams.
 * @returns The validated settings document.
 */
export async function getPlatformSettings(
  options: GetPlatformSettingsOptions = {}
): Promise<PlatformSettings> {
  const clock = options.clock ?? systemClock;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const nowMs = clock.now().getTime();

  const cached = cache;
  if (cached !== null && nowMs < cached.expiresAt) {
    return cached.settings;
  }

  const settings = await loadSettings(options.db, new Date(nowMs));
  cache = { settings, expiresAt: nowMs + ttlMs };

  getLogger().debug("settings.loaded", {
    event: "settings.loaded",
    gracePeriodDays: settings.dunning.gracePeriodDays,
    pollIntervalSeconds: settings.notifications.pollIntervalSeconds,
  });

  return settings;
}

/**
 * Drop the cached settings so the very next {@link getPlatformSettings} reads
 * the database. The single sanctioned way to observe an operator's change
 * within the TTL.
 */
export function invalidatePlatformSettings(): void {
  cache = null;
}

/** Optional seams for {@link seedPlatformSettings}. */
export interface SeedPlatformSettingsOptions {
  /** The database handle; defaults to the shared client. */
  readonly db?: Db;
  /** The clock stamped into `updatedAt`; defaults to the system clock. */
  readonly clock?: Clock;
  /** The acting user stamped into `updatedByUserId`; defaults to `null`. */
  readonly updatedByUserId?: string | null;
}

/**
 * Seed the `platformSettings` singleton, create-only.
 *
 * An upsert with `$setOnInsert` means running the seed twice (cron / deploy)
 * leaves exactly one document and never resets a value an operator already
 * tuned (ADR-0007).
 *
 * @param options - The database/clock/actor seams.
 * @returns The stored (seeded or pre-existing) settings document.
 */
export async function seedPlatformSettings(
  options: SeedPlatformSettingsOptions = {}
): Promise<PlatformSettings> {
  const clock = options.clock ?? systemClock;
  const defaults: PlatformSettingsValues & Pick<PlatformSettings, "updatedAt" | "updatedByUserId"> =
    {
      ...PLATFORM_SETTINGS_DEFAULTS,
      updatedAt: clock.now().toISOString(),
      updatedByUserId: options.updatedByUserId ?? null,
    };

  const stored = await platformRepo(options.db)
    .collection(PLATFORM_SETTINGS_COLLECTION)
    .findOneAndUpdate(
      { _id: SINGLETON_ID },
      { $setOnInsert: defaults },
      { upsert: true, returnDocument: "after" }
    );

  if (stored === null) {
    return { _id: SINGLETON_ID, ...defaults };
  }

  return platformSettingsSchema.parse(stored);
}
