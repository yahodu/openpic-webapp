import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SELFIE_LOCATION_KEY, selfieObjectKey } from "@/server/attendee/selfie-submit";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { crossTenantReads } from "@/server/repos";
import { getObjectStorage } from "@/server/storage/get-object-storage";

import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
  bodyOf,
  confirmSelfie,
  createAttendeeSession,
  finishSelfieWorker,
  grantConsent,
  issueChallenge,
  keysOf,
  makeSelfieBytes,
  nextIp,
  requestFor,
  seedTenant,
  submitBody,
  submitSelfie,
  handlers,
  type SeededEvent,
} from "../helpers/selfie-flow";

/**
 * Integration / contract — the zero-match confirmation arm and the reusable
 * listing's page bound (OP-132 review findings **F6** and **F7** of
 * `t_3b8151c3`, Low; contract §6.3/§6.4, §7.6, §10.3.2; schema §15.3, §16.4;
 * ADR-0807 — whose §Amends names the confirmation and publication records this
 * file extends).
 *
 * **Why this exists.**
 *
 * - **F6 — the `matched === 0` arm of the confirm's publication branch was
 *   unpinned.** The three F3 cases (`selfie-confirm-publication.test.ts`) prove
 *   a confirm publishes once, publishes the delta and publishes a late result;
 *   every one of them has at least one match. So "a ready selfie that matched
 *   nothing announces nothing" was unobserved, and a regression that gated the
 *   outbox on `published` alone would notify an attendee about zero photos.
 * - **F7 — the reusable listing is unbounded.** `GET /p/selfies/reusable` calls
 *   `crossTenantReads.findReusableSelfiesBySubjectUser(principal, {}, getDb())`
 *   — no `limit` — so the answer is every active selfie the subject holds in
 *   every tenant, and the response carries no `nextCursor` to page with. That is
 *   a growth hazard, not a wrong answer, so this file does **not** pin a count:
 *   it pins the two properties any bound must preserve (newest first, and the
 *   caller's own active selfies across both tenants) and, beside them, the seam
 *   the port already offers — a `limit` the route does not pass. The measured
 *   size of today's unbounded answer is recorded in ADR-0807 and the handoff
 *   instead of being asserted, because an assertion on that number would fail
 *   the moment a bound is added.
 *
 * ## What is pinned
 *
 * - Confirm of a selfie whose worker run found **zero** photos answers `200`
 *   with `status: "ready"`, `matchCount: 0`, and **no** `attendee.matches.new`
 *   row — and leaves §15.3's `firstMatchNotifiedAt` watermark unset, because no
 *   delivery happened.
 * - `GET /p/selfies/reusable` answers the caller's own **active** selfies
 *   newest first, reaching **both** tenants, with exactly the four §6.3 keys per
 *   item — over a population larger than a page (50 rows), so a route that
 *   returned one row per profile, or ignored the subject filter, cannot pass.
 * - The whitelisted cross-tenant read honours `limit` when it is given, and
 *   returns the whole set when it is not (its documented default) — the seam a
 *   bound would use.
 *
 * ## Assumptions (recorded in ADR-0807)
 *
 * - **`matchCount` is read off the profile row**, as the three F3 cases and the
 *   §6.4 "cached total" definition do; the confirm's `200` envelope carries the
 *   seven §6.3 keys and no match count, so the row is the observable.
 * - **The zero-match worker still writes its vector.** `finishSelfieWorker` with
 *   `matches: 0` writes the embedding and the quality verdict and no
 *   `faceMatches` row, which is what makes `status: "ready"` a real arm rather
 *   than the pre-worker `processing` arm; the case asserts the vector is there
 *   so it cannot pass for the wrong reason.
 * - **The reusable rows are seeded**, not submitted: 50 selfies would spend the
 *   `selfies.per_attendee` budget (3) and the `selfie.submit` rate class (6/h),
 *   and the listing reads only the stored §16.4 fields. The rows alternate
 *   between two tenants so "spans both tenants" holds for any page size ≥ 2.
 * - **No bound is asserted.** The route has none today; inventing one (a
 *   literal page size) would either pass vacuously or fail a legitimate fix.
 */

let app: TestApp;

/* ───────────────────────────── contract constants ────────────────────────── */

/** The seven keys the confirm's `200` carries, sorted (§6.3/§6.4). */
const CONFIRM_KEYS = [
  "attemptsRemaining",
  "attemptsUsed",
  "pollIntervalMs",
  "pollUrl",
  "profileId",
  "selfieId",
  "status",
];

