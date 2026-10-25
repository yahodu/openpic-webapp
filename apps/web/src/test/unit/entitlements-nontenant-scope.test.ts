import type { ClientSession, Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import type { DomainEventInput } from "@/server/domain/domain-events";
import { fixedClock } from "@/server/runtime/clock";
import {
  consumeEntitlement,
  type EntitlementEventEmitter,
  type EntitlementVerdict,
} from "@/server/services/entitlements";

import { makeSubscription, makeUsageCounter } from "../factories/entitlements";
import { makeEntitlement, makePlan } from "../factories/plan";
import { makeFakeMongo, type FakeMongo, type RecordedCall } from "../helpers/fake-mongo";

/**
 * Unit contract — the non-`tenant` entitlement scope and the counter-advance
 * fallback (OP-103 follow-up, review finding **F1**; ADR-0342).
 *
 * ## The decision this pins: option (a)
 *
 * `consumeEntitlement` **does not advance `usageCounters` for an `event` or
 * `attendee` scope**. The caller's `ctx.counts` is the only usage source for
 * those keys, and the returned verdict's `used` equals `ctx.counts` — the
 * counter's post-increment value is *not* reported.
 *
 * The service already reads non-tenant usage from `ctx.counts`
 * (`resolveEntitlement`: `spec.scope === "tenant" ? readCounter() : ctx.counts`),
 * so a counter row it advances for such a key is never read back by the
 * decision — it is pollution. The schema's own `usageCounters` examples are all
 * `tenant`-scoped (§14.2), the §23 quota-bar read queries only
 * `{ tenantId, periodKey: { $in: [monthKey, "lifetime"] } }` (so a row written
 * for a non-tenant key leaks into it), and contract §3.5 states event/attendee
 * entitlements are returned "without `used`". Option (b) — the counter as the
 * sole usage source for every scope — would require a per-event/attendee
 * counter identity the `{tenantId, entitlementKey, periodKey}` unique index
 * cannot express.
 *
 * ## The invariants these specs pin (the card's three)
 *
 * 1. A returned verdict is **never** `allowed: true` with `used > effectiveLimit`
 *    or `remaining < 0`.
 * 2. A non-`tenant`-scoped consume must not write a `usageCounters` row that the
 *    decision never reads.
 * 3. When the conditional counter advance matches nothing on **both** attempts,
 *    `consumeEntitlement` must not report success off the stale counter — it
 *    re-decides (deny) or surfaces a conflict. The enforcement surface is
 *    pinned too (ADR-0343 §2): the lost race **throws** the Appendix A denial
 *    (`plan_limit_exceeded`, or `payment_required` when the re-read subscription
 *    is `downgraded`), it never *returns* an `allowed: false` verdict; it emits
 *    exactly one `usage.action.blocked`; and the denial's payload (`used`,
 *    `limit`) is the **re-read** state, not the pre-race counter.
 *
 * The atomic/integration view of (1)+(2) against a real replica set lives in
 * `src/test/integration/entitlements-nontenant-scope.test.ts`.
 *
 * @see {@link https://github.com/yahodu/openpic-webapp} schema §14.2/§23, contract §0.14/§3.5.
 */

/** The tenant every fixture is scoped to. */
const TENANT = "t_op103_nontenant";

/** The fixed instant the specs reason about (2026-09, mid-month). */
const NOW = "2026-09-15T10:00:00.000Z";

/** A tenant-scoped metered key (the fallback spec's subject). */
const TENANT_KEY = "events.active";

/** An `event`-scoped metered key (schema §14.1). */
const EVENT_KEY = "events.duration_days";

/** An `attendee`-scoped metered key (schema §14.1). */
const ATTENDEE_KEY = "selfies.per_attendee";

/** An `event`-scoped boolean feature gate (schema §14.1). */
const FEATURE_KEY = "originals.download";

/** The plan key the seeded plan and subscription agree on. */
const PLAN_KEY = "professional";

/** The injected outbox emitter: the deny path's emission without booting the outbox. */
const EMITTER: () => Promise<{ deduped: boolean; id: string | null }> = () =>
  Promise.resolve({ deduped: false, id: "evt_1" });

/** A stand-in session: the specs assert on reads and verdicts, not real writes. */
const SESSION = {} as ClientSession;

/**
 * Seed a fake database with one plan, one subscription and (optionally) one
 * counter row for the key under test.
 *
 * @param input - The plan entitlements and the pre-existing counter row.
 * @returns The recording fake.
 */
function seed(input: {
  readonly entitlements: Record<string, ReturnType<typeof makeEntitlement>>;
  readonly counter: { readonly entitlementKey: string; readonly value: number };
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
  fake.seed("usageCounters", [
    {
      ...makeUsageCounter({
        tenantId: TENANT,
        entitlementKey: input.counter.entitlementKey,
        value: input.counter.value,
      }),
    },
  ]);
  return fake;
}

/** The options every consume spec passes. */
function consumeSeams(fake: FakeMongo) {
  return { db: fake.db, clock: fixedClock(NOW), emit: EMITTER };
}

/** The counter write methods a consume must not issue for a non-tenant key. */
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

/**
 * A fake `Db` modelling a concurrent consumer: the decision reads a counter with
 * room, then the row can no longer accept the increment (both conditional
 * updates match nothing) and the fallback read sees the advanced value.
 *
 * The value the re-read observes is what makes the denial's payload
 * observable: the pre-race read yields `0`, the post-race re-read yields `5`,
 * so a payload reporting `used: 0` is the pre-race (stale) state.
 *
 * @param options - The subscription status the plan resolution reads.
 * @returns A `Db` whose counter row transitions under the advance.
 */
function makeLostRaceDb(options: { readonly subscriptionStatus?: string } = {}): Db {
  let counterValue = 0;
  const handle = (name: string): unknown => {
    if (name === COLLECTIONS.plans) {
      return {
        findOne: () =>
          Promise.resolve(
            makePlan({
              key: PLAN_KEY,
              entitlements: {
                [TENANT_KEY]: makeEntitlement({
                  limit: 3,
                  resetPeriod: "monthly",
                  scope: "tenant",
                }),
              },
            })
          ),
      };
    }
    if (name === COLLECTIONS.subscriptions) {
      return {
        findOne: () =>
          Promise.resolve({
            ...makeSubscription({
              tenantId: TENANT,
              status: options.subscriptionStatus ?? "active",
            }),
          }),
      };
    }
    if (name === COLLECTIONS.entitlementGrants) {
      return { find: () => ({ toArray: () => Promise.resolve([]) }) };
    }
    if (name === COLLECTIONS.usageCounters) {
      return {
        findOne: () => Promise.resolve({ value: counterValue }),
        findOneAndUpdate: () => {
          // The concurrent consumer wins the room between the decision and the advance.
          counterValue = 5;
          return Promise.resolve(null);
        },
      };
    }
    throw new Error(`unexpected collection ${name}`);
  };
  return { collection: handle } as unknown as Db;
}

/** The fields of a thrown denial these lost-race specs inspect. */
interface DenialErrorLike {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
}

/**
 * Await a call expected to be denied and return the thrown error.
 *
 * @param promise - The call under test.
 * @returns The thrown value, typed to the fields the contract pins.
 */
async function caughtDenial(promise: Promise<unknown>): Promise<DenialErrorLike> {
  try {
    await promise;
  } catch (error) {
    return error as DenialErrorLike;
  }
  throw new Error("expected the consume to be denied, but it resolved");
}

/**
 * Issue the lost-race consume: the decision reads room, but both conditional
 * counter updates match nothing (the concurrent consumer took the last unit)
 * and the re-read observes the advanced value.
 *
 * @param db - The `Db` that models the race.
 * @param emit - The outbox emitter seam; defaults to the silent stand-in.
 * @returns The consume's promise — denied, so it rejects.
 */
function consumeLostRace(
  db: Db,
  emit: EntitlementEventEmitter = EMITTER
): Promise<EntitlementVerdict> {
  return consumeEntitlement(
    SESSION,
    TENANT,
    TENANT_KEY,
    1,
    {},
    { db, clock: fixedClock(NOW), emit }
  );
}

describe("consumeEntitlement — non-tenant scope uses ctx.counts (option a)", () => {
  it("U8: an event-scoped consume reports the caller's count as `used`, not the counter row", async () => {
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

    const verdict = await consumeEntitlement(
      SESSION,
      TENANT,
      EVENT_KEY,
      1,
      { counts: 0 },
      consumeSeams(fake)
    );

    expect(verdict).toMatchObject({
      allowed: true,
      entitlementKey: EVENT_KEY,
      used: 0,
      remaining: 3,
      scope: "event",
    });
  });

  it("U8: an attendee-scoped consume with an over-limit counter still respects ctx.counts", async () => {
    const fake = seed({
      entitlements: {
        [ATTENDEE_KEY]: makeEntitlement({
          limit: 3,
          resetPeriod: "none",
          scope: "attendee",
          enforcement: "hard",
        }),
      },
      counter: { entitlementKey: ATTENDEE_KEY, value: 5 },
    });

    const verdict = await consumeEntitlement(
      SESSION,
      TENANT,
      ATTENDEE_KEY,
      1,
      { counts: 2 },
      consumeSeams(fake)
    );

    // ctx.counts (2) is the usage; the counter row (5) must not overdraw the verdict.
    expect(verdict).toMatchObject({ allowed: true, used: 2, remaining: 1, scope: "attendee" });
  });

  it("U8: an event-scoped consume writes no usageCounters row", async () => {
    const fake = seed({
      entitlements: {
        [EVENT_KEY]: makeEntitlement({
          limit: 3,
          resetPeriod: "none",
          scope: "event",
          enforcement: "hard",
        }),
      },
      counter: { entitlementKey: EVENT_KEY, value: 0 },
    });

    await consumeEntitlement(SESSION, TENANT, EVENT_KEY, 1, { counts: 0 }, consumeSeams(fake));

    expect(counterWrites(fake)).toEqual([]);
  });

  it("U8: an enabled event-scoped feature gate writes no usageCounters row", async () => {
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

    const verdict = await consumeEntitlement(
      SESSION,
      TENANT,
      FEATURE_KEY,
      1,
      { counts: 0 },
      consumeSeams(fake)
    );

    expect(verdict).toMatchObject({ allowed: true, used: 0 });
    expect(counterWrites(fake)).toEqual([]);
  });
});

describe("consumeEntitlement — the counter-advance fallback (tenant scope)", () => {
  it("U9: a failed advance is never reported as success off the stale counter", async () => {
    // The decision reads room, but both conditional updates match nothing (the
    // row advanced past the limit) and the fallback read sees `5`. The lost race
    // must deny through the enforcement surface ADR-0343 §2 chose — it throws the
    // Appendix A `plan_limit_exceeded`; it does not resolve an `allowed: false`
    // verdict off the stale counter.
    await expect(consumeLostRace(makeLostRaceDb())).rejects.toMatchObject({
      code: "plan_limit_exceeded",
    });
  });

  it("U9: the thrown denial carries the re-read used/limit, not the pre-race value", async () => {
    await expect(consumeLostRace(makeLostRaceDb())).rejects.toMatchObject({
      details: { entitlementKey: TENANT_KEY, reason: "plan_limit", used: 5, limit: 3 },
    });
  });

  it("U9: the lost race emits exactly one usage.action.blocked carrying the re-read used/limit", async () => {
    const emit = vi.fn((_input: DomainEventInput) =>
      Promise.resolve({ deduped: false, id: "evt_1" })
    );

    await caughtDenial(consumeLostRace(makeLostRaceDb(), emit));

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      eventKey: "usage.action.blocked",
      tenantId: TENANT,
      payload: {
        entitlementKey: TENANT_KEY,
        reason: "plan_limit",
        used: 5,
        limit: 3,
        periodKey: "2026-09",
        scope: "tenant",
      },
    });
  });

  it("U9: a lost race on a downgraded subscription denies with 402 payment_required", async () => {
    await expect(
      consumeLostRace(makeLostRaceDb({ subscriptionStatus: "downgraded" }))
    ).rejects.toMatchObject({ code: "payment_required", status: 402 });
  });
});
