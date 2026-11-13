import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";

import {
  galleryHandlers,
  mediaSigner,
  seedAnonymousGallery,
  seedOriginalsPlan,
  type GalleryWorld,
} from "../helpers/attendee-gallery-flow";
import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { bodyOf, keysOf, nextIp, requestFor } from "../helpers/selfie-flow";

/**
 * Integration / contract — the attendee **read** surface after
 * `events.retentionExpiresAt` has elapsed stays answerable (OP-132 F4-R2b
 * follow-up, review finding F-1 of `t_4503b5cf`; contract §6.1, §6.4, §6.5,
 * §6.6, Appendix A.7; [ADR-0813](../../../../../docs/adr/ADR-0813-op132-attendee-retention-gate.md) §Decision, §Consequences).
 *
 * **Why this exists.** ADR-0813 decided the retention gate for the four
 * biometric **writes** only: `POST …/liveness/challenges`, `POST …/selfies/uploads`,
 * `POST …/selfies` and `POST …/selfies:reuse` answer `410 gallery_expired` once
 * the window has closed. §Decision and §Consequences add the other half — the
 * gate is **not** placed "on any read (`GET …/me`, `GET …/gallery`, image URLs,
 * hide/unhide, downloads)" and "the reads and the confirm stay ungated" — but
 * the shipped pack held only the confirm (its control C4 in
 * `attendee-retention-gate.test.ts`). Nothing held `GET …/gallery`, `GET …/me`
 * or an image read, so a later change that moved the gate into
 * `requireAttendeeProfile` — the helper all three of them share — would have
 * reddened no case. This spec is that missing half.
 *
 * ## Contract pinned here
 *
 * On one event whose `retentionExpiresAt` is in the past, and **before** the
 * purge has run:
 *
 * | case | endpoint | documented answer |
 * | ---- | -------- | ----------------- |
 * | R1 | `GET /api/v1/p/events/{slug}/gallery` | `200 {data, page, summary}`, `summary.galleryExpiresAt` = the event's deadline |
 * | R2 | `GET /api/v1/p/events/{slug}/me` | `200` with the §6.4 envelope, `galleryExpiresAt` = the event's deadline |
 * | R3 | `POST /api/v1/p/events/{slug}/images/{imageId}/original-url` | `201 {url, expiresAt, ttlSeconds}`, `ttlSeconds: 900` |
 * | R4 | `GET …/me` **and** `GET …/gallery` on an event with `retentionExpiresAt: null` | `200` with `galleryExpiresAt: null` |
 * | R5 | `POST /api/v1/p/events/{slug}/downloads` | `202 {downloadId, status: "queued", pollUrl, pollIntervalMs: 3000}` (§6.6) |
 * | R6 | `GET /api/v1/p/downloads/{downloadId}` for a queued job | `200` with the eight §6.6 status keys, `url` and `expiresAt` null while queued |
 *
 * §6.5's own `410 gallery_expired` is scoped to "`retentionExpiresAt` has passed
 * **and the purge has run**", so it belongs to the purge lane's own records and
 * is not the answer of a read on an un-purged event. R1–R3 therefore pin the
 * documented success shape and, by asserting it, the absence of the `410`.
 *
 * R4 is the other half of that predicate: `retentionExpiresAt: null` means
 * "unbounded" (§15.1), so an implementation that treated a missing deadline as
 * elapsed would redden R4 while R1–R3 stayed green.
 *
 * R5 and R6 carry the same predicate to the **downloads pair**, the last item of
 * the decision's "not gated" list that no case held. The pair does not share the
 * read surface's seam: the `GET` resolves the caller through
 * `requireAuth("attendee")` plus `callerProfileId`/`ownsJob`
 * (`server/attendee/download-job.ts`), so a route-local retention gate on either
 * downloads route reddened nothing before this pair existed.
 *
 * ## Why this pack is a characterization (green on first run)
 *
 * `requireAttendeeProfile` (`server/attendee/request-event.ts`) carries no
 * retention check and neither does the gallery route: the trunk answers every
 * case below today. The pack exists so that the **reverse** change — adding a
 * gate to a read — is caught. There is consequently no GREEN card behind it and
 * no production line is owed by it.
 *
 * ## Assumptions (resolved here, not silently)
 *
 * - **A1** — the elapsed fixture is a direct `events` `updateOne` on the seeded
 *   `_id`, storing `Date.now() - 1`: every route reads the event through
 *   `resolveEventBySlug`, so the stored row is the deadline they see, and one
 *   millisecond behind "now" is unambiguously elapsed. Equality itself is
 *   pinned by `apps/web/src/test/unit/retention-gate.test.ts`.
 * - **A2** — the image read is `original-url`, because that is the one the
 *   contract §6.6 documents with a status **and** a body (`201`,
 *   `ttlSeconds: 900`); `preview-url` has no §6.6 row of its own and is
 *   identified-only, so it is out of scope here. The fixture drives the `201`
 *   through the shared helper's `seedOriginalsPlan(…, true)`.
 * - **A3** — the caller is anonymous and its consent was granted **before** the
 *   deadline moved, so every case exercises the retention predicate alone and
 *   never the `412 consent_required` precondition.
 * - **A4** — no ADR number is minted by this card: the decision is ADR-0813's
 *   (§Decision/§Consequences), the record of this pack's evidence is owned by
 *   the lane's sign-off card, and two ADR branches are in flight, so a new
 *   number would only add a ledger merge conflict. The ledger cells are
 *   therefore untouched.
 * - **A5** — R5 queues its download with the empty body the route defaults
 *   (`all_matches`, `original`): §6.6 puts no plan entitlement on the download
 *   pair, so the only variable between this `202` and a refusal is the deadline,
 *   exactly as in A3.
 * - **A6** — the arms are two independent cases, so R6 queues its own job rather
 *   than reading R5's: no case depends on which ran first.
 *
 * ## Out of scope (deliberate)
 *
 * - `POST …/gallery:seen`, `POST …/matches/{matchId}/hide` and
 *   `POST …/matches/{matchId}/unhide`: they are named in the decision's "no
 *   gate" list too, but they are **writes** and are owned by their own suites.
 *   `unhide` in particular has **no route** in this tree (§Decision records it
 *   as out of scope), and a case cannot pin an endpoint that does not exist.
 * - `GET /api/v1/p/selfies/reusable` and `GET /me/events`: different lanes
 *   (OP-132/OP-134), and neither is keyed on the addressed event's retention.
 * - The purge lane's `410 gallery_expired`: it is the other decision, pinned by
 *   the purge lane's own records (the selfie asset owner's expiry-purge suite).
 */

