import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";

import {
  galleryHandlers,
  mediaSigner,
  seedAnonymousGallery,
  seedImage,
  seedOriginalsPlan,
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
} from "../helpers/selfie-flow";

/**
 * Integration / contract — originals, previews and download jobs: who may ask,
 * what a refusal says, and where the download job lives
 * (OP-133 I5, I6, I8, I9, I11; contract §6.6, §5.6, §0.4, §14.1; schema §16.1,
 * §18.1; ADR-0793 §4, §7).
 *
 * **Why this exists.** The gallery deliberately never carries an original: the
 * bytes are requested on an explicit tap, with a 15-minute token, and only for
 * a photo the caller is actually in. That makes the original a **signed
 * capability**, so the interesting cases are the refusals — an unmatched image,
 * a plan that does not grant originals, another attendee's download — and none
 * of them may reveal whether the row exists (§0.4: no existence leak).
 *
 * ## Contract expected of the implementation
 *
 * - `POST /api/v1/p/events/{slug}/images/{imageId}/original-url` (auth
 *   `attendee`, matched, `media.sign`) → `201 {url, expiresAt, ttlSeconds}` with
 *   `ttlSeconds: 900`; the URL is a §5.7 signature over the original's path, so
 *   it verifies with the app's own signer.
 * - A visible image the caller is **not** matched in → `403 forbidden`; an id
 *   that names no live image of this event → `404 not_found`; a plan without
 *   `originals.download` → `403 feature_not_available` (§14.1).
 * - `POST …/images/{imageId}/preview-url` is for identified callers only.
 * - `POST /api/v1/p/events/{slug}/downloads` (idempotency required) → `202
 *   {downloadId, status: "queued", pollUrl, pollIntervalMs: 3000}` and one
 *   `downloadJobs` row; `GET /api/v1/p/downloads/{downloadId}` is the owner's
 *   only — another attendee gets `404`, never `403`, so the id's existence is
 *   not confirmed.
 * - No credential at all → `401 authentication_required` on all four (§6.6
 *   "anonymous sessions"), answered *before* any lookup.
 */

/** The `originals.download` lifetime §6.6 states. */
const ORIGINAL_TTL_SECONDS = 900;

/** The download job's poll cadence (§6.6). */
const DOWNLOAD_POLL_MS = 3000;

/** The three keys §6.6 gives the original-url answer, sorted. */
const ORIGINAL_URL_KEYS = ["expiresAt", "ttlSeconds", "url"];

/** The four keys §6.6 gives the download request, sorted. */
const DOWNLOAD_REQUEST_KEYS = ["downloadId", "pollIntervalMs", "pollUrl", "status"];

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op133-media" });
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

/* ─────────────────────────────── callers ─────────────────────────────────── */

/** POST the original-url request for one image (§6.6). */
async function requestOriginal(
  slug: string,
  imageId: string,
  options: { readonly cookie?: string }
): Promise<Response> {
  return galleryHandlers.originalUrl(
    requestFor(`/api/v1/p/events/${slug}/images/${imageId}/original-url`, "POST", {
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ip: nextIp(),
      body: {},
    })
  );
}

/** POST the preview-url request for one image (§6.6). */
async function requestPreview(
  slug: string,
  imageId: string,
  options: { readonly cookie?: string }
): Promise<Response> {
  return galleryHandlers.previewUrl(
    requestFor(`/api/v1/p/events/${slug}/images/${imageId}/preview-url`, "POST", {
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ip: nextIp(),
      body: {},
    })
  );
}

/** POST a download job for the whole gallery (§6.6). */
async function requestDownload(
  slug: string,
  options: { readonly cookie?: string; readonly body?: unknown }
): Promise<Response> {
  return galleryHandlers.createDownload(
    requestFor(`/api/v1/p/events/${slug}/downloads`, "POST", {
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ip: nextIp(),
      body: options.body ?? { scope: "all_matches", quality: "original" },
    })
  );
}

/** GET one download job's status (§6.6). */
async function downloadStatus(downloadId: string, cookie?: string): Promise<Response> {
  return galleryHandlers.downloadStatus(
    requestFor(`/api/v1/p/downloads/${downloadId}`, "GET", {
      ...(cookie === undefined ? {} : { cookie }),
      ip: nextIp(),
      withoutIdempotencyKey: true,
    })
  );
}

/* ──────────── I5: the original-url refusals, and the signed success ──────── */

