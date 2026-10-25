import { describe, expect, it } from "vitest";

import {
  REASSURANCE_COPY,
  buildSubscriptionActions,
  buildSubscriptionBanner,
  daysRemaining,
} from "@/server/services/subscriptions";
import type { SubscriptionFacts } from "@/server/services/subscriptions";

/**
 * Unit contract — the subscription read view's pure builders (OP-106 RED,
 * contract §3.2, schema §14.3; ADR-0400).
 *
 * The user story: *as an organizer I want a single subscription view with a
 * reassuring banner so that I always know my billing state and that nothing was
 * deleted.* The banner and the `actions` matrix are the two pieces of that view
 * a client renders directly, so they are pinned here as pure functions, away
 * from Mongo and from the HTTP pipeline.
 *
 *   U1  the banner builder — one observable banner per status/mandate
 *       combination, including the legitimate `active` + `revoked` pair, with
 *       `reassurance` **mandatory** on `past_due`/`downgraded` and absent
 *       everywhere else;
 *   U2  the `actions` matrix — `status` × `mandateStatus` × caller `role`
 *       (every billing mutation in §3.3 is `owner`-only, so a non-owner sees
 *       every action `false`);
 *   U3  `daysRemaining` rounding — a partial final day counts as a whole one,
 *       an elapsed window is `0`, never negative.
 *
 * Contract expected of the implementation (module
 * `@/server/services/subscriptions`, barrel over `./view`):
 *
 *   daysRemaining(until: Date, now: Date): number
 *   REASSURANCE_COPY: string
 *   buildSubscriptionBanner(facts: SubscriptionFacts): SubscriptionBanner | null
 *   buildSubscriptionActions(input: {status, mandateStatus, role}): SubscriptionActions
 */

/** A fixed "now" so no assertion depends on the wall clock. */
const NOW = new Date("2026-09-25T00:00:00.000Z");

/** The `gracePeriodEndsAt` exactly 14 days after {@link NOW}. */
const GRACE = new Date("2026-10-09T00:00:00.000Z");

/** Build a facts input, defaulting the fields a given case does not care about. */
function facts(overrides: Partial<SubscriptionFacts>): SubscriptionFacts {
  return {
    status: "active",
    mandateStatus: "active",
    cancelAt: null,
    gracePeriodEndsAt: null,
    now: NOW,
    ...overrides,
  };
}

describe("U1 — buildSubscriptionBanner", () => {
  it("a past_due subscription raises a critical banner that reassures and counts down the grace window", () => {
    const banner = buildSubscriptionBanner(facts({ status: "past_due", gracePeriodEndsAt: GRACE }));

    expect(banner).toEqual({
      kind: "past_due",
      severity: "critical",
      daysRemaining: 14,
      downgradeOn: GRACE.toISOString(),
      reassurance: expect.stringMatching(/nothing has been deleted/i),
    });
  });

  it("a past_due subscription with no grace deadline still reassures, and carries no countdown", () => {
    const banner = buildSubscriptionBanner(facts({ status: "past_due", gracePeriodEndsAt: null }));

    expect(banner).toEqual({
      kind: "past_due",
      severity: "critical",
      reassurance: expect.stringMatching(/nothing has been deleted/i),
    });
  });

  it("a downgraded subscription raises a critical banner that reassures even though the plan already changed", () => {
    const banner = buildSubscriptionBanner(facts({ status: "downgraded" }));

    expect(banner).toEqual({
      kind: "downgraded",
      severity: "critical",
      reassurance: expect.stringMatching(/nothing has been deleted/i),
    });
  });

  it("an active subscription whose mandate was revoked warns about the next renewal (the §3.2 active + revoked pair)", () => {
    const banner = buildSubscriptionBanner(facts({ status: "active", mandateStatus: "revoked" }));

    expect(banner).toEqual({ kind: "mandate_revoked", severity: "important" });
  });

  it("an incomplete subscription whose mandate is pending asks the user to finish the mandate", () => {
    const banner = buildSubscriptionBanner(
      facts({ status: "incomplete", mandateStatus: "pending", cancelAt: null })
    );

    expect(banner).toEqual({ kind: "mandate_pending", severity: "informational" });
  });

  it("an active subscription scheduled to cancel at period end shows an informational cancelling banner", () => {
    const banner = buildSubscriptionBanner(
      facts({ status: "active", cancelAt: new Date("2026-10-01T00:00:00.000Z") })
    );

    expect(banner).toEqual({ kind: "cancelling", severity: "informational" });
  });

  it("a revoked mandate outranks a scheduled cancellation on the same active subscription", () => {
    const banner = buildSubscriptionBanner(
      facts({
        status: "active",
        mandateStatus: "revoked",
        cancelAt: new Date("2026-10-01T00:00:00.000Z"),
      })
    );

    expect(banner).toEqual({ kind: "mandate_revoked", severity: "important" });
  });

  it("a past_due subscription outranks a revoked mandate: the money banner wins", () => {
    const banner = buildSubscriptionBanner(
      facts({ status: "past_due", mandateStatus: "revoked", gracePeriodEndsAt: GRACE })
    );

    expect(banner?.kind).toBe("past_due");
    expect(banner?.severity).toBe("critical");
  });

  it("a healthy active subscription with an active mandate shows no banner", () => {
    expect(buildSubscriptionBanner(facts({ status: "active" }))).toBeNull();
  });

  it("a free tenant with no subscription document shows no banner", () => {
    expect(buildSubscriptionBanner(facts({ status: "none", mandateStatus: null }))).toBeNull();
  });

  it("a cancelled subscription shows no banner", () => {
    expect(buildSubscriptionBanner(facts({ status: "cancelled" }))).toBeNull();
  });

  it("an expired subscription shows no banner", () => {
    expect(buildSubscriptionBanner(facts({ status: "expired" }))).toBeNull();
  });

  it("exports the reassurance copy the contract mandates as product copy", () => {
    expect(REASSURANCE_COPY).toMatch(/nothing has been deleted/i);
  });
});

