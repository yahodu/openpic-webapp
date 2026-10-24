import type { ClientSession } from "mongodb";
import { describe, expect, it } from "vitest";

import { fixedClock } from "@/server/runtime/clock";
import {
  checkEntitlement,
  consumeEntitlement,
  effectiveLimit,
  periodKey,
  type EntitlementGrant,
} from "@/server/services/entitlements";

import { makeGrant, makeSubscription, makeUsageCounter } from "../factories/entitlements";
import { makeEntitlement, makePlan } from "../factories/plan";
import { makeFakeMongo, type FakeMongo } from "../helpers/fake-mongo";

/**
 * Unit contract — the generic entitlement check and consumption service
 * (OP-103, schema §14.2, contract §0.14).
 *
 * The metered-write rule is *policy as data*: `plans.entitlements[key]` is a
 * self-describing spec (`limit` + `resetPeriod` + `scope` + `enforcement`) and
 * the service must resolve it generically — no tier name may appear in the
 * code, and a disabled feature, an unlimited limit and an ungated key are all
 * decided from the spec. These specs pin that decision surface with the
 * recording fake `Db`; the atomic, in-transaction consumption and the
 * `usage.action.blocked` emission are proven against a replica set in
 * `src/test/integration/entitlements.test.ts`.
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/services/entitlements
 *   effectiveLimit(spec: Entitlement, grants: readonly EntitlementGrant[], now: Date): number | null
 *   periodKey(resetPeriod, now: Date): string
 *   checkEntitlement(tenantId, entitlementKey, amount = 1, ctx = {}, options = {}): Promise<EntitlementVerdict>
 *   consumeEntitlement(session, tenantId, entitlementKey, amount = 1, ctx = {}, options = {}): Promise<EntitlementVerdict>
 * ```
 *
 * `EntitlementVerdict` is a discriminated union on `allowed`:
 *
 * ```ts
 * { allowed: true; entitlementKey; limit; effectiveLimit; used; remaining;
 *   periodKey; scope; unlimited: boolean }
 * | { allowed: false; reason: "plan_limit" | "payment_downgrade" | "feature_not_available";
 *     entitlementKey; limit; effectiveLimit; used; periodKey; scope;
 *     pendingDueMinor: number | null; currency: string | null;
 *     gracePeriodEndsAt: Date | null }
 * ```
 *
 * `checkEntitlement` is the **decision**: it never throws for a denial, it
 * returns the denied verdict. `consumeEntitlement` is the **enforcement point**
 * a route uses for a metered write: it re-checks inside the caller's
 * transaction, performs the atomic conditional `$inc`, and on a denial throws
 * the Appendix A `AppError` (`plan_limit_exceeded` / `payment_required` /
 * `feature_not_available`) after emitting `usage.action.blocked`.
 *
 * `options` seams: `{ db?: Db; clock?: Clock; session?: ClientSession }` on the
 * check and `{ db?: Db; clock?: Clock; emit?: EntitlementEventEmitter }` on the
 * consume (the injected `emit` is what lets a unit spec observe the denial path
 * without booting the outbox).
 *
 * `ctx` is `{ counts?: number; actorRef?: DomainEventRef; subjectRef?: DomainEventRef }`:
 * `counts` supplies the usage for an `event`/`attendee`-scoped key (the service
 * reads the counter itself only for `tenant` scope), and the refs are used when
 * the denial emits `usage.action.blocked`. When omitted they default to
 * `{ kind: "tenant", id: tenantId }` and `{ kind: "entitlement", id: entitlementKey }`.
 */

/** The tenant every unit fixture is scoped to. */
const TENANT = "t_op103_unit";

/** The fixed instant the specs reason about (2026-09-15, mid-month). */
const NOW = "2026-09-15T10:00:00.000Z";

/** The `events.active` key the plan fixtures gate on. */
const KEY = "events.active";

/** Seed a fake database with one plan, one subscription and one counter. */
function seed(input: {
  readonly entitlements: Record<string, ReturnType<typeof makeEntitlement>>;
  readonly planKey?: string;
  readonly subscription?: Partial<Parameters<typeof makeSubscription>[0]>;
  readonly used?: number;
}): FakeMongo {
  const planKey = input.planKey ?? "professional";
  const fake = makeFakeMongo();
  fake.seed("plans", [makePlan({ key: planKey, entitlements: input.entitlements })]);
  fake.seed("subscriptions", [
    { ...makeSubscription({ tenantId: TENANT, activePlanKey: planKey, ...input.subscription }) },
  ]);
  fake.seed("usageCounters", [
    { ...makeUsageCounter({ tenantId: TENANT, entitlementKey: KEY, value: input.used ?? 0 }) },
  ]);
  return fake;
}

