import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";

import {
  galleryHandlers,
  markProfileReady,
  mediaSigner,
  readProfile,
  seedAnonymousGallery,
  seedImage,
  seedMatch,
  singleProfileId,
  SEED_INSTANT,
} from "../helpers/attendee-gallery-flow";
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
  makeSelfieBytes,
  nextIp,
  requestFor,
  seedTenant,
  submitHappyPath,
  type SeededEvent,
} from "../helpers/selfie-flow";

/**
 * Integration / contract — the participation poll (`/me`), the seen watermark,
 * the `newerThan` cursor and the e2e match fixture
 * (OP-133 M1, I3, I13, I14; contract §6.4, §6.5; schema §15.3, §17.5;
 * ADR-0793 §1, §6, §9; ADR-0799 §4 the signed selfie tile; ADR-0802 §3 the two
 * `previewUrl: null` arms).
 *
 * **Why this exists.** `/me` is the single polling endpoint of the whole
 * attendee experience, and it is the only place that can tell a client *when*
 * to poll again and *how many* photos are new. Three properties are load
 * bearing and none of them is observable anywhere else:
 *
 *   - the cadence is the server's (U1's table, through the route);
 *   - `GET` never clears the "New" badges — only the explicit `POST
 *     …/gallery:seen` does, so a prefetch is harmless;
 *   - `latestMatchCursor` lets a client fetch only what it has not seen, which
 *     is what makes the poll cheap after the first load.
 *
 * ## Assumptions (recorded in ADR-0793)
 *
 * - `/me` answers the fourteen keys of §6.4 plus `latestMatchCursor` (the green
 *   card's §1 "return latestMatchCursor in /me"), and nothing else.
 * - `indexingComplete` is the event's own progress
 *   (`counters.processedImageCount >= counters.imageCount`), because §6.4 calls
 *   it a property of the event, not of the attendee.
 * - The e2e suite cannot reach the server's in-process MongoDB, so a
 *   **test-only** seeding route stands in for the matcher worker. It answers
 *   `404` outside `test`/`e2e` exactly as the OTP read-back route does.
 */

/** The fifteen keys `/me` answers (§6.4 + `latestMatchCursor`), sorted. */
const PARTICIPATION_KEYS = [
  "galleryExpiresAt",
  "galleryUrl",
  "indexingComplete",
  "lastMatchRunAt",
  "latestMatchCursor",
  "matchCount",
  "newMatchCount",
  "nextPollAfter",
  "pollIntervalMs",
  "profileId",
  "selfie",
  "status",
  "statusDetail",
  "subject",
];

/** The §6.4 cadences (U1's three values). */
const PROCESSING_MS = 2000;
const INDEXING_MS = 15000;
const SETTLED_MS = 60000;

/** The path the poll lives on (§6.4). */
const participationPath = (slug: string): string => `/api/v1/p/events/${slug}/me`;

/** A gallery item reduced to what the seen/new cases read (§6.5). */
interface GalleryItem {
  readonly matchId: string;
  readonly isNew: boolean;
}

