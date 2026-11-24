import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { findForbiddenFields } from "@openpic/contracts";

import { GET as getAddons } from "@/app/api/v1/addons/route";
import type { PlanPrice } from "@/server/plans/plans";

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

/**
 * Characterisation pin — the conditional `GET /api/v1/addons` (OP-102 follow-up,
 * contract §3.6 / §0.10, ADR-0324).
 *
 * `I4` pins the `200` shape and its cache headers, and `conditional-etag.test.ts`
 * (I2) pins the reusable ETag *stage*, but nothing sent an `If-None-Match` to
 * this route: its `304` arm and `addonCatalogueETag`'s stability were free to
 * regress silently. These cases pin the wire behaviour of the arm that exists on
 * the trunk (PR #278's unlanded pins, re-homed in the harness that owns §3.6).
 *
 * They are deliberately implementation-agnostic: the tag's digest is not
 * asserted — only the invariants §0.10 makes of it. A revalidation is answered
 * `304` **iff** the presented tag identifies exactly the bytes this request
 * would otherwise serve; the tag is stable for an unchanged catalogue and
 * distinct for a changed one, including a `?currency` variant.
 */

/** The `etag` header, failing loudly instead of comparing against `null`. */
function etagOf(response: Response): string {
  const etag = response.headers.get("etag");
  expect(etag).toBeTruthy();
  if (etag === null) {
    throw new Error("GET /api/v1/addons served no etag header");
  }
  return etag;
}

/** A GET of the add-on catalogue presenting `If-None-Match: <ifNoneMatch>`. */
function revalidationRequest(ifNoneMatch: string, query = ""): Request {
  return new Request(new URL(`${ADDONS_PATH}${query}`, APP_ORIGIN), {
    method: "GET",
    headers: { "if-none-match": ifNoneMatch },
  });
}

/** One price in a second currency, so the `?currency` variants are not identical. */
function usdPrice(): PlanPrice {
  return makeAddonPrice({
    priceKey: "storage-50gb-monthly-usd",
    currency: "USD",
    amountMinor: 2_900,
  });
}

describe("GET /api/v1/addons (§3.6) — conditional GET", () => {
  it("an unconditional GET returns 200 with the public cache policy, an ETag and the catalogue", async () => {
    await seedAddons([makeAddon()]);

    const response = await getAddons(addonsRequest());
    const body = (await response.json()) as { data: Array<{ addonKey: string }> };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    // §0.10: a public catalogue read answers a **strong** tag (RFC 7232 quoted form).
    expect(etagOf(response)).toMatch(/^"[^"]+"$/);
    expect(body.data.map((addon) => addon.addonKey)).toEqual(["storage-50gb"]);
  });

  it("replaying the ETag as If-None-Match returns 304 with the same ETag and no body", async () => {
    await seedAddons([makeAddon()]);

    const first = await getAddons(addonsRequest());
    const etag = etagOf(first);

    const revalidated = await getAddons(revalidationRequest(etag));

    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("etag")).toBe(etag);
    expect(revalidated.headers.get("cache-control")).toBe("public, max-age=300");
    // The `304` carries no served add-on: the pipeline strips the handler's body.
    expect((await revalidated.arrayBuffer()).byteLength).toBe(0);
  });

  it("a non-matching If-None-Match returns the full 200 catalogue", async () => {
    await seedAddons([makeAddon()]);

    const response = await getAddons(revalidationRequest('"stale-tag"'));
    const body = (await response.json()) as { data: Array<{ addonKey: string }> };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(body.data.map((addon) => addon.addonKey)).toEqual(["storage-50gb"]);
  });
});

describe("GET /api/v1/addons (§3.6) — the catalogue ETag identifies the served representation", () => {
  it("serves the same ETag for an unchanged catalogue", async () => {
    await seedAddons([makeAddon()]);

    const first = await getAddons(addonsRequest());
    const second = await getAddons(addonsRequest());

    expect(etagOf(second)).toBe(etagOf(first));
  });

  it("changes the ETag when a served add-on changes, and no longer revalidates the old tag to 304", async () => {
    await seedAddons([makeAddon()]);
    const previousTag = etagOf(await getAddons(addonsRequest()));

    await seedAddons([makeAddon({ name: "50 GB storage (renamed)" })]);
    const after = await getAddons(addonsRequest());
    const body = (await after.json()) as { data: Array<{ name: string }> };

    // The served bytes really changed, so the tag assertion below is not vacuous.
    expect(body.data.map((addon) => addon.name)).toEqual(["50 GB storage (renamed)"]);
    expect(etagOf(after)).not.toBe(previousTag);

    const revalidated = await getAddons(revalidationRequest(previousTag));
    expect(revalidated.status).toBe(200);
  });

  it("mints a distinct ETag per currency variant of the same catalogue", async () => {
    await seedAddons([makeAddon({ prices: [makeAddonPrice(), usdPrice()] })]);

    const unfilteredTag = etagOf(await getAddons(addonsRequest()));
    const inr = await getAddons(addonsRequest("?currency=INR"));
    const usd = await getAddons(addonsRequest("?currency=USD"));
    const inrTag = etagOf(inr);
    const usdTag = etagOf(usd);

    // The variants serve different price sets, so their tags must differ.
    expect((await inr.json()) as unknown).not.toEqual((await usd.json()) as unknown);
    expect(new Set([unfilteredTag, inrTag, usdTag]).size).toBe(3);

    // A tag minted for one variant must not revalidate another to a `304`.
    const crossVariant = await getAddons(revalidationRequest(inrTag, "?currency=USD"));
    expect(crossVariant.status).toBe(200);
  });
});

