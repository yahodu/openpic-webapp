import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { crossTenantReads } from "@/server/repos";

import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
  bodyOf,
  confirmSelfie,
  createAttendeeSession,
  errorBody,
  finishSelfieWorker,
  grantConsent,
  keysOf,
  nextIp,
  requestFor,
  seedTenant,
  submitHappyPath,
  withdrawConsent,
  handlers,
  type RouteHandler,
} from "../helpers/selfie-flow";

/**
 * Integration / contract — the reusable selfie and cross-event reuse
 * (OP-132 I5, I6, I14, I15; contract §6.3 "reusable", §6.7, §0.15; schema
 * §16.4; green card §4).
 *
 * **Why this exists.** "Reuse a previous selfie" is the PRD's promise that an
 * attendee who already proved liveness once does not have to do it again — and
 * it is the most dangerous endpoint in the lane, because a selfie is biometric
 * data belonging to a specific data subject on a specific event. Three
 * obligations meet here:
 *
 *   - a **foreign** selfie must be indistinguishable from a missing one
 *     (`404`, I5) — never `403`, which would confirm the id exists;
 *   - the list may return **previews only**, never the face vector (§6.3,
 *     I6) — the vector is the key that unlocks matching;
 *   - **consent is per event** (§6.2): a selfie reuse on another event without
 *     that event's consent is `412`, and a selfie destroyed by a withdrawal is
 *     gone for good (`404`, I15).
 *
 * ## Contract expected of the implementation
 *
 * - `GET /api/v1/p/selfies/reusable` — auth `user` (identified only, so an
 *   anonymous attendee session is `401`); answers
 *   `{data: [{selfieId, createdAt, previewUrl, quality: {accepted}}]}` with
 *   signed preview URLs and **no** embedding, vector or similarity anywhere.
 * - `POST /api/v1/p/events/{slug}/selfies:reuse` — auth `attendee`, body
 *   `{selfieId}`, answers `202` with the same seven keys §6.3's submit
 *   answers, skipping upload and liveness; it creates this event's profile and
 *   its own (unconfirmed) selfie row.
 * - Precedence: consent for the addressed event → ownership of the selfie →
 *   the selfie still existing. So a reuse without that event's consent is
 *   `412` even for a selfie that does not exist, and a foreign selfie is `404`
 *   even though the caller's consent is valid.
 *
 * ## Assumptions (recorded in the lane ADR)
 *
 * - **Reuse copies nothing biometric across subjects.** The new row belongs to
 *   the calling subject on the addressed event; the source row must belong to
 *   the same subject (I5's `404`).
 * - **A withdrawn selfie's id never resolves again.** §6.2's withdrawal
 *   deletes the row, so `404` is the honest answer and no tombstone is needed
 *   (I15 re-grants consent first, so the refusal is about the selfie, not the
 *   consent).
 * - The reusable list is **not** pinned to only-confirmed selfies: the card
 *   pins "no embedding", not the membership rule, so the case confirms the
 *   selfie first and asserts only what the contract fixes.
 */

let app: TestApp;

/* ───────────────────────────── contract constants ────────────────────────── */

/** The four keys §6.3 gives one reusable-selfie item, sorted. */
const ITEM_KEYS = ["createdAt", "previewUrl", "quality", "selfieId"];

/** The seven keys the reuse `202` carries (the §6.3 submit envelope), sorted. */
const REUSE_KEYS = [
  "attemptsRemaining",
  "attemptsUsed",
  "pollIntervalMs",
  "pollUrl",
  "profileId",
  "selfieId",
  "status",
];

/** Any key or value that would leak the biometric vector or a raw score. */
const VECTOR_LEAK = /embedding|vector|similarity/i;

/** A stored `selfies` row, as these cases count it (schema §16.4). */
interface SelfieRow {
  readonly _id: ObjectId;
  readonly eventId: ObjectId;
  readonly profileId: ObjectId;
  readonly subject: Record<string, unknown>;
}

/** A stored `attendee_event_profiles` row, as these cases read it (§15.3). */
interface ProfileRow {
  readonly _id: ObjectId;
  readonly status: string;
  readonly subject: Record<string, unknown>;
}

