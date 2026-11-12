import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as createAttendeeSession } from "@/app/api/v1/p/attendee-sessions/route";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import {
  invalidatePlatformSettings,
  seedPlatformSettings,
} from "@/server/settings/platform-settings";

import { APP_ORIGIN, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";

/**
 * Integration / performance — the `eventSlug` lookup of
 * `POST /api/v1/p/attendee-sessions` must be **index-backed** (OP-129 round-1
 * review, finding F1; ADR-0781 F1 amendment).
 *
 * **Why this exists.** The create route is public and unauthenticated, and it
 * resolves the body's `eventSlug` with
 * `{ accessLinks: { $elemMatch: { slug, active: true } } }`. The only `events`
 * index that carries the slug is `events_active_slug_unique`
 * (`{accessLinks.slug: 1}`, unique, partial on `{"accessLinks.active": true}`),
 * and the planner's subset check does not accept an `ELEM_MATCH_VALUE`
 * predicate, so the lookup could not use it: every call full-scanned `events`.
 * A plan regression here is invisible to every correctness pin — the answer is
 * still right — so the cost itself has to be pinned.
 *
 * This file is deliberately **separate** from `attendee-sessions.test.ts`: that
 * file is a multi-lane conflict hotspot (PRs #449, #451, #453, #464).
 *
 * ## Contract expected of the implementation
 *
 * The route keeps resolving the slug through an **element-scoped** match — the
 * same `accessLinks[]` element must carry the slug *and* `active: true`
 * (contract §4.2, schema §15.1, ADR-0781 F1) — and the `events` index set must
 * make that exact predicate index-served: the winning plan contains an
 * `IXSCAN` stage, contains no `COLLSCAN` stage, and examines at most
 * {@link DOCS_EXAMINED_CEILING} documents for a seed of {@link SEEDED_EVENTS}
 * rows.
 *
 * This pin names **no index**: adding a non-partial compound index on
 * `{accessLinks.slug, accessLinks.active}` to `INDEX_SPECS` is one way to
 * satisfy it, and any other index (or equivalent planner-usable form) that
 * keeps the semantics below satisfies it too.
 *
 * ## Assumptions recorded in the handoff
 *
 * - The measured query is the route's filter shape verbatim, explained
 *   **without a `limit`**: a `limit(1)` lets a `COLLSCAN` stop at the first
 *   match and hides exactly the cost this pin exists to catch. The target row
 *   is seeded last so even a limited scan would have to walk the collection.
 * - `ensureIndexes(app.db)` runs before the seed, so the plan is measured
 *   against the real index set and not against a bare collection.
 * - The device-fingerprint inputs are irrelevant here; they are present only
 *   so the request is shaped like a real client's.
 */

/** The slug the plan pin resolves — carried by exactly one active link. */
const TARGET_SLUG = "op129plan-target-0001";

/** A rotated row: the first element is revoked, the second is the live one. */
const ROTATED_REVOKED_SLUG = "op129plan-rotated-revoked";
const ROTATED_ACTIVE_SLUG = "op129plan-rotated-active";

/**
 * Documents the reduced plan may examine.
 *
 * The shipped lookup examines **every** seeded row; an index-backed one
 * examines the single matching document (the seed keeps that number at one).
 * The ceiling leaves room for the index probe and the fetch without leaving
 * room for a scan of the collection.
 */
const DOCS_EXAMINED_CEILING = 5;

/**
 * Seeded `events` rows.
 *
 * Large enough that the collection scan is the measurable cost the review
 * reported, small enough that bulk seeding stays far inside the timeout.
 */
const SEEDED_EVENTS = 300;

/** Seeded filler rows; the target and the rotated control row take the rest. */
const FILLER_EVENTS = SEEDED_EVENTS - 2;

/**
 * Seeding and one plan measurement run inside this budget.
 *
 * The work is one `insertMany` plus one `explain`, so anything near this
 * ceiling is a host problem rather than a plan regression — but the explicit
 * budget keeps a slow host from being reported as a hang.
 */
const EXPLAIN_TEST_TIMEOUT_MS = 30_000;

/** The device headers a real attendee client would send. */
const DEVICE_HEADERS: Readonly<Record<string, string>> = {
  "user-agent": "OpenPic-Attendee-Plan/1.0",
  "accept-language": "en-IN,en;q=0.9",
  "x-forwarded-for": "203.0.113.78",
};

let app: TestApp;

/** The `_id` of the rotated control row, so the active-slug arm can name it. */
let rotatedRowId: ObjectId;

/** The slice of an `explain("executionStats")` result this pin reads. */
interface ExecutionStats {
  readonly totalDocsExamined?: number;
  readonly nReturned?: number;
}

/** An `explain` result, narrowed to what the pin asserts on. */
interface ExplainOutput {
  readonly queryPlanner?: { readonly winningPlan?: unknown };
  readonly executionStats?: ExecutionStats;
}

/** One `accessLinks[]` element in the schema §15.1 shape. */
interface AccessLink {
  readonly slug: string;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
}

/**
 * Build one `accessLinks[]` element.
 *
 * @param slug - The public slug.
 * @param active - Whether the link still resolves.
 * @param now - The timestamp stamped on the element.
 * @returns The element, with the rotation marker `active: false` implies.
 */
function accessLink(slug: string, active: boolean, now: Date): AccessLink {
  return { slug, active, createdAt: now, revokedAt: active ? null : now };
}

/**
 * Build a published `events` row carrying exactly `links`.
 *
 * @param id - The row's `_id`.
 * @param name - The row's display name (it identifies the row in failures).
 * @param links - The `accessLinks[]` elements, in order.
 * @param now - The timestamp stamped on the row.
 * @returns The insertable document.
 */
function eventRow(
  id: ObjectId,
  name: string,
  links: readonly AccessLink[],
  now: Date
): Record<string, unknown> {
  return {
    _id: id,
    tenantId: new ObjectId(),
    name,
    description: "",
    status: "published",
    startAt: now,
    endAt: now,
    displayTimeZone: "Asia/Kolkata",
    uploadWindowEndsAt: now,
    retentionExpiresAt: now,
    accessLinks: links,
    createdAt: now,
    schemaVersion: 1,
  };
}

/**
 * Seed the collection the plan is measured against.
 *
 * Every active slug is unique because `events_active_slug_unique` is a unique
 * multikey index: two rows may not both index the same value of
 * `accessLinks.slug` while either is active.
 *
 * @returns Nothing; the rows are written to `app.db`.
 */
async function seedEvents(): Promise<void> {
  const now = new Date();
  const rows: Record<string, unknown>[] = [];

  for (let index = 0; index < FILLER_EVENTS; index += 1) {
    const tag = String(index).padStart(4, "0");
    rows.push(
      eventRow(
        new ObjectId(),
        `OP-129 plan filler ${tag}`,
        [accessLink(`op129plan-${tag}`, true, now)],
        now
      )
    );
  }

  // The shape rotation actually produces, and the one a document-scoped filter
  // cannot tell apart from a live link: the revoked element carries the slug,
  // the active element carries a different one.
  rotatedRowId = new ObjectId();
  rows.push(
    eventRow(
      rotatedRowId,
      "OP-129 plan rotated control",
      [accessLink(ROTATED_REVOKED_SLUG, false, now), accessLink(ROTATED_ACTIVE_SLUG, true, now)],
      now
    )
  );

  // Seeded last: a `limit(1)`-ed collection scan would have to walk every
  // filler row to reach it, so the cost cannot hide behind the row order.
  rows.push(
    eventRow(new ObjectId(), "OP-129 plan target", [accessLink(TARGET_SLUG, true, now)], now)
  );

  await app.db.collection(COLLECTIONS.events).insertMany(rows);
}

/**
 * Explain the route's `eventSlug` filter with execution statistics.
 *
 * The filter is the route's own predicate, verbatim:
 * `{ accessLinks: { $elemMatch: { slug, active: true } } }`.
 *
 * @param slug - The slug to resolve.
 * @returns The narrowed explain output.
 */
async function explainSlugLookup(slug: string): Promise<ExplainOutput> {
  const explanation = await app.db
    .collection(COLLECTIONS.events)
    .find({ accessLinks: { $elemMatch: { slug, active: true } } })
    .explain("executionStats");
  return explanation;
}

/**
 * The winning plan as JSON text, or a failure naming the missing field.
 *
 * @param explanation - The explain output under test.
 * @returns The serialized plan tree, every stage name included.
 */
function winningPlanJson(explanation: ExplainOutput): string {
  const plan = explanation.queryPlanner?.winningPlan;
  if (plan === undefined) {
    throw new Error("the explain result carried no queryPlanner.winningPlan");
  }
  return JSON.stringify(plan);
}

/**
 * The winning plan's examined-document count, or a failure naming the field.
 *
 * @param explanation - The explain output under test.
 * @returns `executionStats.totalDocsExamined`.
 */
function totalDocsExamined(explanation: ExplainOutput): number {
  const examined = explanation.executionStats?.totalDocsExamined;
  if (examined === undefined) {
    throw new Error("the explain result carried no executionStats.totalDocsExamined");
  }
  return examined;
}

/**
 * Send `POST /api/v1/p/attendee-sessions` through the exported handler.
 *
 * @param eventSlug - The body's `eventSlug`.
 * @returns The raw response.
 */
function createSession(eventSlug: string): Promise<Response> {
  return createAttendeeSession(
    new Request(new URL("/api/v1/p/attendee-sessions", APP_ORIGIN), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: APP_ORIGIN,
        ...DEVICE_HEADERS,
      },
      body: JSON.stringify({ eventSlug }),
    })
  );
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op129-slug-plan" });
  await ensureIndexes(app.db);
  await seedPlatformSettings({ db: app.db });
  await seedEvents();
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  // The settings read is process-cached: never leave this suite's seed behind
  // for another file rendered by the same worker.
  invalidatePlatformSettings();
  await app.cleanup();
});