/**
 * Characterisation pin — the RFC 7232 **list** form of `If-None-Match` (OP-102
 * follow-up, contract §0.10, ADR-0325).
 *
 * `ifNoneMatchSatisfied` compares each comma-separated member of the header
 * (RFC 7232 §3.2), and the route must hand the header to it. Every case shipped
 * before this block presents a **single** tag, so a route that re-implemented
 * the comparison as a literal string equality would keep the whole §3.6 suite
 * green while a real client — which sends the tag it holds inside a list —
 * stopped revalidating. This case presents a two-member list on both sides: one
 * that contains this catalogue's tag (→ `304`) and one that contains only other
 * tags (→ `200`, so an always-`304` route cannot satisfy it).
 */
describe("GET /api/v1/addons (§3.6) — the If-None-Match list form", () => {
  it("revalidates a list containing this catalogue's tag to 304, and serves 200 for a list of only other tags", async () => {
    await seedAddons([makeAddon()]);
    const etag = etagOf(await getAddons(addonsRequest()));

    const listed = await getAddons(revalidationRequest(`"older-catalogue-tag", ${etag}`));

    expect(listed.status).toBe(304);
    expect(listed.headers.get("etag")).toBe(etag);
    expect((await listed.arrayBuffer()).byteLength).toBe(0);

    const othersOnly = await getAddons(
      revalidationRequest('"older-catalogue-tag", "an-even-older-catalogue-tag"')
    );

    expect(othersOnly.status).toBe(200);
    const body = (await othersOnly.json()) as { data: Array<{ addonKey: string }> };
    expect(body.data.map((addon) => addon.addonKey)).toEqual(["storage-50gb"]);
  });
});

/**
 * Characterisation pin — the tag identifies the **served** representation only
 * (OP-102 follow-up, contract §3.6, ADR-0325).
 *
 * The shipped case above proves one direction: a change to a *served* field
 * moves the tag. This pins the inverse, which is what stops a tag from
 * over-invalidating — `grantDelta` is stored (`@/server/plans/addons.ts`) and
 * absent from the §3.6 served schema (`projectAddon` never emits it), so an
 * edit to it changes no served byte and must leave the tag alone. Otherwise
 * every such edit would force every client to refetch a body that did not
 * change. The body equality is asserted first, so the tag assertion cannot be
 * satisfied by a catalogue that ignores the edit for some other reason.
 */
describe("GET /api/v1/addons (§3.6) — an unserved stored edit leaves the ETag alone", () => {
  it("keeps the served body and the ETag when only a stored-but-unserved field changes", async () => {
    await seedAddons([makeAddon({ grantDelta: 100 })]);
    const before = await getAddons(addonsRequest());
    const beforeBody: unknown = await before.json();
    const beforeTag = etagOf(before);

    await seedAddons([makeAddon({ grantDelta: 200 })]);
    const after = await getAddons(addonsRequest());
    const afterBody: unknown = await after.json();

    // The stored document really carries the edit, so the identity below is not
    // satisfied by a seed that silently failed.
    const stored = await app.db
      .collection<StoredAddon>("addons")
      .findOne({ addonKey: "storage-50gb" });
    expect(stored?.grantDelta).toBe(200);

    // `grantDelta` is stored but never served: the bytes are byte-identical…
    expect(afterBody).toEqual(beforeBody);
    const servedItem = (afterBody as { data: Array<Record<string, unknown>> }).data.at(0);
    expect(servedItem).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(servedItem, "grantDelta")).toBe(false);
    // …so the tag that identifies those bytes must not move.
    expect(etagOf(after)).toBe(beforeTag);
  });
});
