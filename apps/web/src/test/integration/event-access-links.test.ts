import { createHash } from "node:crypto";

import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as rotateRouteModule from "@/app/api/v1/events/[eventId]/access-links:rotate/route";
import * as qrRouteModule from "@/app/api/v1/events/[eventId]/access-links/[slug]/qr/route";
import { COLLECTIONS } from "@/server/db/collections";
import { renderQrCode } from "@/server/events/access-link-qr";
import * as qrRenderer from "@/server/events/access-link-qr";
import { buildQrPayloadUrl } from "@/server/events/access-links";
import { ensureIndexes } from "@/server/db/indexes";
import { createMediaSigner } from "@/server/media/signer";
import { getObjectStorage } from "@/server/storage/get-object-storage";

import { makeEnv } from "../factories/env";
import { body } from "../helpers/auth-requests";
import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";

/**
 * Integration / contract — access-link rotation and QR generation (OP-118
 * I1–I4, contract §4.2, schema §15.1/§16.1, ADR-0620).
 *
 * The **organizer** rotates a compromised share link: a new slug is pushed,
 * the previous one is deactivated with a `revokedAt` stamp (so exactly one link
 * stays active), the answer carries the §4.2 `{ accessLinks, warning }` body
 * and the `event.link.rotated` domain event is emitted. Requesting the QR for a
 * link generates the image **once**, stores it as a content-addressed
 * `mediaAssets` export and answers a redirect-free signed URL; a repeat request
 * is a cache hit (one stored object), while a different format is a different
 * asset.
 *
 * ## Contract expected of the implementation
 *
 * - `@/app/api/v1/events/[eventId]/access-links:rotate/route` exports `POST`
 *   declared on `defineRoute({ route: "/api/v1/events/:eventId/access-links:rotate" })`
 *   with the `user` auth stage and body `{ confirmUnderstood: true }`.
 *   - role `organizer` only: a co-organizer answers `403 forbidden`, a caller
 *     with no relationship `404 not_found` (never an oracle, contract §0.4).
 *   - a missing or `false` `confirmUnderstood` answers `422
 *     acknowledgement_required` and writes nothing (contract §4.2: "already
 *     printed QR codes stop working").
 *   - `200` → exactly two top-level keys, `accessLinks` (the **new** active
 *     link first with its `shareUrl`, then the revoked one with `revokedAt`)
 *     and `warning`, the contract's sentence naming the revoked slug.
 *   - the write is atomic (one `accessLinks` array, one `$set`): after the
 *     answer exactly one element is `active: true` and the previous one carries
 *     a `revokedAt` instant.
 *   - emits `event.link.rotated` in the same transaction
 *     (`subjectRef: { kind: "event", id }`); the key is already registered in
 *     the notification catalogue.
 * - `@/app/api/v1/events/[eventId]/access-links/[slug]/qr/route` exports `GET`
 *   declared on `defineRoute({ route: "/api/v1/events/:eventId/access-links/:slug/qr" })`.
 *   - **event member** access (organizer, co-organizer or tenant member);
 *     unauthenticated `401`, unrelated `404`.
 *   - `?format=png|svg|pdf&size=256..2048` (validated by
 *     `parseQrQuery` in `@/server/events/access-links`); out of range/unknown
 *     answers `422 validation_failed`.
 *   - a slug that exists but is `active: false` answers `410
 *     access_link_revoked` with `details.message` (card §3's decision).
 *   - `200` with **exactly** `{ url, expiresAt, format, size }` — a
 *     redirect-free signed URL (no `3xx`, no `location` header), signed with
 *     `MEDIA_SIGNING_SECRET_CURRENT` for the `export` derivative
 *     (`https://pic.openpic.in/o/<contentHash>.<ext>?exp=…&sig=…`).
 *   - the bytes are put through `getObjectStorage().putObject` **once** per
 *     `(slug, format, size)`; the `mediaAssets` row is
 *     `{ tenantId: <string>, contentHash, kind: "export" }` (schema §16.1,
 *     `media_assets_tenant_content_hash_unique`).
 *
 * ## Assumptions (ADR-0620 §Assumptions)
 *
 * - The routes live on the **global** `/api/v1/events/{eventId}` family (as
 *   OP-117's PATCH/archive/delete and upload-window:extend do), not the
 *   contract's tenant-scoped spelling, because that family admits a
 *   co-organizer who is not a tenant member.
 * - The QR routes are invoked directly; the `{eventId}` and `{slug}` segments
 *   are read off `request.url` (the pipeline never exposes Next `params`).
 * - The `event_organizers` fixture is the OP-116/OP-117 one: an active row
 *   (`revokedAt: null`) per user, the co-organizer holding no `tenantMembers`
 *   row.
 * - The cache key is `(slug, format, size)`: the same format twice is one
 *   asset, a different format is a second asset. Whether the implementation
 *   keys on `accessLinks[].qrAssetId` or on the content hash is not pinned —
 *   only the storage/row counts are.
 */