/** The three keys §6.5 gives the gallery body, sorted. */
const GALLERY_BODY_KEYS = ["data", "page", "summary"];

/** The five keys §6.5 gives the gallery `summary`, sorted. */
const GALLERY_SUMMARY_KEYS = [
  "galleryExpiresAt",
  "hiddenCount",
  "indexingComplete",
  "matchCount",
  "newMatchCount",
];

/** The fourteen keys `/me` answers: §6.4's thirteen plus `latestMatchCursor`. */
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

/** The three keys §6.6 gives an image read, sorted. */
const IMAGE_URL_KEYS = ["expiresAt", "ttlSeconds", "url"];

/** The `originals.download` lifetime §6.6 states. */
const ORIGINAL_TTL_SECONDS = 900;

/** The four keys §6.6 gives the download request, sorted. */
const DOWNLOAD_REQUEST_KEYS = ["downloadId", "pollIntervalMs", "pollUrl", "status"];

/** The eight keys §6.6 gives the download status body, sorted. */
const DOWNLOAD_STATUS_KEYS = [
  "bytes",
  "createdAt",
  "downloadId",
  "downloadsRemaining",
  "expiresAt",
  "fileCount",
  "status",
  "url",
];

/** The poll cadence §6.6 states for a queued download. */
const DOWNLOAD_POLL_MS = 3000;

