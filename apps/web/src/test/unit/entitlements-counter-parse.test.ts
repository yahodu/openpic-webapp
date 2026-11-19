import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { readEntitlementsView } from "@/server/services/entitlements";

import { makeUsageCounter } from "../factories/entitlements";
import { makeEntitlement, makePlan } from "../factories/plan";
import { makeFakeMongo, type FakeMongo } from "../helpers/fake-mongo";

/**
 * Unit contract — `readEntitlementsView` **parses** the counter rows it fetches
 * (OP-104 follow-up, ADR-0368).
 *
 * ## Why this file exists: the L8 discrimination gap
 *
 * ADR-0367 §Consequences claims that "a regression that loosens or drops
 * `storedCounterSchema.parse` on the fetched rows now fails on L8". That claim
 * was measured false. L8 in
 * `src/test/integration/entitlements-endpoints.test.ts` asserts only the wire
 * pair `status === 500` + `code === "internal_error"`, and the wire stays
 * fail-closed either way: with the parse dropped (`view.ts:261` replaced by a
 * pass-through cast) a non-numeric `value` fails later, in the response-model
 * serialisation, and the route still answers `500 internal_error`. L8 therefore
 * cannot tell the two mechanisms apart.
 *
 * This file pins the mechanism itself. It calls the service directly — no
 * booted app, no replica set, no route — so a dropped or loosened parse fails
 * here for the right reason (`the read resolved a corrupt counter row`) instead
 * of hiding behind a status code that is `500` for several causes.
 *
 * ## Characterization, not RED
 *
 * Both arms pass on `origin/main` `dbf93bf3`, where
 * `counterRows.map((row) => storedCounterSchema.parse(row))` is in place. This
 * is a regression lock: a red means the parse moved, not that work is owed.
 *
 * ## What the fake `Db` does and does not model
 *
 * `makeFakeMongo` records the driver calls but returns `find`'s seeded rows
 * regardless of the filter, so the `$or` over the plan's `tenant`-scoped
 * `(entitlementKey, periodKey)` pairs is not evaluated here — faithfulness of
 * that filter is the integration spec's job (L7/L8). What this file needs is
 * only that the row reaches the parse, which it does.
 */

/** The workspace every fixture is scoped to. */
const TENANT = "t_op104_counter_parse";

/** The instant the read reasons about (2026-09, mid-month). */
const NOW = new Date("2026-09-15T10:00:00.000Z");

/** The `periodKey` of {@link NOW} at the seeded key's monthly cadence. */
const PERIOD = "2026-09";

/** The `tenant`-scoped metered key the served row is built from. */
const KEY = "events.active";

/** The plan's hard monthly limit for {@link KEY}. */
const LIMIT = 5;

/**
 * Seed a fake `Db` with the free plan and exactly one counter row for
 * {@link KEY} at {@link PERIOD}.
 *
 * No `subscriptions` row is seeded, so the view defaults to the `free` plan
 * (schema §14.3) — the same plan the integration spec's L8 seeds.
 *
 * @param value - The counter row's stored `value`; a string is the corruption.
 * @returns The recording fake.
 */
function seedView(value: number | string): FakeMongo {
  const fake = makeFakeMongo();
  fake.seed(COLLECTIONS.plans, [
    makePlan({
      key: "free",
      name: "Free",
      entitlements: { [KEY]: makeEntitlement({ limit: LIMIT }) },
    }),
  ]);
  fake.seed(COLLECTIONS.usageCounters, [
    {
      // The driver stamps `_id`; the read's schema requires an `ObjectId` there.
      _id: new ObjectId(),
      ...makeUsageCounter({
        tenantId: TENANT,
        entitlementKey: KEY,
        periodKey: PERIOD,
      }),
      value,
    },
  ]);
  return fake;
}

describe("readEntitlementsView — the fetched counter rows are parsed", () => {
  it("U10: a counter row whose `value` is not a number is refused by the read", async () => {
    const fake = seedView("corrupt");

    await expect(readEntitlementsView(fake.db, TENANT, NOW)).rejects.toBeInstanceOf(ZodError);
  });

  it("U10: the refusal names the counter's `value` field, not the read as a whole", async () => {
    const fake = seedView("corrupt");

    await expect(readEntitlementsView(fake.db, TENANT, NOW)).rejects.toMatchObject({
      issues: [{ path: ["value"] }],
    });
  });

  it("U10: the same seed with a numeric `value` resolves and serves it as `used`", async () => {
    const fake = seedView(LIMIT - 1);

    const body = await readEntitlementsView(fake.db, TENANT, NOW);

    // The negative control: a service that threw for every input would satisfy
    // the two arms above and fail here.
    expect(body.entitlements).toMatchObject([
      { key: KEY, periodKey: PERIOD, used: LIMIT - 1, remaining: 1 },
    ]);
  });
});
