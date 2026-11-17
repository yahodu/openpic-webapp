import { describe, expect, it } from "vitest";

import { decideRenewalReminder } from "@/server/billing/jobs/renewal-reminders";
import type { SubscriptionStatus } from "@/server/payments/payment-provider";

/**
 * Unit contract — the renewal-reminder window decision (OP-111 U2, contract
 * §10.2 `renewal-reminders`, schema §14.3; ADR-0500).
 *
 * The user story: *as the platform I want billing crons that downgrade after
 * grace, remind on schedule and heal missed webhooks so that billing is correct
 * and content is never touched.*
 *
 * `renewal-reminders` runs daily and is the only billing cron whose subject is a
 * **healthy** subscription, so it needs its own window and its own idempotency
 * token. §10.2 states the window — `status: "active"`, `nextChargeAt` within 3
 * days, "not already reminded this cycle" — and leaves the token to the
 * implementation; pinning it here keeps the job's idempotency (and its
 * `dunning.remindersSent` entry) derivable without I/O:
 *
 *   - the cycle is identified by `currentPeriodEnd`, so the token is
 *     `renewal:<currentPeriodEnd ISO>`;
 *   - the window is `0 < nextChargeAt - now <= 3 days`;
 *   - only `status: "active"` renews — a `past_due`, `downgraded`, `cancelled` or
 *     `expired` row is dunning's business, not a renewal nudge;
 *   - a row carrying `cancelAt` (a period-end cancel) will not be charged, so it
 *     must not be reminded to renew.
 *
 * ## Contract this spec pins
 *
 * - module `@/server/billing/jobs/renewal-reminders`;
 * - `decideRenewalReminder(input: RenewalWindowInput): RenewalDue | null` where
 *   `RenewalWindowInput = { status: SubscriptionStatus; nextChargeAt: Date | null;
 *   currentPeriodEnd: Date | null; cancelAt: Date | null; remindersSent:
 *   readonly string[]; now: Date }` and `RenewalDue = { key: string }`.
 *
 * ## Assumptions recorded in the handoff (ADR-0500)
 *
 * - The window is a **strict** future window: at `nextChargeAt === now` the
 *   charge instant has arrived and the payment webhook is the signal, so a
 *   "renewal is upcoming" nudge would be stale. §10.2's "within 3 days" is read
 *   as the upper bound inclusive (`delta <= 3 d`) and the lower bound exclusive.
 * - `cancelAt !== null` suppresses the reminder. The card is silent; a reminder
 *   asking a user to renew a subscription that is already cancelled at period
 *   end is the wrong product behaviour, and suppressing it is the conservative
 *   reading.
 * - A missing `currentPeriodEnd` has no cycle to key on, so it is `null` rather
 *   than a reminder that could be sent twice.
 */

/** The instant every case below is evaluated at. */
const NOW = new Date("2026-10-25T12:00:00.000Z");

/** The live period end — also the renewal cycle's identity. */
const PERIOD_END = new Date("2026-11-01T00:00:00.000Z");

/** The token a due reminder for {@link PERIOD_END} must carry. */
const CYCLE_KEY = `renewal:${PERIOD_END.toISOString()}`;

/** A case's overrides; every unset field falls back to a healthy active row. */
interface WindowCase {
  readonly name: string;
  readonly chargeInMs?: number | null;
  readonly status?: SubscriptionStatus;
  readonly currentPeriodEnd?: Date | null;
  readonly cancelAt?: Date | null;
  readonly remindersSent?: readonly string[];
  readonly due: boolean;
}

/**
 * Helper-free by construction: the row's `nextChargeAt` is expressed as an
 * offset from `NOW`, so no case depends on a clock read at module scope.
 */
const CASES: readonly WindowCase[] = [
  { name: "a charge two days away is due", chargeInMs: 2 * 86_400_000, due: true },
  { name: "a charge exactly three days away is due", chargeInMs: 3 * 86_400_000, due: true },
  {
    name: "a charge three days and one millisecond away is outside the window",
    chargeInMs: 3 * 86_400_000 + 1,
    due: false,
  },
  { name: "the charge instant itself is not upcoming", chargeInMs: 0, due: false },
  { name: "a charge in the past is not upcoming", chargeInMs: -86_400_000, due: false },
  { name: "a row with no charge date is not due", chargeInMs: null, due: false },
  {
    name: "a cycle already reminded is not reminded twice",
    chargeInMs: 2 * 86_400_000,
    remindersSent: [CYCLE_KEY],
    due: false,
  },
  {
    name: "a reminder for a previous cycle does not cover this one",
    chargeInMs: 2 * 86_400_000,
    remindersSent: ["renewal:2026-10-01T00:00:00.000Z"],
    due: true,
  },
  {
    name: "a past_due row is dunning's business, not a renewal nudge",
    chargeInMs: 86_400_000,
    status: "past_due",
    due: false,
  },
  {
    name: "a cancelled row is not renewed",
    chargeInMs: 86_400_000,
    status: "cancelled",
    due: false,
  },
  {
    name: "an incomplete row is not renewed",
    chargeInMs: 86_400_000,
    status: "incomplete",
    due: false,
  },
  {
    name: "a subscription cancelled at period end is not asked to renew",
    chargeInMs: 86_400_000,
    cancelAt: PERIOD_END,
    due: false,
  },
  {
    name: "a row with no period end has no cycle to key on",
    chargeInMs: 86_400_000,
    currentPeriodEnd: null,
    due: false,
  },
];

describe("decideRenewalReminder (U2)", () => {
  it.each(CASES)("$name", (testCase) => {
    // Act
    const decision = decideRenewalReminder({
      status: testCase.status ?? "active",
      nextChargeAt:
        testCase.chargeInMs === undefined || testCase.chargeInMs === null
          ? null
          : new Date(NOW.getTime() + testCase.chargeInMs),
      currentPeriodEnd:
        testCase.currentPeriodEnd === undefined ? PERIOD_END : testCase.currentPeriodEnd,
      cancelAt: testCase.cancelAt ?? null,
      remindersSent: testCase.remindersSent ?? [],
      now: NOW,
    });

    // Assert
    expect(decision).toEqual(testCase.due ? { key: CYCLE_KEY } : null);
  });
});
