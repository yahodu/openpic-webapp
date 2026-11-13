import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as completeRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/[uploadSessionId]/complete/route";
import * as paramsRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/params/route";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { invalidatePlatformSettings } from "@/server/settings/platform-settings";

import { makeSubscription } from "../factories/entitlements";
import { makeEntitlement, makePlan } from "../factories/plan";
import { startTestApp, type SignedInUser, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
  bodyOf,
  confirmSelfie,
  finishSelfieWorker,
  grantConsent,
  handlers,
  makeSelfieBytes,
  nextIp,
  requestFor,
  requireHandler,
  seedTenant,
  submitHappyPath,
} from "../helpers/selfie-flow";

/**
 * Integration / contract — an organizer upload of bytes identical to a
 * submitted selfie (OP-132 findings F-A3 and F-A4; schema §16.1, §16.3, §16.4;
 * contract §5.3).
 *
 * **Why this exists.** A selfie and an organizer's event image are two
 * different assets that may hold the **same bytes**: the attendee's probe photo
 * and a guest's copy of that photo are the same file. The two lanes nevertheless
 * write very different `media_assets` rows — the organizer path writes a
 * `storage` descriptor (`{locationKey, objectKey, bytes, contentType, …}`,
 * schema §11.2) and registers an `eventImages` join row against it, while the
 * selfie path deliberately writes **no** descriptor, because the selfie's bytes
 * are the attendee's and are erased with the selfie (§16.4's owner row).
 *
 * The tenant-wide dedupe key `[tenantId, contentHash]` predates the first
 * `kind: "selfie"` row and therefore cannot tell the two apart: an organizer who
 * uploads bytes an attendee already submitted is handed the selfie's
 * descriptor-less asset. `@/server/uploads/complete-upload` then reads
 * `existingAsset.storage` as an `EventImageAsset` and projects it into the
 * answer, so the completion raises on a missing descriptor **after** its
 * transaction committed — the uploader sees `500 internal_error` while an
 * `eventImages` row points at an asset the gallery cannot render.
 *
 * ## Contract expected of the implementation
 *
 * Asset identity is kind-aware. Whichever way it is encoded (`kind` in the
 * unique dedupe key, or a unique index made partial on `kind`), the observable
 * contract is the same and is pinned here:
 *
 * - the organizer's completion answers **`201`** with the §5.3 `EventImage`
 *   DTO — never `500` — and its `assetId` names an asset **other than** the
 *   selfie's;
 * - that asset is a `kind: "event_image"` row carrying a `storage` descriptor
 *   whose `objectKey` is the content-addressed original the uploader PUT and
 *   whose `bytes` is the stored size;
 * - the selfie's own asset row is **untouched**: still `kind: "selfie"`, still
 *   `status: "stored"`, `refCount` still `1`, and still carrying no `storage`
 *   descriptor. Adding an organizer reference to a biometric row would make the
 *   attendee's erasure path reachable from an event image, and a `refCount` the
 *   selfie lane does not own would make the withdrawal's purge undecidable;
 * - two `media_assets` rows that differ **only** by `kind` coexist in one
 *   tenant (case I4), which is the index invariant behind all three pins above.
 *
 * ## Assumptions
 *
 * - **An upload of the same bytes is not a duplicate the event already holds.**
 *   §16.3's `{eventId, assetId}` uniqueness is about one *asset* attached twice;
 *   here the event holds no image at all, so the `200 duplicate` branch is not
 *   the answer this case may accept.
 * - The selfie's object and the organizer's object are different objects in the
 *   store even though their bytes are equal: the selfie lane addresses its blob
 *   from the selfie row, the organizer lane from the presigned key it minted
 *   (§5.3). Nothing in these cases asserts a shared object key.
 * - A plan with room for the bytes is seeded, because the completion meters
 *   `storage.bytes` and `images.per_event` (§4.7); the case is about asset
 *   identity, not about a quota refusal.
 *
 * See `docs/adr/ADR-0800-op132-selfies-ttl-and-kind-dedupe-pins.md`.
 */

/* ───────────────────────────── contract constants ────────────────────────── */

/** The storage limit the seeded plan grants — roomy, so no quota branch is hit. */
const ROOMY_STORAGE_LIMIT = 10_000_000_000;

/** The plan key the seeded subscription uses. */
const PLAN_KEY = "op132-collision-roomy";

/** The organizer's file name and MIME: a JPEG that agrees with its extension. */
const UPLOAD_FILE_NAME = "DSC_0421.JPG";
const UPLOAD_MIME_TYPE = "image/jpeg";

/* ─────────────────────────────── route handlers ──────────────────────────── */