describe("POST /api/v1/p/attendee-sessions — the eventSlug lookup is index-backed (round-1 F1)", () => {
  it(
    "serves the slug lookup from an IXSCAN and never from a COLLSCAN",
    async () => {
      const plan = winningPlanJson(await explainSlugLookup(TARGET_SLUG));

      expect(plan).toContain('"IXSCAN"');
      expect(plan).not.toContain('"COLLSCAN"');
    },
    EXPLAIN_TEST_TIMEOUT_MS
  );

  it(
    "examines at most 5 event documents to resolve one slug",
    async () => {
      const explanation = await explainSlugLookup(TARGET_SLUG);

      expect(totalDocsExamined(explanation)).toBeLessThanOrEqual(DOCS_EXAMINED_CEILING);
    },
    EXPLAIN_TEST_TIMEOUT_MS
  );
});

describe("the element-scoped slug match an optimised lookup must not weaken", () => {
  it("returns no event when the slug sits on an inactive element of a rotated row", async () => {
    const matches = await app.db
      .collection(COLLECTIONS.events)
      .find({ accessLinks: { $elemMatch: { slug: ROTATED_REVOKED_SLUG, active: true } } })
      .toArray();

    // Both predicates are true of the *document* (the row carries this slug and
    // it carries an active link) but not of one element — the match a
    // `accessLinks.slug` + `accessLinks.active` dotted filter would return.
    expect(matches).toHaveLength(0);
  });

  it("returns the event whose active element carries the slug", async () => {
    const matches = await app.db
      .collection(COLLECTIONS.events)
      .find({ accessLinks: { $elemMatch: { slug: ROTATED_ACTIVE_SLUG, active: true } } })
      .toArray();

    expect(matches).toHaveLength(1);
    const matched = matches.at(0) as { readonly _id?: ObjectId } | undefined;
    expect(matched?._id?.toHexString()).toBe(rotatedRowId.toHexString());
  });
});

describe("the route keeps that element-scoped match while the lookup is optimised", () => {
  it("answers 404 not_found for the slug of a rotated-away access link", async () => {
    const response = await createSession(ROTATED_REVOKED_SLUG);

    expect(response.status).toBe(404);
    const body = (await response.json()) as { readonly error: { readonly code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("mints a session for the slug of an active access link", async () => {
    const response = await createSession(ROTATED_ACTIVE_SLUG);

    expect(response.status).toBe(201);
  });
});
