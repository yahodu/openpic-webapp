import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestApp, type SignedInUser, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { bodyOf, errorBody, handlers, keysOf, nextIp, requestFor } from "../helpers/selfie-flow";

/**
 * Integration / contract — the reusable selfie listing is **bounded and
 * cursor-paged** (OP-132 F7; contract §0.8, §6.3; `ADR-0810`).
 *
 * **Why this exists.** `GET /api/v1/p/selfies/reusable` used to answer every
 * active selfie the calling subject holds in every tenant, signing each one on
 * every call. `ADR-0810` fixed the bound — default `40`, ceiling `100`, keyset
 * paging on `(createdAt desc, _id desc)` — but nothing on the tree asserts it:
 * the sibling OP-132 suite that exercises this route deliberately asserts no
 * count (`expect(items.length).toBeGreaterThan(1)`), so a regression that
 * answered `{}` again, or that paged with `skip(offset)`, would go unnoticed.
 * This file is the executable pin for the decision, and it states each
 * obligation as an observable answer: the page size, the cursor round-trip, the
 * tie that straddles the boundary, the refusals and the scope.
 *
 * **The contract pinned here** (from `ADR-0810`; §6.3 carries the wording):
 *
 * ```
 * request   GET /api/v1/p/selfies/reusable?cursor=<opaque>&limit=<1..100>
 *           no `offset`, no `page` param (§0.8)
 * limit     absent -> 40; >100 -> clamped to 100;
 *           non-integer or < 1 -> 422 validation_failed
 * cursor    unparseable / foreign / extra key -> 400 invalid_cursor
 * sort      createdAt desc, then _id desc
 * 200       { data: [...], page: { nextCursor: string|null, hasMore: boolean,
 *           limit: number } }   — no page.total
 * item      exactly { selfieId, createdAt, previewUrl, quality }
 * auth      user only; anonymous -> 401 authentication_required
 * ```
 *
 * **Why these seven cases and this population.** A page size of `0`/`∞` and an
 * offset page are indistinguishable on a small fixture, so the fixture is
 * larger than one default page: 25 active rows in each of two tenants (50 in
 * total), plus one **newer inactive** row and one **newer foreign-subject**
 * row. Ranks 40 and 41 share one `createdAt` on purpose — the default page ends
 * exactly between them, so a keyset filter missing its `_id` tie arm drops a row
 * and one using `<=` repeats it.
 *
 * **How the rows are seeded.** Through the driver, never through the submit
 * route: 50 submissions would spend the per-event attempt budget and the rate
 * limits, and would make this file test the submit path instead of the read.
 * The harness is local to this file (the lane's pin-spec precedent) — no new
 * `src/test/helpers/*` module.
 *
 * **Assumptions.**
 *   - The two tenants are only stamps on the `selfies` rows: the read is the
 *     whitelisted cross-tenant projection, so it must reach both without a
 *     tenant scope and without resolving either tenant.
 *   - `previewUrl` is pinned by its **path**, not by its host or expiry: §5.6's
 *     signer owns both, and the listing's obligation is that the preview names
 *     *this* row's derivative and is signed.
 *   - The `page` object's key set is asserted, not its absence of `total`
 *     alone: §6.3's envelope is closed, and a future member must be a decision.
 */

/* ───────────────────────────── contract constants ────────────────────────── */

/** The endpoint under pin. */
const PATH = "/api/v1/p/selfies/reusable";

/**
 * §0.8's default page size, as a **literal**.
 *
 * Deliberately not imported from `DEFAULT_PAGE_LIMIT`: importing the constant
 * would let a change to the bound pass this pin. The number is the contract.
 */
const DEFAULT_LIMIT = 40;

/** §0.8's ceiling, as a literal, for the same reason. */
const MAX_LIMIT = 100;

/** Active selfies the caller holds in each of the two tenants. */
const PER_TENANT = 25;

/** The four keys §6.3 gives one item, sorted. */
const ITEM_KEYS = ["createdAt", "previewUrl", "quality", "selfieId"];

/** The three keys §6.3 gives the `page` member, sorted — `total` is not one. */
const PAGE_KEYS = ["hasMore", "limit", "nextCursor"];