/** The four keys one reusable-selfie item carries, sorted (§6.3). */
const REUSABLE_ITEM_KEYS = ["createdAt", "previewUrl", "quality", "selfieId"];

/** The one event key the "new photos of you" arrival is recorded under (§7.6). */
const MATCHES_NEW_EVENT = "attendee.matches.new";

/** How many active selfies the subject holds in **each** of the two tenants. */
const PER_TENANT = 25;

/** The newest `createdAt` of the seeded population (a fixed, ordered instant). */
const NEWEST_AT = Date.parse("2026-06-01T12:00:00.000Z");

/* ─────────────────────────────── row shapes ──────────────────────────────── */

/** A stored `attendee_event_profiles` row, as these cases read it (§15.3). */
interface ProfileRow {
  readonly _id: ObjectId;
  readonly subject: Record<string, unknown>;
  readonly status: string;
  readonly matchCount: number;
  readonly firstMatchNotifiedAt?: Date | null;
}

/** A stored `selfies` row, as the non-vacuity readers read it (§16.4). */
interface SelfieRow {
  readonly embedding?: unknown;
  readonly isActive?: boolean;
}

/** The caller's credential and client address. */
interface Caller {
  readonly cookie: string;
  readonly ip: string;
}

/* ───────────────────────────────── harness ───────────────────────────────── */

