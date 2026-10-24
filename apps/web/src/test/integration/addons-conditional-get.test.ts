import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as getAddons } from "@/app/api/v1/addons/route";

import { makeAddon, makeAddonPrice, type StoredAddon } from "../factories/addon";
import { APP_ORIGIN, startTestApp, type TestApp } from "../helpers/authed-app";

/**
 * Characterisation pin — the conditional `GET /api/v1/addons` (OP-102 follow-up,
 * contract §3.6 / §0.10, ADR-0320).
 *
 * The OP-102 card requires the add-on catalogue to carry "the same cache and
 * ETag rules as `/plans`". `addons-endpoint.test.ts` (I4) pins the `200` shape
 * and the cache headers, and `conditional-etag.test.ts` (I2) pins the reusable
 * ETag *stage*, but nothing yet sends an `If-None-Match` to this route, so the
 * route's `304` branch and `addonCatalogueETag`'s stability are free to regress
 * silently. These specs pin the wire behaviour on the current trunk.
 *
 * They are deliberately implementation-agnostic: the tag's *shape* (hash vs
 * join, strong vs weak) is not asserted — only the invariants the contract
 * makes of it. A revalidation is answered `304` **iff** the client's tag
 * identifies exactly the bytes this request would otherwise serve, and the tag
 * is stable for an unchanged catalogue and distinct for a changed one.
 */

const ADDONS_PATH = "/api/v1/addons";

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op102-addons-revalidate" });
}, 60_000);

afterAll(async () => {
  await app.cleanup();
});

/** Replace the add-on catalogue with exactly `addons` (as I4 seeds it). */
async function seedAddons(addons: readonly StoredAddon[]): Promise<void> {
  await app.db.collection<StoredAddon>("addons").deleteMany({});
  if (addons.length > 0) {
    await app.db.collection<StoredAddon>("addons").insertMany([...addons]);
  }
}

/** A GET of the add-on catalogue, optionally conditional and/or query-filtered. */
function addonsRequest(headers: Record<string, string> = {}, query = ""): Request {
  return new Request(new URL(`${ADDONS_PATH}${query}`, APP_ORIGIN), {
    method: "GET",
    headers,
  });
}

/** One add-on price in a second currency, so the currency filter is not vacuous. */
function usdPrice() {
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
    expect(response.headers.get("etag")).toBeTruthy();
    expect(body.data.map((addon) => addon.addonKey)).toEqual(["storage-50gb"]);
  });

  it("replaying the ETag as If-None-Match returns 304 with the same ETag and no body", async () => {
    await seedAddons([makeAddon()]);

    const first = await getAddons(addonsRequest());
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();

    const revalidated = await getAddons(addonsRequest({ "if-none-match": etag ?? "" }));

    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("etag")).toBe(etag);
    expect(revalidated.headers.get("cache-control")).toBe("public, max-age=300");
    expect((await revalidated.arrayBuffer()).byteLength).toBe(0);
  });

  it("a non-matching If-None-Match returns the full 200 catalogue", async () => {
    await seedAddons([makeAddon()]);

    const response = await getAddons(addonsRequest({ "if-none-match": '"stale-tag"' }));
    const body = (await response.json()) as { data: Array<{ addonKey: string }> };

    expect(response.status).toBe(200);
    expect(body.data.map((addon) => addon.addonKey)).toEqual(["storage-50gb"]);
  });
});

describe("GET /api/v1/addons (§3.6) — the catalogue ETag identifies the served representation", () => {
  it("serves the same ETag for an unchanged catalogue", async () => {
    await seedAddons([makeAddon()]);

    const first = await getAddons(addonsRequest());
    const second = await getAddons(addonsRequest());

    expect(first.headers.get("etag")).toBeTruthy();
    expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
  });

  it("changes the ETag when a served add-on changes, and no longer revalidates the old tag to 304", async () => {
    await seedAddons([makeAddon()]);
    const before = await getAddons(addonsRequest());
    const previousTag = before.headers.get("etag");
    expect(previousTag).toBeTruthy();

    await seedAddons([makeAddon({ name: "50 GB storage (renamed)" })]);
    const after = await getAddons(addonsRequest());

    expect(after.headers.get("etag")).not.toBe(previousTag);

    const revalidated = await getAddons(addonsRequest({ "if-none-match": previousTag ?? "" }));
    expect(revalidated.status).toBe(200);
  });

  it("mints a distinct ETag per currency variant of the same catalogue", async () => {
    await seedAddons([makeAddon({ prices: [makeAddonPrice(), usdPrice()] })]);

    const unfiltered = await getAddons(addonsRequest());
    const inr = await getAddons(addonsRequest({}, "?currency=INR"));
    const usd = await getAddons(addonsRequest({}, "?currency=USD"));

    const tags = [unfiltered.headers.get("etag"), inr.headers.get("etag"), usd.headers.get("etag")];
    expect(tags.every((tag) => tag !== null && tag.length > 0)).toBe(true);
    expect(new Set(tags).size).toBe(3);

    // A tag minted for one variant must not revalidate another to a 304.
    const crossVariant = await getAddons(
      addonsRequest({ "if-none-match": inr.headers.get("etag") ?? "" }, "?currency=USD")
    );
    expect(crossVariant.status).toBe(200);
  });
});