type TenantKey = string;

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op118-access-links" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  for (const name of [
    COLLECTIONS.events,
    COLLECTIONS.eventOrganizers,
    COLLECTIONS.tenants,
    COLLECTIONS.tenantMembers,
    COLLECTIONS.userProfiles,
    COLLECTIONS.mediaAssets,
    COLLECTIONS.domainEvents,
    COLLECTIONS.idempotencyKeys,
  ]) {
    await app.db.collection(name).deleteMany({});
  }
});

/** Read a route export off a route namespace, failing with a naming message. */
function requireHandler(
  module: object,
  name: "GET" | "POST",
  path: string
): (request: Request) => Promise<Response> {
  const handler = (module as Record<string, unknown>)[name];
  if (typeof handler !== "function") {
    throw new Error(`expected ${path} to export a ${name} handler`);
  }
  return handler as (request: Request) => Promise<Response>;
}

const rotateAccessLink = requireHandler(
  rotateRouteModule,
  "POST",
  "/api/v1/events/:eventId/access-links:rotate"
);
const getQrCode = requireHandler(
  qrRouteModule,
  "GET",
  "/api/v1/events/:eventId/access-links/:slug/qr"
);

/** The configured public base URL of the test environment (makeEnv default). */
const APP_BASE_URL = String(makeEnv().APP_BASE_URL);

/** The signing secret the route reads — the same validated env. */
const SIGNING_SECRET = makeEnv().MEDIA_SIGNING_SECRET_CURRENT ?? "";

/** The unambiguous slug alphabet (schema §15.1, ADR-0520). */
const SLUG_PATTERN = /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/;

/** The response keys §4.2 spells for a QR download — exactly, no extras. */
const QR_RESPONSE_KEYS = ["expiresAt", "format", "size", "url"];

/** The two keys the §4.2 rotate answer carries. */
const ROTATE_RESPONSE_KEYS = ["accessLinks", "warning"];

/** A signed-in user who owns a fresh active tenant. */
async function seedOwner(prefix: string): Promise<{ user: SignedInUser; tenantId: ObjectId }> {
  const user = await app.signIn(makeIdentity(prefix));
  await app.db
    .collection(COLLECTIONS.userProfiles)
    .updateOne(
      { userId: user.userId },
      { $set: { accountCompletedAt: new Date(), displayName: "Organizer", updatedAt: new Date() } }
    );
  const tenantId = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id: tenantId,
    slug: `op118-${prefix}`,
    name: "OP118 Studio",
    status: "active",
    ownerUserId: user.userId,
    billingContactUserId: user.userId,
    dataRegion: "in",
    counters: {
      eventCount: 0,
      activeEventCount: 0,
      imageCount: 0,
      storageBytes: 0,
      attendeeCount: 0,
      reconciledAt: null,
    },
    settings: {
      defaultTimeZone: "Asia/Kolkata",
      brandLogoAssetId: null,
      defaultWatermarkAssetId: null,
    },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    schemaVersion: 1,
  });
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId,
    userId: user.userId,
    role: "owner",
    status: "active",
    joinedAt: new Date(),
  });
  return { user, tenantId };
}

/** A monotonically-increasing unique access-link slug for seeded events. */
let seededSlugSeq = 0;

/** The seeded event's active slug. */
interface SeededEvent {
  readonly id: ObjectId;
  readonly slug: string;
}

/**
 * Insert a stored `events` row plus its single organizer `event_organizers`
 * row (schema §15.1/§15.2).
 */
