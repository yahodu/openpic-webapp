import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { findForbiddenFields } from "@openpic/contracts";

import { GET as getPlans } from "@/app/api/v1/plans/route";
import type { Plan } from "@/server/plans/plans";
import { SEED_PLANS } from "@/server/plans/plans.values";
import { seedPlans } from "@/server/plans/seed-plans";

import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";

/**
 * Integration / contract — `GET /api/v1/plans` (OP-102, contract §3.1, schema
 * §14.1, ADR-0320).
 *
 * The endpoint drives the public pricing page from `plans` data so pricing copy
 * changes need no deploy. It is `public` and cacheable
 * (`Cache-Control: public, max-age=300`) with an `ETag` of the plan versions, so
 * the page can revalidate cheaply.
 *
 * ## Contract expected of the implementation
 *
 * `@/app/api/v1/plans/route` exports `GET`, declared on `defineRoute` with
 * `route: "/api/v1/plans"`, no auth guard, answering `{ data: Plan[] }`:
 *
 *   - only **active** plans (`active: true`), sorted ascending by `tierRank`;
 *   - each plan's `entitlements` verbatim from storage **plus** an added
 *     `display` string (`@/server/plans/plan-display`);
 *   - each plan's `prices` filtered to `active: true` and to the `currency` /
 *     `billingCycle` query when supplied, projected without `validFrom` /
 *     `validUntil` and **never** with `externalRefs` (contract §0.15);
 *   - `contactSalesUrl` on the sales-assisted tiers (contract §3.1 example);
 *   - `Content-Type: application/json`, `cache-control: public, max-age=300`
 *     and an `etag` header on the `200`.
 *
 * ## Assumptions recorded in the handoff (ADR-0320)
 *
 * - `?includeInactive=true` is **ignored** on this public route: a non-admin
 *   caller simply never sees a retired plan (no `403`). The admin surface
 *   (§9.3 `/admin/plans`) is where full documents, including `externalRefs`,
 *   are read; the public pricing page has no use for a retired tier.
 * - The exact `display` prose for the seeded keys is owned by the formatter
 *   (unit-pinned in `plan-display.test.ts`); here only its presence and its
 *   application to the seeded `storage.bytes` / `originals.download` specs are
 *   asserted.
 */

const PLANS_PATH = "/api/v1/plans";

/** One price as the §3.1 projection serves it (no `validFrom`, no `externalRefs`). */
const planPriceSchema = z
  .object({
    priceKey: z.string(),
    billingCycle: z.enum(["monthly", "yearly"]),
    amountMinor: z.number().int(),
    currency: z.string(),
    taxBehavior: z.enum(["inclusive", "exclusive"]),
    trialDays: z.number().int(),
    active: z.boolean(),
  })
  .strict();

/** One entitlement as the §3.1 projection serves it — stored spec plus `display`. */
const planEntitlementSchema = z.object({
  limit: z.number().int().nullable(),
  resetPeriod: z.enum(["monthly", "yearly", "lifetime", "none"]),
  scope: z.enum(["tenant", "event", "attendee"]),
  enforcement: z.enum(["hard", "soft", "policy", "feature"]),
  enabled: z.boolean().optional(),
  display: z.string(),
});

/** One plan as the §3.1 projection serves it. */
const planListItemSchema = z
  .object({
    key: z.string(),
    name: z.string(),
    description: z.string(),
    marketingFeatures: z.array(z.string()),
    tierRank: z.number().int(),
    selfServe: z.boolean(),
    salesAssisted: z.boolean(),
    version: z.number().int(),
    prices: z.array(planPriceSchema),
    entitlements: z.record(z.string(), planEntitlementSchema),
    contactSalesUrl: z.string().optional(),
  })
  .strict();

/** The §3.1 `{ data }` envelope. */
const planListResponseSchema = z.object({ data: z.array(planListItemSchema) });

/** The active tiers the pricing page must serve, in `tierRank` order. */
const ACTIVE_PLAN_KEYS = ["free", "starter", "professional", "enterprise"];

let app: TestApp;

/**
 * A retired tier kept for grandfathered subscriptions (schema §14.1: "never
 * delete a plan"). It must never appear on the public pricing page.
 */
function retiredPlan(): Plan {
  return {
    key: "legacy",
    name: "Legacy",
    description: "Retired tier kept for grandfathered subscriptions.",
    marketingFeatures: [],
    tierRank: 4,
    selfServe: false,
    salesAssisted: false,
    active: false,
    version: 1,
    prices: [],
    entitlements: {
      "events.active": { limit: 1, resetPeriod: "monthly", scope: "tenant", enforcement: "hard" },
    },
  };
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op102-plans" });
  await seedPlans({ db: app.db });
  // Seed the retired tier too, so every "excluded" assertion is meaningful
  // rather than vacuous: it really is in the database, and really is hidden.
  await seedPlans({ db: app.db, plans: [...SEED_PLANS, retiredPlan()] });
}, 60_000);

afterAll(async () => {
  await app.cleanup();
});