/** Resolve a route export, failing with a message that names the module. */
const uploadParams = requireHandler(paramsRouteModule, "POST", "…/events/:eventId/uploads/params");
const uploadComplete = requireHandler(
  completeRouteModule,
  "POST",
  "…/events/:eventId/uploads/:uploadSessionId/complete"
);

/* ───────────────────────────────── harness ───────────────────────────────── */

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op132-asset-kinds" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  for (const name of [
    COLLECTIONS.tenants,
    COLLECTIONS.tenantMembers,
    COLLECTIONS.userProfiles,
    COLLECTIONS.events,
    COLLECTIONS.eventOrganizers,
    COLLECTIONS.mediaAssets,
    COLLECTIONS.eventImages,
    COLLECTIONS.uploadSessions,
    COLLECTIONS.plans,
    COLLECTIONS.subscriptions,
    COLLECTIONS.usageCounters,
    COLLECTIONS.entitlementGrants,
    COLLECTIONS.domainEvents,
    COLLECTIONS.idempotencyKeys,
    COLLECTIONS.attendeeSessions,
    COLLECTIONS.attendeeEventProfiles,
    COLLECTIONS.faceMatches,
    COLLECTIONS.selfies,
    "consents",
    "platformSettings",
  ]) {
    await app.db.collection(name).deleteMany({});
  }
  invalidatePlatformSettings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ──────────────────────────────── seeding ────────────────────────────────── */

/**
 * Give a tenant a plan with room for the upload.
 *
 * The completion meters `storage.bytes` (tenant scope) and `images.per_event`
 * (event scope) inside its transaction, so an unsubscribed tenant would fail
 * the case with a quota refusal instead of the asset-identity behaviour under
 * test.
 *
 * @param tenantKey - The tenant's hex id, as the tenancy stage resolves it.
 */
async function seedRoomyPlan(tenantKey: string): Promise<void> {
  await app.db.collection(COLLECTIONS.plans).insertOne(
    makePlan({
      key: PLAN_KEY,
      entitlements: {
        "storage.bytes": makeEntitlement({
          limit: ROOMY_STORAGE_LIMIT,
          scope: "tenant",
          resetPeriod: "monthly",
        }),
        "images.per_event": makeEntitlement({
          limit: 5_000,
          scope: "event",
          resetPeriod: "none",
        }),
      },
    })
  );
  await app.db.collection(COLLECTIONS.subscriptions).insertOne(
    makeSubscription({
      tenantId: tenantKey,
      subscribedPlanKey: PLAN_KEY,
      activePlanKey: PLAN_KEY,
      status: "active",
    })
  );
}

/** Everything one case needs: the organizer, the event and the selfie it took. */
interface SelfieSetup {
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly organizer: SignedInUser;
  readonly ip: string;
  /** The selfie's exact bytes, as the attendee uploaded them. */
  readonly bytes: Buffer;
  /** Their lowercase-hex SHA-256 — the content hash both lanes address. */
  readonly hash: string;
  /** The `media_assets` row the selfie path created for that hash. */
  readonly selfieAssetId: ObjectId;
}

/** A stored `selfies` row, as these cases read it (schema §16.4). */
interface StoredSelfie {
  readonly _id: ObjectId;
  readonly eventId: ObjectId;
  readonly profileId: ObjectId;
  readonly tenantId: string;
  readonly contentHash: string;
  readonly assetId: ObjectId;
}

/** A stored `media_assets` row, as these cases read it (schema §16.1). */
interface AssetRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly contentHash: string;
  readonly kind: string;
  readonly status: string;
  readonly refCount: number;
  readonly storage?: { readonly objectKey?: string; readonly bytes?: number };
}

/** A stored `event_images` join row, as these cases read it (schema §16.3). */
interface EventImageRow {
  readonly _id: ObjectId;
  readonly eventId: ObjectId;
  readonly assetId: ObjectId;
}

/**
 * Submit and confirm one selfie for `tag`'s bytes, on a tenant with one event.
 *
 * The tag is the only input to the bytes ({@link makeSelfieBytes}), so the
 * caller can address the very same bytes the route stored without trusting a
 * hash the implementation computed.
 *
 * @param tag - A per-case tag folded into the selfie's bytes.
 * @returns The tenant, event, organizer, bytes, hash and selfie asset row id.
 */
