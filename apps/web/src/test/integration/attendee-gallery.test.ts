import type { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";

import {
  galleryHandlers,
  markProfileReady,
  mediaSigner,
  readProfile,
  seedAnonymousGallery,
  seedIdentifiedGallery,
  seedImage,
  seedMatch,
  singleProfileId,
  SEED_INSTANT,
  type SeededImage,
} from "../helpers/attendee-gallery-flow";
import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
  bodyOf,
  createAttendeeSession,
  errorBody,
  grantConsent,
  keysOf,
  nextIp,
  requestFor,
  seedTenant,
} from "../helpers/selfie-flow";

/**
 * Integration / contract — the attendee gallery: ordering, the two hide
 * semantics, what may never appear in an item, the anonymous truncation and
 * paging under writes
 * (OP-133 I1, I1b, I2, I4, I4b, I7, I10, I12; contract §6.5, §6.6, §0.4, §5.6;
 * schema §15.3, §16.1, §16.3, §17.5; ADR-0793 §5–§8).
 *
 * **Why this exists.** The gallery is the only screen that shows an attendee
 * their own photos, so every rule about it is a rule about somebody's data:
 * newest first, nothing they hid, nothing the organizer hid, no similarity
 * score, and a page that stays coherent while a match run inserts rows.
 *
 * ## Contract expected of the implementation
 *
 * - `GET /api/v1/p/events/{slug}/gallery?cursor=&limit=` (auth `attendee`, owns
 *   the profile) → `200 {data, page, summary}`; identified callers get exactly
 *   those three keys.
 * - `page` is `{nextCursor, hasMore, limit, total}`; `summary` is
 *   `{matchCount, newMatchCount, hiddenCount, galleryExpiresAt,
 *   indexingComplete}`; each `data` item is exactly the twelve keys of §6.5.
 * - The ordering key is `event_images.sequence` descending — §16.3 calls it the
 *   stable "newest first" ordering "that can't tie like `createdAt` can", and
 *   the first match run stamps every row with nearly the same instant. I1 makes
 *   `createdAt` run **opposite** to `sequence`, so an implementation that sorts
 *   by the match's own timestamp fails the ordering assertion.
 * - `hiddenAt != null` (the **attendee** hide, §17.5) is excluded and counted in
 *   `summary.hiddenCount`; `event_images.visibility: "hidden"` (the
 *   **organizer** hide, §16.3) is excluded and **not** counted, because
 *   it is not the attendee's own action. I1 and I1b keep the two apart.
 * - `similarity` is never returned (§6.5) — only `confidence`.
 * - An anonymous caller gets at most the platform's
 *   `attendee.anonymousPreviewLimit` items, `truncatedForAnonymous: true`,
 *   `page.nextCursor: null`, `page.hasMore: false` and a `loginUrl`; a comparator
 *   cursor that the server did not mint is `422 validation_failed` (§6.5).
 */

/** The twelve keys §6.5 gives a gallery item, sorted. */
const ITEM_KEYS = [
  "aspectRatio",
  "confidence",
  "createdAt",
  "height",
  "imageId",
  "isNew",
  "matchId",
  "orientation",
  "originalAvailable",
  "thumbnailUrl",
  "thumbnailUrlExpiresAt",
  "width",
];

/** The three keys §6.5 gives the identified body, sorted. */
const BODY_KEYS = ["data", "page", "summary"];

/** The five keys inside `page`, sorted. */
const PAGE_KEYS = ["hasMore", "limit", "nextCursor", "total"];

/** The five keys inside `summary`, sorted. */
const SUMMARY_KEYS = [
  "galleryExpiresAt",
  "hiddenCount",
  "indexingComplete",
  "matchCount",
  "newMatchCount",
];

/** The platform's anonymous preview allowance (§6.5, green card §6). */
const ANONYMOUS_PREVIEW_LIMIT = 10;

/** One gallery item, as these cases read it (§6.5). */
interface GalleryItem {
  readonly matchId: string;
  readonly imageId: string;
  readonly thumbnailUrl: string;
  readonly thumbnailUrlExpiresAt: string;
  readonly width: number;
  readonly height: number;
  readonly orientation: number;
  readonly aspectRatio: number;
  readonly isNew: boolean;
  readonly confidence: string;
  readonly originalAvailable: boolean;
  readonly createdAt: string;
}

/** The `page` envelope (§6.5). */
interface GalleryPage {
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly limit: number;
  readonly total: number;
}

