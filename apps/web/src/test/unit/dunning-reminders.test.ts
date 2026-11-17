import { describe, expect, it } from "vitest";

import { resolveDueReminderDay } from "@/server/billing/jobs/dunning-reminders";
import {
  PLATFORM_SETTINGS_DEFAULTS,
  type PlatformSettings,
} from "@/server/settings/platform-settings";

/**
 * Unit contract — the dunning reminder due-day computation (OP-111 U1, contract
 * §10.2 `dunning-reminders`, schema §14.3 `subscriptions.dunning`; ADR-0500).
 *
 * The user story: *as the platform I want billing crons that downgrade after
 * grace, remind on schedule and heal missed webhooks so that billing is correct
 * and content is never touched.*
 *
 * The grace-reminder cron is the one job whose schedule is a function of two
 * stored facts — `subscriptions.gracePeriodEndsAt` (which the webhook projection
 * set to `now + settings.dunning.gracePeriodDays`) and
 * `settings.dunning.reminderDays` — so the whole decision is derivable without
 * I/O and must not be re-derived inline inside the job:
 *
 *   - **day 1 is the first day of the grace window**, and the window starts at
 *     `gracePeriodEndsAt - gracePeriodDays` (never a hard-coded 14, contract
 *     §10.1.2);
 *   - a day counts as elapsed once a full 24 h have passed since the window
 *     opened, so the day is `floor((now - start) / 24 h) + 1`;
 *   - a reminder is due only on a day named by `settings.dunning.reminderDays`;
 *   - the key `d{day}` is what `dunning.remindersSent` stores, so it is the
 *     job's idempotency token and belongs to this computation;
 *   - `isFinal` marks the last schedule day — the only day the reminder's
 *     payload is allowed to ask for a mobile push (contract §10.2: "mobile only
 *     on day 13").
 *
 * ## Contract this spec pins
 *
 * - module `@/server/billing/jobs/dunning-reminders`;
 * - `resolveDueReminderDay(input: ReminderDueInput): ReminderDue | null` where
 *   - `ReminderDueInput = { gracePeriodEndsAt: Date; settings: PlatformSettings;
 *     now: Date }` (the whole settings document, so the caller cannot pass a
 *     reminder list that disagrees with the grace period it was validated
 *     against — `validateReminderDays` guards them together);
 *   - `ReminderDue = { day: number; key: string; isFinal: boolean }`.
 *
 * ## Assumptions recorded in the handoff (ADR-0500)
 *
 * - The 24-hour bucket (rather than a calendar day in a tenant timezone) is the
 *   definition, because the window itself is derived from an instant
 *   (`gracePeriodEndsAt`) and the job runs 4×/day; a calendar-day definition
 *   would need a per-tenant timezone this module must not read.
 * - A day *before* the window opens and the instant the grace ends are both
 *   `null`: the grace reminder is only for a subscription still inside its
 *   grace period. The `dunning` job owns the past-grace transition.
 */

/** The documented settings singleton, as the pure function receives it. */
const DEFAULT_SETTINGS: PlatformSettings = {
  _id: "singleton",
  ...PLATFORM_SETTINGS_DEFAULTS,
  updatedAt: "2026-10-01T00:00:00.000Z",
  updatedByUserId: null,
};

/** Settings with a different grace length than the documented default. */
const SEVEN_DAY_GRACE: PlatformSettings = {
  ...DEFAULT_SETTINGS,
  dunning: { ...PLATFORM_SETTINGS_DEFAULTS.dunning, gracePeriodDays: 7, reminderDays: [1, 5] },
};

/** Settings with a custom reminder schedule over the default grace length. */
const CUSTOM_SCHEDULE: PlatformSettings = {
  ...DEFAULT_SETTINGS,
  dunning: { ...PLATFORM_SETTINGS_DEFAULTS.dunning, reminderDays: [3, 9] },
};

/** One due-day case: inputs and the exact computation they must produce. */
interface DueCase {
  readonly name: string;
  /** `subscriptions.gracePeriodEndsAt`, as seeded by the webhook projection. */
  readonly gracePeriodEndsAt: string;
  /** The job's `clock.now()`. */
  readonly now: string;
  readonly settings: PlatformSettings;
  readonly expected: {
    readonly day: number;
    readonly key: string;
    readonly isFinal: boolean;
  } | null;
}

/**
 * The default grace window for every case below is
 * `2026-10-18T00:00:00.000Z` → `2026-11-01T00:00:00.000Z` (14 days at the
 * documented `gracePeriodDays`), so day `N` starts at `10-18 + (N - 1)` days
 * unless a case overrides the grace length.
 */