/* ──────────────────────────────── wire shapes ────────────────────────────── */

/** One reusable selfie as §6.3 shows it. */
interface ReusableItem {
  readonly selfieId: string;
  readonly createdAt: string;
  readonly previewUrl: string;
  readonly quality: { readonly accepted: boolean };
}

/** The `page` member §6.3 shows next to `data`. */
interface PageEnvelope {
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly limit: number;
}

/** A seeded `selfies` row as these cases track it. */
interface SeededSelfie {
  readonly selfieId: string;
  readonly contentHash: string;
  readonly createdAt: Date;
  /** Which of the two tenants the row was uploaded in; the read must span both. */
  readonly tenant: "a" | "b";
}

/* ──────────────────────────────── seeding ────────────────────────────────── */

const MINUTE_MS = 60_000;

/** The instant rank 50 is stamped with; every other row is whole minutes later. */
const OLDEST_INSTANT = Date.parse("2026-03-01T00:00:00.000Z");

/** Sixteen hex characters of a synthetic `_id`; the last eight carry the rank. */
const ID_PREFIX = "0a1320af9c6e6900";

/**
 * A deterministic `_id` for the row of the given rank (1 = newest).
 *
 * The id **descends** with the rank, so `_id: -1` orders a higher rank first.
 * That is what decides the `createdAt` tie at ranks 40/41: the newer id closes
 * the default page, the older one opens the next.
 *
 * @param rank - The 1-based position in the descending listing.
 * @returns The row's `_id`.
 */
function idOf(rank: number): ObjectId {
  return new ObjectId(`${ID_PREFIX}${(1000 - rank).toString(16).padStart(8, "0")}`);
}

/**
 * The `createdAt` of the row of the given rank.
 *
 * Ranks 40 and 41 deliberately share one instant, so the default page's last
 * row and the next page's first row tie. Every other rank is a distinct minute.
 *
 * @param rank - The 1-based position in the descending listing.
 * @returns The row's creation instant.
 */
function createdAtOf(rank: number): Date {
  // Rank 41 borrows rank 40's minute: the tie, on the page boundary.
  const minutes = rank === 41 ? 10 : 50 - rank;
  return new Date(OLDEST_INSTANT + minutes * MINUTE_MS);
}

/** The fields this file stamps onto a `selfies` row. */
interface SeedSelfieInput {
  readonly _id: ObjectId;
  readonly tenantId: ObjectId;
  readonly subjectUserId: ObjectId;
  readonly createdAt: Date;
  readonly contentHash: string;
  readonly isActive: boolean;
}

/**
 * Insert one `selfies` row through the driver.
 *
 * The listing projects `_id`, `createdAt`, `contentHash` and `quality`, so those
 * are the four the row must carry; the tenant, event and profile stamps are
 * what the cross-tenant read must ignore. `expireAt` is omitted on purpose —
 * the TTL index that sweeps it is built by `ensureIndexes`, which this harness
 * never runs, and a row without the field is never swept.
 *
 * @param row - The stamped row.
 * @returns A promise that settles once the row is stored.
 */
async function seedSelfie(row: SeedSelfieInput): Promise<void> {
  await app.db.collection("selfies").insertOne({
    _id: row._id,
    tenantId: row.tenantId,
    eventId: new ObjectId(),
    profileId: new ObjectId(),
    subject: { userId: row.subjectUserId },
    kind: "selfie",
    contentHash: row.contentHash,
    quality: { accepted: true },
    isActive: row.isActive,
    createdAt: row.createdAt,
  });
}

/* ──────────────────────────────── harness ────────────────────────────────── */

let app: TestApp;
let caller: SignedInUser;

/** The 50 active rows, newest first — the order the listing must answer. */
let seeded: SeededSelfie[];

/** The id of the tied row that closes the default page (rank 40). */
let tieNewerId: string;

/** The id of the tied row that opens the next page (rank 41). */
let tieOlderId: string;

/** The id of the newer row that is inactive, and so never listed. */
let inactiveId: string;

/** The id of the newer active row that belongs to another subject. */
let foreignId: string;