/* ───────────────────────────────── harness ───────────────────────────────── */

beforeAll(async () => {
  app = await startTestApp({ prefix: "op132-reuse" });
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
    "consents",
    "selfies",
  ]) {
    await app.db.collection(name).deleteMany({});
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ──────────────────────────────── readers ────────────────────────────────── */

/** Every stored `selfies` row, oldest first. */
async function selfieRows(): Promise<SelfieRow[]> {
  return (await app.db
    .collection("selfies")
    .find({})
    .sort({ _id: 1 })
    .toArray()) as unknown as SelfieRow[];
}

/** Every stored `attendee_event_profiles` row. */
async function profileRows(): Promise<ProfileRow[]> {
  return (await app.db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .find({})
    .toArray()) as unknown as ProfileRow[];
}

/** The `selfies:reuse` route, resolved with a naming failure if it is absent. */
const reuse: RouteHandler = handlers.reuseSelfie;

/**
 * Submit, finish the worker, then confirm one selfie for `user` on `slug`.
 *
 * @param slug - The event's active access-link slug.
 * @param options - The caller's credential, address and a per-case tag.
 * @returns The confirmed selfie's id and the profile it belongs to.
 */
async function readySelfie(
  slug: string,
  options: { readonly cookie: string; readonly ip: string; readonly tag: string }
): Promise<{ selfieId: string; profileId: string }> {
  const submitted = await submitHappyPath(slug, options);
  const [profile] = (await profileRows()).filter(
    (row) => row._id.toHexString() === submitted.profileId
  );
  if (profile === undefined) {
    throw new Error("expected the submit to create the attendee profile");
  }
  const stored = await app.db
    .collection("selfies")
    .findOne({ _id: new ObjectId(submitted.selfieId) });
  if (stored === null) {
    throw new Error("expected the submit to store the selfie");
  }
  await finishSelfieWorker(app, {
    selfieId: submitted.selfieId,
    profileId: submitted.profileId,
    eventId: String(stored.eventId),
    tenantKey: String(stored.tenantId),
    subject: profile.subject,
    matches: 2,
  });
  const confirmed = await confirmSelfie(slug, submitted.selfieId, {
    cookie: options.cookie,
    ip: options.ip,
  });
  if (confirmed.status !== 200) {
    throw new Error(`expected 200 from the confirm route, received ${String(confirmed.status)}`);
  }
  return { selfieId: submitted.selfieId, profileId: submitted.profileId };
}

/* ───────────────── I6: previews only, never the embedding ────────────────── */

describe("when an identified attendee lists their reusable selfies", () => {
  it("returns signed previews with no embedding or vector anywhere", async () => {
    const { owner, events } = await seedTenant(app, "op132-i6");
    const [event] = events;
    if (event === undefined) {
      throw new Error("expected one seeded event");
    }
    const ip = nextIp();
    await grantConsent(event.slug, { cookie: owner.cookie, ip });
    const ready = await readySelfie(event.slug, { cookie: owner.cookie, ip, tag: "i6" });

    const response = await handlers.reusableSelfies(
      requestFor("/api/v1/p/selfies/reusable", "GET", {
        cookie: owner.cookie,
        ip,
        withoutIdempotencyKey: true,
      })
    );

    const body = await bodyOf(response, 200, "GET /p/selfies/reusable");
    const data = body.data;
    if (!Array.isArray(data) || data.length !== 1) {
      throw new Error(`expected one reusable selfie, received ${JSON.stringify(data)}`);
    }
    const [item] = data as Record<string, unknown>[];
    if (item === undefined) {
      throw new Error("expected one reusable selfie item");
    }
    expect(keysOf(item)).toEqual(ITEM_KEYS);
    expect(item.selfieId).toBe(ready.selfieId);
    expect(item.quality).toMatchObject({ accepted: true });

    const previewUrl = new URL(String(item.previewUrl));
    expect(previewUrl.searchParams.get("exp")).toMatch(/^\d+$/);
    expect(previewUrl.searchParams.get("sig")).toMatch(/\S/);

    // §6.3/§0.15: the vector is what unlocks matching — it never leaves the API.
    expect(JSON.stringify(body)).not.toMatch(VECTOR_LEAK);
  });

  it("refuses an anonymous attendee session with 401 authentication_required", async () => {
    const ip = nextIp();
    const session = await createAttendeeSession(app, ip);

    const response = await handlers.reusableSelfies(
      requestFor("/api/v1/p/selfies/reusable", "GET", {
        cookie: session.cookie,
        ip,
        withoutIdempotencyKey: true,
      })
    );

    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe("authentication_required");
  });
});

/* ─────────────── I5: another subject's selfie is not found ───────────────── */

describe("when an attendee reuses a selfie that belongs to somebody else", () => {
  it("answers 404 not_found and creates nothing", async () => {
    const { owner, events } = await seedTenant(app, "op132-i5", 2);
    const [eventA, eventB] = events;
    if (eventA === undefined || eventB === undefined) {
      throw new Error("expected two seeded events");
    }
    const ip = nextIp();
    await grantConsent(eventA.slug, { cookie: owner.cookie, ip });
    const mine = await readySelfie(eventA.slug, { cookie: owner.cookie, ip, tag: "i5-owner" });

    // A second signed-in user, consenting on the same event.
    const stranger = await seedTenant(app, "op132-i5-other");
    const strangerEvent = stranger.events[0];
    if (strangerEvent === undefined) {
      throw new Error("expected the stranger's event");
    }
    const strangerIp = nextIp();
    await grantConsent(eventA.slug, { cookie: stranger.owner.cookie, ip: strangerIp });

    const response = await reuse(
      requestFor(`/api/v1/p/events/${eventA.slug}/selfies:reuse`, "POST", {
        cookie: stranger.owner.cookie,
        ip: strangerIp,
        body: { selfieId: mine.selfieId },
      })
    );

    expect(response.status).toBe(404);
    expect((await errorBody(response)).code).toBe("not_found");
    // Only the owner's row exists: a foreign reuse creates nothing.
    expect(await selfieRows()).toHaveLength(1);
  });
});

/* ──────────── I14: consent is per event, including on reuse ──────────────── */

describe("when a reusable selfie is used on another event", () => {
  it("refuses without that event's consent with 412 consent_required", async () => {
    const { owner, events } = await seedTenant(app, "op132-i14", 2);
    const [eventA, eventB] = events;
    if (eventA === undefined || eventB === undefined) {
      throw new Error("expected two seeded events");
    }
    const ip = nextIp();
    await grantConsent(eventA.slug, { cookie: owner.cookie, ip });
    const mine = await readySelfie(eventA.slug, { cookie: owner.cookie, ip, tag: "i14" });

    const response = await reuse(
      requestFor(`/api/v1/p/events/${eventB.slug}/selfies:reuse`, "POST", {
        cookie: owner.cookie,
        ip,
        body: { selfieId: mine.selfieId },
      })
    );

    expect(response.status).toBe(412);
    const error = await errorBody(response);
    expect(error.code).toBe("consent_required");
    expect(error.details?.purpose).toBe("biometric_processing");
    // No profile and no selfie were created for the second event.
    expect(await profileRows()).toHaveLength(1);
    expect(await selfieRows()).toHaveLength(1);
  });

  it("accepts with that event's consent and creates this event's own profile", async () => {
    const { owner, events } = await seedTenant(app, "op132-i14b", 2);
    const [eventA, eventB] = events;
    if (eventA === undefined || eventB === undefined) {
      throw new Error("expected two seeded events");
    }
    const ip = nextIp();
    await grantConsent(eventA.slug, { cookie: owner.cookie, ip });
    await grantConsent(eventB.slug, { cookie: owner.cookie, ip });
    const mine = await readySelfie(eventA.slug, { cookie: owner.cookie, ip, tag: "i14b" });

    const response = await reuse(
      requestFor(`/api/v1/p/events/${eventB.slug}/selfies:reuse`, "POST", {
        cookie: owner.cookie,
        ip,
        body: { selfieId: mine.selfieId },
      })
    );

    const body = await bodyOf(response, 202, "POST selfies:reuse");
    expect(keysOf(body)).toEqual(REUSE_KEYS);
    expect(body.status).toBe("processing");
    expect(body.selfieId).not.toBe(mine.selfieId);
    expect(body.pollUrl).toBe(`/api/v1/p/events/${eventB.slug}/me`);

    // The new selfie belongs to event B's profile, not to event A's.
    const rows = await selfieRows();
    expect(rows).toHaveLength(2);
    const created = rows.find((row) => row._id.toHexString() === body.selfieId);
    if (created === undefined) {
      throw new Error("expected the reuse to store a selfie row");
    }
    expect(created.eventId.toHexString()).toBe(eventB.id.toHexString());
    expect(created.profileId.toHexString()).toBe(String(body.profileId));
    expect(await profileRows()).toHaveLength(2);
  });
});

/* ────────── I15: a withdrawn selfie's id never resolves again ────────────── */

describe("when the source selfie was destroyed by a consent withdrawal", () => {
  it("answers 404 not_found even after consent is granted again", async () => {
    const { owner, events } = await seedTenant(app, "op132-i15");
    const [event] = events;
    if (event === undefined) {
      throw new Error("expected one seeded event");
    }
    const ip = nextIp();
    await grantConsent(event.slug, { cookie: owner.cookie, ip });
    const mine = await readySelfie(event.slug, { cookie: owner.cookie, ip, tag: "i15" });

    const withdrawn = await withdrawConsent(event.slug, { cookie: owner.cookie, ip });
    expect(withdrawn.status).toBe(204);
    expect(await selfieRows()).toHaveLength(0);

    // Re-grant, so the refusal below is about the selfie and not the consent.
    await grantConsent(event.slug, { cookie: owner.cookie, ip });

    const response = await reuse(
      requestFor(`/api/v1/p/events/${event.slug}/selfies:reuse`, "POST", {
        cookie: owner.cookie,
        ip,
        body: { selfieId: mine.selfieId },
      })
    );

    expect(response.status).toBe(404);
    expect((await errorBody(response)).code).toBe("not_found");
    expect(await selfieRows()).toHaveLength(0);
  });
});

/* ────────────── the reusable list is scoped to the calling subject ───────── */

describe("when two identified attendees have each submitted a selfie", () => {
  it("lists only the caller's own reusable selfies", async () => {
    const { owner, events } = await seedTenant(app, "op132-scope", 2);
    const [eventA, eventB] = events;
    if (eventA === undefined || eventB === undefined) {
      throw new Error("expected two seeded events");
    }
    const ip = nextIp();
    await grantConsent(eventA.slug, { cookie: owner.cookie, ip });
    const mine = await readySelfie(eventA.slug, { cookie: owner.cookie, ip, tag: "scope-mine" });

    const other = await seedTenant(app, "op132-scope-other");
    const otherEvent = other.events[0];
    if (otherEvent === undefined) {
      throw new Error("expected the other attendee's event");
    }
    const otherIp = nextIp();
    await grantConsent(otherEvent.slug, { cookie: other.owner.cookie, ip: otherIp });
    await readySelfie(otherEvent.slug, {
      cookie: other.owner.cookie,
      ip: otherIp,
      tag: "scope-theirs",
    });

    const response = await handlers.reusableSelfies(
      requestFor("/api/v1/p/selfies/reusable", "GET", {
        cookie: owner.cookie,
        ip,
        withoutIdempotencyKey: true,
      })
    );

    const body = await bodyOf(response, 200, "GET /p/selfies/reusable");
    const data = (body.data ?? []) as Record<string, unknown>[];
    expect(data).toHaveLength(1);
    expect(data[0]?.selfieId).toBe(mine.selfieId);

    // The whitelisted cross-tenant read is the "my events" projection: it sees
    // both subjects' profiles, so the list's scoping is a real filter and not
    // an artefact of there being only one row.
    const all = await profileRows();
    expect(all).toHaveLength(2);
    const projected = await crossTenantReads.findAttendeeProfilesBySubjectUser(
      other.owner.userId.toHexString(),
      {},
      app.db
    );
    expect(projected.items).toHaveLength(1);
  });
});