const CASES: readonly DueCase[] = [
  {
    name: "the first 24 h of the window is day 1",
    gracePeriodEndsAt: "2026-11-01T00:00:00.000Z",
    now: "2026-10-18T12:00:00.000Z",
    settings: DEFAULT_SETTINGS,
    expected: { day: 1, key: "d1", isFinal: false },
  },
  {
    name: "exactly the instant the window opens is day 1",
    gracePeriodEndsAt: "2026-11-01T00:00:00.000Z",
    now: "2026-10-18T00:00:00.000Z",
    settings: DEFAULT_SETTINGS,
    expected: { day: 1, key: "d1", isFinal: false },
  },
  {
    name: "the fifth 24 h of the window is day 5",
    gracePeriodEndsAt: "2026-11-01T00:00:00.000Z",
    now: "2026-10-22T12:00:00.000Z",
    settings: DEFAULT_SETTINGS,
    expected: { day: 5, key: "d5", isFinal: false },
  },
  {
    name: "a day the schedule does not name is not due",
    gracePeriodEndsAt: "2026-11-01T00:00:00.000Z",
    now: "2026-10-23T12:00:00.000Z",
    settings: DEFAULT_SETTINGS,
    expected: null,
  },
  {
    name: "the last schedule day is due and is marked final",
    gracePeriodEndsAt: "2026-11-01T00:00:00.000Z",
    now: "2026-10-30T12:00:00.000Z",
    settings: DEFAULT_SETTINGS,
    expected: { day: 13, key: "d13", isFinal: true },
  },
  {
    name: "the final grace day is past the schedule and not due",
    gracePeriodEndsAt: "2026-11-01T00:00:00.000Z",
    now: "2026-10-31T12:00:00.000Z",
    settings: DEFAULT_SETTINGS,
    expected: null,
  },
  {
    name: "one millisecond before the window opens nothing is due",
    gracePeriodEndsAt: "2026-11-01T00:00:00.000Z",
    now: "2026-10-17T23:59:59.999Z",
    settings: DEFAULT_SETTINGS,
    expected: null,
  },
  {
    name: "at gracePeriodEndsAt the grace period is over",
    gracePeriodEndsAt: "2026-11-01T00:00:00.000Z",
    now: "2026-11-01T00:00:00.000Z",
    settings: DEFAULT_SETTINGS,
    expected: null,
  },
  {
    name: "an operator's schedule decides which days are due (a day 3 reminder)",
    gracePeriodEndsAt: "2026-11-01T00:00:00.000Z",
    now: "2026-10-20T12:00:00.000Z",
    settings: CUSTOM_SCHEDULE,
    expected: { day: 3, key: "d3", isFinal: false },
  },
  {
    name: "an operator's schedule closes the days it omits (day 5 is silent)",
    gracePeriodEndsAt: "2026-11-01T00:00:00.000Z",
    now: "2026-10-22T12:00:00.000Z",
    settings: CUSTOM_SCHEDULE,
    expected: null,
  },
  {
    name: "an operator's schedule marks its own last day final (day 9)",
    gracePeriodEndsAt: "2026-11-01T00:00:00.000Z",
    now: "2026-10-26T12:00:00.000Z",
    settings: CUSTOM_SCHEDULE,
    expected: { day: 9, key: "d9", isFinal: true },
  },
  {
    name: "a shorter grace period moves day 1 to the new window start",
    gracePeriodEndsAt: "2026-11-01T00:00:00.000Z",
    now: "2026-10-25T12:00:00.000Z",
    settings: SEVEN_DAY_GRACE,
    expected: { day: 1, key: "d1", isFinal: false },
  },
  {
    name: "a shorter grace period moves the final reminder to its own last day",
    gracePeriodEndsAt: "2026-11-01T00:00:00.000Z",
    now: "2026-10-29T12:00:00.000Z",
    settings: SEVEN_DAY_GRACE,
    expected: { day: 5, key: "d5", isFinal: true },
  },
  {
    name: "a shorter grace period ends earlier",
    gracePeriodEndsAt: "2026-11-01T00:00:00.000Z",
    now: "2026-10-31T12:00:00.000Z",
    settings: SEVEN_DAY_GRACE,
    expected: null,
  },
];

describe("resolveDueReminderDay (U1)", () => {
  it.each(CASES)("$name", (testCase) => {
    // Act
    const due = resolveDueReminderDay({
      gracePeriodEndsAt: new Date(testCase.gracePeriodEndsAt),
      settings: testCase.settings,
      now: new Date(testCase.now),
    });

    // Assert
    expect(due).toEqual(testCase.expected);
  });
});