/** A GET of the plans endpoint, optionally with a session cookie and query. */
function plansRequest(query = "", session?: SignedInUser): Request {
  return new Request(new URL(`${PLANS_PATH}${query}`, APP_ORIGIN), {
    method: "GET",
    headers: session === undefined ? {} : { cookie: session.cookie },
  });
}

/** The served plan keys, in the order the endpoint returned them. */
async function servedKeys(response: Response): Promise<string[]> {
  const body = (await response.json()) as { data: Array<{ key: string }> };
  return body.data.map((plan) => plan.key);
}

describe("GET /api/v1/plans (§3.1) — I1: the Plan list contract", () => {
  it("answers 200 with the cache headers, an ETag and the { data } envelope", async () => {
    const response = await getPlans(plansRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("etag")).toBeTruthy();
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("serves the active catalogue in tierRank order and matches the Plan list schema", async () => {
    const response = await getPlans(plansRequest());
    const body: unknown = await response.json();

    const parsed = planListResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data.data.map((plan) => plan.key)).toEqual(ACTIVE_PLAN_KEYS);
    expect(parsed.data.data.map((plan) => plan.tierRank)).toEqual([0, 1, 2, 3]);
  });

  it("adds a non-empty display string to every entitlement", async () => {
    const response = await getPlans(plansRequest());
    const body = (await response.json()) as {
      data: Array<{ entitlements: Record<string, { display?: unknown }> }>;
    };

    expect(body.data.length).toBeGreaterThan(0);
    for (const plan of body.data) {
      const entries = Object.entries(plan.entitlements);
      expect(entries.length).toBeGreaterThan(0);
      for (const [key, spec] of entries) {
        expect(typeof spec.display, `${key} display`).toBe("string");
        expect(String(spec.display).length, `${key} display`).toBeGreaterThan(0);
      }
    }
  });

  it("applies the formatter to the seeded storage and feature entitlements", async () => {
    const response = await getPlans(plansRequest());
    const body = (await response.json()) as {
      data: Array<{
        key: string;
        entitlements: Record<string, { display?: unknown }>;
      }>;
    };

    const free = body.data.find((plan) => plan.key === "free");
    expect(free).toBeDefined();
    expect(free?.entitlements["storage.bytes"]?.display).toBe("2 GB");
    expect(free?.entitlements["originals.download"]?.display).toBe("Not included");
  });

  it("never exposes externalRefs or any never-return field", async () => {
    const response = await getPlans(plansRequest());
    const text = await response.text();

    expect(text).not.toContain("externalRefs");
    expect(text).not.toContain("cashfree");

    const body: unknown = JSON.parse(text);
    // A non-empty catalogue, so the leak scan is not vacuously green.
    expect((body as { data: unknown[] }).data.length).toBeGreaterThan(0);
    expect(findForbiddenFields(body, "default")).toEqual([]);
  });

  it("serves the sales-assisted tier flags and its contactSalesUrl", async () => {
    const response = await getPlans(plansRequest());
    const body = (await response.json()) as {
      data: Array<{
        key: string;
        selfServe: boolean;
        salesAssisted: boolean;
        prices: unknown[];
        contactSalesUrl?: string;
      }>;
    };

    const enterprise = body.data.find((plan) => plan.key === "enterprise");
    expect(enterprise?.selfServe).toBe(false);
    expect(enterprise?.salesAssisted).toBe(true);
    expect(enterprise?.prices).toEqual([]);
    expect(enterprise?.contactSalesUrl).toBe("/contact-sales");
  });

  it("filters prices to the requested currency", async () => {
    const response = await getPlans(plansRequest("?currency=USD&billingCycle=monthly"));
    const body = (await response.json()) as {
      data: Array<{ prices: Array<{ currency: string }> }>;
    };

    expect(response.status).toBe(200);
    // The plans are still served — only their USD prices are filtered out.
    expect(body.data).toHaveLength(4);
    for (const plan of body.data) {
      expect(plan.prices).toEqual([]);
    }
  });
});

describe("GET /api/v1/plans (§3.1) — I2: a retired plan is excluded", () => {
  it("omits an active:false plan from the public catalogue", async () => {
    const response = await getPlans(plansRequest());

    expect(response.status).toBe(200);
    const keys = await servedKeys(response);
    expect(keys).not.toContain("legacy");
    expect(keys).toEqual(ACTIVE_PLAN_KEYS);
  });
});

describe("GET /api/v1/plans (§3.1) — I3: includeInactive without admin is ignored", () => {
  it("still omits the retired plan for an anonymous caller asking for it", async () => {
    const response = await getPlans(plansRequest("?includeInactive=true"));

    expect(response.status).toBe(200);
    expect(await servedKeys(response)).toEqual(ACTIVE_PLAN_KEYS);
  });

  it("still omits the retired plan for a signed-in non-admin asking for it", async () => {
    const session = await app.signIn(makeIdentity("op102-plans-nonadmin"));

    const response = await getPlans(plansRequest("?includeInactive=true", session));

    expect(response.status).toBe(200);
    expect(await servedKeys(response)).toEqual(ACTIVE_PLAN_KEYS);
  });
});