describe("U2 — buildSubscriptionActions", () => {
  it.each<{
    name: string;
    status: SubscriptionFacts["status"];
    expected: Record<string, boolean>;
  }>([
    {
      name: "a free tenant (no document) may only upgrade",
      status: "none",
      expected: {
        canUpgrade: true,
        canDowngrade: false,
        canCancel: false,
        canRetryCharge: false,
        mustCompleteMandate: false,
      },
    },
    {
      name: "an active subscriber may upgrade, downgrade or cancel but has nothing to pay",
      status: "active",
      expected: {
        canUpgrade: true,
        canDowngrade: true,
        canCancel: true,
        canRetryCharge: false,
        mustCompleteMandate: false,
      },
    },
    {
      name: "a past_due subscriber may pay the outstanding due as well as the usual moves",
      status: "past_due",
      expected: {
        canUpgrade: true,
        canDowngrade: true,
        canCancel: true,
        canRetryCharge: true,
        mustCompleteMandate: false,
      },
    },
    {
      name: "a downgraded subscriber may retry the charge or upgrade, but nothing is left to downgrade",
      status: "downgraded",
      expected: {
        canUpgrade: true,
        canDowngrade: false,
        canCancel: true,
        canRetryCharge: true,
        mustCompleteMandate: false,
      },
    },
    {
      name: "an incomplete mandate must be completed and cannot start a second subscription",
      status: "incomplete",
      expected: {
        canUpgrade: false,
        canDowngrade: false,
        canCancel: true,
        canRetryCharge: false,
        mustCompleteMandate: true,
      },
    },
    {
      name: "a cancelled subscription may only be replaced by a new one",
      status: "cancelled",
      expected: {
        canUpgrade: true,
        canDowngrade: false,
        canCancel: false,
        canRetryCharge: false,
        mustCompleteMandate: false,
      },
    },
    {
      name: "an expired subscription may only be replaced by a new one",
      status: "expired",
      expected: {
        canUpgrade: true,
        canDowngrade: false,
        canCancel: false,
        canRetryCharge: false,
        mustCompleteMandate: false,
      },
    },
  ])("an owner: $name", ({ status, expected }) => {
    expect(buildSubscriptionActions({ status, mandateStatus: "active", role: "owner" })).toEqual(
      expected
    );
  });

  it("an owner cannot retry a charge against a revoked mandate — the recovery is a new checkout", () => {
    expect(
      buildSubscriptionActions({ status: "past_due", mandateStatus: "revoked", role: "owner" })
    ).toMatchObject({ canRetryCharge: false, canUpgrade: true });
  });

  it("an owner cannot retry a charge against an expired mandate", () => {
    expect(
      buildSubscriptionActions({ status: "past_due", mandateStatus: "expired", role: "owner" })
    ).toMatchObject({ canRetryCharge: false });
  });

  it("a plain member of the workspace may perform no billing action, even while past_due", () => {
    expect(
      buildSubscriptionActions({ status: "past_due", mandateStatus: "active", role: "member" })
    ).toEqual({
      canUpgrade: false,
      canDowngrade: false,
      canCancel: false,
      canRetryCharge: false,
      mustCompleteMandate: false,
    });
  });

  it("an admin may perform no billing action either — every §3.3 mutation is owner-only", () => {
    expect(
      buildSubscriptionActions({ status: "active", mandateStatus: "active", role: "admin" })
    ).toEqual({
      canUpgrade: false,
      canDowngrade: false,
      canCancel: false,
      canRetryCharge: false,
      mustCompleteMandate: false,
    });
  });

  it("an owner of a free tenant still gets the upgrade action (it is the only move)", () => {
    expect(
      buildSubscriptionActions({ status: "none", mandateStatus: null, role: "owner" })
    ).toMatchObject({ canUpgrade: true });
  });
});

describe("U3 — daysRemaining", () => {
  it.each([
    { name: "an exact window is the whole number of days", until: GRACE, expected: 14 },
    {
      name: "a partial final day counts as a whole one",
      until: new Date("2026-10-08T23:00:00.000Z"),
      expected: 14,
    },
    {
      name: "half an hour over the window still rounds up",
      until: new Date("2026-10-09T00:30:00.000Z"),
      expected: 15,
    },
    {
      name: "a single millisecond left is one remaining day, never zero",
      until: new Date(NOW.getTime() + 1),
      expected: 1,
    },
    {
      name: "exactly one day left is one",
      until: new Date("2026-09-26T00:00:00.000Z"),
      expected: 1,
    },
    {
      name: "an instant that has already arrived is zero",
      until: NOW,
      expected: 0,
    },
    {
      name: "an elapsed window is clamped to zero, never negative",
      until: new Date("2026-09-22T00:00:00.000Z"),
      expected: 0,
    },
  ])("$name", ({ until, expected }) => {
    expect(daysRemaining(until, NOW)).toBe(expected);
  });
});
