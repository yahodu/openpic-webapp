import type { ClientSession } from "mongodb";
import { describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { fixedClock } from "@/server/runtime/clock";
import { releaseEntitlement } from "@/server/services/entitlements";

import { makeSubscription, makeUsageCounter } from "../factories/entitlements";
import { makeEntitlement, makePlan } from "../factories/plan";
import { makeFakeMongo, type FakeMongo, type RecordedCall } from "../helpers/fake-mongo";

/**
 * Unit contract — the non-`tenant` release scope (OP-103 follow-up; ADR-0346).
 *
 * ## The decision this pins: option (a), mirrored from `consumeEntitlement`
 *
 * `releaseEntitlement` **does not touch `usageCounters` for an `event` or
 * `attendee` scope**. The caller's `ctx.counts` is the only usage source for
 * those keys, the returned verdict's `used` is derived from `ctx.counts` — the
 * tenant-scoped counter row is *not* read and its post-decrement value is *not*
 * reported — and no counter write is issued.
 *
 * This mirrors the contract `src/test/unit/entitlements-nontenant-scope.test.ts`
 * settled for the consume path (ADR-0342): `resolveEntitlement` already reads a
 * counter only for `tenant` scope
 * (`spec.scope === "tenant" ? readCounter() : (ctx.counts ?? 0)`), so a counter
 * `releaseCounter` decrements for a non-tenant key is never read back by the
 * decision — it is pollution the schema §23 quota-bar read
 * (`usageCounters.find({ tenantId, periodKey: { $in: [monthKey, "lifetime"] } })`)
 * would surface. Release must agree with consume.
 *
 * ## What is pinned here (the card's items 1 and 2)
 *
 * 1. A non-`tenant`-scoped `releaseEntitlement` issues **no** `usageCounters`
 *    write (the collection's write log is empty).
 * 2. The returned verdict's `used` comes from `ctx.counts`, never from the
 *    counter: it equals `ctx.counts` (`0` when absent), clamped to `0` when
 *    `amount > (ctx.counts ?? 0)`.
 *
 * The `tenant`-scoped release (decrement + clamp at zero, item 3) is guarded in
 * `src/test/integration/entitlements-release-nontenant.test.ts`, next to the
 * `I5` pins it mirrors, and against a real replica set.
 */

/** The tenant every fixture is scoped to. */
const TENANT = "t_op103_release_nontenant";

/** The fixed instant the specs reason about (2026-09, mid-month). */
const NOW = "2026-09-15T10:00:00.000Z";

/** An `event`-scoped metered key (schema §14.1). */
const EVENT_KEY = "events.duration_days";

/** An `attendee`-scoped metered key (schema §14.1). */
const ATTENDEE_KEY = "selfies.per_attendee";

/** An `event`-scoped boolean feature gate (schema §14.1). */
const FEATURE_KEY = "originals.download";

/** The plan key the seeded plan and subscription agree on. */
const PLAN_KEY = "professional";

/** A stand-in session: the specs assert on reads, verdicts and write logs. */
const SESSION = {} as ClientSession;

/**
 * Seed a fake database with one plan, one subscription and (optionally) one
 * pre-existing counter row for the key under test.
 *
 * The counter row models the pollution a prior `consumeEntitlement` left behind
 * for a non-tenant key: the decision never reads it, so the release must neither
 * decrement it nor report it.
 *
 * @param input - The plan entitlements and the optional pre-existing counter row.
 * @returns The recording fake.
 */
function seed(input: {
  readonly entitlements: Record<string, ReturnType<typeof makeEntitlement>>;
  readonly counter?: { readonly entitlementKey: string; readonly value: number };
}): FakeMongo {
  const fake = makeFakeMongo();
  fake.seed("plans", [makePlan({ key: PLAN_KEY, entitlements: input.entitlements })]);
  fake.seed("subscriptions", [
    {
      ...makeSubscription({
        tenantId: TENANT,
        subscribedPlanKey: PLAN_KEY,
        activePlanKey: PLAN_KEY,
      }),
    },
  ]);
  if (input.counter !== undefined) {
    fake.seed("usageCounters", [
      {
        ...makeUsageCounter({
          tenantId: TENANT,
          entitlementKey: input.counter.entitlementKey,
          periodKey: "lifetime",
          value: input.counter.value,
        }),
      },
    ]);
  }
  return fake;
}

/** The options every release spec passes. */
function releaseSeams(fake: FakeMongo) {
  return { db: fake.db, clock: fixedClock(NOW) };
}

/** The counter write methods a release must not issue for a non-tenant key. */
const COUNTER_WRITES = ["findOneAndUpdate", "updateOne", "updateMany", "insertOne", "insertMany"];

/**
 * Every write the service issued against `usageCounters`.
 *
 * @param fake - The recording fake.
 * @returns The mutating calls on the counter collection, in order.
 */
function counterWrites(fake: FakeMongo): RecordedCall[] {
  return fake.calls.filter(
    (call) => call.collection === COLLECTIONS.usageCounters && COUNTER_WRITES.includes(call.method)
  );
}

describe("releaseEntitlement — non-tenant scope uses ctx.counts (option a)", () => {
  it("U10: an event-scoped release reports ctx.counts as `used`, not the counter row", async () => {
    const fake = seed({
      entitlements: {
        [EVENT_KEY]: makeEntitlement({
          limit: 3,
          resetPeriod: "none",
          scope: "event",
          enforcement: "hard",
        }),
      },
      counter: { entitlementKey: EVENT_KEY, value: 5 },
    });

    const verdict = await releaseEntitlement(
      SESSION,
      TENANT,
      EVENT_KEY,
      1,
      { counts: 2 },
      releaseSeams(fake)
    );

    // ctx.counts (2) is the usage; the counter row (5 -> 4) must not appear.
    expect(verdict).toMatchObject({
      allowed: true,
      entitlementKey: EVENT_KEY,
      used: 2,
      remaining: 1,
      scope: "event",
    });
  });

  it("U10: an event-scoped release writes no usageCounters row", async () => {
    const fake = seed({
      entitlements: {
        [EVENT_KEY]: makeEntitlement({
          limit: 3,
          resetPeriod: "none",
          scope: "event",
          enforcement: "hard",
        }),
      },
      counter: { entitlementKey: EVENT_KEY, value: 5 },
    });

    await releaseEntitlement(SESSION, TENANT, EVENT_KEY, 1, { counts: 2 }, releaseSeams(fake));

    expect(counterWrites(fake)).toEqual([]);
  });

  it("U10: an attendee-scoped release clamps `used` to 0 when the amount exceeds ctx.counts", async () => {
    const fake = seed({
      entitlements: {
        [ATTENDEE_KEY]: makeEntitlement({
          limit: 5,
          resetPeriod: "none",
          scope: "attendee",
          enforcement: "hard",
        }),
      },
      counter: { entitlementKey: ATTENDEE_KEY, value: 3 },
    });

    const verdict = await releaseEntitlement(
      SESSION,
      TENANT,
      ATTENDEE_KEY,
      4,
      { counts: 1 },
      releaseSeams(fake)
    );

    expect(verdict).toMatchObject({
      allowed: true,
      entitlementKey: ATTENDEE_KEY,
      used: 0,
      remaining: 5,
      scope: "attendee",
    });
    expect(counterWrites(fake)).toEqual([]);
  });

  it("U10: an attendee-scoped release with no counter row and no counts reports used 0", async () => {
    const fake = seed({
      entitlements: {
        [ATTENDEE_KEY]: makeEntitlement({
          limit: 5,
          resetPeriod: "none",
          scope: "attendee",
          enforcement: "hard",
        }),
      },
    });

    const verdict = await releaseEntitlement(
      SESSION,
      TENANT,
      ATTENDEE_KEY,
      1,
      {},
      releaseSeams(fake)
    );

    expect(verdict).toMatchObject({ allowed: true, used: 0, remaining: 5 });
    expect(counterWrites(fake)).toEqual([]);
  });

  it("U10: an enabled event-scoped feature gate writes no usageCounters row", async () => {
    const fake = seed({
      entitlements: {
        [FEATURE_KEY]: makeEntitlement({
          limit: null,
          resetPeriod: "none",
          scope: "event",
          enforcement: "feature",
          enabled: true,
        }),
      },
      counter: { entitlementKey: FEATURE_KEY, value: 4 },
    });

    const verdict = await releaseEntitlement(
      SESSION,
      TENANT,
      FEATURE_KEY,
      1,
      { counts: 0 },
      releaseSeams(fake)
    );

    expect(verdict).toMatchObject({ allowed: true, used: 0 });
    expect(counterWrites(fake)).toEqual([]);
  });
});