describe("when the attendee asks for an original", () => {
  it("answers 201 with a 15-minute signed URL for a photo they are in", async () => {
    const world = await seedAnonymousGallery(app, "op133-i5-ok", { matches: 1 });
    await seedOriginalsPlan(app, world.tenantKey, true);
    const imageId = world.images.at(0)?.imageId;
    if (imageId === undefined) {
      throw new Error("expected a seeded image");
    }
    const image = world.images.at(0);

    const before = Date.now();
    const response = await requestOriginal(world.event.slug, imageId.toHexString(), {
      cookie: world.cookie,
    });
    const body = await bodyOf(response, 201, "POST original-url");

    expect(keysOf(body)).toEqual(ORIGINAL_URL_KEYS);
    expect(body.ttlSeconds).toBe(ORIGINAL_TTL_SECONDS);
    expect(new URL(String(body.url)).pathname).toBe(`/o/${String(image?.contentHash)}.jpg`);
    expect(mediaSigner().verify(String(body.url))).toBe(true);
    const expiresAt = Date.parse(String(body.expiresAt));
    expect(expiresAt).toBeGreaterThanOrEqual(before + ORIGINAL_TTL_SECONDS * 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + ORIGINAL_TTL_SECONDS * 1000);
  });

  it("answers 403 forbidden for a visible image the attendee is not matched in", async () => {
    const world = await seedAnonymousGallery(app, "op133-i5-unmatched", { matches: 0 });
    await seedOriginalsPlan(app, world.tenantKey, true);
    const image = await seedImage(
      app,
      { tenantKey: world.tenantKey, eventId: world.event.id },
      { sequence: 1 }
    );

    const response = await requestOriginal(world.event.slug, image.imageId.toHexString(), {
      cookie: world.cookie,
    });

    expect(response.status).toBe(403);
    expect((await errorBody(response)).code).toBe("forbidden");
  });

  it("answers 404 for an image id that names no image of this event", async () => {
    const world = await seedAnonymousGallery(app, "op133-i5-unknown", { matches: 1 });
    await seedOriginalsPlan(app, world.tenantKey, true);

    const response = await requestOriginal(world.event.slug, new ObjectId().toHexString(), {
      cookie: world.cookie,
    });

    expect(response.status).toBe(404);
    expect((await errorBody(response)).code).toBe("not_found");
  });

  it("answers 403 feature_not_available when the plan does not grant originals", async () => {
    const world = await seedAnonymousGallery(app, "op133-i5-plan", { matches: 1 });
    await seedOriginalsPlan(app, world.tenantKey, false);
    const imageId = world.images.at(0)?.imageId;
    if (imageId === undefined) {
      throw new Error("expected a seeded image");
    }

    const response = await requestOriginal(world.event.slug, imageId.toHexString(), {
      cookie: world.cookie,
    });

    expect(response.status).toBe(403);
    expect((await errorBody(response)).code).toBe("feature_not_available");
  });
});

/* ───────────── I6: a download job belongs to the attendee who made it ────── */

describe("when two attendees each ask for a download", () => {
  it("shows the job to its owner and answers 404 to anyone else", async () => {
    const owner = await seedAnonymousGallery(app, "op133-i6-owner", { matches: 2 });

    // A second attendee on the **same** event: the refusal must be about
    // ownership of the profile, not about the tenant the job lives in.
    const strangerSession = await createAttendeeSession(app, nextIp());
    await grantConsent(owner.event.slug, {
      cookie: strangerSession.cookie,
      ip: nextIp(),
    });

    const created = await requestDownload(owner.event.slug, { cookie: owner.cookie });
    const body = await bodyOf(created, 202, "POST /p/events/:slug/downloads");

    expect(keysOf(body)).toEqual(DOWNLOAD_REQUEST_KEYS);
    expect(body.status).toBe("queued");
    expect(body.pollIntervalMs).toBe(DOWNLOAD_POLL_MS);
    expect(String(body.pollUrl)).toBe(`/api/v1/p/downloads/${String(body.downloadId)}`);

    const downloadId = String(body.downloadId);
    const job = await app.db.collection("downloadJobs").findOne({ _id: new ObjectId(downloadId) });
    expect(job).not.toBeNull();
    expect(job?.kind).toBe("attendee");
    expect(job?.status).toBe("queued");
    expect(String(job?.profileId)).toBe(owner.profileId.toHexString());
    expect(String(job?.eventId)).toBe(owner.event.id.toHexString());

    // The owner can poll it — otherwise "404" below could just be a dead route.
    const mine = await downloadStatus(downloadId, owner.cookie);
    expect(mine.status).toBe(200);
    const mineBody = await bodyOf(mine, 200, "GET /p/downloads/:id");
    expect(mineBody.status).toBe("queued");
    expect(mineBody.downloadId).toBe(downloadId);

    // §0.4: an id that is not yours is indistinguishable from an id that is not.
    const theirs = await downloadStatus(downloadId, strangerSession.cookie);
    expect(theirs.status).toBe(404);
    expect((await errorBody(theirs)).code).toBe("not_found");
  });
});

/* ───────────── I8 / I9 / I11: no credential at all is 401, always ────────── */

describe("when a request carries no attendee credential", () => {
  it("answers 401 to an original-url request", async () => {
    const world = await seedAnonymousGallery(app, "op133-i8", { matches: 1 });
    const imageId = world.images.at(0)?.imageId;
    if (imageId === undefined) {
      throw new Error("expected a seeded image");
    }

    const response = await requestOriginal(world.event.slug, imageId.toHexString(), {});

    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe("authentication_required");
  });

  it("answers 401 to a preview-url request", async () => {
    const world = await seedAnonymousGallery(app, "op133-i11", { matches: 1 });
    const imageId = world.images.at(0)?.imageId;
    if (imageId === undefined) {
      throw new Error("expected a seeded image");
    }

    const response = await requestPreview(world.event.slug, imageId.toHexString(), {});

    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe("authentication_required");
  });

  it("answers 401 to a download request and to a download status read", async () => {
    const world = await seedAnonymousGallery(app, "op133-i9", { matches: 1 });

    const created = await requestDownload(world.event.slug, {});
    expect(created.status).toBe(401);
    expect((await errorBody(created)).code).toBe("authentication_required");
    expect(await app.db.collection("downloadJobs").countDocuments()).toBe(0);

    const status = await downloadStatus(new ObjectId().toHexString());
    expect(status.status).toBe(401);
    expect((await errorBody(status)).code).toBe("authentication_required");
  });
});
