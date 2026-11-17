import { createHash } from "node:crypto";

import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as tenantBrandingUpload } from "@/app/api/v1/tenants/[tenantId]/assets/branding/route";
import { COLLECTIONS } from "@/server/db/collections";
import {
  createLogger,
  getLogger,
  memoryTransport,
  setLogger,
  type LogEntry,
  type MemoryTransport,
} from "@/server/logging";
import { createMediaSigner } from "@/server/media/signer";

import { makeEnv } from "../factories/env";
import { APP_ORIGIN, makeIdentity, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";

/**
 * OP-113 round-1 follow-up (ADR-0585) — **a signed media URL never reaches a
 * log**, pinned at the composition boundary that mints one today.
 *
 * ADR-0582/ADR-0583 record "never log full signed URLs; log counts of URLs
 * signed at debug" as a required property of the media delivery surface. The
 * pure signer has no logging seam of its own, so the property can only be
 * broken where signing and logging meet: a caller that signs a URL and then
 * hands it (in the message, or under any field — `url`, `signedUrl`, `path`,
 * `sig`, `exp`, a nested context object) to `requestLogger` / `getLogger`.
 *
 * `POST /api/v1/tenants/{tenantId}/assets/branding` is that caller: it mints a
 * `/t/<contentHash>.<ext>?exp=&sig=` URL through OP-113's `createMediaSigner`
 * and holds a request-scoped logger. This spec installs a memory transport
 * through the process-logger seam, drives the real route handler, and asserts
 * that **no emitted entry at any level** carries the signed URL, its `sig`
 * value or its data-plane path.
 *
 * The capture is proven live (T2 captures the refusal line this route does
 * emit) and proven armed at `debug` (T3), so T1 cannot pass vacuously.
 */

const TENANTS_BASE = "/api/v1/tenants";

/** The `makeEnv` default signing secret — the route reads the same validated env. */
const SIGNING_SECRET = makeEnv().MEDIA_SIGNING_SECRET_CURRENT ?? "";

/** A real 1×1 transparent PNG. */
const ONE_PX_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The 1×1 PNG bytes, the happy-path upload. */
const PNG_BYTES = Uint8Array.from(Buffer.from(ONE_PX_PNG_BASE64, "base64"));

/** A Windows executable (`MZ…`) — refused with `415 unsupported_media_type`. */
const EXE_BYTES = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op113-signing-logs" });
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  await app.db.collection(COLLECTIONS.mediaAssets).deleteMany({});
});

/**
 * Install a `debug`-floored memory logger as the process logger.
 *
 * @returns The memory sink every entry the port emits lands in.
 */
function captureLogs(): MemoryTransport {
  const sink = memoryTransport();
  setLogger(
    createLogger({
      level: "debug",
      transports: [sink],
      service: "openpic-web",
      env: "test",
      version: "test-sha",
    })
  );
  return sink;
}

/** The lowercase hex SHA-256 of the uploaded bytes (schema §16.1). */
function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Insert a tenant (schema §13.3) and return its id. */
async function insertTenant(fields: { slug: string; ownerUserId: ObjectId }): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug: fields.slug,
    name: "OP113 Signing Studio",
    status: "active",
    ownerUserId: fields.ownerUserId,
    billingContactUserId: fields.ownerUserId,
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

/** Seed a workspace owned by `userId`, making it that user's primary tenant. */
async function seedWorkspace(userId: ObjectId): Promise<ObjectId> {
  const tenantId = await insertTenant({ slug: "op113-signing", ownerUserId: userId });
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId,
    userId,
    role: "owner",
    status: "active",
    joinedAt: new Date(),
  });
  await app.db
    .collection(COLLECTIONS.userProfiles)
    .updateOne({ userId }, { $set: { primaryTenantId: tenantId, updatedAt: new Date() } });
  return tenantId;
}

/** A `multipart/form-data` branding upload request carrying the session cookie. */
function uploadRequest(
  cookie: string,
  tenantId: string,
  file: { name: string; type: string; bytes: Uint8Array<ArrayBuffer> }
): Request {
  const form = new FormData();
  form.append("file", new File([file.bytes], file.name, { type: file.type }));
  form.append("kind", "event_logo");
  return new Request(new URL(`${TENANTS_BASE}/${tenantId}/assets/branding`, APP_ORIGIN), {
    method: "POST",
    headers: { cookie },
    body: form,
  });
}

/** Every string any entry carries, flattened, so no field can hide a leak. */
function entryStrings(entries: readonly LogEntry[]): string[] {
  return entries.map((entry) => JSON.stringify(entry));
}

describe("a signed media URL never reaches a log (OP-113 follow-up, ADR-0585)", () => {
  it("a successful branding upload signs a URL and emits no entry carrying it", async () => {
    // Arrange — a live capture, floored at debug so a debug leak cannot hide.
    const sink = captureLogs();
    const owner = await app.signIn(makeIdentity("op113-logs-owner"));
    const tenantId = await seedWorkspace(owner.userId);

    // Act — the real route handler mints and returns the signed URL.
    const response = await tenantBrandingUpload(
      uploadRequest(owner.cookie, tenantId.toHexString(), {
        name: "logo.png",
        type: "image/png",
        bytes: PNG_BYTES,
      })
    );

    // Assert — the happy path really did sign (so the pin is not vacuous) …
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { url: string };
    const signedUrl = payload.url;
    const parsed = new URL(signedUrl);
    const sig = parsed.searchParams.get("sig");
    const contentHash = sha256Hex(PNG_BYTES);
    expect(parsed.pathname).toBe(`/t/${contentHash}.png`);
    expect(sig).not.toBeNull();
    expect(createMediaSigner({ currentSecret: SIGNING_SECRET }).verify(signedUrl)).toBe(true);

    // … and that no entry, at any level and under any field, carries the URL,
    // its signature or its data-plane path.
    const all = entryStrings(sink.entries);
    expect(all.filter((entry) => entry.includes(signedUrl))).toEqual([]);
    expect(all.filter((entry) => entry.includes(sig ?? "<missing-sig>"))).toEqual([]);
    expect(all.filter((entry) => entry.includes(`/t/${contentHash}.png`))).toEqual([]);
    expect(all.filter((entry) => /[?&]sig=/.test(entry))).toEqual([]);
  });

  it("captures the refusal warnings the branding route does emit", async () => {
    // Arrange — the same route, the same sink, a file the route refuses.
    const sink = captureLogs();
    const owner = await app.signIn(makeIdentity("op113-logs-owner"));
    const tenantId = await seedWorkspace(owner.userId);

    // Act
    const response = await tenantBrandingUpload(
      uploadRequest(owner.cookie, tenantId.toHexString(), {
        name: "payload.png",
        type: "image/png",
        bytes: EXE_BYTES,
      })
    );

    // Assert — 415, and the warning reached the sink, proving the capture is
    // live for this route and T1 is not passing because nothing is observed.
    expect(response.status).toBe(415);
    const rejected = sink.entries.filter((entry) => entry.event === "upload.rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ level: "warn", reason: "unsupported_media_type" });
  });

  it("captures debug-level entries, so a debug leak cannot hide", () => {
    // Arrange — the same installation the leak pins rely on.
    const sink = captureLogs();

    // Act — one debug line through the port.
    getLogger().debug("debug capture probe", { event: "test.debug_probe" });

    // Assert — a future "log counts at debug" implementation that slipped the
    // URL into a debug field would land in the same sink.
    expect(sink.entries.map((entry) => entry.event)).toContain("test.debug_probe");
  });
});