async function submitAndConfirmSelfie(tag: string): Promise<SelfieSetup> {
  const { tenantKey, owner, events } = await seedTenant(app, `op132-${tag}`);
  const [event] = events;
  if (event === undefined) {
    throw new Error("expected one seeded event");
  }
  await seedRoomyPlan(tenantKey);
  const ip = nextIp();
  await grantConsent(event.slug, { cookie: owner.cookie, ip });

  const { bytes, hash } = makeSelfieBytes(tag);
  const submitted = await submitHappyPath(event.slug, { cookie: owner.cookie, ip, tag });

  const stored = (await app.db
    .collection(COLLECTIONS.selfies)
    .findOne({ _id: new ObjectId(submitted.selfieId) })) as unknown as StoredSelfie | null;
  if (stored === null) {
    throw new Error("expected the submit route to store a selfies row");
  }
  // The bytes the case will upload are the bytes this row was written for.
  expect(stored.contentHash).toBe(hash);

  await finishSelfieWorker(app, {
    selfieId: submitted.selfieId,
    profileId: submitted.profileId,
    eventId: String(stored.eventId),
    tenantKey: stored.tenantId,
    subject: { kind: "user", userId: owner.userId.toHexString() },
    matches: 0,
  });
  const confirmed = await confirmSelfie(event.slug, submitted.selfieId, {
    cookie: owner.cookie,
    ip,
  });
  if (confirmed.status !== 200) {
    throw new Error(
      `expected 200 from the confirm route, received ${String(confirmed.status)}: ` +
        JSON.stringify(await confirmed.json())
    );
  }

  return {
    tenantKey,
    eventId: event.id,
    organizer: owner,
    ip,
    bytes,
    hash,
    selfieAssetId: stored.assetId,
  };
}

/* ───────────────────────────── organizer upload ──────────────────────────── */

/** What one completion answered, and the body it answered with. */
interface CompletionAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * Drive the §5.3 single-PUT completion for `setup`'s exact bytes.
 *
 * The bytes travel the honest path: presign through the shipped route, `PUT`
 * them to the URL that route minted, then complete the session — the same three
 * steps the browser takes, so the completion's `HeadObject` and content sniff
 * see a real stored object.
 *
 * @param setup - The tenant/event/organizer and the bytes to upload.
 * @returns The completion's status and parsed body.
 */
