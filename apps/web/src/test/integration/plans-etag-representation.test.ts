import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as getPlans } from "@/app/api/v1/plans/route";
import { COLLECTIONS } from "@/server/db/collections";
import { seedPlans } from "@/server/plans/seed-plans";

import { APP_ORIGIN, startTestApp, type TestApp } from "../helpers/authed-app";

/**
 * Integration / contract — the `GET /api/v1/plans` entity tag identifies the
 * **representation it tags** (OP-102 follow-up, contract §3.1 + §0.10,
 * ADR-0321 round-1 finding; the GREEN is `t_0ad1baa2`).
 *
 * `GET /plans` is `public, max-age=300` and answers a conditional request, so a
 * client that revalidates with `If-None-Match` must be told `304` **only** when
 * the bytes it holds are the bytes this request would serve. The route's body —
 * and therefore the correct tag — varies with two things the tag did not used to
 * capture:
 *
 *   - the `currency` / `billingCycle` query, which filters `prices` (pinned by
 *     I1 of `plans-endpoint.test.ts`);
 *   - the served copy and prices of a plan, which a data edit changes without
 *     bumping `version` (`seedPlans` bumps `version` only on an entitlement
 *     change — ADR-0014 §6).
 *
 * The old `(key, version)`-only tag failed both ways: a `?currency=USD`
 * revalidation could be answered `304` off an `ETag` minted for `?currency=INR`
 * (the client then reuses the wrong variant's price set), and a price/copy edit
 * never invalidated a revalidating client — and because a `304` refreshes
 * `max-age`, that staleness was unbounded, contradicting the card story
 * ("pricing copy changes need no deploy").
 *
 * ## Contract expected of the implementation
 *
 * `@/app/api/v1/plans/route` exports `GET`, still `public` and answering
 * `{ data: Plan[] }` with `Cache-Control: public, max-age=300` and an `etag`
 * header — but the tag must now be a function of the **served representation**,
 * so that:
 *
 *   - two requests whose bodies differ never share an `etag` (variant identity);
 *   - replaying one variant's tag on another variant is `200`, never `304`;
 *   - a copy-only or price-only edit (no `version` bump) changes the tag and
 *     invalidates a revalidating client;
 *   - an unchanged catalogue still answers `304` (the invariant the change must
 *     preserve, also covered end-to-end by `e2e/plans.spec.ts` E1).
 *
 * The tag's *shape* is deliberately not pinned (hash vs join, weak vs strong):
 * only these observable invariants are contractual.
 *
 * ## Assumption recorded in the handoff
 *
 * The card routes "copy/price edit invalidates" as a change of the `/plans`
 * tag, superseding ADR-0320 §2's "copy-only edits leave the tag unchanged".
 * ADR-0321's Consequences section already records the old behaviour as a bug,
 * so that is the intended direction; the GREEN owns the ADR amendment.
 */

const PLANS_PATH = "/api/v1/plans";

/** A variant whose `prices` are filtered away by the default (INR) catalogue. */
const USD_MONTHLY_QUERY = "?currency=USD&billingCycle=monthly";

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op102-plans-etag" });
}, 60_000);

afterAll(async () => {
  await app.cleanup();
});

/** A GET of the plans endpoint, optionally with a query and extra headers. */
function plansRequest(query = "", headers: Record<string, string> = {}): Request {
  return new Request(new URL(`${PLANS_PATH}${query}`, APP_ORIGIN), { method: "GET", headers });
}

/** The `etag` header of a response, asserting a 200 really carried one. */
function etagOf(response: Response): string {
  const etag = response.headers.get("etag");
  expect(etag, "a GET /plans response must carry an ETag").toBeTruthy();
  return etag ?? "";
}

/** The served plans keyed by `key`, for non-vacuous body assertions. */
async function servedPlans(
  response: Response
): Promise<Map<string, { name: string; version: number; prices: Array<{ amountMinor: number }> }>> {
  const body = (await response.json()) as {
    data: Array<{
      key: string;
      name: string;
      version: number;
      prices: Array<{ amountMinor: number }>;
    }>;
  };
  return new Map(body.data.map((plan) => [plan.key, plan]));
}