/** One gallery item, as these cases need it (§6.5). */
interface GalleryItem {
  readonly matchId: string;
  readonly imageId: string;
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
}

/** The `selfie` half of the §6.4 poll, read only for its presence. */
interface ParticipationSelfie {
  readonly id: string;
}

/** The §6.4 body. */
interface ParticipationBody {
  readonly profileId: string;
  readonly subject: { readonly kind: string };
  readonly status: string;
  readonly statusDetail: unknown;
  readonly selfie: ParticipationSelfie | null;
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

/** The §6.6 answer to a download request. */
interface DownloadRequestBody {
  readonly downloadId: string;
  readonly status: string;
  readonly pollUrl: string;
  readonly pollIntervalMs: number;
}

/** The §6.6 status body of one download job. */
interface DownloadStatusBody {
  readonly downloadId: string;
  readonly status: string;
  readonly fileCount: number;
  readonly bytes: number;
  readonly url: string | null;
  readonly expiresAt: string | null;
  readonly downloadsRemaining: number;
  readonly createdAt: string;
}

let app: TestApp;

/* ───────────────────────────────── harness ───────────────────────────────── */

beforeAll(async () => {
  app = await startTestApp({ prefix: "op132-read-surface" });
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
    COLLECTIONS.downloadJobs,
    COLLECTIONS.domainEvents,
    COLLECTIONS.idempotencyKeys,
    COLLECTIONS.plans,
    COLLECTIONS.subscriptions,
    "consents",
    "selfies",
  ]) {
    await app.db.collection(name).deleteMany({});
  }
});

/* ──────────────────────────────── fixtures ───────────────────────────────── */

/**
 * Store one retention deadline on the seeded event's own row.
 *
 * @param event - The seeded event to move.
 * @param value - The deadline to store, or `null` for an unlimited event.
 */
async function setRetention(event: { readonly id: ObjectId }, value: Date | null): Promise<void> {
  const updated = await app.db
    .collection(COLLECTIONS.events)
    .updateOne({ _id: event.id }, { $set: { retentionExpiresAt: value } });
  if (updated.matchedCount !== 1) {
    throw new Error(`expected to move the retention deadline of ${event.id.toHexString()}`);
  }
}

/**
 * Move the event's retention deadline one millisecond into the past.
 *
 * @param world - The seeded gallery world whose event is closed.
 * @returns The stored deadline, which both read envelopes echo.
 */
async function expireRetention(world: GalleryWorld): Promise<Date> {
  const elapsed = new Date(Date.now() - 1);
  await setRetention(world.event, elapsed);
  return elapsed;
}

/* ───────────────────────────────── readers ───────────────────────────────── */

/** GET the gallery for one event, through the shipped route. */
async function getGallery(world: GalleryWorld): Promise<Response> {
  return galleryHandlers.gallery(
    requestFor(`/api/v1/p/events/${world.event.slug}/gallery`, "GET", {
      cookie: world.cookie,
      ip: nextIp(),
      withoutIdempotencyKey: true,
    })
  );
}

/** GET the participation poll for one event, through the shipped route. */
async function poll(world: GalleryWorld): Promise<Response> {
  return galleryHandlers.participation(
    requestFor(`/api/v1/p/events/${world.event.slug}/me`, "GET", {
      cookie: world.cookie,
      ip: nextIp(),
      withoutIdempotencyKey: true,
    })
  );
}

/**
 * POST the original-url request for one seeded image (§6.6).
 *
 * @param world - The seeded gallery world and its caller.
 * @param imageId - The hex id of the image the caller is matched in.
 */
async function requestOriginalUrl(world: GalleryWorld, imageId: string): Promise<Response> {
  return galleryHandlers.originalUrl(
    requestFor(`/api/v1/p/events/${world.event.slug}/images/${imageId}/original-url`, "POST", {
      cookie: world.cookie,
      ip: nextIp(),
      body: {},
    })
  );
}