/** The `summary` envelope (§6.5). */
interface GallerySummary {
  readonly matchCount: number;
  readonly newMatchCount: number;
  readonly hiddenCount: number;
  readonly galleryExpiresAt: string | null;
  readonly indexingComplete: boolean;
}

/** The §6.5 body. */
interface GalleryBody {
  readonly data: readonly GalleryItem[];
  readonly page: GalleryPage;
  readonly summary: GallerySummary;
  readonly truncatedForAnonymous?: boolean;
  readonly loginUrl?: string;
}

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op133-gallery" });
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
});

/* ─────────────────────────────── readers ─────────────────────────────────── */

/** GET the gallery, with an optional raw query string. */
async function getGallery(
  slug: string,
  options: { readonly cookie?: string; readonly ip: string; readonly query?: string }
): Promise<Response> {
  const path = `/api/v1/p/events/${slug}/gallery${options.query === undefined ? "" : `?${options.query}`}`;
  return galleryHandlers.gallery(
    requestFor(path, "GET", {
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ip: options.ip,
      withoutIdempotencyKey: true,
    })
  );
}

/** Parse a gallery body, failing loudly when the status is not `200`. */
async function galleryBody(response: Response): Promise<GalleryBody> {
  const raw = await bodyOf(response, 200, "GET /p/events/:slug/gallery");
  return raw as unknown as GalleryBody;
}

/** The hex id at an index, without an unchecked array access. */
function idAt(ids: readonly ObjectId[], index: number): string {
  const id = ids.at(index);
  if (id === undefined) {
    throw new Error(`expected a seeded id at index ${String(index)}`);
  }
  return id.toHexString();
}

/** The stored `event_images.sequence` values, largest first. */
async function storedSequences(): Promise<number[]> {
  const rows = (await app.db.collection(COLLECTIONS.eventImages).find({}).toArray()) as unknown as {
    readonly sequence: number;
  }[];
  return rows.map((row) => row.sequence).sort((left, right) => right - left);
}

/* ─────────────── I1: five matches, one attendee-hidden, newest first ─────── */

describe("when the attendee has five matches and has hidden one", () => {
  it("returns the four visible matches newest first, counts the hide, and keeps the cached total", async () => {
    const { tenantKey, events } = await seedTenant(app, "op133-i1");
    const event = events[0];
    if (event === undefined) {
      throw new Error("expected one seeded event");
    }
    const session = await createAttendeeSession(app, nextIp());
    await grantConsent(event.slug, { cookie: session.cookie, ip: nextIp() });
    const profileId = await singleProfileId(app);
    const profile = await readProfile(app, profileId);
    const scope = { tenantKey, eventId: event.id, profileId, subject: profile.subject };

    // Sequences descend from 50 to 10 while the matches' `createdAt` ascends:
    // the two orderings disagree, so only the documented sort key can pass.
    const sequences = [50, 40, 30, 20, 10] as const;
    const images: SeededImage[] = [];
    for (const sequence of sequences) {
      images.push(
        await seedImage(app, { tenantKey, eventId: event.id }, { sequence, orientation: 6 })
      );
    }
    const hiddenAt = new Date(SEED_INSTANT.getTime() + 30 * 60_000);
    const matchIds: ObjectId[] = [];
    for (const [index, image] of images.entries()) {
      matchIds.push(
        await seedMatch(app, scope, {
          imageId: image.imageId,
          createdAt: new Date(SEED_INSTANT.getTime() + (4 - index) * 60_000),
          hiddenAt: image.sequence === 30 ? hiddenAt : null,
        })
      );
    }
    await markProfileReady(app, profileId, { matchCount: 5 });

    const body = await galleryBody(
      await getGallery(event.slug, { cookie: session.cookie, ip: nextIp() })
    );

    // Arrange-check: the fixture really does invert the two orderings.
    expect(await storedSequences()).toEqual([50, 40, 30, 20, 10]);

    expect(body.data).toHaveLength(4);
    expect(body.data.map((item) => item.matchId)).toEqual([
      idAt(matchIds, 0),
      idAt(matchIds, 1),
      idAt(matchIds, 3),
      idAt(matchIds, 4),
    ]);
    expect(body.summary.hiddenCount).toBe(1);
    expect(body.summary.matchCount).toBe(5);
    expect(body.page.total).toBe(5);
    expect(body.data.map((item) => item.matchId)).not.toContain(idAt(matchIds, 2));
  });

  it("returns the documented item shape with the display geometry, a verified thumbnail and no similarity", async () => {
    const world = await seedAnonymousGallery(app, "op133-i1-shape", { matches: 3, orientation: 6 });
    const response = await getGallery(world.event.slug, {
      cookie: world.cookie,
      ip: nextIp(),
    });
    const body = await galleryBody(response);

    expect(keysOf(body)).toEqual(BODY_KEYS);
    expect(keysOf(body.page)).toEqual(PAGE_KEYS);
    expect(keysOf(body.summary)).toEqual(SUMMARY_KEYS);

    const item = body.data.at(0);
    if (item === undefined) {
      throw new Error("expected at least one gallery item");
    }
    expect(keysOf(item)).toEqual(ITEM_KEYS);

    // §16.1 stores 4000×6000 with EXIF orientation 6; the tile is landscape.
    expect([item.width, item.height, item.orientation]).toEqual([6000, 4000, 6]);
    expect(item.aspectRatio).toBe(1.5);
    expect(item.confidence).toBe("strong");
    expect(item.originalAvailable).toBe(true);
    expect(item.isNew).toBe(true);
    expect(mediaSigner().verify(item.thumbnailUrl)).toBe(true);
    expect(item.thumbnailUrl).toMatch(/^https:\/\/pic\.openpic\.in\/t\/[0-9a-f]{64}\.webp\?/);
  });
});