async function seedOwnedEvent(
  tenantKey: TenantKey,
  ownerUserId: SignedInUser["userId"]
): Promise<SeededEvent> {
  const _id = new ObjectId();
  const now = new Date();
  const slug = `op${String(seededSlugSeq).padStart(6, "0")}`;
  seededSlugSeq += 1;
  await app.db.collection(COLLECTIONS.events).insertOne({
    _id,
    tenantId: tenantKey,
    name: "Rahul & Priya's Wedding",
    description: "",
    status: "published",
    startAt: new Date("2026-11-10T10:00:00.000Z"),
    endAt: new Date("2026-11-10T12:00:00.000Z"),
    displayTimeZone: "Asia/Kolkata",
    uploadWindowEndsAt: new Date("2026-11-17T12:00:00.000Z"),
    retentionExpiresAt: new Date("2027-02-08T12:00:00.000Z"),
    accessLinks: [{ slug, active: true, createdAt: now, revokedAt: null, scanCount: 0 }],
    counters: {
      imageCount: 0,
      processedImageCount: 0,
      failedImageCount: 0,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: 0,
    },
    sequence: 1,
    logoAssetId: null,
    watermarkAssetId: null,
    createdByUserId: ownerUserId.toHexString(),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
  await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
    tenantId: tenantKey,
    eventId: _id,
    userId: ownerUserId.toHexString(),
    role: "organizer",
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  });
  return { id: _id, slug };
}

/** Record an `event_organizers` row for the co-organizer (no tenantMembers row). */
async function seedCoOrganizer(
  tenantKey: TenantKey,
  eventId: ObjectId,
  user: SignedInUser
): Promise<void> {
  await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
    tenantId: tenantKey,
    eventId,
    userId: user.userId.toHexString(),
    role: "co_organizer",
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    schemaVersion: 1,
  });
}

/** A `POST /events/{eventId}/access-links:rotate` request carrying the cookie. */
function rotateRequest(
  cookie: string,
  eventId: string,
  payload: Record<string, unknown> | undefined
): Request {
  return new Request(new URL(`/api/v1/events/${eventId}/access-links:rotate`, APP_ORIGIN), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(payload ?? { confirmUnderstood: true }),
  });
}

/** A `GET /events/{eventId}/access-links/{slug}/qr` request carrying the cookie. */
function qrRequest(
  cookie: string,
  eventId: string,
  slug: string,
  query = "format=png&size=1024"
): Request {
  const path = `/api/v1/events/${eventId}/access-links/${slug}/qr${query === "" ? "" : `?${query}`}`;
  return new Request(new URL(path, APP_ORIGIN), {
    method: "GET",
    headers: { cookie },
  });
}

/** The stored `events` row, or a failure naming the seed. */
async function readEventRow(eventId: ObjectId): Promise<Record<string, unknown>> {
  const row = await app.db.collection(COLLECTIONS.events).findOne({ _id: eventId });
  if (row === null) {
    throw new Error("expected the event row to exist");
  }
  return row;
}

/** The stored `accessLinks` array of an event row. */
function storedLinks(row: Record<string, unknown>): Record<string, unknown>[] {
  const links = row.accessLinks;
  if (!Array.isArray(links)) {
    throw new Error("expected the stored event row to carry an accessLinks array");
  }
  return links as Record<string, unknown>[];
}

/** The `error` block of a refusal body. */
async function errorBody(
  response: Response
): Promise<{ code: string; details?: Record<string, unknown> }> {
  const parsed = await body(response);
  const error = parsed.error;
  if (error === null || typeof error !== "object") {
    throw new Error(`expected an error envelope, received ${JSON.stringify(parsed)}`);
  }
  return error as { code: string; details?: Record<string, unknown> };
}

/** The `details.fields[].path` values of a 422 validation refusal. */
function fieldPaths(details: Record<string, unknown> | undefined): string[] {
  const fields = details?.fields;
  if (!Array.isArray(fields)) {
    return [];
  }
  return fields.map((entry: unknown): string => {
    if (entry !== null && typeof entry === "object" && "path" in entry) {
      const path: unknown = entry.path;
      return typeof path === "string" ? path : "";
    }
    return "";
  });
}

/** The sorted own keys of a JSON object, or `[]` for a non-object. */
function keysOf(value: unknown): string[] {
  return value !== null && typeof value === "object" ? Object.keys(value).sort() : [];
}

