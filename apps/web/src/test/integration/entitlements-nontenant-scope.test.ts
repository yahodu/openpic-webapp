import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { withTransaction } from "@/server/db/transaction";
import { consumeEntitlement } from "@/server/services/entitlements";

import { makeSubscription } from "../factories/entitlements";
import { makeEntitlement, makePlan } from "../factories/plan";
import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";

/**
 * Integration / contract — the non-`tenant` entitlement scope against a real
 * replica set (OP-103 follow-up, review finding **F1**; ADR-0342).
 *
 * Option (a), pinned by `src/test/unit/entitlements-nontenant-scope.test.ts`:
 * an `event`/`attendee`-scoped consume takes its usage from the caller's
 * `ctx.counts` and **writes no `usageCounters` row**. This suite proves the two
 * observable consequences the unit fake cannot: (i) nothing is persisted for
 * such a key, and (ii) the schema §23 quota-bar read
 * (`usageCounters.find({ tenantId, periodKey: { $in: [monthKey, "lifetime"] } })`)
 * therefore never surfaces one.
 *
 * The suite runs against the `MongoMemoryReplSet` booted by the integration
 * `globalSetup`, so the unique `{tenantId, entitlementKey, periodKey}` index is
 * real and a stray non-tenant counter row would be observable.
 */

/** The tenant every integration fixture is scoped to. */
const TENANT = "t_op103_nontenant_integration";

/** The plan key the seeded plan and subscription agree on. */
const PLAN_KEY = "professional";

/** An `event`-scoped metered key (schema §14.1). */
const EVENT_KEY = "events.duration_days";

/** An `attendee`-scoped metered key (schema §14.1). */
const ATTENDEE_KEY = "selfies.per_attendee";

let app: TestApp;

/** The current UTC month key (the `monthly` bucket the §23 read queries). */
function monthKey(): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${String(now.getUTCFullYear())}-${month}`;
}

/** Seed the active plan with the given entitlement specs. */
async function seedPlan(
  entitlements: Record<string, ReturnType<typeof makeEntitlement>>
): Promise<void> {
  await app.db.collection(COLLECTIONS.plans).insertOne(makePlan({ key: PLAN_KEY, entitlements }));
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

/** The stored counter value for a key, or `0` when the row does not exist. */
async function counterValue(entitlementKey: string): Promise<number> {
  const row = await app.db
    .collection(COLLECTIONS.usageCounters)
    .findOne({ tenantId: TENANT, entitlementKey });
  return typeof row?.value === "number" ? row.value : 0;
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op103-nontenant" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await app.db.collection(COLLECTIONS.plans).deleteMany({});
  await app.db.collection(COLLECTIONS.subscriptions).deleteMany({});
  await app.db.collection(COLLECTIONS.usageCounters).deleteMany({});
  await app.db.collection(COLLECTIONS.entitlementGrants).deleteMany({});
  await app.db.collection(COLLECTIONS.domainEvents).deleteMany({});
});

afterAll(async () => {
  await app.cleanup();
});

describe("consumeEntitlement — a non-tenant consume writes no counter row (§14.2/§23)", () => {
  it("I7: an event-scoped consume reports ctx.counts and persists no usageCounters row", async () => {
    await seedPlan({
      [EVENT_KEY]: makeEntitlement({
        limit: 3,
        resetPeriod: "none",
        scope: "event",
        enforcement: "hard",
      }),
    });
    await seedActiveSubscription();

    const verdict = await withTransaction((session) =>
      consumeEntitlement(session, TENANT, EVENT_KEY, 1, { counts: 0 }, { db: app.db })
    );

    expect(verdict).toMatchObject({ allowed: true, used: 0, remaining: 3, scope: "event" });
    await expect(counterValue(EVENT_KEY)).resolves.toBe(0);

    // The schema §23 quota-bar read must not surface a non-tenant key.
    const quotaRows = await app.db
      .collection(COLLECTIONS.usageCounters)
      .find({ tenantId: TENANT, periodKey: { $in: [monthKey(), "lifetime"] } })
      .toArray();
    expect(quotaRows.map((row) => row.entitlementKey)).not.toContain(EVENT_KEY);
  });

  it("I8: an attendee-scoped consume reports ctx.counts and persists no usageCounters row", async () => {
    await seedPlan({
      [ATTENDEE_KEY]: makeEntitlement({
        limit: 3,
        resetPeriod: "none",
        scope: "attendee",
        enforcement: "hard",
      }),
    });
    await seedActiveSubscription();

    const verdict = await withTransaction((session) =>
      consumeEntitlement(session, TENANT, ATTENDEE_KEY, 1, { counts: 2 }, { db: app.db })
    );

    expect(verdict).toMatchObject({ allowed: true, used: 2, remaining: 1, scope: "attendee" });
    await expect(counterValue(ATTENDEE_KEY)).resolves.toBe(0);
  });
});