/* ────── I1b: an organizer-hidden image is not an attendee hide ───────────── */

describe("when the organizer has hidden one of the attendee's matched images", () => {
  it("omits the image, does not count it as hidden, and never surfaces it while paging", async () => {
    const { tenantKey, events } = await seedTenant(app, "op133-i1b");
    const event = events[0];
    if (event === undefined) {
      throw new Error("expected one seeded event");
    }
    const session = await createAttendeeSession(app, nextIp());
    await grantConsent(event.slug, { cookie: session.cookie, ip: nextIp() });
    const profileId = await singleProfileId(app);
    const profile = await readProfile(app, profileId);
    const scope = { tenantKey, eventId: event.id, profileId, subject: profile.subject };

    const sequences = [30, 20, 10] as const;
    const images: SeededImage[] = [];
    for (const sequence of sequences) {
      images.push(
        await seedImage(
          app,
          { tenantKey, eventId: event.id },
          { sequence, ...(sequence === 20 ? { visibility: "hidden" as const } : {}) }
        )
      );
    }
    const matchIds: ObjectId[] = [];
    for (const image of images) {
      matchIds.push(
        await seedMatch(app, scope, {
          imageId: image.imageId,
          createdAt: new Date(SEED_INSTANT.getTime() + image.sequence * 1_000),
        })
      );
    }
    await markProfileReady(app, profileId, { matchCount: 3 });

    const firstPage = await galleryBody(
      await getGallery(event.slug, { cookie: session.cookie, ip: nextIp(), query: "limit=1" })
    );
    const secondPage = await galleryBody(
      await getGallery(event.slug, {
        cookie: session.cookie,
        ip: nextIp(),
        query: `limit=1&cursor=${encodeURIComponent(String(firstPage.page.nextCursor))}`,
      })
    );

    expect(firstPage.data).toHaveLength(1);
    expect(firstPage.summary.hiddenCount).toBe(0);
    expect(firstPage.page.hasMore).toBe(true);
    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.page.hasMore).toBe(false);

    const surfaced = [...firstPage.data, ...secondPage.data];
    expect(surfaced.map((item) => item.matchId)).toEqual([idAt(matchIds, 0), idAt(matchIds, 2)]);
    expect(surfaced.map((item) => item.imageId)).not.toContain(images[1]?.imageId.toHexString());
  });
});

/* ───────────── I2: no similarity, ever, in an attendee response ──────────── */