/** The seeded row of the given 1-based rank, newest first. */
function rankRow(rank: number): SeededSelfie {
  const row = seeded[rank - 1];
  if (row === undefined) {
    throw new Error(`expected a seeded row at rank ${String(rank)}`);
  }
  return row;
}

/** The ids of the first `count` seeded rows, newest first. */
function expectedIds(count: number): string[] {
  return seeded.slice(0, count).map((row) => row.selfieId);
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op132-f7pin" });
  caller = await app.signIn();

  const tenantA = new ObjectId();
  const tenantB = new ObjectId();
  const rows: SeededSelfie[] = [];

  for (let rank = 1; rank <= PER_TENANT * 2; rank += 1) {
    const tenant = rank <= PER_TENANT ? "a" : "b";
    const createdAt = createdAtOf(rank);
    const contentHash = `hash-${String(rank).padStart(2, "0")}`;
    const _id = idOf(rank);
    await seedSelfie({
      _id,
      tenantId: tenant === "a" ? tenantA : tenantB,
      subjectUserId: caller.userId,
      createdAt,
      contentHash,
      isActive: true,
    });
    rows.push({ selfieId: _id.toHexString(), contentHash, createdAt, tenant });
  }

  seeded = rows;
  tieNewerId = rankRow(40).selfieId;
  tieOlderId = rankRow(41).selfieId;

  // Two rows newer than every listed one, each excluded for its own reason: one
  // is inactive, the other belongs to a different subject. Neither may appear.
  const inactive = new ObjectId(`${ID_PREFIX}ffffffff`);
  inactiveId = inactive.toHexString();
  await seedSelfie({
    _id: inactive,
    tenantId: tenantA,
    subjectUserId: caller.userId,
    createdAt: new Date(OLDEST_INSTANT + 300 * MINUTE_MS),
    contentHash: "hash-inactive",
    isActive: false,
  });

  const foreign = new ObjectId(`${ID_PREFIX}fffffffe`);
  foreignId = foreign.toHexString();
  await seedSelfie({
    _id: foreign,
    tenantId: tenantA,
    subjectUserId: new ObjectId(),
    createdAt: new Date(OLDEST_INSTANT + 200 * MINUTE_MS),
    contentHash: "hash-foreign",
    isActive: true,
  });
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

/* ──────────────────────────────── requests ───────────────────────────────── */

/**
 * Build one listing request.
 *
 * @param query - The query string, `""` for no parameters.
 * @param cookie - The caller's session cookie, or `undefined` for an anonymous
 *   caller.
 * @returns The `Request` the handler is invoked with.
 */
function listingRequest(query: string, cookie: string | undefined): Request {
  return requestFor(`${PATH}${query}`, "GET", {
    ip: nextIp(),
    withoutIdempotencyKey: true,
    ...(cookie === undefined ? {} : { cookie }),
  });
}

/** The ids an answer lists, in the order it lists them. */
function idsOf(items: readonly ReusableItem[]): string[] {
  return items.map((item) => item.selfieId);
}

/** The distinct sorted key sets across `values`, so one assertion covers every one. */
function distinctKeySets(values: readonly object[]): string[] {
  return [...new Set(values.map((value) => keysOf(value).join(",")))].sort();
}

/** The path of a signed media URL, host and query stripped. */
function previewPath(url: string): string {
  return new URL(url).pathname;
}

/**
 * GET the listing and parse the documented `200`.
 *
 * @param query - The query string, `""` for no parameters.
 * @returns The items and the page envelope.
 */
async function list(query: string): Promise<{ items: ReusableItem[]; page: PageEnvelope }> {
  const response = await handlers.reusableSelfies(listingRequest(query, caller.cookie));
  const body = await bodyOf(response, 200, `GET ${PATH}${query}`);
  return {
    items: (body.data ?? []) as ReusableItem[],
    page: (body.page ?? {}) as PageEnvelope,
  };
}

/* ──────────────────────────────── the pins ───────────────────────────────── */

describe("when an identified attendee lists more reusable selfies than one page", () => {
  it("bounds the first page at the default 40 and hands back a cursor", async () => {
    const { items, page } = await list("");

    // The bound is the decision: 50 rows exist, 40 are answered.
    expect(items).toHaveLength(DEFAULT_LIMIT);
    expect(idsOf(items)).toEqual(expectedIds(DEFAULT_LIMIT));

    // The envelope is §6.3's, closed: no `total`, no other member.
    expect(distinctKeySets([page])).toEqual([PAGE_KEYS.join(",")]);
    expect(page.limit).toBe(DEFAULT_LIMIT);
    expect(page.hasMore).toBe(true);
    expect(typeof page.nextCursor).toBe("string");
    expect(page.nextCursor).not.toBe("");

    // One item is exactly the four safe facts — never a vector, never a score.
    expect(distinctKeySets(items)).toEqual([ITEM_KEYS.join(",")]);
    expect(distinctKeySets(items.map((item) => item.quality))).toEqual(["accepted"]);

    // The signed preview names *this* row's derivative and is signed.
    expect(items.map((item) => previewPath(item.previewUrl))).toEqual(
      seeded.slice(0, DEFAULT_LIMIT).map((row) => `/p/${row.contentHash}.webp`)
    );
    expect(items.map((item) => item.createdAt)).toEqual(
      seeded.slice(0, DEFAULT_LIMIT).map((row) => row.createdAt.toISOString())
    );
    const [first] = items;
    if (first === undefined) {
      throw new Error("expected the first page to carry at least one item");
    }
    expect(new URL(first.previewUrl).searchParams.get("sig")).toMatch(/^[\w-]+$/);
    expect(first.quality.accepted).toBe(true);
  });

  it("follows the cursor to a terminal page of the remaining 10", async () => {
    const first = await list("");
    const cursor = first.page.nextCursor;
    if (cursor === null) {
      throw new Error("expected the first page to carry a cursor");
    }

    const second = await list(`?cursor=${encodeURIComponent(cursor)}`);

    expect(second.items).toHaveLength(PER_TENANT * 2 - DEFAULT_LIMIT);
    expect(second.page.hasMore).toBe(false);
    expect(second.page.nextCursor).toBeNull();

    // The two pages cover the 50 seeded rows exactly once each, in the one order
    // the sort defines — a repeated or skipped row breaks this `toEqual`.
    const ids = [...idsOf(first.items), ...idsOf(second.items)];
    expect(ids).toEqual(expectedIds(PER_TENANT * 2));
    expect(new Set(ids).size).toBe(PER_TENANT * 2);
  });

  it("does not skip or repeat a row whose createdAt ties across the page break", async () => {
    const first = await list("");
    const cursor = first.page.nextCursor;
    if (cursor === null) {
      throw new Error("expected the first page to carry a cursor");
    }
    const second = await list(`?cursor=${encodeURIComponent(cursor)}`);
    const ids = [...idsOf(first.items), ...idsOf(second.items)];

    // The tie is split by the boundary: the larger `_id` ends page 1, the
    // smaller one opens page 2 — `_id` desc is the tiebreak the sort declares.
    expect(first.items).toHaveLength(DEFAULT_LIMIT);
    expect(ids.at(DEFAULT_LIMIT - 1)).toBe(tieNewerId);
    expect(ids.at(DEFAULT_LIMIT)).toBe(tieOlderId);

    // A keyset filter without the `_id` arm drops the second row; one that
    // compares `<=` repeats the first. Both are visible exactly here.
    expect(ids.filter((id) => id === tieNewerId)).toHaveLength(1);
    expect(ids.filter((id) => id === tieOlderId)).toHaveLength(1);
    expect(ids).toHaveLength(PER_TENANT * 2);
  });

  it("honours a small limit, clamps an over-max one and rejects an impossible one", async () => {
    const small = await list("?limit=5");
    expect(small.items).toHaveLength(5);
    expect(idsOf(small.items)).toEqual(expectedIds(5));
    expect(small.page.limit).toBe(5);
    expect(small.page.hasMore).toBe(true);
    expect(small.page.nextCursor).not.toBeNull();

    // Over the ceiling is clamped, never rejected: the whole population fits.
    const clamped = await list(`?limit=${String(MAX_LIMIT + 1)}`);
    expect(clamped.page.limit).toBe(MAX_LIMIT);
    expect(clamped.items.length).toBeLessThanOrEqual(MAX_LIMIT);
    expect(idsOf(clamped.items)).toEqual(expectedIds(PER_TENANT * 2));
    expect(clamped.page.hasMore).toBe(false);

    const zero = await handlers.reusableSelfies(listingRequest("?limit=0", caller.cookie));
    expect(zero.status).toBe(422);
    expect((await errorBody(zero)).code).toBe("validation_failed");

    const text = await handlers.reusableSelfies(listingRequest("?limit=abc", caller.cookie));
    expect(text.status).toBe(422);
    expect((await errorBody(text)).code).toBe("validation_failed");
  });

  it("refuses a garbage, empty or extra-key cursor instead of ignoring it", async () => {
    const garbage = await handlers.reusableSelfies(
      listingRequest("?cursor=not-a-cursor", caller.cookie)
    );
    expect(garbage.status).toBe(400);
    expect((await errorBody(garbage)).code).toBe("invalid_cursor");

    // An empty cursor is a cursor the client sent, not an absent one.
    const empty = await handlers.reusableSelfies(listingRequest("?cursor=", caller.cookie));
    expect(empty.status).toBe(400);
    expect((await errorBody(empty)).code).toBe("invalid_cursor");

    // Well-formed halves plus one extra key: the codec is strict, so a cursor
    // this deployment never minted is refused rather than read.
    const extraKey = Buffer.from(
      JSON.stringify({ c: rankRow(1).createdAt.toISOString(), i: rankRow(1).selfieId, x: 1 })
    ).toString("base64url");
    const strict = await handlers.reusableSelfies(
      listingRequest(`?cursor=${extraKey}`, caller.cookie)
    );
    expect(strict.status).toBe(400);
    expect((await errorBody(strict)).code).toBe("invalid_cursor");
  });

  it("ignores an offset parameter instead of paging by it", async () => {
    const plain = await list("");
    const offset = await list("?offset=10");

    // §0.8 has no offset parameter, so an unknown one is not honoured: the
    // answer is byte-for-byte the first page, cursor included. A listing that
    // quietly skipped 10 rows would differ in every one of these.
    expect(idsOf(offset.items)).toEqual(idsOf(plain.items));
    expect(offset.page).toEqual(plain.page);
    expect(offset.items).toHaveLength(DEFAULT_LIMIT);
  });

  it("keeps the read scoped to the caller across both tenants and still refuses an anonymous caller", async () => {
    const first = await list("");
    const cursor = first.page.nextCursor;
    if (cursor === null) {
      throw new Error("expected the first page to carry a cursor");
    }
    const second = await list(`?cursor=${encodeURIComponent(cursor)}`);
    const ids = [...idsOf(first.items), ...idsOf(second.items)];

    // Neither exclusion is an artefact of the bound: the inactive row is newer
    // than everything listed, and so is the other subject's row.
    expect(idsOf(first.items)).not.toContain(inactiveId);
    expect(idsOf(second.items)).not.toContain(inactiveId);
    expect(idsOf(first.items)).not.toContain(foreignId);
    expect(idsOf(second.items)).not.toContain(foreignId);

    // The read spans the two tenants the caller uploaded in, and holds only the
    // caller's own rows: 25 from each, nothing else.
    expect(ids).toEqual(expectedIds(PER_TENANT * 2));
    expect(new Set(ids).size).toBe(PER_TENANT * 2);

    const perTenant = (tenant: "a" | "b"): number =>
      ids.filter((id) => seeded.some((row) => row.selfieId === id && row.tenant === tenant)).length;
    expect(perTenant("a")).toBe(PER_TENANT);
    expect(perTenant("b")).toBe(PER_TENANT);

    // The bound does not change the auth stage: no session is no listing.
    const anonymous = await handlers.reusableSelfies(listingRequest("", undefined));
    expect(anonymous.status).toBe(401);
    expect((await errorBody(anonymous)).code).toBe("authentication_required");
  });
});
