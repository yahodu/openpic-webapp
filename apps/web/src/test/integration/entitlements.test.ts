import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { withTransaction } from "@/server/db/transaction";
import { fixedClock } from "@/server/runtime/clock";
import {
  checkEntitlement,
  consumeEntitlement,
  releaseEntitlement,
} from "@/server/services/entitlements";

import { makeGrant, makeSubscription, makeUsageCounter } from "../factories/entitlements";
import { makeEntitlement, makePlan } from "../factories/plan";
import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";

/**
 * Integration / contract — the generic entitlement check, consumption and
 * release (OP-103, schema §14.2/§14.3/§23, contract §0.14).
 *
 * Every metered write is checked against plan data *inside the same
 * transaction* as the counter `$inc`, so concurrency can never exceed a limit
 * and an aborted domain write leaves no usage behind. These specs run against
 * the `MongoMemoryReplSet` booted by the integration `globalSetup`, so the
 * atomicity is real; the pure decision surface is unit-pinned in
 * `src/test/unit/entitlements.test.ts`.
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/services/entitlements
 *   checkEntitlement(tenantId, entitlementKey, amount = 1, ctx = {}, { db?, clock?, session? })
 *     : Promise<EntitlementVerdict>
 *   consumeEntitlement(session, tenantId, entitlementKey, amount = 1, ctx = {}, { db?, clock?, emit? })
 *     : Promise<EntitlementVerdict>   // throws the Appendix A AppError on denial
 *   releaseEntitlement(session, tenantId, entitlementKey, amount = 1, ctx = {}, { db?, clock? })
 *     : Promise<EntitlementVerdict>   // clamped at zero
 * ```
 *
 * - `consumeEntitlement` is **race-safe**: the counter is advanced with one
 *   conditional update whose filter admits the write only while
 *   `value <= effectiveLimit - amount`, upserting the row on first use. This
 *   requires the `{ tenantId: 1, entitlementKey: 1, periodKey: 1 }` **unique**
 *   index from schema §14.2 to be registered in `INDEX_SPECS` (the suite calls
 *   `ensureIndexes`, and ten concurrent transactions must still admit exactly
 *   the remaining amount).
 * - Every read and write it performs uses the caller's `session`, so the check,
 *   the `$inc` and the caller's domain write commit or abort together.
 * - A denial emits **one** `usage.action.blocked` domain event per
 *   `{ tenant, entitlementKey, hour }` bucket — the dedupe key is what collapses
 *   the repeats (schema §18.3). The event does **not** join the caller's
 *   transaction: a blocked write leaves no metered row but must leave the durable
 *   notification, so it is written outside the session and survives the abort.
 *
 * ## Assumptions recorded in the handoff (ADR-0340)
 *
 * - `tenantId` is a plain string compared as-is; the specs write it into the
 *   fixture rows unchanged (no `ObjectId` conversion).
 * - `details.payNowUrl`'s exact path is not fixed by the contract (§0.14 names
 *   only the field); the specs assert only that it is a tenant-scoped string.
 * - Scope `event`/`attendee` counts come from `ctx.counts` and are out of scope
 *   here (only `tenant`-scoped keys are exercised).
 */

/** The tenant every integration fixture is scoped to. */
const TENANT = "t_op103_integration";

/** The plan key the seeded plan and subscription agree on. */
const PLAN_KEY = "starter";

/** The metered key under test (schema §14.1 `events.active`). */
const KEY = "events.active";

/**
 * The counter and grant collections (schema §14.2). Spelled literally rather
 * than through `COLLECTIONS` because registering them there is part of the
 * GREEN work this RED pins; a literal keeps the spec runnable in both states.
 */
const USAGE_COUNTERS = "usageCounters";
const ENTITLEMENT_GRANTS = "entitlementGrants";

let app: TestApp;

/** Seed the active plan with one `events.active` entitlement at `limit`. */
async function seedPlan(limit: number | null): Promise<void> {
  await app.db.collection(COLLECTIONS.plans).insertOne(
    makePlan({
      key: PLAN_KEY,
      entitlements: {
        [KEY]: makeEntitlement({
          limit,
          resetPeriod: "monthly",
          scope: "tenant",
          enforcement: "hard",
        }),
      },
    })
  );
}