describe("what an attendee response may contain", () => {
  it("never carries the raw similarity or any model-side score", async () => {
    const world = await seedAnonymousGallery(app, "op133-i2", { matches: 2 });
    await app.db
      .collection(COLLECTIONS.faceMatches)
      .updateMany({}, { $set: { similarity: 0.812345 } });

    const gallery = await getGallery(world.event.slug, { cookie: world.cookie, ip: nextIp() });
    const galleryText = await gallery.clone().text();
    const galleryJson = (await gallery.json()) as Record<string, unknown>;

    const participation = await galleryHandlers.participation(
      requestFor(`/api/v1/p/events/${world.event.slug}/me`, "GET", {
        cookie: world.cookie,
        ip: nextIp(),
        withoutIdempotencyKey: true,
      })
    );
    const participationText = await participation.text();

    const imageId = world.images.at(0)?.imageId;
    if (imageId === undefined) {
      throw new Error("expected a seeded image");
    }
    const originalUrl = await galleryHandlers.originalUrl(
      requestFor(
        `/api/v1/p/events/${world.event.slug}/images/${imageId.toHexString()}/original-url`,
        "POST",
        { cookie: world.cookie, ip: nextIp(), body: {} }
      )
    );
    const originalText = await originalUrl.text();

    const banned = /"(similarity|score|distance|embedding|vector|modelKey|spaceKey)"/;
    expect(galleryText).not.toMatch(banned);
    expect(participationText).not.toMatch(banned);
    expect(originalText).not.toMatch(banned);
    expect(galleryText).not.toContain("0.812");
    expect(galleryJson).not.toHaveProperty("similarity");

    const data = galleryJson.data;
    if (!Array.isArray(data)) {
      throw new Error("expected `data` to be an array");
    }
    const first: unknown = data.at(0);
    expect(keysOf(first)).toEqual(ITEM_KEYS);
    expect(["strong", "normal"]).toContain(
      first !== null && typeof first === "object" && "confidence" in first
        ? String(first.confidence)
        : ""
    );
  });
});

/* ──────────────── I4 / I4b: the two outcomes of POST …/hide ──────────────── */

describe("hiding a match", () => {
  it("answers 404 when the match belongs to another attendee's profile and leaves it untouched", async () => {
    const { tenantKey, events } = await seedTenant(app, "op133-i4");
    const event = events[0];
    if (event === undefined) {
      throw new Error("expected one seeded event");
    }
    const mine = await createAttendeeSession(app, nextIp());
    await grantConsent(event.slug, { cookie: mine.cookie, ip: nextIp() });
    const myProfileId = await singleProfileId(app);

    const theirs = await createAttendeeSession(app, nextIp());
    await grantConsent(event.slug, { cookie: theirs.cookie, ip: nextIp() });
    const theirProfileId = await singleProfileId(app);
    const theirProfile = await readProfile(app, theirProfileId);
    expect(theirProfileId.equals(myProfileId)).toBe(false);

    const image = await seedImage(app, { tenantKey, eventId: event.id }, { sequence: 1 });
    const foreignMatchId = await seedMatch(
      app,
      { tenantKey, eventId: event.id, profileId: theirProfileId, subject: theirProfile.subject },
      { imageId: image.imageId }
    );
    await markProfileReady(app, myProfileId, { matchCount: 0 });

    const response = await galleryHandlers.hideMatch(
      requestFor(`/api/v1/p/matches/${foreignMatchId.toHexString()}/hide`, "POST", {
        cookie: mine.cookie,
        ip: nextIp(),
        body: {},
      })
    );

    expect(response.status).toBe(404);
    expect((await errorBody(response)).code).toBe("not_found");
    const stored = await app.db
      .collection(COLLECTIONS.faceMatches)
      .findOne({ _id: foreignMatchId });
    expect(stored?.hiddenAt ?? null).toBeNull();
  });

  it("answers 204 for the caller's own match, removes it from the gallery and keeps the row", async () => {
    const world = await seedAnonymousGallery(app, "op133-i4b", { matches: 3 });
    const matchId = world.matchIds.at(0);
    if (matchId === undefined) {
      throw new Error("expected a seeded match");
    }

    const response = await galleryHandlers.hideMatch(
      requestFor(`/api/v1/p/matches/${matchId.toHexString()}/hide`, "POST", {
        cookie: world.cookie,
        ip: nextIp(),
        body: { reason: "not_me" },
      })
    );
    expect(response.status).toBe(204);

    const body = await galleryBody(
      await getGallery(world.event.slug, { cookie: world.cookie, ip: nextIp() })
    );
    expect(body.data).toHaveLength(2);
    expect(body.summary.hiddenCount).toBe(1);
    expect(body.data.map((item) => item.matchId)).not.toContain(matchId.toHexString());

    // §6.5: never a delete — a re-run would re-insert the row it removed.
    const stored = await app.db.collection(COLLECTIONS.faceMatches).findOne({ _id: matchId });
    expect(stored).not.toBeNull();
    expect(stored?.hiddenAt instanceof Date).toBe(true);
  });
});