/**
 * Queue one download of the caller's whole gallery (§6.6).
 *
 * `requestFor` sends the `idempotency-key` §6.6 makes required, and the empty
 * body takes the route's own `all_matches` / `original` defaults.
 *
 * @param world - The seeded gallery world and its caller.
 */
async function requestDownload(world: GalleryWorld): Promise<Response> {
  return galleryHandlers.createDownload(
    requestFor(`/api/v1/p/events/${world.event.slug}/downloads`, "POST", {
      cookie: world.cookie,
      ip: nextIp(),
      body: {},
    })
  );
}

/**
 * GET one download job's status (§6.6).
 *
 * @param world - The seeded gallery world and its caller.
 * @param downloadId - The id the queued `202` answered.
 */
async function downloadStatus(world: GalleryWorld, downloadId: string): Promise<Response> {
  return galleryHandlers.downloadStatus(
    requestFor(`/api/v1/p/downloads/${downloadId}`, "GET", {
      cookie: world.cookie,
      ip: nextIp(),
      withoutIdempotencyKey: true,
    })
  );
}

/** Parse a gallery body, failing loudly when the status is not `200`. */
async function galleryBody(response: Response): Promise<GalleryBody> {
  const raw = await bodyOf(response, 200, "GET /p/events/:slug/gallery");
  return raw as unknown as GalleryBody;
}

/** Parse a `/me` body, failing loudly when the status is not `200`. */
async function pollBody(response: Response): Promise<ParticipationBody> {
  const raw = await bodyOf(response, 200, "GET /p/events/:slug/me");
  return raw as unknown as ParticipationBody;
}

/** Parse a download-request body, failing loudly when the status is not `202`. */
async function downloadRequestBody(response: Response): Promise<DownloadRequestBody> {
  const raw = await bodyOf(response, 202, "POST /p/events/:slug/downloads");
  return raw as unknown as DownloadRequestBody;
}

/** Parse a download status body, failing loudly when the status is not `200`. */
async function downloadStatusBody(response: Response): Promise<DownloadStatusBody> {
  const raw = await bodyOf(response, 200, "GET /p/downloads/:downloadId");
  return raw as unknown as DownloadStatusBody;
}

/* ──────────── the elapsed window: every read still answers its shape ─────── */