/** Seed the live subscription that makes `PLAN_KEY` the active plan. */
async function seedActiveSubscription(): Promise<void> {
  await app.db.collection(COLLECTIONS.subscriptions).insertOne(
    makeSubscription({
      tenantId: TENANT,
      subscribedPlanKey: PLAN_KEY,
      activePlanKey: PLAN_KEY,
      status: "active",
    })
  );
}

/** Insert a grant row for the metered key, with the fixture's window. */
async function seedGrant(grant: {
  readonly delta: number;
  readonly validFrom: Date;
  readonly validUntil: Date | null;
}): Promise<void> {
  await app.db
    .collection(ENTITLEMENT_GRANTS)
    .insertOne({ ...grant, tenantId: TENANT, entitlementKey: KEY, overrideLimit: null });
}

/** The stored counter value, or `0` when the row does not exist yet. */
async function counterValue(): Promise<number> {
  const row = await app.db
    .collection(USAGE_COUNTERS)
    .findOne({ tenantId: TENANT, entitlementKey: KEY });
  return typeof row?.value === "number" ? row.value : 0;
}

/** The `error.code` of every rejected outcome, in settlement order. */
function rejectionCodes(outcomes: readonly PromiseSettledResult<unknown>[]): string[] {
  return outcomes
    .filter((outcome) => outcome.status === "rejected")
    .map((outcome) => {
      const reason: unknown = outcome.reason;
      if (typeof reason === "object" && reason !== null && "code" in reason) {
        const code: unknown = reason.code;
        return typeof code === "string" ? code : "";
      }
      return "";
    });
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op103-entitlements" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await app.db.collection(COLLECTIONS.plans).deleteMany({});
  await app.db.collection(COLLECTIONS.subscriptions).deleteMany({});
  await app.db.collection(USAGE_COUNTERS).deleteMany({});
  await app.db.collection(ENTITLEMENT_GRANTS).deleteMany({});
  await app.db.collection(COLLECTIONS.domainEvents).deleteMany({});
});

afterAll(async () => {
  await app.cleanup();
});

describe("consumeEntitlement — atomic consumption (§0.14)", () => {
  it("I1: ten concurrent consumes against a remaining three admit exactly three", async () => {
    await seedPlan(3);
    await seedActiveSubscription();

    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        withTransaction(
          (session) => consumeEntitlement(session, TENANT, KEY, 1, {}, { db: app.db }),
          { maxAttempts: 10 }
        )
      )
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(3);
    await expect(counterValue()).resolves.toBe(3);

    const denialCodes = rejectionCodes(outcomes);
    expect(denialCodes).toEqual(Array.from({ length: 7 }, () => "plan_limit_exceeded"));
  });

  it("I4: an aborted transaction leaves the counter untouched", async () => {
    await seedPlan(3);
    await seedActiveSubscription();

    await expect(
      withTransaction(async (session) => {
        await consumeEntitlement(session, TENANT, KEY, 1, {}, { db: app.db });
        throw new Error("domain write failed");
      })
    ).rejects.toThrow("domain write failed");

    await expect(counterValue()).resolves.toBe(0);

    // The rollback must release the capacity too: the whole limit is still spendable.
    await withTransaction((session) =>
      consumeEntitlement(session, TENANT, KEY, 3, {}, { db: app.db })
    );
    await expect(counterValue()).resolves.toBe(3);
  });
});

describe("consumeEntitlement — grants are additive and time-bounded (§14.2)", () => {
  it("I2: an expired grant does not raise the effective limit", async () => {
    await seedPlan(1);
    await seedActiveSubscription();
    await seedGrant(makeGrant({ delta: 5, validUntil: new Date("2026-09-14T10:00:00.000Z") }));
    const options = { db: app.db, clock: fixedClock("2026-09-15T10:00:00.000Z") };

    await expect(checkEntitlement(TENANT, KEY, 1, {}, options)).resolves.toMatchObject({
      allowed: true,
      limit: 1,
      effectiveLimit: 1,
    });
    await expect(checkEntitlement(TENANT, KEY, 2, {}, options)).resolves.toMatchObject({
      allowed: false,
      reason: "plan_limit",
    });
  });

  it("I6: a grant is ignored at exactly validUntil", async () => {
    await seedPlan(1);
    await seedActiveSubscription();
    const now = new Date("2026-09-15T10:00:00.000Z");
    await seedGrant(makeGrant({ delta: 5, validUntil: now }));

    const verdict = await checkEntitlement(
      TENANT,
      KEY,
      1,
      {},
      {
        db: app.db,
        clock: fixedClock(now),
      }
    );

    // validFrom <= now < validUntil — the upper bound is exclusive.
    expect(verdict).toMatchObject({ allowed: true, limit: 1, effectiveLimit: 1 });
  });

  it("I6: a grant valid one millisecond past now is counted", async () => {
    await seedPlan(1);
    await seedActiveSubscription();
    const now = new Date("2026-09-15T10:00:00.000Z");
    await seedGrant(makeGrant({ delta: 5, validUntil: new Date(now.getTime() + 1) }));

    const verdict = await checkEntitlement(
      TENANT,
      KEY,
      1,
      {},
      {
        db: app.db,
        clock: fixedClock(now),
      }
    );

    expect(verdict).toMatchObject({ allowed: true, limit: 1, effectiveLimit: 6 });
  });
});