/* ──────────── I7: the anonymous truncation and a comparator cursor ───────── */

describe("when an anonymous attendee has twenty matches", () => {
  it("returns the preview allowance, no cursor, the truncated flag and a login link", async () => {
    const world = await seedAnonymousGallery(app, "op133-i7", { matches: 20 });

    const body = await galleryBody(
      await getGallery(world.event.slug, { cookie: world.cookie, ip: nextIp() })
    );

    expect(body.data).toHaveLength(ANONYMOUS_PREVIEW_LIMIT);
    expect(body.truncatedForAnonymous).toBe(true);
    expect(typeof body.loginUrl).toBe("string");
    expect(String(body.loginUrl).startsWith("/")).toBe(true);
    expect(body.page.nextCursor).toBeNull();
    expect(body.page.hasMore).toBe(false);
    expect(body.summary.matchCount).toBe(20);
    // `keysOf` sorts, and `loginUrl` sorts before `page`, so the expected side
    // must be sorted too — the assertion is exact-set, not insertion-order.
    expect(keysOf(body)).toEqual([...BODY_KEYS, "loginUrl", "truncatedForAnonymous"].sort());
  });

  it("rejects a cursor the server did not mint with validation_failed", async () => {
    const world = await seedAnonymousGallery(app, "op133-i7-cursor", { matches: 3 });

    const response = await getGallery(world.event.slug, {
      cookie: world.cookie,
      ip: nextIp(),
      query: "cursor=not-a-cursor-the-server-minted",
    });

    expect(response.status).toBe(422);
    expect((await errorBody(response)).code).toBe("validation_failed");
  });
});

/* ───────────── I10 / I12: identified pagination under writes ─────────────── */

describe("when a signed-in attendee pages through a large gallery", () => {
  it("serves every match across the pages a limit asks for", async () => {
    const world = await seedIdentifiedGallery(app, "op133-i10", { matches: 45 });

    const first = await galleryBody(
      await getGallery(world.event.slug, { cookie: world.cookie, ip: nextIp(), query: "limit=20" })
    );
    expect(keysOf(first)).toEqual(BODY_KEYS);
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextCursor).not.toBeNull();

    const second = await galleryBody(
      await getGallery(world.event.slug, {
        cookie: world.cookie,
        ip: nextIp(),
        query: `limit=20&cursor=${encodeURIComponent(String(first.page.nextCursor))}`,
      })
    );
    expect(second.page.hasMore).toBe(true);

    const third = await galleryBody(
      await getGallery(world.event.slug, {
        cookie: world.cookie,
        ip: nextIp(),
        query: `limit=20&cursor=${encodeURIComponent(String(second.page.nextCursor))}`,
      })
    );
    expect(third.page.hasMore).toBe(false);
    expect(third.page.nextCursor).toBeNull();

    const served = [...first.data, ...second.data, ...third.data];
    expect([first.data.length, second.data.length, third.data.length]).toEqual([20, 20, 5]);
    expect(new Set(served.map((item) => item.matchId)).size).toBe(45);
  });

  it("does not duplicate or skip when matches arrive between pages", async () => {
    const world = await seedIdentifiedGallery(app, "op133-i12", { matches: 6 });

    const first = await galleryBody(
      await getGallery(world.event.slug, { cookie: world.cookie, ip: nextIp(), query: "limit=2" })
    );
    expect(first.data).toHaveLength(2);

    // A match run inserts two newer photos while the client is between pages.
    for (const sequence of [7, 8]) {
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
        { imageId: image.imageId, createdAt: new Date() }
      );
    }

    const second = await galleryBody(
      await getGallery(world.event.slug, {
        cookie: world.cookie,
        ip: nextIp(),
        query: `limit=2&cursor=${encodeURIComponent(String(first.page.nextCursor))}`,
      })
    );
    const third = await galleryBody(
      await getGallery(world.event.slug, {
        cookie: world.cookie,
        ip: nextIp(),
        query: `limit=2&cursor=${encodeURIComponent(String(second.page.nextCursor))}`,
      })
    );

    const served = [...first.data, ...second.data, ...third.data].map((item) => item.matchId);
    expect(served).toHaveLength(6);
    expect(new Set(served).size).toBe(6);
    expect([...served].sort()).toEqual([...world.matchIds.map((id) => id.toHexString())].sort());
  });
});
