import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { withTransaction } from "@/server/db/transaction";
import { consumeEntitlement, releaseEntitlement } from "@/server/services/entitlements";

import { makeSubscription, makeUsageCounter } from "../factories/entitlements";
import { makeEntitlement, makePlan } from "../factories/plan";
import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";

/**
 * Integration / contract — the non-`tenant` release scope against a real replica
 * set (OP-103 follow-up; ADR-0346).
 *
 * Option (a), pinned by `src/test/unit/entitlements-release-nontenant.test.ts`:
 * an `event`/`attendee`-scoped release takes its usage from the caller's
 * `ctx.counts` and **leaves `usageCounters` untouched**. This suite proves the
 * two observable consequences the unit write-log fake cannot: (i) a
 * counter row left behind by a prior non-tenant consume (the pollution class the
 * sibling F1 fix stopped for `consumeEntitlement`) is **not** decremented by a
 * release, and (ii) a release for a fresh non-tenant key creates **no** row — so
 * the schema §23 quota-bar read
 * (`usageCounters.find({ tenantId, periodKey: { $in: [monthKey, "lifetime"] } })`)
 * gains nothing from it.
 *
 * The `tenant`-scoped release (item 3 of the card) is guarded at the end: it
 * must still decrement and clamp at zero, byte-for-byte the behaviour `I5` pins
 * in `src/test/integration/entitlements.test.ts`.
 *
 * The suite runs against the `MongoMemoryReplSet` booted by the integration
 * `globalSetup`, so the unique `{tenantId, entitlementKey, periodKey}` index is
 * real and a stray counter write would be observable.
 */

/** The tenant every integration fixture is scoped to. */
const TENANT = "t_op103_release_nontenant_integration";

/** The plan key the seeded plan and subscription agree on. */
const PLAN_KEY = "professional";

/** An `event`-scoped metered key (schema §14.1). */
const EVENT_KEY = "events.duration_days";

/** An `attendee`-scoped metered key (schema §14.1). */
const ATTENDEE_KEY = "selfies.per_attendee";

/** A `tenant`-scoped metered key (the regression guard's subject). */
const TENANT_KEY = "events.active";

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

/** Insert a pre-existing `usageCounters` row (the prior-consume pollution). */
async function seedCounter(
  entitlementKey: string,
  periodKey: string,
  value: number
): Promise<void> {
  await app.db
    .collection(COLLECTIONS.usageCounters)
    .insertOne({ ...makeUsageCounter({ tenantId: TENANT, entitlementKey, periodKey, value }) });
}

/** The stored counter value for a key, or `null` when the row does not exist. */
async function counterValue(entitlementKey: string): Promise<number | null> {
  const row = await app.db
    .collection(COLLECTIONS.usageCounters)
    .findOne({ tenantId: TENANT, entitlementKey });
  return typeof row?.value === "number" ? row.value : null;
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op103-release-nontenant" });
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

describe("releaseEntitlement — a non-tenant release leaves usageCounters untouched (§14.2/§23)", () => {
  it("I9: an event-scoped release reports ctx.counts and does not decrement the counter row", async () => {
    await seedPlan({
      [EVENT_KEY]: makeEntitlement({
        limit: 3,
        resetPeriod: "none",
        scope: "event",
        enforcement: "hard",
      }),
    });
    await seedActiveSubscription();
    // The row a prior non-tenant consume would have written (the F1 pollution).
    await seedCounter(EVENT_KEY, "lifetime", 5);

    const verdict = await withTransaction((session) =>
      releaseEntitlement(session, TENANT, EVENT_KEY, 1, { counts: 2 }, { db: app.db })
    );

    expect(verdict).toMatchObject({ allowed: true, used: 2, remaining: 1, scope: "event" });
    // The pre-existing row is untouched: it is not the release's counter to write.
    await expect(counterValue(EVENT_KEY)).resolves.toBe(5);
  });

  it("I9: an event-scoped release for a fresh key creates no usageCounters row", async () => {
    await seedPlan({
      [EVENT_KEY]: makeEntitlement({
        limit: 3,
        resetPeriod: "none",
        scope: "event",
        enforcement: "hard",
      }),
    });
    await seedActiveSubscription();

    await withTransaction((session) =>
      releaseEntitlement(session, TENANT, EVENT_KEY, 1, { counts: 0 }, { db: app.db })
    );

    await expect(counterValue(EVENT_KEY)).resolves.toBeNull();

    // The schema §23 quota-bar read must therefore not surface the key.
    const quotaRows = await app.db
      .collection(COLLECTIONS.usageCounters)
      .find({ tenantId: TENANT, periodKey: { $in: [monthKey(), "lifetime"] } })
      .toArray();
    expect(quotaRows.map((row) => row.entitlementKey)).not.toContain(EVENT_KEY);
  });

  it("I10: an attendee-scoped release reports ctx.counts and does not decrement the counter row", async () => {
    await seedPlan({
      [ATTENDEE_KEY]: makeEntitlement({
        limit: 5,
        resetPeriod: "none",
        scope: "attendee",
        enforcement: "hard",
      }),
    });
    await seedActiveSubscription();
    await seedCounter(ATTENDEE_KEY, "lifetime", 3);

    const verdict = await withTransaction((session) =>
      releaseEntitlement(session, TENANT, ATTENDEE_KEY, 4, { counts: 1 }, { db: app.db })
    );

    expect(verdict).toMatchObject({ allowed: true, used: 0, remaining: 5, scope: "attendee" });
    await expect(counterValue(ATTENDEE_KEY)).resolves.toBe(3);
  });
});

describe("releaseEntitlement — the tenant-scoped release is unchanged (§0.14 C6)", () => {
  it("I11: releasing after a consume decrements the counter and restores the remaining amount", async () => {
    await seedPlan({
      [TENANT_KEY]: makeEntitlement({
        limit: 3,
        resetPeriod: "monthly",
        scope: "tenant",
        enforcement: "hard",
      }),
    });
    await seedActiveSubscription();
    await withTransaction((session) =>
      consumeEntitlement(session, TENANT, TENANT_KEY, 2, {}, { db: app.db })
    );

    const released = await withTransaction((session) =>
      releaseEntitlement(session, TENANT, TENANT_KEY, 1, {}, { db: app.db })
    );

    expect(released).toMatchObject({ allowed: true, used: 1, remaining: 2 });
    await expect(counterValue(TENANT_KEY)).resolves.toBe(1);
  });

  it("I11: a tenant-scoped release beyond the counter clamps at zero", async () => {
    await seedPlan({
      [TENANT_KEY]: makeEntitlement({
        limit: 3,
        resetPeriod: "monthly",
        scope: "tenant",
        enforcement: "hard",
      }),
    });
    await seedActiveSubscription();
    await withTransaction((session) =>
      consumeEntitlement(session, TENANT, TENANT_KEY, 1, {}, { db: app.db })
    );

    const released = await withTransaction((session) =>
      releaseEntitlement(session, TENANT, TENANT_KEY, 5, {}, { db: app.db })
    );

    expect(released).toMatchObject({ allowed: true, used: 0, remaining: 3 });
    await expect(counterValue(TENANT_KEY)).resolves.toBe(0);
  });
});
