import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestApp, type SignedInUser, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { bodyOf, errorBody, handlers, keysOf, nextIp, requestFor } from "../helpers/selfie-flow";

/**
 * Integration / contract — a cursor that **decodes** at the wire codec but whose
 * halves are not the stored types is refused by the repository, not read
 * (contract §0.8, §6.3; `ADR-0810`).
 *
 * **Why this exists.** The reusable listing (`ADR-0810`) continues a page with a
 * keyset filter on the compound `(createdAt, _id)` key. Two layers can refuse a
 * cursor, and they are not the same refusal:
 *
 * ```text
 * wire codec    decodeCursor / parsePageQuery   base64url(JSON) -> strict { c, i }
 *                                                both halves non-empty strings
 * stored types  reusableKeysetFilter            c -> Date, i -> 24 hex ObjectId
 * ```
 *
 * The wire codec is shared by every cursor-paged endpoint, so it can only check
 * *shape*: `{ c: "not-a-date", i: "<24 hex>" }` is a perfectly well-formed cursor
 * and comes back as a `Cursor`. The **stored-type** half is the listing's own
 * obligation — `new Date("not-a-date")` is `Invalid Date` (a page filter that
 * silently matches nothing) and `new ObjectId("zzz")` throws (a `500`), so the
 * repository revives both halves and refuses the cursor with `invalid_cursor`
 * first. The merged F7 pin (`selfie-reusable-listing-page-bound.test.ts`, case 5)
 * only sends cursors the *codec* rejects — garbage, empty, extra key — so it
 * fails one layer too early and leaves the stored-type guard unpinned.
 *
 * **The obligation pinned here**, in one sentence: a cursor whose halves decode
 * but are not a stored date and a stored `_id` answers `400 invalid_cursor`, and
 * a cursor whose halves *are* stored types is honoured as a position.
 *
 * **Why a control case.** "Refuse everything" would satisfy the two refusal cases
 * and break the listing, so case 2 sends the cursor a client actually receives —
 * a real row's `createdAt` and `_id` — and requires the page after it. Case 4 is
 * the other control: a non-string half never reaches the repository at all, which
 * is what keeps the two layers from being conflated into one.
 *
 * **How the rows are seeded.** Through the driver, exactly as the F7 pin does:
 * the fixture is a read fixture, and driving two submissions would exercise the
 * submit path (attempt budget, rate limits) instead of this read. The harness is
 * local to this file — no new `src/test/helpers/*` module.
 *
 * **Assumptions.**
 *   - The `selfies` row shape is the one the listing projects: `_id`, `createdAt`,
 *     `contentHash`, `quality`, `isActive`, `subject.userId`. The tenant stamps
 *     are irrelevant to a cross-tenant read and are present only to be realistic.
 *   - Both refusal cases carry a **24-hex** `i` (case 1) or an **ISO** `c`
 *     (case 2), so exactly one half is bad: the case fails the half it names.
 *   - Assertions stop at `status` + `error.code`. The refusal's `details` is not
 *     part of this contract and is not asserted.
 */

/* ───────────────────────────── contract constants ────────────────────────── */

/** The endpoint under pin. */
const PATH = "/api/v1/p/selfies/reusable";

/** §6.3's page member, sorted — the envelope the control case must see. */
const PAGE_KEYS = ["hasMore", "limit", "nextCursor"];

/** §0.8's default page size, as a **literal**: importing it would let a change pass. */
const DEFAULT_LIMIT = 40;

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

/* ──────────────────────────────── seeding ────────────────────────────────── */

/** The instant the older of the two seeded rows was created. */
const OLDER_INSTANT = "2026-03-01T00:00:00.000Z";

/** The instant the newer of the two seeded rows was created. */
const NEWER_INSTANT = "2026-03-02T00:00:00.000Z";

/** The fields this file stamps onto a `selfies` row. */
interface SeedSelfieInput {
  readonly _id: ObjectId;
  readonly tenantId: ObjectId;
  readonly subjectUserId: ObjectId;
  readonly createdAt: Date;
  readonly contentHash: string;
}

/**
 * Insert one active `selfies` row through the driver.
 *
 * `expireAt` is omitted on purpose: the TTL index that sweeps it is built by
 * `ensureIndexes`, which this harness never runs, so a row without the field is
 * never swept.
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
    isActive: true,
    createdAt: row.createdAt,
  });
}

/* ──────────────────────────────── harness ────────────────────────────────── */

let app: TestApp;
let caller: SignedInUser;

/** The newer of the two seeded rows — the one the control cursor points at. */
let newerId: string;