describe("when the event's retention deadline has elapsed and the purge has not run", () => {
  it("R1: the gallery answers its 200 envelope, not 410 gallery_expired", async () => {
    // Arrange — two matches, then the deadline one millisecond into the past.
    const world = await seedAnonymousGallery(app, "op132-rs-r1", { matches: 2 });
    const expiredAt = await expireRetention(world);

    // Act
    const response = await getGallery(world);

    // Assert — the §6.5 envelope, and the window it publishes is the stored one.
    expect(response.status).toBe(200);
    const body = await galleryBody(response);
    expect(keysOf(body)).toEqual(GALLERY_BODY_KEYS);
    expect(keysOf(body.summary)).toEqual(GALLERY_SUMMARY_KEYS);
    expect(body.summary.galleryExpiresAt).toBe(expiredAt.toISOString());
    expect(body.summary.matchCount).toBe(2);
    expect(body.data).toHaveLength(2);
    expect(body.page.total).toBe(2);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("R2: the participation poll answers its 200 envelope after retention", async () => {
    // Arrange
    const world = await seedAnonymousGallery(app, "op132-rs-r2", { matches: 2 });
    const expiredAt = await expireRetention(world);

    // Act
    const response = await poll(world);

    // Assert — the §6.4 body, with the closed window stated rather than refused.
    expect(response.status).toBe(200);
    const body = await pollBody(response);
    expect(keysOf(body)).toEqual(PARTICIPATION_KEYS);
    expect(body.profileId).toBe(world.profileId.toHexString());
    expect(body.status).toBe("ready");
    expect(body.matchCount).toBe(2);
    expect(body.galleryExpiresAt).toBe(expiredAt.toISOString());
    expect(body.selfie).toBeNull();
  });

  it("R3: the original-url read answers its documented 201 after retention", async () => {
    // Arrange — the caller is matched in image 0 and the plan grants originals,
    // so the only variable between this `201` and a refusal is the deadline.
    const world = await seedAnonymousGallery(app, "op132-rs-r3", { matches: 1 });
    await seedOriginalsPlan(app, world.tenantKey, true);
    const image = world.images.at(0);
    if (image === undefined) {
      throw new Error("expected the fixture to seed one image");
    }
    await expireRetention(world);

    // Act
    const response = await requestOriginalUrl(world, image.imageId.toHexString());

    // Assert — the §6.6 answer, and a URL the app's own signer accepts.
    expect(response.status).toBe(201);
    const body = await bodyOf(response, 201, "POST original-url");
    expect(keysOf(body)).toEqual(IMAGE_URL_KEYS);
    expect(body.ttlSeconds).toBe(ORIGINAL_TTL_SECONDS);
    expect(mediaSigner().verify(String(body.url))).toBe(true);
    expect(Date.parse(String(body.expiresAt))).toBeGreaterThan(Date.now());
  });

  it("R5: the download request answers its documented 202 after retention", async () => {
    // Arrange — a caller with matches, then the deadline one millisecond into the past.
    const world = await seedAnonymousGallery(app, "op132-rs-r5", { matches: 2 });
    await expireRetention(world);

    // Act
    const response = await requestDownload(world);

    // Assert — §6.6's queued envelope: four keys, and a poll URL naming the job.
    expect(response.status).toBe(202);
    const body = await downloadRequestBody(response);
    expect(keysOf(body)).toEqual(DOWNLOAD_REQUEST_KEYS);
    expect(body.status).toBe("queued");
    expect(body.pollIntervalMs).toBe(DOWNLOAD_POLL_MS);
    expect(body.pollUrl).toBe(`/api/v1/p/downloads/${body.downloadId}`);
  });

  it("R6: the download job status answers its documented 200 body after retention", async () => {
    // Arrange — one queued job (A6: its own, so no case depends on another).
    const world = await seedAnonymousGallery(app, "op132-rs-r6", { matches: 2 });
    await expireRetention(world);
    const queued = await downloadRequestBody(await requestDownload(world));
    const downloadId = queued.downloadId;

    // Act
    const response = await downloadStatus(world, downloadId);

    // Assert — §6.6's status body, with nothing built yet.
    expect(response.status).toBe(200);
    const body = await downloadStatusBody(response);
    expect(keysOf(body)).toEqual(DOWNLOAD_STATUS_KEYS);
    expect(body.downloadId).toBe(downloadId);
    expect(body.status).toBe("queued");
    expect(body.fileCount).toBe(0);
    expect(body.bytes).toBe(0);
    expect(body.url).toBeNull();
    expect(body.expiresAt).toBeNull();
    // §6.6 states a capped count but not the cap itself, so only its sign is pinned.
    expect(body.downloadsRemaining).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
  });
});

/* ────────────── the other half of the predicate: no deadline at all ──────── */

describe("when the event carries no retention deadline", () => {
  it("R4: the poll and the gallery both answer 200 with a null galleryExpiresAt", async () => {
    // Arrange — `retentionExpiresAt: null` is §15.1's "unbounded".
    const world = await seedAnonymousGallery(app, "op132-rs-r4", { matches: 1 });
    await setRetention(world.event, null);

    // Act
    const pollResponse = await poll(world);
    const galleryResponse = await getGallery(world);

    // Assert — a null deadline is not an elapsed one on either read.
    expect(pollResponse.status).toBe(200);
    const polled = await pollBody(pollResponse);
    expect(polled.galleryExpiresAt).toBeNull();

    expect(galleryResponse.status).toBe(200);
    const gallery = await galleryBody(galleryResponse);
    expect(gallery.summary.galleryExpiresAt).toBeNull();
  });
});