/** Restore the catalogue to its seeded state (a no-op version-wise). */
async function reseed(): Promise<void> {
  await seedPlans({ db: app.db });
}

describe("GET /api/v1/plans — the ETag identifies the served representation", () => {
  it("mints a different ETag for a different currency/billingCycle variant", async () => {
    await reseed();

    const defaultResponse = await getPlans(plansRequest());
    const usdResponse = await getPlans(plansRequest(USD_MONTHLY_QUERY));

    expect(defaultResponse.status).toBe(200);
    expect(usdResponse.status).toBe(200);

    const defaultBody: unknown = await defaultResponse.json();
    const usdBody: unknown = await usdResponse.json();

    // Guard against a vacuous assertion: the two representations really differ
    // (the default response serves INR prices that the USD filter drops).
    expect(defaultBody).not.toEqual(usdBody);

    expect(etagOf(defaultResponse)).not.toBe(etagOf(usdResponse));
  });

  it("does not answer 304 for a variant whose ETag differs (no cross-variant 304)", async () => {
    await reseed();

    const defaultEtag = etagOf(await getPlans(plansRequest()));
    const usdBody: unknown = await (await getPlans(plansRequest(USD_MONTHLY_QUERY))).json();

    const crossVariant = await getPlans(
      plansRequest(USD_MONTHLY_QUERY, { "if-none-match": defaultEtag })
    );

    expect(crossVariant.status).toBe(200);
    expect(await crossVariant.json()).toEqual(usdBody);
  });

  it("changes the ETag when only a plan's copy changes (no version bump)", async () => {
    await reseed();
    const beforeEtag = etagOf(await getPlans(plansRequest()));

    await app.db
      .collection(COLLECTIONS.plans)
      .updateOne({ key: "free" }, { $set: { name: "Free (new copy)" } });

    const after = await getPlans(plansRequest());
    expect(etagOf(after)).not.toBe(beforeEtag);
    // The served body really carries the new copy, so the tag change is not vacuous.
    expect((await servedPlans(after)).get("free")?.name).toBe("Free (new copy)");

    const revalidated = await getPlans(plansRequest("", { "if-none-match": beforeEtag }));
    expect(revalidated.status).toBe(200);
  });

  it("changes the ETag when only a plan's price changes (no version bump)", async () => {
    await reseed();
    const beforeEtag = etagOf(await getPlans(plansRequest()));

    await app.db
      .collection(COLLECTIONS.plans)
      .updateOne({ key: "starter" }, { $set: { "prices.0.amountMinor": 59_900 } });

    const after = await getPlans(plansRequest());
    expect(etagOf(after)).not.toBe(beforeEtag);

    const starter = (await servedPlans(after)).get("starter");
    expect(starter?.prices[0]?.amountMinor).toBe(59_900);
    // The edit did not bump `version`, so a `(key, version)`-only tag would miss it.
    expect(starter?.version).toBe(1);

    const revalidated = await getPlans(plansRequest("", { "if-none-match": beforeEtag }));
    expect(revalidated.status).toBe(200);
  });
});

describe("GET /api/v1/plans — the existing revalidation invariant still holds", () => {
  it("still answers 304 for an unchanged catalogue revalidating with its ETag", async () => {
    await reseed();

    const first = await getPlans(plansRequest());
    const etag = etagOf(first);

    const revalidated = await getPlans(plansRequest("", { "if-none-match": etag }));

    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("etag")).toBe(etag);
  });

  it("answers 304 for each variant revalidating with its own ETag", async () => {
    await reseed();

    for (const query of ["", USD_MONTHLY_QUERY]) {
      const etag = etagOf(await getPlans(plansRequest(query)));
      const revalidated = await getPlans(plansRequest(query, { "if-none-match": etag }));

      expect(revalidated.status, `variant ${query || "(default)"}`).toBe(304);
    }
  });
});