/** The older of the two seeded rows — the one the control cursor must reach. */
let olderId: string;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op132-cursor-halves" });
  caller = await app.signIn();

  const tenantId = new ObjectId();

  // Two rows a day apart in the sort. A cursor placed on the newer row is only
  // honoured correctly if the older one is the answer.
  const newer = new ObjectId("0a1320af9c6e690000000002");
  newerId = newer.toHexString();
  await seedSelfie({
    _id: newer,
    tenantId,
    subjectUserId: caller.userId,
    createdAt: new Date(NEWER_INSTANT),
    contentHash: "hash-newer",
  });

  const older = new ObjectId("0a1320af9c6e690000000001");
  olderId = older.toHexString();
  await seedSelfie({
    _id: older,
    tenantId,
    subjectUserId: caller.userId,
    createdAt: new Date(OLDER_INSTANT),
    contentHash: "hash-older",
  });
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

/* ──────────────────────────────── requests ───────────────────────────────── */

/**
 * Encode a cursor the way a client would see one — `base64url(JSON.stringify(k))`.
 *
 * Deliberately local: the point of these cases is the **wire shape a client can
 * send**, so the spec builds the string itself rather than calling the endpoint's
 * encoder with a value it could never mint.
 *
 * @param key - The halves to serialize; `i` may be any JSON value here.
 * @returns The opaque cursor string.
 */
function encodeHalves(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

/**
 * GET the listing with one cursor.
 *
 * @param cursor - The raw (already encoded) cursor value.
 * @returns The response, unread, so each case asserts what it owns.
 */
async function get(cursor: string): Promise<Response> {
  return handlers.reusableSelfies(
    requestFor(`${PATH}?cursor=${encodeURIComponent(cursor)}`, "GET", {
      cookie: caller.cookie,
      ip: nextIp(),
      withoutIdempotencyKey: true,
    })
  );
}

/**
 * GET the listing with one cursor and require the §6.3 `200`.
 *
 * @param cursor - The raw (already encoded) cursor value.
 * @returns The items and the page envelope the answer carried.
 */
async function get200(cursor: string): Promise<{ items: ReusableItem[]; page: PageEnvelope }> {
  const response = await get(cursor);
  const body = await bodyOf(response, 200, `GET ${PATH}?cursor=<${cursor}>`);
  return {
    items: (body.data ?? []) as ReusableItem[],
    page: (body.page ?? {}) as PageEnvelope,
  };
}

/* ───────────────────────────────── the pins ──────────────────────────────── */

describe("when a cursor decodes but its halves are not the stored types", () => {
  it("refuses a well-formed cursor whose `c` is not a date with 400 invalid_cursor", async () => {
    // `{ c, i }`, both strings, `i` a real 24-hex id: the wire codec accepts it,
    // so this refusal can only come from the stored-type guard.
    const response = await get(encodeHalves({ c: "not-a-date", i: olderId }));

    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe("invalid_cursor");
  });

  it("refuses a well-formed cursor whose `i` is not 24 hex with 400 invalid_cursor", async () => {
    // The `c` half is a date the sort can compare; `i` is not an ObjectId, and
    // reviving it would throw rather than filter.
    const response = await get(encodeHalves({ c: OLDER_INSTANT, i: "zzz" }));

    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe("invalid_cursor");
  });
});

describe("when a cursor's halves are the types the listing stores", () => {
  it("honours a structurally valid cursor as a position and answers the §6.3 envelope", async () => {
    // The cursor the endpoint itself hands a client: the newer row's createdAt and
    // `_id`. Refusing this would satisfy the two cases above and break paging.
    const { items, page } = await get200(encodeHalves({ c: NEWER_INSTANT, i: newerId }));

    // The page **after** that position: the older row, and only it. A guard that
    // refused every cursor would never get here; one that ignored the cursor would
    // answer the newer row too.
    expect(items.map((item) => item.selfieId)).toEqual([olderId]);

    // §6.3's envelope, closed: three keys, no `total`, terminal because two rows
    // cannot fill a 40-row page.
    expect(keysOf(page)).toEqual(PAGE_KEYS);
    expect(page.limit).toBe(DEFAULT_LIMIT);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("refuses a non-string half at the wire codec, before the stored-type guard", async () => {
    // `i: 5` is not a cursor this deployment ever minted, so `decodeCursor`'s
    // strict `{ c: string, i: string }` refuses it. That is the layering this case
    // pins: wire shape first, stored types second — the repository never sees it.
    const response = await get(encodeHalves({ c: OLDER_INSTANT, i: 5 }));

    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe("invalid_cursor");
  });
});