describe("consumeEntitlement — a denial is recorded once per hour bucket (§0.14)", () => {
  it("I3: the same hour's second denial does not emit a second event", async () => {
    await seedPlan(1);
    await seedActiveSubscription();
    await app.db
      .collection(USAGE_COUNTERS)
      .insertOne(
        makeUsageCounter({ tenantId: TENANT, entitlementKey: KEY, periodKey: "2026-09", value: 1 })
      );
    const clock = fixedClock("2026-09-15T10:15:00.000Z");
    const deny = (): Promise<unknown> =>
      withTransaction(
        (session) => consumeEntitlement(session, TENANT, KEY, 1, {}, { db: app.db, clock }),
        { maxAttempts: 5 }
      );

    await expect(deny()).rejects.toMatchObject({ code: "plan_limit_exceeded" });
    await expect(deny()).rejects.toMatchObject({ code: "plan_limit_exceeded" });

    const emitted = await app.db
      .collection(COLLECTIONS.domainEvents)
      .countDocuments({ eventKey: "usage.action.blocked", tenantId: TENANT });
    expect(emitted).toBe(1);
  });

  it("I3: a denial in the next hour bucket emits a second event", async () => {
    await seedPlan(1);
    await seedActiveSubscription();
    await app.db
      .collection(USAGE_COUNTERS)
      .insertOne(
        makeUsageCounter({ tenantId: TENANT, entitlementKey: KEY, periodKey: "2026-09", value: 1 })
      );
    const denyAt = (instant: string): Promise<unknown> =>
      withTransaction(
        (session) =>
          consumeEntitlement(
            session,
            TENANT,
            KEY,
            1,
            {},
            {
              db: app.db,
              clock: fixedClock(instant),
            }
          ),
        { maxAttempts: 5 }
      );

    await expect(denyAt("2026-09-15T10:15:00.000Z")).rejects.toMatchObject({
      code: "plan_limit_exceeded",
    });
    await expect(denyAt("2026-09-15T11:15:00.000Z")).rejects.toMatchObject({
      code: "plan_limit_exceeded",
    });

    const emitted = await app.db
      .collection(COLLECTIONS.domainEvents)
      .countDocuments({ eventKey: "usage.action.blocked", tenantId: TENANT });
    expect(emitted).toBe(2);
  });
});

describe("releaseEntitlement — a reversal restores the remaining amount (§0.14 C6)", () => {
  it("I5: releasing after an image delete restores the remaining amount", async () => {
    await seedPlan(3);
    await seedActiveSubscription();
    await withTransaction((session) =>
      consumeEntitlement(session, TENANT, KEY, 1, {}, { db: app.db })
    );
    await withTransaction((session) =>
      consumeEntitlement(session, TENANT, KEY, 1, {}, { db: app.db })
    );

    const released = await withTransaction((session) =>
      releaseEntitlement(session, TENANT, KEY, 1, {}, { db: app.db })
    );

    expect(released).toMatchObject({ allowed: true, used: 1, remaining: 2 });
    await expect(counterValue()).resolves.toBe(1);
  });

  it("I5: releasing more than was consumed clamps the counter at zero", async () => {
    await seedPlan(3);
    await seedActiveSubscription();
    await withTransaction((session) =>
      consumeEntitlement(session, TENANT, KEY, 1, {}, { db: app.db })
    );

    const released = await withTransaction((session) =>
      releaseEntitlement(session, TENANT, KEY, 5, {}, { db: app.db })
    );

    expect(released).toMatchObject({ allowed: true, used: 0, remaining: 3 });
    await expect(counterValue()).resolves.toBe(0);
  });
});