/** The injected outbox emitter: the deny path's emission without booting the outbox. */
const EMITTER: () => Promise<{ deduped: boolean; id: string | null }> = () =>
  Promise.resolve({ deduped: false, id: "evt_1" });

/** The options every check/consume spec passes. */
function seams(fake: FakeMongo) {
  const clock = fixedClock(NOW);
  return {
    check: { db: fake.db, clock },
    consume: { db: fake.db, clock, emit: EMITTER },
  };
}

/** A stand-in session: the deny path never reaches a write. */
const SESSION = {} as ClientSession;

/** The shape of a thrown `AppError` these specs inspect. */
interface AppErrorLike {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
}

/**
 * Await a call expected to be denied and return the thrown error.
 *
 * @param promise - The call under test.
 * @returns The thrown value, typed to the fields a contract assertion reads.
 */
async function denialError(promise: Promise<unknown>): Promise<AppErrorLike> {
  try {
    await promise;
  } catch (error) {
    return error as AppErrorLike;
  }
  throw new Error("expected the entitlement call to be denied, but it resolved");
}

describe("effectiveLimit — the effective limit is data, never a branch", () => {
  it("U1: returns the raw plan limit when there are no grants", () => {
    const spec = makeEntitlement({ limit: 7 });

    expect(effectiveLimit(spec, [], new Date(NOW))).toBe(7);
  });

  it("U1: adds every active grant delta to the plan limit", () => {
    const spec = makeEntitlement({ limit: 7 });
    const grants: EntitlementGrant[] = [makeGrant({ delta: 3 }), makeGrant({ delta: 10 })];

    expect(effectiveLimit(spec, grants, new Date(NOW))).toBe(20);
  });

  it("U1: an overrideLimit replaces the plan limit and the deltas entirely", () => {
    const spec = makeEntitlement({ limit: 7 });
    const grants: EntitlementGrant[] = [makeGrant({ delta: 3, overrideLimit: 42 })];

    expect(effectiveLimit(spec, grants, new Date(NOW))).toBe(42);
  });

  it("U1: ignores a grant that has already expired", () => {
    const spec = makeEntitlement({ limit: 7 });
    const grants: EntitlementGrant[] = [
      makeGrant({ delta: 5, validUntil: new Date("2026-09-15T09:59:59.999Z") }),
    ];

    expect(effectiveLimit(spec, grants, new Date(NOW))).toBe(7);
  });

  it("U1: ignores a grant that has not started yet", () => {
    const spec = makeEntitlement({ limit: 7 });
    const grants: EntitlementGrant[] = [
      makeGrant({ delta: 5, validFrom: new Date("2026-09-15T10:00:00.001Z") }),
    ];

    expect(effectiveLimit(spec, grants, new Date(NOW))).toBe(7);
  });

  it("U1: an unlimited plan limit stays unlimited however many grants exist", () => {
    const spec = makeEntitlement({ limit: null, enforcement: "hard" });
    const grants: EntitlementGrant[] = [makeGrant({ delta: 5 })];

    expect(effectiveLimit(spec, grants, new Date(NOW))).toBeNull();
  });
});

describe("periodKey — one key per reset cadence", () => {
  it.each([
    ["monthly", "2026-09-15T00:00:00.000Z", "2026-09"],
    ["monthly", "2026-09-30T23:59:59.000Z", "2026-09"],
    ["monthly", "2026-10-01T00:00:00.000Z", "2026-10"],
    ["yearly", "2026-01-01T00:00:00.000Z", "2026"],
    ["yearly", "2026-12-31T23:59:59.000Z", "2026"],
    ["lifetime", "2026-09-15T00:00:00.000Z", "lifetime"],
    ["none", "2026-09-15T00:00:00.000Z", "lifetime"],
  ] as const)("U2: %s at %s -> %s", (resetPeriod, at, expected) => {
    expect(periodKey(resetPeriod, new Date(at))).toBe(expected);
  });
});

