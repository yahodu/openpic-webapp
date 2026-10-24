import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { findForbiddenFields } from "@openpic/contracts";

import { GET as getAddons } from "@/app/api/v1/addons/route";

import { makeAddon, makeAddonPrice, type StoredAddon } from "../factories/addon";
import { APP_ORIGIN, startTestApp, type TestApp } from "../helpers/authed-app";

/**
 * Integration / contract — `GET /api/v1/addons` (OP-102, contract §3.6, schema
 * §14.1, ADR-0320).
 *
 * A top-up an organizer can buy is catalogue-as-data, exactly like a plan: its
 * identity is an `addonKey` (`POST /tenants/{tenantId}/billing/addons` takes
 * one), what it grants is an entitlement delta, and its price lives in an
 * embedded `prices[]`. The public pricing page lists the orderable add-ons next
 * to the tiers, so this is a peer of `GET /plans`: `public`, cacheable
 * (`public, max-age=300`), and it **never** leaks `externalRefs` — the same
 * §0.15 never-return rule that governs plan prices.
 *
 * ## Contract expected of the implementation
 *
 * `@/app/api/v1/addons/route` exports `GET`, declared on `defineRoute` with
 * `route: "/api/v1/addons"`, no auth guard, answering `{ data: Addon[] }` from
 * the platform-scope `addons` collection:
 *
 *   { addonKey, name, description, entitlementKey, unit,
 *     quantity: { min, max }, prices, display, active }
 *
 *   - only **active** add-ons are served;
 *   - `prices` follows `GET /plans`: filtered to `active: true`, optionally to
 *     the `currency` query, projected without `validFrom`/`validUntil` and
 *     without `externalRefs`;
 *   - `display` is a non-empty human string (the exact copy is a product
 *     decision, not a contract — as with the notification catalogue label);
 *   - `Content-Type: application/json`, `cache-control: public, max-age=300`
 *     and an `etag` header on the `200`.
 *
 * ## Decision recorded in the handoff (ADR-0320)
 *
 * The card offered "`GET /addons`, or `addons[]` inside `GET /plans`". The
 * separate endpoint is chosen: it keeps the `GET /plans` body the strict §3.1
 * Plan list (I1 parses it with a `.strict()` schema) and lets each catalogue
 * carry its own cache/ETag without versioning the other.
 */

const ADDONS_PATH = "/api/v1/addons";

/** One add-on price as the catalogue serves it (no lifecycle fields, no refs). */
const addonPriceSchema = z
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

/** One add-on as the catalogue serves it. */
const addonItemSchema = z
  .object({
    addonKey: z.string(),
    name: z.string(),
    description: z.string(),
    entitlementKey: z.string(),
    unit: z.string(),
    quantity: z.object({ min: z.number().int(), max: z.number().int() }),
    prices: z.array(addonPriceSchema),
    display: z.string(),
    active: z.boolean(),
  })
  .strict();

/** The `{ data }` envelope. */
const addonListResponseSchema = z.object({ data: z.array(addonItemSchema) });

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op102-addons" });
}, 60_000);

afterAll(async () => {
  await app.cleanup();
});

/** Replace the add-on catalogue with exactly `addons`. */
async function seedAddons(addons: readonly StoredAddon[]): Promise<void> {
  await app.db.collection<StoredAddon>("addons").deleteMany({});
  if (addons.length > 0) {
    await app.db.collection<StoredAddon>("addons").insertMany([...addons]);
  }
}

/** A GET of the add-on catalogue, optionally with a query string. */
function addonsRequest(query = ""): Request {
  return new Request(new URL(`${ADDONS_PATH}${query}`, APP_ORIGIN), { method: "GET" });
}

/** A second, distinct add-on so "lists every active add-on" is not vacuous. */
function eventPack(): StoredAddon {
  return makeAddon({
    addonKey: "events-pack-10",
    name: "10 event pack",
    description: "Add ten active events for the current month.",
    entitlementKey: "events.active",
    unit: "events",
    quantity: { min: 1, max: 5 },
    prices: [
      makeAddonPrice({
        priceKey: "events-pack-10-monthly-inr",
        amountMinor: 49_900,
        externalRefs: [
          { provider: "cashfree", env: "production", kind: "addon", id: "EVENTS_PACK_10_V1" },
        ],
      }),
    ],
  });
}

describe("GET /api/v1/addons (§3.6) — I4: the add-on catalogue contract", () => {
  it("lists every active add-on with the cache headers and a display string", async () => {
    await seedAddons([makeAddon(), eventPack()]);

    const response = await getAddons(addonsRequest());
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("etag")).toBeTruthy();

    const parsed = addonListResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data.data.map((addon) => addon.addonKey)).toEqual([
      "storage-50gb",
      "events-pack-10",
    ]);
    for (const addon of parsed.data.data) {
      expect(addon.display.length).toBeGreaterThan(0);
      expect(addon.active).toBe(true);
      expect(addon.quantity.min).toBeLessThanOrEqual(addon.quantity.max);
    }
  });

  it("never exposes externalRefs or any never-return field", async () => {
    await seedAddons([makeAddon(), eventPack()]);

    const response = await getAddons(addonsRequest());
    const text = await response.text();

    expect(text).not.toContain("externalRefs");
    expect(text).not.toContain("cashfree");

    const body: unknown = JSON.parse(text);
    // A non-empty catalogue, so the leak scan is not vacuously green.
    expect((body as { data: unknown[] }).data).toHaveLength(2);
    expect(findForbiddenFields(body, "default")).toEqual([]);

    // `externalRefs` is not in the scanner's blind spot here: assert the key's
    // absence on the served price explicitly (the ADR-0014 §2 shape).
    const served = body as { data: Array<{ prices: Array<Record<string, unknown>> }> };
    for (const addon of served.data) {
      for (const price of addon.prices) {
        expect(Object.prototype.hasOwnProperty.call(price, "externalRefs")).toBe(false);
      }
    }
  });

  it("filters prices to the requested currency", async () => {
    await seedAddons([
      makeAddon({
        prices: [
          makeAddonPrice(),
          makeAddonPrice({
            priceKey: "storage-50gb-monthly-usd",
            currency: "USD",
            amountMinor: 2_900,
            externalRefs: [
              { provider: "cashfree", env: "production", kind: "addon", id: "STORAGE_50GB_USD_V1" },
            ],
          }),
        ],
      }),
    ]);

    const response = await getAddons(addonsRequest("?currency=INR"));
    const body = (await response.json()) as {
      data: Array<{ prices: Array<{ currency: string }> }>;
    };

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data.flatMap((addon) => addon.prices).map((price) => price.currency)).toEqual([
      "INR",
    ]);
  });
});

describe("GET /api/v1/addons (§3.6) — I4: a retired add-on is excluded", () => {
  it("omits an active:false add-on from the public catalogue", async () => {
    await seedAddons([makeAddon(), makeAddon({ addonKey: "storage-retired", active: false })]);

    const response = await getAddons(addonsRequest());
    const body = (await response.json()) as { data: Array<{ addonKey: string }> };

    expect(response.status).toBe(200);
    expect(body.data.map((addon) => addon.addonKey)).toEqual(["storage-50gb"]);
  });
});