/** One wire link of the §4.2 rotate answer. */
interface RotateLink {
  readonly slug: string;
  readonly active: boolean;
  readonly shareUrl?: string;
  readonly revokedAt?: string;
}

/** The §4.2 rotate answer. */
interface RotateAnswer {
  readonly accessLinks: RotateLink[];
  readonly warning: string;
}

describe("POST /api/v1/events/{eventId}/access-links:rotate — rotate a share link (contract §4.2)", () => {
  it("I1: rotating answers exactly one active link and revokes the previous one", async () => {
    const { user, tenantId } = await seedOwner("op118-rotate");
    const tenantKey = tenantId.toHexString();
    const seeded = await seedOwnedEvent(tenantKey, user.userId);
    const id = seeded.id.toHexString();

    const response = await rotateAccessLink(rotateRequest(user.cookie, id, undefined));

    expect(response.status).toBe(200);
    const parsed = (await body(response)) as unknown as RotateAnswer;
    expect(keysOf(parsed)).toEqual(ROTATE_RESPONSE_KEYS);

    expect(parsed.accessLinks).toHaveLength(2);
    const [newLink, revokedLink] = parsed.accessLinks;
    if (newLink === undefined || revokedLink === undefined) {
      throw new Error("expected the rotate answer to carry both the new and the revoked link");
    }

    // The new link leads the array, is active and is the only active one.
    expect(newLink.active).toBe(true);
    expect(newLink.slug).toMatch(SLUG_PATTERN);
    expect(newLink.slug).not.toBe(seeded.slug);
    expect(newLink.shareUrl).toBe(`${APP_BASE_URL}/e/${newLink.slug}`);

    // The previous link is revoked with a stamped instant, in the answer...
    expect(revokedLink.slug).toBe(seeded.slug);
    expect(revokedLink.active).toBe(false);
    expect(typeof revokedLink.revokedAt).toBe("string");
    expect(Number.isNaN(Date.parse(revokedLink.revokedAt ?? ""))).toBe(false);

    // ...and the contract's warning names the slug that stops working.
    expect(parsed.warning).toBe(
      `Previously printed QR codes for ${seeded.slug} will no longer work.`
    );

    // The stored row carries the same single-active invariant.
    const row = await readEventRow(seeded.id);
    const links = storedLinks(row);
    expect(links.filter((link) => link.active === true)).toHaveLength(1);
    const storedOld = links.find((link) => link.slug === seeded.slug);
    if (storedOld === undefined) {
      throw new Error("expected the previous link to stay in the stored array");
    }
    expect(storedOld.active).toBe(false);
    expect(storedOld.revokedAt).toBeInstanceOf(Date);
    const storedNew = links.find((link) => link.slug === newLink.slug);
    if (storedNew === undefined) {
      throw new Error("expected the new link to be stored");
    }
    expect(storedNew.active).toBe(true);

    // The rotation announces itself on the outbox.
    const emitted = await app.db
      .collection(COLLECTIONS.domainEvents)
      .findOne({ eventKey: "event.link.rotated", tenantId: tenantKey });
    expect(emitted).toMatchObject({
      eventKey: "event.link.rotated",
      actorRef: { kind: "user", id: user.userId.toHexString() },
      subjectRef: { kind: "event", id },
    });
  });

  it("I1: a rotation without the confirmation acknowledgement answers 422 and writes nothing", async () => {
    const { user, tenantId } = await seedOwner("op118-rotate-noconfirm");
    const tenantKey = tenantId.toHexString();
    const seeded = await seedOwnedEvent(tenantKey, user.userId);
    const id = seeded.id.toHexString();

    const missing = await rotateAccessLink(rotateRequest(user.cookie, id, {}));
    expect(missing.status).toBe(422);
    expect((await errorBody(missing)).code).toBe("acknowledgement_required");

    const refused = await rotateAccessLink(
      rotateRequest(user.cookie, id, { confirmUnderstood: false })
    );
    expect(refused.status).toBe(422);
    expect((await errorBody(refused)).code).toBe("acknowledgement_required");

    const links = storedLinks(await readEventRow(seeded.id));
    expect(links).toHaveLength(1);
    expect(links[0]?.slug).toBe(seeded.slug);
    expect(links[0]?.active).toBe(true);
  });

  it("I3: a co-organizer rotating answers 403 and changes no link", async () => {
    const owner = await seedOwner("op118-rotate-co");
    const tenantKey = owner.tenantId.toHexString();
    const seeded = await seedOwnedEvent(tenantKey, owner.user.userId);
    const id = seeded.id.toHexString();

    const coOrganizer = await app.signIn(makeIdentity("op118-rotate-co-org"));
    await seedCoOrganizer(tenantKey, seeded.id, coOrganizer);

    const response = await rotateAccessLink(rotateRequest(coOrganizer.cookie, id, undefined));

    expect(response.status).toBe(403);
    expect((await errorBody(response)).code).toBe("forbidden");

    const links = storedLinks(await readEventRow(seeded.id));
    expect(links).toHaveLength(1);
    expect(links[0]?.slug).toBe(seeded.slug);
    expect(links[0]?.active).toBe(true);
    const emitted = await app.db
      .collection(COLLECTIONS.domainEvents)
      .findOne({ eventKey: "event.link.rotated", tenantId: tenantKey });
    expect(emitted).toBeNull();
  });

  it("I3: a caller with no relationship to the event answers 404, not an oracle", async () => {
    const owner = await seedOwner("op118-rotate-outsider");
    const tenantKey = owner.tenantId.toHexString();
    const seeded = await seedOwnedEvent(tenantKey, owner.user.userId);
    const id = seeded.id.toHexString();

    const outsider = await app.signIn(makeIdentity("op118-rotate-outsider-2"));
    const response = await rotateAccessLink(rotateRequest(outsider.cookie, id, undefined));

    expect(response.status).toBe(404);
  });

  it("I3: an unauthenticated rotation answers 401 authentication_required", async () => {
    const { user, tenantId } = await seedOwner("op118-rotate-anon");
    const seeded = await seedOwnedEvent(tenantId.toHexString(), user.userId);

    const response = await rotateAccessLink(
      new Request(
        new URL(`/api/v1/events/${seeded.id.toHexString()}/access-links:rotate`, APP_ORIGIN),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmUnderstood: true }),
        }
      )
    );

    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe("authentication_required");
  });
});