async function completeOrganizerUpload(setup: SelfieSetup): Promise<CompletionAnswer> {
  const tenantKey = setup.tenantKey;
  const eventIdHex = setup.eventId.toHexString();
  const ip = nextIp();

  const presign = await bodyOf(
    await uploadParams(
      requestFor(`/api/v1/tenants/${tenantKey}/events/${eventIdHex}/uploads/params`, "POST", {
        cookie: setup.organizer.cookie,
        ip,
        body: {
          batchId: new ObjectId().toHexString(),
          hash: setup.hash,
          size: setup.bytes.byteLength,
          fileName: UPLOAD_FILE_NAME,
          mimeType: UPLOAD_MIME_TYPE,
        },
      })
    ),
    201,
    "POST …/uploads/params"
  );
  const { uploadSessionId, url } = presign;
  if (typeof uploadSessionId !== "string" || typeof url !== "string") {
    throw new Error(
      `expected the presign body to carry uploadSessionId and url: ${JSON.stringify(presign)}`
    );
  }

  const put = await handlers.putObject(
    new Request(url, { method: "PUT", body: new Uint8Array(setup.bytes) })
  );
  if (put.status !== 200) {
    throw new Error(`expected the presigned PUT to answer 200, received ${String(put.status)}`);
  }

  const response = await uploadComplete(
    requestFor(
      `/api/v1/tenants/${tenantKey}/events/${eventIdHex}/uploads/${uploadSessionId}/complete`,
      "POST",
      {
        cookie: setup.organizer.cookie,
        ip,
        body: {
          etag: put.headers.get("etag") ?? '"op132-same-bytes"',
          bytes: setup.bytes.byteLength,
        },
      }
    )
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/* ──────────────────────────────── readers ────────────────────────────────── */

/** Every `media_assets` row of one tenant that holds `hash`, as stored. */
async function assetRows(tenantKey: string, hash: string): Promise<AssetRow[]> {
  return (await app.db
    .collection(COLLECTIONS.mediaAssets)
    .find({ tenantId: tenantKey, contentHash: hash })
    .toArray()) as unknown as AssetRow[];
}

/** The single `event_images` row of an event, or `null`. */
async function eventImageOf(eventId: ObjectId): Promise<EventImageRow | null> {
  const rows = (await app.db
    .collection(COLLECTIONS.eventImages)
    .find({ eventId })
    .toArray()) as unknown as EventImageRow[];
  return rows.length === 1 ? (rows[0] ?? null) : null;
}

/* ──────────── the completion answers with its own stored asset ───────────── */

describe("when an organizer uploads bytes identical to a submitted selfie", () => {
  it("answers 201 with the EventImage DTO instead of failing on the selfie's asset", async () => {
    // Arrange — the attendee's selfie is submitted, indexed and confirmed, so
    // its storage-less `media_assets` row already holds this content hash.
    const setup = await submitAndConfirmSelfie("collision-answer");

    // Act
    const completion = await completeOrganizerUpload(setup);

    // Assert — a 500 here is the defect: the descriptor-less row was reused.
    expect(
      completion.status,
      `expected 201 from the completion, received ${String(completion.status)}: ${JSON.stringify(completion.body)}`
    ).toBe(201);
    expect(completion.body.bytes).toBe(setup.bytes.byteLength);
    expect(completion.body.contentType).toBe(UPLOAD_MIME_TYPE);
    expect(completion.body.sequence).toBe(1);
    expect(completion.body.visibility).toBe("visible");

    // The event image names its own asset, not the attendee's selfie asset.
    expect(completion.body.assetId).not.toBe(setup.selfieAssetId.toHexString());
  });

  it("registers the event image against an asset that carries a storage descriptor", async () => {
    // Arrange
    const setup = await submitAndConfirmSelfie("collision-descriptor");
    const completion = await completeOrganizerUpload(setup);
    if (completion.status !== 201) {
      throw new Error(
        `expected 201 from the completion, received ${String(completion.status)}: ${JSON.stringify(completion.body)}`
      );
    }

    // Act — the join row the gallery renders, and the asset behind it.
    const row = await eventImageOf(setup.eventId);
    if (row === null) {
      throw new Error("expected the completion to register exactly one event_images row");
    }
    const asset = (await app.db
      .collection(COLLECTIONS.mediaAssets)
      .findOne({ _id: row.assetId })) as unknown as AssetRow | null;

    // Assert — §16.1's descriptor is what the DTO is projected from.
    expect(row.assetId.toHexString()).toBe(String(completion.body.assetId));
    const storage = asset?.storage;
    if (storage === undefined) {
      throw new Error(
        `expected the event image's asset to carry a storage descriptor, received ${JSON.stringify(asset)}`
      );
    }
    expect(asset).toMatchObject({ kind: "event_image", status: "stored" });
    expect(storage.objectKey).toBe(`images/${setup.hash}.jpg`);
    expect(storage.bytes).toBe(setup.bytes.byteLength);
  });

  it("leaves the selfie's own asset row untouched", async () => {
    // Arrange
    const setup = await submitAndConfirmSelfie("collision-untouched");
    const before = await assetRows(setup.tenantKey, setup.hash);
    expect(before).toHaveLength(1);

    // Act
    await completeOrganizerUpload(setup);

    // Assert — the biometric row keeps its shape: no descriptor, no extra
    // reference, no kind change.
    const rows = await assetRows(setup.tenantKey, setup.hash);
    const selfieAsset = rows.find(
      (asset) => asset._id.toHexString() === setup.selfieAssetId.toHexString()
    );
    if (selfieAsset === undefined) {
      throw new Error("expected the selfie's media_assets row to survive the organizer upload");
    }
    expect(selfieAsset).toMatchObject({ kind: "selfie", status: "stored", refCount: 1 });
    expect(selfieAsset.storage, "the selfie asset must stay descriptor-less").toBeUndefined();
  });
});

/* ───────────── the index invariant behind all three pins above ───────────── */

describe("when two media_assets rows differ only by their kind", () => {
  it("lets both rows exist in one tenant", async () => {
    // Arrange — the smallest pair that states the invariant: same tenant, same
    // content hash, different kind. `ensureIndexes` built the registry on this
    // database in `beforeAll`, so this is the real index set.
    const { tenantKey } = await seedTenant(app, "op132-two-kinds");
    const now = new Date("2026-03-02T10:00:00.000Z");
    const contentHash = makeSelfieBytes("two-kinds").hash;
    const first = {
      _id: new ObjectId(),
      tenantId: tenantKey,
      contentHash,
      kind: "event_image",
      status: "stored",
      refCount: 1,
      createdAt: now,
    };
    const second = { ...first, _id: new ObjectId(), kind: "selfie" };
    await app.db.collection(COLLECTIONS.mediaAssets).insertOne(first);

    // Act — the second row differs only by `kind`.
    const insert = app.db.collection(COLLECTIONS.mediaAssets).insertOne(second);

    // Assert
    await expect(insert).resolves.toMatchObject({ acknowledged: true });
    expect(await assetRows(tenantKey, contentHash)).toHaveLength(2);
  });
});