beforeAll(async () => {
  app = await startTestApp({ prefix: "op132-zero-and-page" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  for (const name of [
    COLLECTIONS.events,
    COLLECTIONS.eventOrganizers,
    COLLECTIONS.tenants,
    COLLECTIONS.tenantMembers,
    COLLECTIONS.userProfiles,
    COLLECTIONS.mediaAssets,
    COLLECTIONS.attendeeSessions,
    COLLECTIONS.attendeeEventProfiles,
    COLLECTIONS.faceMatches,
    COLLECTIONS.domainEvents,
    COLLECTIONS.idempotencyKeys,
    COLLECTIONS.consents,
    COLLECTIONS.selfies,
  ]) {
    await app.db.collection(name).deleteMany({});
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ──────────────────────────────── readers ────────────────────────────────── */

/**
 * The single stored `attendee_event_profiles` row these cases expect.
 *
 * @returns The profile row.
 */
async function profileRow(): Promise<ProfileRow> {
  const row = (await app.db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .findOne({})) as unknown as ProfileRow | null;
  if (row === null) {
    throw new Error("expected the caller's attendee profile to exist");
  }
  return row;
}

/**
 * Every stored `attendee.matches.new` outbox row, oldest first (§7.7).
 *
 * @returns The outbox rows for that event key.
 */
async function matchesNewRows(): Promise<{ readonly payload?: Record<string, unknown> }[]> {
  const rows = await app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey: MATCHES_NEW_EVENT })
    .toArray();
  return rows as unknown as { readonly payload?: Record<string, unknown> }[];
}

/* ──────────────────────────────── fixtures ───────────────────────────────── */

/** A published event with a consented anonymous attendee. */
type ReadyEvent = { readonly tenantKey: string; readonly event: SeededEvent } & Caller;

/**
 * Seed a published event, mint an attendee session on it and grant consent.
 *
 * @param prefix - The suite-local prefix for the seeded organizer.
 * @returns The event and the caller's handles.
 */
async function readyEvent(prefix: string): Promise<ReadyEvent> {
  const { tenantKey, events } = await seedTenant(app, prefix);
  const [event] = events;
  if (event === undefined) {
    throw new Error("expected one seeded event");
  }
  const ip = nextIp();
  const session = await createAttendeeSession(app, ip);
  await grantConsent(event.slug, { cookie: session.cookie, ip });
  return { tenantKey, event, cookie: session.cookie, ip };
}

/**
 * Submit one already-uploaded selfie (the §6.3 `202`).
 *
 * @param slug - The event's active access-link slug.
 * @param caller - The caller's credential and client address.
 * @param tag - The per-selfie tag whose bytes are put into the store.
 * @returns The stored selfie's id and its profile's id.
 */
async function submitOne(
  slug: string,
  caller: Caller,
  tag: string
): Promise<{ readonly selfieId: string; readonly profileId: string }> {
  const bytes = makeSelfieBytes(tag);
  await getObjectStorage().putObject(
    SELFIE_LOCATION_KEY,
    selfieObjectKey(bytes.hash),
    bytes.bytes,
    "image/jpeg"
  );
  const challenge = await issueChallenge(slug, caller);
  const response = await submitSelfie(slug, {
    cookie: caller.cookie,
    ip: caller.ip,
    body: submitBody({ hash: bytes.hash }, challenge),
  });
  const body = await bodyOf(response, 202, `POST selfies on ${slug}`);
  const selfieId = body.selfieId;
  const profileId = body.profileId;
  if (typeof selfieId !== "string" || typeof profileId !== "string") {
    throw new Error(`expected the 202 body to carry ids: ${JSON.stringify(body)}`);
  }
  return { selfieId, profileId };
}

/* ──────────── F6: a ready selfie that matched nothing announces nothing ──── */

describe("when the worker's run finds no photos of the attendee", () => {
  it("answers 200 with status ready, matchCount 0 and no attendee.matches.new row", async () => {
    const ready = await readyEvent("op132-f6-zero");
    const submitted = await submitOne(ready.event.slug, ready, "f6-zero");
    const profile = await profileRow();

    // The worker finished and wrote its verdict — just zero rows. Without the
    // vector the confirm would answer `processing` and the case would be about
    // the pre-worker arm instead of the zero-match arm.
    await finishSelfieWorker(app, {
      selfieId: submitted.selfieId,
      profileId: submitted.profileId,
      eventId: ready.event.id.toHexString(),
      tenantKey: ready.tenantKey,
      subject: profile.subject,
      matches: 0,
    });
    const stored = (await app.db
      .collection(COLLECTIONS.selfies)
      .findOne(
        { _id: new ObjectId(submitted.selfieId) },
        { projection: { embedding: 1 } }
      )) as unknown as SelfieRow | null;
    expect(stored?.embedding).toBeDefined();

    const response = await confirmSelfie(ready.event.slug, submitted.selfieId, {
      cookie: ready.cookie,
      ip: ready.ip,
    });
    const confirmation = await bodyOf(response, 200, "POST selfie confirm");

    expect(keysOf(confirmation)).toEqual(CONFIRM_KEYS);
    expect(confirmation.status).toBe("ready");
    expect(confirmation.selfieId).toBe(submitted.selfieId);

    // §6.4's cached total is a real zero, not an untouched row.
    const after = await profileRow();
    expect(after.matchCount).toBe(0);

    // §7.6/§7.7: no photos, no notification — and therefore no §15.3 watermark:
    // the one-shot "we told you about your photos" stamp belongs to a delivery.
    expect(await matchesNewRows()).toHaveLength(0);
    expect(after.firstMatchNotifiedAt ?? null).toBeNull();
  });
});

/* ────────── F7: the reusable listing over a page-sized population ────────── */

/** One seeded selfie this file can recognise again. */
interface SeededSelfie {
  readonly selfieId: string;
  readonly tenantKey: string;
  readonly createdAt: Date;
  readonly active: boolean;
}

/**
 * Seed one stored, active selfie row for a subject (schema §16.4, §16.1).
 *
 * @param input - The subject, the tenant, the instant, the tag and the flag.
 * @returns The seeded row's recognisable facts.
 */
async function seedSelfie(input: {
  readonly userId: string;
  readonly tenantKey: string;
  readonly at: Date;
  readonly tag: string;
  readonly active: boolean;
}): Promise<SeededSelfie> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.selfies).insertOne({
    _id,
    tenantId: input.tenantKey,
    eventId: new ObjectId(),
    profileId: new ObjectId(),
    subject: { kind: "user", userId: new ObjectId(input.userId) },
    contentHash: makeSelfieBytes(input.tag).hash,
    isActive: input.active,
    createdAt: input.at,
    quality: { accepted: true },
  });
  return {
    selfieId: _id.toHexString(),
    tenantKey: input.tenantKey,
    createdAt: input.at,
    active: input.active,
  };
}

/**
 * Seed a subject's active selfies, alternating between two tenants, newest
 * first in the population, so the order and the cross-tenant reach are both
 * measurable from one answer.
 *
 * @param input - The subject, the two tenants and any extra rows to place.
 * @returns The seeded rows, newest first.
 */
async function seedReusablePopulation(input: {
  readonly userId: string;
  readonly tenants: readonly [string, string];
}): Promise<readonly SeededSelfie[]> {
  const rows: SeededSelfie[] = [];
  for (let index = 0; index < PER_TENANT * 2; index += 1) {
    const tenantKey = input.tenants[index % 2] ?? input.tenants[0];
    rows.push(
      await seedSelfie({
        userId: input.userId,
        tenantKey,
        at: new Date(NEWEST_AT - index * 60_000),
        tag: `reusable-${String(index)}`,
        active: true,
      })
    );
  }
  return rows;
}

describe("when the subject holds more reusable selfies than a page", () => {
  it("lists the caller's own active selfies newest first across both tenants", async () => {
    const mine = await seedTenant(app, "op132-f7-mine");
    const otherTenant = await seedTenant(app, "op132-f7-other");
    const mineTenant = mine.events[0];
    const theirEvent = otherTenant.events[0];
    if (mineTenant === undefined || theirEvent === undefined) {
      throw new Error("expected both seeded tenants to publish an event");
    }

    const rows = await seedReusablePopulation({
      userId: mine.owner.userId.toHexString(),
      tenants: [mineTenant.id.toHexString(), theirEvent.id.toHexString()],
    });

    // Two rows that must never appear, both newer than every active one: a
    // listing that dropped the `isActive` or the `subject.userId` filter would
    // answer one of them first.
    const inactive = await seedSelfie({
      userId: mine.owner.userId.toHexString(),
      tenantKey: mineTenant.id.toHexString(),
      at: new Date(NEWEST_AT + 120_000),
      tag: "reusable-inactive",
      active: false,
    });
    const stranger = await seedSelfie({
      userId: otherTenant.owner.userId.toHexString(),
      tenantKey: theirEvent.id.toHexString(),
      at: new Date(NEWEST_AT + 60_000),
      tag: "reusable-stranger",
      active: true,
    });

    const ip = nextIp();
    const response = await handlers.reusableSelfies(
      requestFor("/api/v1/p/selfies/reusable", "GET", {
        cookie: mine.owner.cookie,
        ip,
        withoutIdempotencyKey: true,
      })
    );
    const body = await bodyOf(response, 200, "GET /p/selfies/reusable");

    const data = body.data;
    if (!Array.isArray(data)) {
      throw new Error(`expected a data array, received ${JSON.stringify(body)}`);
    }
    const items = data as Record<string, unknown>[];
    const ids = items.map((item) => String(item.selfieId));

    // The page is the newest active selfie of the subject, whatever its size.
    expect(items.length).toBeGreaterThan(1);
    expect(ids[0]).toBe(rows[0]?.selfieId);
    expect(ids).not.toContain(inactive.selfieId);
    expect(ids).not.toContain(stranger.selfieId);

    // Every item is the caller's own: no id outside the seeded population.
    const seeded = new Set(rows.map((row) => row.selfieId));
    expect(ids.filter((id) => !seeded.has(id))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);

    // ...and the listing reaches both tenants (the rows alternate).
    const firstTenant = new Set(
      rows.filter((row) => row.tenantKey === mineTenant.id.toHexString()).map((row) => row.selfieId)
    );
    const secondTenant = new Set(
      rows.filter((row) => row.tenantKey === theirEvent.id.toHexString()).map((row) => row.selfieId)
    );
    expect(firstTenant.size).toBe(PER_TENANT);
    expect(secondTenant.size).toBe(PER_TENANT);
    expect(ids.some((id) => firstTenant.has(id))).toBe(true);
    expect(ids.some((id) => secondTenant.has(id))).toBe(true);

    // §6.3: four safe facts per item, nothing else (the vector never leaves).
    expect(items.map((item) => keysOf(item))).toEqual(items.map(() => REUSABLE_ITEM_KEYS));

    // Newest first, over the returned page.
    const createdAtMs = items.map((item) => Date.parse(String(item.createdAt)));
    expect(createdAtMs).toEqual([...createdAtMs].sort((left, right) => right - left));
  });

  it("caps the whitelisted read at the limit a caller passes", async () => {
    const subject = await seedTenant(app, "op132-f7-limit");
    const [event] = subject.events;
    if (event === undefined) {
      throw new Error("expected one seeded event");
    }
    const rows = await seedReusablePopulation({
      userId: subject.owner.userId.toHexString(),
      tenants: [event.id.toHexString(), event.id.toHexString()],
    });

    // The bound the route could pass: the port already honours it, newest first.
    const page = await crossTenantReads.findReusableSelfiesBySubjectUser(
      subject.owner.userId.toHexString(),
      { limit: 5 },
      app.db
    );

    expect(page.items).toHaveLength(5);
    expect(page.items.map((item) => item.id)).toEqual(rows.slice(0, 5).map((row) => row.selfieId));

    // Its documented default is "no limit", which is what the route passes.
    const unbounded = await crossTenantReads.findReusableSelfiesBySubjectUser(
      subject.owner.userId.toHexString(),
      {},
      app.db
    );
    expect(unbounded.items).toHaveLength(rows.length);
  });
});
