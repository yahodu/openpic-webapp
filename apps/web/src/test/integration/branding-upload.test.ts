import { createHash } from "node:crypto";

import { ObjectId, type Document, type WithId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as eventBrandingUpload } from "@/app/api/v1/events/[eventId]/assets/branding/route";
import { POST as tenantBrandingUpload } from "@/app/api/v1/tenants/[tenantId]/assets/branding/route";
import { COLLECTIONS } from "@/server/db/collections";
import { createMediaSigner } from "@/server/media/signer";
import { getObjectStorage } from "@/server/storage/get-object-storage";
import { buildObjectKey } from "@/server/storage/object-key";

import { makeEnv } from "../factories/env";
import { body } from "../helpers/auth-requests";
import { APP_ORIGIN, makeIdentity, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";

/**
 * Branding asset upload (OP-114, API contract §2.1 — "the single
 * byte-accepting endpoint").
 *
 * `POST /api/v1/tenants/{tenantId}/assets/branding` accepts exactly one
 * `multipart/form-data` upload (`file`, ≤ 2 MB, png | jpeg | webp | svg by
 * **magic bytes**, never by the file name or declared `Content-Type`), stores
 * the content-addressed object under the tenant's `branding` location,
 * records a `mediaAssets` row (`{ tenantId, contentHash, kind }` — the unique
 * `{tenantId, contentHash}` index is the dedupe identity), and answers
 * `201 { assetId, kind, url, bytes }` where `url` is a signed
 * `https://pic.openpic.in/t/<contentHash>.<ext>?exp=&sig=` media URL.
 *
 * Refusals: `413 file_too_large {maxBytes, actualBytes}` over 2 MB,
 * `415 unsupported_media_type {supportedMimeTypes}` for non-image bytes, and
 * `403 forbidden` for a `member` (owner|admin only). The event-scoped twin
 * `POST /api/v1/events/{eventId}/assets/branding` authorises through the
 * event's organizer rows and attributes the asset to the **event's** tenant —
 * a co-organizer upload lands in the organizer's tenant even though the uploader
 * is not a member of it.
 *
 * ## Contract expected of the implementation
 *
 * - `@/app/api/v1/tenants/[tenantId]/assets/branding/route` exports `POST`
 *   declared on `defineRoute({ route: "/api/v1/tenants/:tenantId/assets/branding" })`
 *   with the `user` auth stage, the reusable tenant stage and **no** body
 *   schema (this route is exempt from the JSON content-type rule — the handler
 *   reads the multipart stream itself).
 * - `@/app/api/v1/events/[eventId]/assets/branding/route` exports `POST`
 *   declared on `defineRoute({ route: "/api/v1/events/:eventId/assets/branding" })`.
 * - `@/server/storage/get-object-storage` exports `getObjectStorage(): ObjectStorage`
 *   selecting the OP-112 port by `STORAGE_PROVIDER` (`memory` for tests/e2e —
 *   **memoized**, so a test reads back the very store the route wrote to — and
 *   the R2 adapter for `s3`).
 * - `@/server/media/signer` (`createMediaSigner`) and
 *   `@/server/storage/object-key` (`buildObjectKey`) come from the OP-112/OP-113
 *   lanes; the signing secret is the `MEDIA_SIGNING_SECRET_CURRENT` the
 *   `makeEnv` fixture defaults to.
 * - The `mediaAssets` row carries `tenantId` (string, per `TENANT_SCOPED_COLLECTIONS`),
 *   `contentHash` (the lowercase hex SHA-256 of the **original uploaded bytes**,
 *   schema §16.1) and `kind` (`"event_logo" | "watermark"`, echoed from the
 *   form field `kind`).
 * - The new error code `file_too_large` (contract Appendix A.2, `413`,
 *   `{ maxBytes, actualBytes }`) must be appended to the contracts error enum
 *   and the server error catalogue exactly like the tenancy/entitlement codes.
 *
 * ## Assumptions (recorded in ADR-0540)
 *
 * - **A1 — the 2 MB limit is 2 MiB (`2_097_152` bytes).** The platform's own
 *   upload ceilings follow MiB (`platformSettings.upload.maxFileBytes =
 *   104_857_600`), and the contract example `bytes: 48120` is a logo, not PRD
 *   precision about decimal SI. `maxBytes` echoes this exact number.
 * - **A2 — `kind` is an optional multipart text field; its default is
 *   unpinned.** The tests always send it explicitly; the GREEN may default or
 *   reject an omitted/unknown value, but must echo the sent value in the row
 *   and the response.
 * - **A3 — the media URL signs the `thumbnail` derivative** (`/t/`,
 *   §5.6–§5.7), because the contract's response example is
 *   `https://pic.openpic.in/t/...` and logos/watermarks are small.
 * - **A4 — `event_organizers` membership is the event route's authorisation**:
 *   an active (revokedAt null) row `{ tenantId, eventId, userId, role }` for the
 *   caller. At this head the collection's unique partial index allows **one**
 *   active row per `(tenantId, eventId)`, so the co-organizer fixture seeds only
 *   the co-organizer's row (the event's own organizer row convention belongs to
 *   the OP-115 lane).
 */

const TENANTS_BASE = "/api/v1/tenants";
const EVENTS_BASE = "/api/v1/events";

/** The makeEnv default signing secret — the route reads the same validated env. */
const SIGNING_SECRET = makeEnv().MEDIA_SIGNING_SECRET_CURRENT ?? "";

/** The assumed 2 MiB branding limit (assumption A1). */
const MAX_BRANDING_BYTES = 2 * 1024 * 1024;

/** A real 1×1 transparent PNG. */
const ONE_PX_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The 1×1 PNG bytes, the happy-path fixture. */
const PNG_BYTES = Uint8Array.from(Buffer.from(ONE_PX_PNG_BASE64, "base64"));

/** A Windows executable (`MZ…`) — image-shaped only to a liar. */
const EXE_BYTES = new Uint8Array([
  0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00,
]);

/** An SVG carrying every payload U2 says the sanitizer must remove. */
const MALICIOUS_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
  <script>document.body.innerHTML = "pwned"</script>
  <a href="javascript:alert(2)"><text>click</text></a>
  <foreignObject><div onclick="alert(3)">x</div></foreignObject>
</svg>`;

/** The §2.1 upload response keys — exactly, no extras (§0.15). */
const BRANDING_RESPONSE_KEYS = ["assetId", "bytes", "kind", "url"];

let app: TestApp;

beforeAll(async () => {
  // Boots a private database, the real auth surface and the readiness probe;
  // the cold connect belongs in this hook, never inside a timed spec.
  app = await startTestApp({ prefix: "op114-branding" });
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

// Each case seeds its own workspace but the suite shares one database; the
// content-hash counts below are global, so every case starts with an empty
// `media_assets` (the billing suites clear their collections the same way).
beforeEach(async () => {
  await app.db.collection(COLLECTIONS.mediaAssets).deleteMany({});
});

/** The lowercase hex SHA-256 of the uploaded bytes (schema §16.1). */
function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Merge fields into a caller's auto-provisioned `userProfiles` row. */
async function updateProfile(userId: ObjectId, fields: Record<string, unknown>): Promise<void> {
  const result = await app.db
    .collection(COLLECTIONS.userProfiles)
    .updateOne({ userId }, { $set: { ...fields, updatedAt: new Date() } });
  expect(result.matchedCount).toBe(1);
}

/** Insert a tenant (schema §13.3) and return its id. */
async function insertTenant(fields: {
  slug: string;
  name: string;
  ownerUserId?: ObjectId;
}): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug: fields.slug,
    name: fields.name,
    status: "active",
    ownerUserId: fields.ownerUserId ?? null,
    billingContactUserId: fields.ownerUserId ?? null,
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
  return _id;
}

/** Insert a membership row (schema §13.4). */
async function insertTenantMember(fields: {
  tenantId: ObjectId;
  userId: ObjectId;
  role: "owner" | "admin" | "member";
}): Promise<void> {
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    ...fields,
    status: "active",
    joinedAt: new Date(),
  });
}

/** Seed a workspace owned by `userId`, making it that user's primary tenant. */
async function seedWorkspace(options: {
  userId: ObjectId;
  role: "owner" | "admin" | "member";
  slug?: string;
}): Promise<ObjectId> {
  const tenantId = await insertTenant({
    slug: options.slug ?? "op114-studio",
    name: "OP114 Studio",
    ownerUserId: options.role === "owner" ? options.userId : new ObjectId(),
  });
  await insertTenantMember({ tenantId, userId: options.userId, role: options.role });
  await updateProfile(options.userId, { primaryTenantId: tenantId });
  return tenantId;
}

/** A `multipart/form-data` branding upload request carrying the session cookie. */
function uploadRequest(
  cookie: string,
  path: string,
  file: { name: string; type: string; bytes: Uint8Array<ArrayBuffer> },
  kind: string
): Request {
  const form = new FormData();
  form.append("file", new File([file.bytes], file.name, { type: file.type }));
  form.append("kind", kind);
  return new Request(new URL(path, APP_ORIGIN), {
    method: "POST",
    headers: cookie === "" ? {} : { cookie },
    body: form,
  });
}

/** The error envelope of a failed response. */
async function errorOf(
  response: Response
): Promise<{ code: string; details?: Record<string, unknown> }> {
  const parsed = await body(response);
  return parsed.error as { code: string; details?: Record<string, unknown> };
}

/** Assert the §2.1 signed branding URL exactly: `/t/<contentHash>.<ext>` + exp/sig. */
function expectSignedBrandingUrl(url: string, expectedPath: string): void {
  const parsed = new URL(url);
  expect(parsed.origin).toBe("https://pic.openpic.in");
  expect(parsed.pathname).toBe(expectedPath);
  expect(parsed.searchParams.get("exp")).toMatch(/^\d+$/);
  expect(parsed.searchParams.get("sig")).not.toBeNull();
  expect(createMediaSigner({ currentSecret: SIGNING_SECRET }).verify(url)).toBe(true);
}

/** The mediaAssets row whose content hash matches, across every tenant. */
async function findAssetByHash(contentHash: string): Promise<WithId<Document> | null> {
  return app.db.collection(COLLECTIONS.mediaAssets).findOne({ contentHash });
}

describe("POST /api/v1/tenants/{tenantId}/assets/branding", () => {
  it("I1: refuses a 2.1 MB upload with 413 file_too_large and maxBytes/actualBytes", async () => {
    const owner = await app.signIn(makeIdentity("op114-owner"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });

    const oversized = new Uint8Array(2_100_000);
    oversized.set(PNG_BYTES, 0);
    const uploadHash = sha256Hex(oversized);

    const response = await tenantBrandingUpload(
      uploadRequest(
        owner.cookie,
        `${TENANTS_BASE}/${tenantId.toHexString()}/assets/branding`,
        { name: "logo.png", type: "image/png", bytes: oversized },
        "event_logo"
      )
    );

    expect(response.status).toBe(413);
    const error = await errorOf(response);
    expect(error.code).toBe("file_too_large");
    expect(error.details).toEqual({
      maxBytes: MAX_BRANDING_BYTES,
      actualBytes: 2_100_000,
    });

    // The refusal is total: no mediaAssets row and no stored object.
    expect(
      await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({ contentHash: uploadHash })
    ).toBe(0);
  });

  it("I2: treats a PNG whose file name says .svg as a PNG", async () => {
    const owner = await app.signIn(makeIdentity("op114-owner"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    const tenantIdHex = tenantId.toHexString();

    const response = await tenantBrandingUpload(
      uploadRequest(
        owner.cookie,
        `${TENANTS_BASE}/${tenantIdHex}/assets/branding`,
        { name: "logo.svg", type: "image/png", bytes: PNG_BYTES },
        "event_logo"
      )
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("x-tenant-id")).toBe(tenantIdHex);

    const payload = await body(response);
    expect(Object.keys(payload).sort()).toEqual(BRANDING_RESPONSE_KEYS);
    expect(payload.kind).toBe("event_logo");
    expect(payload.bytes).toBe(PNG_BYTES.length);

    const contentHash = sha256Hex(PNG_BYTES);
    expectSignedBrandingUrl(payload.url as string, `/t/${contentHash}.png`);

    // The row is tenant-scoped, content-addressed and carries the sent kind.
    const row = await findAssetByHash(contentHash);
    if (row === null) {
      throw new Error(`expected a mediaAssets row for ${contentHash}`);
    }
    expect(String(row.tenantId)).toBe(tenantIdHex);
    expect(row.contentHash).toBe(contentHash);
    expect(row.kind).toBe("event_logo");
    expect(payload.assetId).toBe(row._id.toHexString());
  });

  it("detects the MIME from the bytes, not the declared Content-Type", async () => {
    const owner = await app.signIn(makeIdentity("op114-owner"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });

    const response = await tenantBrandingUpload(
      uploadRequest(
        owner.cookie,
        `${TENANTS_BASE}/${tenantId.toHexString()}/assets/branding`,
        { name: "logo.bin", type: "application/octet-stream", bytes: PNG_BYTES },
        "event_logo"
      )
    );

    expect(response.status).toBe(201);
    const payload = await body(response);
    const contentHash = sha256Hex(PNG_BYTES);
    expectSignedBrandingUrl(payload.url as string, `/t/${contentHash}.png`);
  });

  it("I3: refuses an exe carrying an image Content-Type with 415 unsupported_media_type", async () => {
    const owner = await app.signIn(makeIdentity("op114-owner"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });

    const response = await tenantBrandingUpload(
      uploadRequest(
        owner.cookie,
        `${TENANTS_BASE}/${tenantId.toHexString()}/assets/branding`,
        { name: "photo.png", type: "image/png", bytes: EXE_BYTES },
        "event_logo"
      )
    );

    expect(response.status).toBe(415);
    const error = await errorOf(response);
    expect(error.code).toBe("unsupported_media_type");
    expect(error.details?.supportedMimeTypes).toEqual(
      ["image/jpeg", "image/png", "image/svg+xml", "image/webp"].sort()
    );
    expect(
      await app.db
        .collection(COLLECTIONS.mediaAssets)
        .countDocuments({ contentHash: sha256Hex(EXE_BYTES) })
    ).toBe(0);
  });

  it("I4: stores a malicious SVG sanitized", async () => {
    const owner = await app.signIn(makeIdentity("op114-owner"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });

    const raw = new TextEncoder().encode(MALICIOUS_SVG);

    const response = await tenantBrandingUpload(
      uploadRequest(
        owner.cookie,
        `${TENANTS_BASE}/${tenantId.toHexString()}/assets/branding`,
        { name: "logo.svg", type: "image/svg+xml", bytes: raw },
        "event_logo"
      )
    );

    expect(response.status).toBe(201);
    const payload = await body(response);
    const contentHash = sha256Hex(raw);
    expectSignedBrandingUrl(payload.url as string, `/t/${contentHash}.svg`);

    // The content hash is of the ORIGINAL bytes (schema §16.1)…
    const row = await findAssetByHash(contentHash);
    if (row === null) {
      throw new Error(`expected a mediaAssets row for ${contentHash}`);
    }
    expect(String(row.tenantId)).toBe(tenantId.toHexString());
    expect(row.contentHash).toBe(contentHash);
    expect(row.kind).toBe("event_logo");
    expect(payload.assetId).toBe(row._id.toHexString());

    // …while the STORED bytes are the sanitized copy: fetched from the memory
    // storage the route wrote to, every payload U2 names is gone, and the
    // response `bytes` is the stored (sanitized) length.
    const key = buildObjectKey(contentHash, "svg");
    const stored = await getObjectStorage().getObject("branding", key);
    const storedText = new TextDecoder().decode(stored);
    expect(storedText).not.toContain("script");
    expect(storedText).not.toContain("pwned");
    expect(storedText.toLowerCase()).not.toContain("onload");
    expect(storedText.toLowerCase()).not.toContain("onclick");
    expect(storedText.toLowerCase()).not.toContain("javascript:");
    expect(storedText.toLowerCase()).not.toContain("foreignobject");
    expect(payload.bytes).toBe(stored.length);
  });

  it("I5: refuses a member with 403 forbidden and writes nothing", async () => {
    const owner = await app.signIn(makeIdentity("op114-owner"));
    const member = await app.signIn(makeIdentity("op114-member"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    await insertTenantMember({ tenantId, userId: member.userId, role: "member" });
    await updateProfile(member.userId, { primaryTenantId: tenantId });

    const response = await tenantBrandingUpload(
      uploadRequest(
        member.cookie,
        `${TENANTS_BASE}/${tenantId.toHexString()}/assets/branding`,
        { name: "logo.png", type: "image/png", bytes: PNG_BYTES },
        "event_logo"
      )
    );

    expect(response.status).toBe(403);
    const error = await errorOf(response);
    expect(error.code).toBe("forbidden");
    expect(
      await app.db
        .collection(COLLECTIONS.mediaAssets)
        .countDocuments({ contentHash: sha256Hex(PNG_BYTES) })
    ).toBe(0);
  });

  it("allows an admin as well as the owner", async () => {
    const admin = await app.signIn(makeIdentity("op114-admin"));
    const tenantId = await seedWorkspace({ userId: admin.userId, role: "admin" });

    const response = await tenantBrandingUpload(
      uploadRequest(
        admin.cookie,
        `${TENANTS_BASE}/${tenantId.toHexString()}/assets/branding`,
        { name: "logo.png", type: "image/png", bytes: PNG_BYTES },
        "event_logo"
      )
    );

    expect(response.status).toBe(201);
  });

  it("answers 401 without a session", async () => {
    const response = await tenantBrandingUpload(
      uploadRequest(
        "",
        `${TENANTS_BASE}/000000000000000000000000/assets/branding`,
        { name: "logo.png", type: "image/png", bytes: PNG_BYTES },
        "event_logo"
      )
    );

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("authentication_required");
  });

  it("answers 404 to a caller who is not a member of the workspace", async () => {
    const owner = await app.signIn(makeIdentity("op114-owner"));
    const stranger = await app.signIn(makeIdentity("op114-stranger"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });

    const response = await tenantBrandingUpload(
      uploadRequest(
        stranger.cookie,
        `${TENANTS_BASE}/${tenantId.toHexString()}/assets/branding`,
        { name: "logo.png", type: "image/png", bytes: PNG_BYTES },
        "event_logo"
      )
    );

    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("not_found");
  });

  it("I6: returns the same assetId for the same file uploaded twice", async () => {
    const owner = await app.signIn(makeIdentity("op114-owner"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    const path = `${TENANTS_BASE}/${tenantId.toHexString()}/assets/branding`;

    const first = await tenantBrandingUpload(
      uploadRequest(
        owner.cookie,
        path,
        { name: "logo.png", type: "image/png", bytes: PNG_BYTES },
        "event_logo"
      )
    );
    const second = await tenantBrandingUpload(
      uploadRequest(
        owner.cookie,
        path,
        { name: "logo.png", type: "image/png", bytes: PNG_BYTES },
        "event_logo"
      )
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstPayload = await body(first);
    const secondPayload = await body(second);
    expect(secondPayload.assetId).toBe(firstPayload.assetId);

    // One tenant-scoped row for the content hash — the dedupe identity.
    const contentHash = sha256Hex(PNG_BYTES);
    const rows = await app.db.collection(COLLECTIONS.mediaAssets).find({ contentHash }).toArray();
    expect(rows).toHaveLength(1);
    if (rows[0] === undefined) {
      throw new Error("unreachable: rows.length was 1");
    }
    expect(String(rows[0].tenantId)).toBe(tenantId.toHexString());
    expect(rows[0]._id.toHexString()).toBe(firstPayload.assetId);
  });
});

describe("POST /api/v1/events/{eventId}/assets/branding", () => {
  it("I7: stores a co-organizer upload under the organizer's tenant", async () => {
    const organizer = await app.signIn(makeIdentity("op114-org"));
    const coOrganizer = await app.signIn(makeIdentity("op114-coorg"));
    const orgTenantId = await seedWorkspace({
      userId: organizer.userId,
      role: "owner",
      slug: "op114-org-studio",
    });
    const coOrgTenantId = await seedWorkspace({
      userId: coOrganizer.userId,
      role: "owner",
      slug: "op114-coorg-studio",
    });
    const orgTenantHex = orgTenantId.toHexString();

    const eventId = new ObjectId();
    await app.db.collection(COLLECTIONS.events).insertOne({
      _id: eventId,
      tenantId: orgTenantHex,
      name: "Branding Party",
      status: "draft",
      createdAt: new Date(),
      schemaVersion: 1,
    });
    // The co-organizer is authorized by the event row alone — they are NOT a
    // member of the organizer's workspace (assumption A4).
    await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
      tenantId: orgTenantHex,
      eventId,
      userId: coOrganizer.userId,
      role: "co_organizer",
      revokedAt: null,
      joinedAt: new Date(),
    });

    const response = await eventBrandingUpload(
      uploadRequest(
        coOrganizer.cookie,
        `${EVENTS_BASE}/${eventId.toHexString()}/assets/branding`,
        { name: "logo.png", type: "image/png", bytes: PNG_BYTES },
        "event_logo"
      )
    );

    expect(response.status).toBe(201);
    const payload = await body(response);
    const contentHash = sha256Hex(PNG_BYTES);
    expectSignedBrandingUrl(payload.url as string, `/t/${contentHash}.png`);

    // The asset is stored and billed under the ORGANIZER's tenant, never the
    // co-organizer's own workspace.
    const rows = await app.db.collection(COLLECTIONS.mediaAssets).find({ contentHash }).toArray();
    expect(rows).toHaveLength(1);
    if (rows[0] === undefined) {
      throw new Error("unreachable: rows.length was 1");
    }
    expect(String(rows[0].tenantId)).toBe(orgTenantHex);
    expect(String(rows[0].tenantId)).not.toBe(coOrgTenantId.toHexString());
    expect(rows[0]._id.toHexString()).toBe(payload.assetId);
    expect(rows[0].kind).toBe("event_logo");
  });
});