describe("checkEntitlement — the decision never throws", () => {
  it("U3: an unlimited hard limit allows the write whatever the usage", async () => {
    const fake = seed({
      entitlements: { [KEY]: makeEntitlement({ limit: null, enforcement: "hard" }) },
      used: 10_000,
    });

    const verdict = await checkEntitlement(TENANT, KEY, 1, {}, seams(fake).check);

    expect(verdict).toMatchObject({
      allowed: true,
      entitlementKey: KEY,
      limit: null,
      effectiveLimit: null,
      unlimited: true,
      remaining: null,
      periodKey: "2026-09",
    });
  });

  it("U4: a disabled feature entitlement is denied as feature_not_available", async () => {
    const fake = seed({
      entitlements: {
        "originals.download": makeEntitlement({
          limit: null,
          resetPeriod: "none",
          scope: "event",
          enforcement: "feature",
          enabled: false,
        }),
      },
    });

    const verdict = await checkEntitlement(TENANT, "originals.download", 1, {}, seams(fake).check);

    expect(verdict).toMatchObject({
      allowed: false,
      reason: "feature_not_available",
      entitlementKey: "originals.download",
    });
  });

  it("U4: consuming a disabled feature throws 403 feature_not_available", async () => {
    const fake = seed({
      entitlements: {
        "originals.download": makeEntitlement({
          limit: null,
          resetPeriod: "none",
          scope: "event",
          enforcement: "feature",
          enabled: false,
        }),
      },
    });
    const options = seams(fake).consume;

    const error = await denialError(
      consumeEntitlement(SESSION, TENANT, "originals.download", 1, {}, options)
    );

    expect(error.code).toBe("feature_not_available");
    expect(error.status).toBe(403);
  });

  it("U5: a downgraded subscription is denied with the payment_downgrade reason", async () => {
    const gracePeriodEndsAt = new Date("2026-09-20T10:00:00.000Z");
    const fake = seed({
      entitlements: { [KEY]: makeEntitlement({ limit: 1 }) },
      planKey: "free",
      used: 1,
      subscription: {
        status: "downgraded",
        activePlanKey: "free",
        subscribedPlanKey: "professional",
        pendingDueMinor: 49_900,
        currency: "INR",
        gracePeriodEndsAt,
      },
    });

    const verdict = await checkEntitlement(TENANT, KEY, 1, {}, seams(fake).check);

    expect(verdict).toMatchObject({
      allowed: false,
      reason: "payment_downgrade",
      entitlementKey: KEY,
      limit: 1,
      used: 1,
      periodKey: "2026-09",
    });
  });

  it("U5: consuming on a downgraded subscription throws 402 payment_required with the pay-now details", async () => {
    const gracePeriodEndsAt = new Date("2026-09-20T10:00:00.000Z");
    const fake = seed({
      entitlements: { [KEY]: makeEntitlement({ limit: 1 }) },
      planKey: "free",
      used: 1,
      subscription: {
        status: "downgraded",
        activePlanKey: "free",
        subscribedPlanKey: "professional",
        pendingDueMinor: 49_900,
        currency: "INR",
        gracePeriodEndsAt,
      },
    });
    const options = seams(fake).consume;

    const error = await denialError(consumeEntitlement(SESSION, TENANT, KEY, 1, {}, options));

    expect(error.code).toBe("payment_required");
    expect(error.status).toBe(402);
    expect(error.details).toMatchObject({
      entitlementKey: KEY,
      reason: "payment_downgrade",
      pendingDueMinor: 49_900,
      currency: "INR",
      gracePeriodEndsAt: gracePeriodEndsAt.toISOString(),
    });
    // The exact route is not pinned by the contract (§0.14 lists only the field);
    // it must be a pay-now URL scoped to this tenant.
    expect(String(error.details?.payNowUrl)).toContain(TENANT);
  });

  it("U6: a key the active plan does not gate is allowed", async () => {
    const fake = seed({ entitlements: { [KEY]: makeEntitlement({ limit: 1 }) }, used: 5 });

    const verdict = await checkEntitlement(
      TENANT,
      "gallery.retention_days",
      1,
      {},
      seams(fake).check
    );

    expect(verdict.allowed).toBe(true);
  });

  it("U6: an unknown key is allowed even when the tenant has no subscription row", async () => {
    const fake = makeFakeMongo();
    fake.seed("plans", [makePlan({ key: "free", entitlements: { [KEY]: makeEntitlement() } })]);

    const verdict = await checkEntitlement(
      TENANT,
      "coorganizers.per_event",
      1,
      {},
      seams(fake).check
    );

    expect(verdict.allowed).toBe(true);
  });
});