/** The `latestMatchCursor` half of the gallery body these cases read. */
interface NewerThanBody {
  readonly data: readonly GalleryItem[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
  readonly summary: { readonly newMatchCount: number };
}

/** The §6.4 selfie summary these cases read (schema §16.4). */
interface SelfieSummary {
  readonly id: string;
  readonly accepted: boolean;
  readonly previewUrl: string | null;
  readonly liveness: { readonly required: boolean; readonly passed: boolean };
  readonly quality: { readonly accepted: boolean; readonly rejectionReason: string | null };
  readonly attemptsUsed: number;
  readonly attemptsRemaining: number;
}

/** The seven keys §6.4 gives the selfie summary, sorted. */
const SELFIE_KEYS = [
  "accepted",
  "attemptsRemaining",
  "attemptsUsed",
  "id",
  "liveness",
  "previewUrl",
  "quality",
];

/** The default attempt budget (§6.1 fallback, `settings.selfie.attemptsAllowed`). */
const ATTEMPTS_ALLOWED = 3;

/** The §6.4 body. */
interface ParticipationBody {
  readonly profileId: string;
  readonly subject: { readonly kind: string };
  readonly status: string;
  readonly statusDetail: unknown;
  readonly selfie: SelfieSummary | null;
  readonly matchCount: number;
  readonly newMatchCount: number;
  readonly lastMatchRunAt: string | null;
  readonly indexingComplete: boolean;
  readonly galleryUrl: string;
  readonly galleryExpiresAt: string | null;
  readonly pollIntervalMs: number;
  readonly nextPollAfter: string;
  readonly latestMatchCursor: string | null;
}

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op133-poll" });
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
    COLLECTIONS.eventImages,
    COLLECTIONS.attendeeSessions,
    COLLECTIONS.attendeeEventProfiles,
    COLLECTIONS.faceMatches,
    COLLECTIONS.domainEvents,
    COLLECTIONS.idempotencyKeys,
    COLLECTIONS.plans,
    COLLECTIONS.subscriptions,
    "consents",
    "selfies",
    "downloadJobs",
  ]) {
    await app.db.collection(name).deleteMany({});
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/* ─────────────────────────────── readers ─────────────────────────────────── */

/** GET the participation poll for one event. */
async function poll(slug: string, options: { readonly cookie?: string; readonly ip?: string }) {
  return galleryHandlers.participation(
    requestFor(participationPath(slug), "GET", {
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ip: options.ip ?? nextIp(),
      withoutIdempotencyKey: true,
    })
  );
}

/** Parse a `/me` body, failing loudly when the status is not `200`. */
async function pollBody(
  slug: string,
  options: { readonly cookie?: string; readonly ip?: string }
): Promise<{ readonly status: number; readonly body: ParticipationBody }> {
  const response = await poll(slug, options);
  const raw = await bodyOf(response, 200, `GET ${participationPath(slug)}`);
  return { status: response.status, body: raw as unknown as ParticipationBody };
}

/** POST the explicit "I have seen the gallery" call (§6.5). */
async function markSeen(
  slug: string,
  options: { readonly cookie: string; readonly body?: unknown }
): Promise<Response> {
  return galleryHandlers.markSeen(
    requestFor(`/api/v1/p/events/${slug}/gallery:seen`, "POST", {
      cookie: options.cookie,
      ip: nextIp(),
      ...(options.body === undefined ? {} : { body: options.body }),
    })
  );
}

/** GET the gallery with a raw query string. */
async function getGallery(slug: string, cookie: string, query = ""): Promise<Response> {
  return galleryHandlers.gallery(
    requestFor(`/api/v1/p/events/${slug}/gallery${query === "" ? "" : `?${query}`}`, "GET", {
      cookie,
      ip: nextIp(),
      withoutIdempotencyKey: true,
    })
  );
}

/* ─────────────── M1: the poll cadence is the server's, end to end ────────── */

describe("when the attendee polls their participation status", () => {
  it("answers the documented cadence for processing, indexing and settled profiles", async () => {
    const world = await seedAnonymousGallery(app, "op133-m1", { matches: 3 });

    await app.db
      .collection(COLLECTIONS.attendeeEventProfiles)
      .updateOne({ _id: world.profileId }, { $set: { status: "processing" } });

    const before = Date.now();
    const processing = await pollBody(world.event.slug, { cookie: world.cookie });
    const after = Date.now();

    expect(keysOf(processing.body)).toEqual(PARTICIPATION_KEYS);
    expect(processing.body.status).toBe("processing");
    expect(processing.body.statusDetail).toBeNull();
    expect(processing.body.pollIntervalMs).toBe(PROCESSING_MS);
    const nextPollAfter = Date.parse(processing.body.nextPollAfter);
    expect(nextPollAfter).toBeGreaterThanOrEqual(before + PROCESSING_MS);
    expect(nextPollAfter).toBeLessThanOrEqual(after + PROCESSING_MS);

    // Ready, but the event is still indexing.
    await app.db
      .collection(COLLECTIONS.events)
      .updateOne(
        { _id: world.event.id },
        { $set: { "counters.imageCount": 10, "counters.processedImageCount": 4 } }
      );
    await markProfileReady(app, world.profileId, { matchCount: 3 });
    const indexing = await pollBody(world.event.slug, { cookie: world.cookie });
    expect(indexing.body.indexingComplete).toBe(false);
    expect(indexing.body.pollIntervalMs).toBe(INDEXING_MS);

    // Ready and fully indexed: the gallery is settled.
    await app.db
      .collection(COLLECTIONS.events)
      .updateOne(
        { _id: world.event.id },
        { $set: { "counters.imageCount": 10, "counters.processedImageCount": 10 } }
      );
    const settled = await pollBody(world.event.slug, { cookie: world.cookie });
    expect(settled.body.indexingComplete).toBe(true);
    expect(settled.body.pollIntervalMs).toBe(SETTLED_MS);
  });

  it("reports no_match with a statusDetail when the selfie found nothing", async () => {
    const world = await seedAnonymousGallery(app, "op133-m1-none", { matches: 0 });

    const { body } = await pollBody(world.event.slug, { cookie: world.cookie });

    expect(body.status).toBe("no_match");
    const detail = body.statusDetail as { readonly code?: string } | null;
    expect(detail?.code).toBe("no_matches_yet");
  });
});

/* ────────────── I3: GET never clears the New badges, POST does ───────────── */

describe("when the attendee has three unseen matches", () => {
  it("keeps newMatchCount across reads and clears it only on the explicit seen call", async () => {
    const world = await seedAnonymousGallery(app, "op133-i3", { matches: 3 });
    await markProfileReady(app, world.profileId, {
      matchCount: 3,
      lastSeenGalleryAt: new Date(SEED_INSTANT.getTime() - 60_000),
    });

    const firstGallery = await bodyOf(
      await getGallery(world.event.slug, world.cookie),
      200,
      "gallery 1"
    );
    const firstSummary = firstGallery.summary as { readonly newMatchCount: number };
    expect(firstSummary.newMatchCount).toBe(3);

    const firstPoll = await pollBody(world.event.slug, { cookie: world.cookie });
    expect(firstPoll.body.newMatchCount).toBe(3);

    // A prefetch must not dismiss the badge.
    const secondGallery = await bodyOf(
      await getGallery(world.event.slug, world.cookie),
      200,
      "gallery 2"
    );
    expect((secondGallery.summary as { readonly newMatchCount: number }).newMatchCount).toBe(3);

    const seen = await markSeen(world.event.slug, { cookie: world.cookie });
    expect(seen.status).toBe(204);

    const afterSeen = await pollBody(world.event.slug, { cookie: world.cookie });
    expect(afterSeen.body.newMatchCount).toBe(0);
    const profile = await readProfile(app, world.profileId);
    expect(profile.lastSeenGalleryAt instanceof Date).toBe(true);
  });
});

/* ────────── I13: latestMatchCursor / ?newerThan= fetch only the new ──────── */

describe("when matches arrive after the attendee loaded the gallery", () => {
  it("returns only the new items for the cursor the poll handed out", async () => {
    const world = await seedAnonymousGallery(app, "op133-i13", { matches: 4 });

    const { body: before } = await pollBody(world.event.slug, { cookie: world.cookie });
    expect(typeof before.latestMatchCursor).toBe("string");
    expect(String(before.latestMatchCursor).length).toBeGreaterThan(0);

    const arrived: string[] = [];
    for (const sequence of [5, 6]) {
      const image = await seedImage(
        app,
        { tenantKey: world.tenantKey, eventId: world.event.id },
        { sequence }
      );
      const matchId = await seedMatch(
        app,
        {
          tenantKey: world.tenantKey,
          eventId: world.event.id,
          profileId: world.profileId,
          subject: world.subject,
        },
        { imageId: image.imageId, createdAt: new Date(SEED_INSTANT.getTime() + sequence * 60_000) }
      );
      arrived.push(matchId.toHexString());
    }

    const response = await getGallery(
      world.event.slug,
      world.cookie,
      `newerThan=${encodeURIComponent(String(before.latestMatchCursor))}`
    );
    const body = (await bodyOf(response, 200, "gallery?newerThan")) as unknown as NewerThanBody;

    expect([...body.data.map((item) => item.matchId)].sort()).toEqual([...arrived].sort());
    expect(body.summary.newMatchCount).toBe(2);
  });
});

/* ───── I14: an explicit seenAt leaves later matches flagged as new ───────── */

describe("when the attendee marks the gallery seen at an explicit instant", () => {
  it("stamps only the matches created up to that instant", async () => {
    const world = await seedAnonymousGallery(app, "op133-i14", { matches: 4 });
    const seenAt = new Date(SEED_INSTANT.getTime() + 90_000);

    const olderHex = world.matchIds.slice(0, 2).map((id) => id.toHexString());
    const newerHex = world.matchIds.slice(2).map((id) => id.toHexString());
    for (const [index, matchId] of world.matchIds.entries()) {
      await app.db.collection(COLLECTIONS.faceMatches).updateOne(
        { _id: matchId },
        {
          $set: {
            createdAt: new Date(SEED_INSTANT.getTime() + (index < 2 ? 0 : 180_000)),
            seenAt: null,
          },
        }
      );
    }
    await markProfileReady(app, world.profileId, {
      matchCount: 4,
      lastSeenGalleryAt: new Date(SEED_INSTANT.getTime() - 60_000),
    });

    const response = await markSeen(world.event.slug, {
      cookie: world.cookie,
      body: { seenAt: seenAt.toISOString() },
    });
    expect(response.status).toBe(204);

    const gallery = (await bodyOf(
      await getGallery(world.event.slug, world.cookie),
      200,
      "gallery after seen"
    )) as unknown as NewerThanBody;

    const flags = new Map(gallery.data.map((item) => [item.matchId, item.isNew]));
    expect(olderHex.map((id) => flags.get(id))).toEqual([false, false]);
    expect(newerHex.map((id) => flags.get(id))).toEqual([true, true]);

    const profile = await readProfile(app, world.profileId);
    expect(profile.lastSeenGalleryAt?.toISOString()).toBe(seenAt.toISOString());
  });
});

/* ───────────── S1: the test-only match fixture the e2e journey uses ──────── */

describe("the test-only attendee-match seeder", () => {
  it("seeds matches the gallery then serves, so the e2e journey has photos", async () => {
    const world = await seedAnonymousGallery(app, "op133-seed", { matches: 0 });

    const response = await galleryHandlers.seedMatches(
      requestFor("/api/v1/test-support/attendee-matches", "POST", {
        ip: nextIp(),
        body: {
          slug: world.event.slug,
          profileId: world.profileId.toHexString(),
          count: 3,
        },
      })
    );

    const body = await bodyOf(response, 201, "POST /test-support/attendee-matches");
    expect(keysOf(body)).toEqual(["imageIds", "matchIds"]);
    expect((body.matchIds as readonly string[]).length).toBe(3);

    await markProfileReady(app, world.profileId, { matchCount: 3 });
    const gallery = (await bodyOf(
      await getGallery(world.event.slug, world.cookie),
      200,
      "gallery after the seed"
    )) as unknown as NewerThanBody;
    expect(gallery.data).toHaveLength(3);
    expect([...gallery.data.map((item) => item.matchId)].sort()).toEqual(
      [...(body.matchIds as readonly string[])].sort()
    );
    // The fixture creates oldest-first and the gallery serves newest-first.
    expect(gallery.data.map((item) => item.matchId)).toEqual(
      [...(body.matchIds as readonly string[])].reverse()
    );
  });

  it("answers 404 outside the test and e2e environments", async () => {
    const world = await seedAnonymousGallery(app, "op133-seed-guard", { matches: 0 });
    vi.stubEnv("APP_ENV", "production");

    const response = await galleryHandlers.seedMatches(
      requestFor("/api/v1/test-support/attendee-matches", "POST", {
        ip: nextIp(),
        body: {
          slug: world.event.slug,
          profileId: world.profileId.toHexString(),
          count: 1,
        },
      })
    );

    expect(response.status).toBe(404);
    expect(await app.db.collection(COLLECTIONS.faceMatches).countDocuments()).toBe(0);
  });
});

/* ─────────── the seeder's event lookup shares the public 404 shape ───────── */

describe("when the poll is asked about an event with no active link", () => {
  it("answers 404 rather than distinguishing an unknown event", async () => {
    const response = await poll("no-such-slug-op133", { ip: nextIp() });

    expect(response.status).toBe(404);
    expect((await errorBody(response)).code).toBe("not_found");
  });
});

/* ──────────── F2: the selfie summary the poll projects (§6.4) ────────────── */

/** The per-case selfie bytes tag, so the stored content hash is known here. */
const SELFIE_TAG = "op133-f2-selfie";

/** A consented attendee with no selfie yet, built through the shipped routes. */
interface ConsentingAttendee {
  readonly tenantKey: string;
  readonly event: SeededEvent;
  readonly cookie: string;
  readonly profileId: ObjectId;
  readonly subject: Record<string, unknown>;
}

/**
 * Create an anonymous attendee and grant consent, leaving the profile exactly as
 * the consent route stores it: `selfie_pending`, no selfie, no attempts used.
 *
 * @param prefix - The suite-local identity/slug prefix.
 * @returns The handles the selfie-summary cases read.
 */
async function seedConsentingAttendee(prefix: string): Promise<ConsentingAttendee> {
  const { tenantKey, events } = await seedTenant(app, prefix);
  const event = events.at(0);
  if (event === undefined) {
    throw new Error("expected a seeded event");
  }
  const session = await createAttendeeSession(app, nextIp());
  await grantConsent(event.slug, { cookie: session.cookie, ip: nextIp() });
  const profileId = await singleProfileId(app);
  const profile = await readProfile(app, profileId);
  return { tenantKey, event, cookie: session.cookie, profileId, subject: profile.subject };
}

/**
 * Submit, finish and confirm one selfie, so the profile has an **active** one.
 *
 * @param world - The consented attendee.
 * @param options - The bytes tag and the matches the worker found.
 * @returns The activated selfie's id.
 */
async function activateSelfie(
  world: ConsentingAttendee,
  options: { readonly tag: string; readonly matches: number }
): Promise<string> {
  const submitted = await submitHappyPath(world.event.slug, {
    cookie: world.cookie,
    ip: nextIp(),
    tag: options.tag,
  });
  await finishSelfieWorker(app, {
    selfieId: submitted.selfieId,
    profileId: submitted.profileId,
    eventId: world.event.id.toHexString(),
    tenantKey: world.tenantKey,
    subject: world.subject,
    matches: options.matches,
  });
  const confirmed = await confirmSelfie(world.event.slug, submitted.selfieId, {
    cookie: world.cookie,
    ip: nextIp(),
  });
  if (confirmed.status !== 200) {
    throw new Error(`expected 200 from the selfie confirm, received ${String(confirmed.status)}`);
  }
  return submitted.selfieId;
}

describe("when the poll projects the attendee's selfie", () => {
  it("answers the seven §6.4 fields and a signed thumbnail URL that is not the original", async () => {
    const world = await seedConsentingAttendee("op133-f2-selfie");
    const selfieId = await activateSelfie(world, { tag: SELFIE_TAG, matches: 0 });

    const { body } = await pollBody(world.event.slug, { cookie: world.cookie });
    const selfie = body.selfie;
    if (selfie === null) {
      throw new Error(`expected a selfie summary, received null: ${JSON.stringify(body)}`);
    }

    expect(keysOf(selfie)).toEqual(SELFIE_KEYS);
    expect(selfie.id).toBe(selfieId);
    expect(selfie.accepted).toBe(true);
    expect(selfie.liveness).toEqual({ required: true, passed: true });
    expect(selfie.quality).toEqual({ accepted: true, rejectionReason: null });
    expect(selfie.attemptsUsed).toBe(1);
    expect(selfie.attemptsRemaining).toBe(ATTEMPTS_ALLOWED - 1);

    // §5.7: the tile is the thumbnail (`/t/`), never the original (`/o/`).
    const previewUrl = String(selfie.previewUrl);
    const url = new URL(previewUrl);
    expect(url.pathname).toBe(`/t/${makeSelfieBytes(SELFIE_TAG).hash}.webp`);
    expect(Number(url.searchParams.get("exp")) * 1000).toBeGreaterThan(Date.now());
    expect(url.searchParams.get("sig")).not.toBeNull();
    expect(mediaSigner().verify(previewUrl)).toBe(true);
  });

  it("answers previewUrl: null when the stored selfie carries no asset id", async () => {
    // Arrange — a real active selfie through the shipped submit → worker →
    // confirm path, so the only change is the `assetId` the route reads.
    const world = await seedConsentingAttendee("op133-f2-legacy");
    const selfieId = await activateSelfie(world, { tag: "op133-f2-legacy", matches: 0 });

    // The tile is signed while the row is normal, so a `null` below is the
    // mutation's effect and not a fixture that never had an asset.
    const before = await pollBody(world.event.slug, { cookie: world.cookie });
    expect(new URL(String(before.body.selfie?.previewUrl)).pathname).toBe(
      `/t/${makeSelfieBytes("op133-f2-legacy").hash}.webp`
    );

    // `SelfieRow.assetId` is typed `assetId?: ObjectId | null`: a legacy selfie
    // written before §16.4 took an asset is exactly this shape.
    const cleared = await app.db
      .collection(COLLECTIONS.selfies)
      .updateOne({ _id: new ObjectId(selfieId) }, { $set: { assetId: null } });
    expect(cleared.modifiedCount).toBe(1);

    // Act
    const { status, body } = await pollBody(world.event.slug, { cookie: world.cookie });
    const selfie = body.selfie;
    if (selfie === null) {
      throw new Error(`expected a selfie summary, received null: ${JSON.stringify(body)}`);
    }

    // Assert — a poll must not throw and must not answer 500; the summary keeps
    // every §6.4 field and reports the missing tile as `null`, not by omitting
    // the key.
    expect(status).toBe(200);
    expect(keysOf(selfie)).toEqual(SELFIE_KEYS);
    expect(selfie.previewUrl).toBeNull();
    expect(selfie.id).toBe(selfieId);
    expect(selfie.accepted).toBe(true);
    expect(selfie.attemptsUsed).toBe(1);
    expect(selfie.attemptsRemaining).toBe(ATTEMPTS_ALLOWED - 1);
  });

  it("answers previewUrl: null when the selfie's media asset row is gone", async () => {
    // Arrange — an active selfie whose `media_assets` row was purged (§16.1):
    // the row the tile is signed from is missing while the selfie itself lives.
    const world = await seedConsentingAttendee("op133-f2-purged");
    const selfieId = await activateSelfie(world, { tag: "op133-f2-purged", matches: 0 });

    const selfieRow = await app.db
      .collection(COLLECTIONS.selfies)
      .findOne({ _id: new ObjectId(selfieId) }, { projection: { assetId: 1 } });
    const assetId: unknown = selfieRow?.assetId;
    if (!(assetId instanceof ObjectId)) {
      throw new Error(`expected the stored selfie to reference a media asset`);
    }
    const before = await pollBody(world.event.slug, { cookie: world.cookie });
    // Pin the tile itself, not merely "not null": `.not.toBeNull()` also passes
    // for `undefined`, so an envelope that omitted `previewUrl` would satisfy it.
    expect(new URL(String(before.body.selfie?.previewUrl)).pathname).toBe(
      `/t/${makeSelfieBytes("op133-f2-purged").hash}.webp`
    );

    const purged = await app.db.collection(COLLECTIONS.mediaAssets).deleteOne({ _id: assetId });
    expect(purged.deletedCount).toBe(1);

    // Act
    const { status, body } = await pollBody(world.event.slug, { cookie: world.cookie });
    const selfie = body.selfie;
    if (selfie === null) {
      throw new Error(`expected a selfie summary, received null: ${JSON.stringify(body)}`);
    }

    // Assert — the missing asset is a `null` tile, never a 500, and the rest of
    // the summary is unchanged.
    expect(status).toBe(200);
    expect(keysOf(selfie)).toEqual(SELFIE_KEYS);
    expect(selfie.previewUrl).toBeNull();
    expect(selfie.id).toBe(selfieId);
    expect(selfie.accepted).toBe(true);
    expect(selfie.attemptsUsed).toBe(1);
    expect(selfie.attemptsRemaining).toBe(ATTEMPTS_ALLOWED - 1);
  });

  it("answers selfie: null with the no_selfie wire status before any submission", async () => {
    const world = await seedConsentingAttendee("op133-f2-none");

    const { body } = await pollBody(world.event.slug, { cookie: world.cookie });

    expect(body.selfie).toBeNull();
    expect(body.status).toBe("no_selfie");
    expect((await readProfile(app, world.profileId)).activeSelfieId ?? null).toBeNull();
  });

  it("returns the same summary on every poll and never clears the New badges", async () => {
    const world = await seedConsentingAttendee("op133-f2-stable");
    const selfieId = await activateSelfie(world, { tag: "op133-f2-stable", matches: 0 });

    for (const sequence of [1, 2]) {
      const image = await seedImage(
        app,
        { tenantKey: world.tenantKey, eventId: world.event.id },
        { sequence }
      );
      await seedMatch(
        app,
        {
          tenantKey: world.tenantKey,
          eventId: world.event.id,
          profileId: world.profileId,
          subject: world.subject,
        },
        { imageId: image.imageId }
      );
    }
    await markProfileReady(app, world.profileId, { matchCount: 2, lastSeenGalleryAt: null });

    const first = await pollBody(world.event.slug, { cookie: world.cookie });
    const second = await pollBody(world.event.slug, { cookie: world.cookie });

    expect(first.body.newMatchCount).toBe(2);
    expect(second.body.newMatchCount).toBe(2);
    expect(second.body.selfie?.id).toBe(selfieId);
    expect(second.body.selfie?.attemptsUsed).toBe(1);
    expect(second.body.selfie?.liveness).toEqual(first.body.selfie?.liveness);
    expect(second.body.selfie?.quality).toEqual(first.body.selfie?.quality);
    // A token may be re-minted across a second boundary; it always signs the same row.
    expect(new URL(String(second.body.selfie?.previewUrl)).pathname).toBe(
      new URL(String(first.body.selfie?.previewUrl)).pathname
    );

    // A poll is a read: no badge cleared and no attempt consumed.
    expect(await app.db.collection(COLLECTIONS.faceMatches).countDocuments({ seenAt: null })).toBe(
      2
    );
    expect(await app.db.collection(COLLECTIONS.selfies).countDocuments()).toBe(1);
    expect((await readProfile(app, world.profileId)).lastSeenGalleryAt ?? null).toBeNull();
  });
});