describe("GET /api/v1/events/{eventId}/access-links/{slug}/qr — generate a QR code (contract §4.2)", () => {
  it("I2: the same QR requested twice stores one asset and answers the same signed URL", async () => {
    const { user, tenantId } = await seedOwner("op118-qr-cache");
    const tenantKey = tenantId.toHexString();
    const seeded = await seedOwnedEvent(tenantKey, user.userId);
    const id = seeded.id.toHexString();
    const storage = getObjectStorage();
    const putSpy = vi.spyOn(storage, "putObject");

    const first = await getQrCode(qrRequest(user.cookie, id, seeded.slug));
    expect(first.status).toBe(200);
    expect(first.headers.get("location")).toBeNull();
    const firstBody = await body(first);
    expect(keysOf(firstBody)).toEqual(QR_RESPONSE_KEYS);
    expect(firstBody.format).toBe("png");
    expect(firstBody.size).toBe(1024);
    const url = String(firstBody.url);
    expect(url).toMatch(/^https:\/\/pic\.openpic\.in\/o\/[0-9a-f]{64}\.png\?exp=\d+&sig=[\w-]+$/);
    expect(typeof firstBody.expiresAt).toBe("string");
    expect(Number.isNaN(Date.parse(String(firstBody.expiresAt)))).toBe(false);

    const second = await getQrCode(qrRequest(user.cookie, id, seeded.slug));
    expect(second.status).toBe(200);
    expect(await body(second)).toEqual(firstBody);

    // One stored object for two downloads: the generated image is cached.
    expect(putSpy).toHaveBeenCalledTimes(1);

    const contentHash = /\/o\/([0-9a-f]{64})\.png/.exec(url)?.[1] ?? "";
    expect(contentHash).not.toBe("");
    const rows = await app.db
      .collection(COLLECTIONS.mediaAssets)
      .countDocuments({ contentHash, kind: "export" });
    expect(rows).toBe(1);
    const stored = await app.db
      .collection(COLLECTIONS.mediaAssets)
      .findOne({ contentHash, kind: "export" });
    // `mediaAssets.tenantId` is a string (§16.1, TENANT_SCOPED_COLLECTIONS).
    expect(stored?.tenantId).toBe(tenantKey);
  });

  it("I2: the confirmed URL really is signed for the export derivative", async () => {
    const { user, tenantId } = await seedOwner("op118-qr-signature");
    const tenantKey = tenantId.toHexString();
    const seeded = await seedOwnedEvent(tenantKey, user.userId);
    const id = seeded.id.toHexString();

    const response = await getQrCode(qrRequest(user.cookie, id, seeded.slug));
    expect(response.status).toBe(200);
    const parsed = (await body(response)) as unknown as { url: string; expiresAt: string };

    const signer = createMediaSigner({ currentSecret: SIGNING_SECRET });
    expect(signer.verify(parsed.url)).toBe(true);
    expect(new Date(parsed.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("I2: a different format is a different cached asset", async () => {
    const { user, tenantId } = await seedOwner("op118-qr-format");
    const tenantKey = tenantId.toHexString();
    const seeded = await seedOwnedEvent(tenantKey, user.userId);
    const id = seeded.id.toHexString();
    const storage = getObjectStorage();
    const putSpy = vi.spyOn(storage, "putObject");

    const png = await getQrCode(qrRequest(user.cookie, id, seeded.slug, "format=png&size=1024"));
    expect(png.status).toBe(200);
    const svg = await getQrCode(qrRequest(user.cookie, id, seeded.slug, "format=svg&size=1024"));
    expect(svg.status).toBe(200);

    const svgBody = (await body(svg)) as unknown as { url: string; format: string };
    expect(svgBody.format).toBe("svg");
    expect(svgBody.url).toMatch(/\.svg\?exp=\d+&sig=[\w-]+$/);
    expect(putSpy).toHaveBeenCalledTimes(2);
    expect(
      await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({ kind: "export" })
    ).toBe(2);
  });

  it("I4: a size above the 2048 ceiling answers 422 validation_failed naming size", async () => {
    const { user, tenantId } = await seedOwner("op118-qr-size");
    const tenantKey = tenantId.toHexString();
    const seeded = await seedOwnedEvent(tenantKey, user.userId);
    const id = seeded.id.toHexString();

    const response = await getQrCode(
      qrRequest(user.cookie, id, seeded.slug, "format=png&size=4096")
    );

    expect(response.status).toBe(422);
    const error = await errorBody(response);
    expect(error.code).toBe("validation_failed");
    expect(fieldPaths(error.details)).toContain("size");
    expect(await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({})).toBe(0);
  });

  it("I4: an unsupported format answers 422 validation_failed naming format", async () => {
    const { user, tenantId } = await seedOwner("op118-qr-format-bad");
    const tenantKey = tenantId.toHexString();
    const seeded = await seedOwnedEvent(tenantKey, user.userId);
    const id = seeded.id.toHexString();

    const response = await getQrCode(
      qrRequest(user.cookie, id, seeded.slug, "format=gif&size=1024")
    );

    expect(response.status).toBe(422);
    const error = await errorBody(response);
    expect(error.code).toBe("validation_failed");
    expect(fieldPaths(error.details)).toContain("format");
  });

  it("§3: a revoked slug is no longer downloadable (410 access_link_revoked)", async () => {
    const { user, tenantId } = await seedOwner("op118-qr-revoked");
    const tenantKey = tenantId.toHexString();
    const seeded = await seedOwnedEvent(tenantKey, user.userId);
    const id = seeded.id.toHexString();

    const rotated = await rotateAccessLink(rotateRequest(user.cookie, id, undefined));
    expect(rotated.status).toBe(200);

    const response = await getQrCode(qrRequest(user.cookie, id, seeded.slug));

    expect(response.status).toBe(410);
    const error = await errorBody(response);
    expect(error.code).toBe("access_link_revoked");
    expect(typeof error.details?.message).toBe("string");
    expect(await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({})).toBe(0);
  });

  it("a co-organizer can download the QR (event member, not organizer-only)", async () => {
    const owner = await seedOwner("op118-qr-co");
    const tenantKey = owner.tenantId.toHexString();
    const seeded = await seedOwnedEvent(tenantKey, owner.user.userId);
    const id = seeded.id.toHexString();

    const coOrganizer = await app.signIn(makeIdentity("op118-qr-co-org"));
    await seedCoOrganizer(tenantKey, seeded.id, coOrganizer);

    const response = await getQrCode(qrRequest(coOrganizer.cookie, id, seeded.slug));

    expect(response.status).toBe(200);
  });

  it("an unrelated caller answers 404 and generates nothing", async () => {
    const owner = await seedOwner("op118-qr-outsider");
    const tenantKey = owner.tenantId.toHexString();
    const seeded = await seedOwnedEvent(tenantKey, owner.user.userId);
    const id = seeded.id.toHexString();

    const outsider = await app.signIn(makeIdentity("op118-qr-outsider-2"));
    const response = await getQrCode(qrRequest(outsider.cookie, id, seeded.slug));

    expect(response.status).toBe(404);
    expect(await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({})).toBe(0);
  });

  it("an unauthenticated download answers 401 authentication_required", async () => {
    const { user, tenantId } = await seedOwner("op118-qr-anon");
    const seeded = await seedOwnedEvent(tenantId.toHexString(), user.userId);

    const response = await getQrCode(
      new Request(
        new URL(
          `/api/v1/events/${seeded.id.toHexString()}/access-links/${seeded.slug}/qr?format=png&size=1024`,
          APP_ORIGIN
        ),
        { method: "GET" }
      )
    );

    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe("authentication_required");
  });
});

/**
 * F2/F3 — OP-118 review round 1 follow-up.
 *
 * `F2`: the QR was rendered **before** the cache was consulted, so the cache
 * saved storage but no work — every download paid the `qrcode` render (and a
 * PDF its `pdf-lib` embed + save as well).
 *
 * `F3`: the cache read and the upsert matched `{ tenantId, contentHash }`
 * without `kind: "export"`, so a `mediaAssets` row of another kind holding
 * byte-identical content was reused as the QR cache and stamped with
 * `qrUrl`/`qrExpiresAt`.
 */
describe("GET …/access-links/{slug}/qr — the cache hides the work, not only the write (OP-118 review round 1)", () => {
  it("F2: two identical downloads render the QR image once", async () => {
    // Arrange
    const { user, tenantId } = await seedOwner("op118-qr-render-once");
    const seeded = await seedOwnedEvent(tenantId.toHexString(), user.userId);
    const id = seeded.id.toHexString();
    const renderSpy = vi.spyOn(qrRenderer, "renderQrCode");

    // Act
    const first = await getQrCode(qrRequest(user.cookie, id, seeded.slug));
    const second = await getQrCode(qrRequest(user.cookie, id, seeded.slug));

    // Assert — both answers succeed and the repeat costs no render (`I2`
    // already pins that the two bodies are byte-identical).
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it("F3: a thumbnail row carrying the QR bytes is not reused as the QR cache", async () => {
    // Arrange
    const { user, tenantId } = await seedOwner("op118-qr-foreign-kind");
    const tenantKey = tenantId.toHexString();
    const seeded = await seedOwnedEvent(tenantKey, user.userId);
    const id = seeded.id.toHexString();

    // The renderer is pure (schema §16.1: "same input, same bytes"), so the
    // content hash this request will compute is known up front — that is what
    // lets the fixture occupy the very row the route would otherwise match.
    const rendered = await renderQrCode(buildQrPayloadUrl(APP_BASE_URL, seeded.slug), {
      format: "png",
      size: 1024,
    });
    const contentHash = createHash("sha256").update(rendered.bytes).digest("hex");
    await app.db.collection(COLLECTIONS.mediaAssets).insertOne({
      tenantId: tenantKey,
      contentHash,
      kind: "thumbnail",
      createdAt: new Date(),
    });

    // Act
    const response = await getQrCode(qrRequest(user.cookie, id, seeded.slug));

    // Assert — the answer names those bytes...
    expect(response.status).toBe(200);
    const parsed = (await body(response)) as unknown as { url: string };
    expect(parsed.url).toContain(`/o/${contentHash}.png`);

    // ...and the thumbnail row keeps no QR state: the cache row is kind-scoped.
    const foreign = await app.db.collection(COLLECTIONS.mediaAssets).findOne({ contentHash });
    expect(foreign?.kind).toBe("thumbnail");
    expect(foreign?.qrUrl).toBeUndefined();
    expect(foreign?.qrExpiresAt).toBeUndefined();
    expect(
      await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({ qrUrl: { $exists: true } })
    ).toBe(0);
  });
});
