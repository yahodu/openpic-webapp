/**
 * The shared harness of the four internal-worker endpoint specs (OP-135).
 *
 * The four M2M routes the Python worker and the thumbnail processor call are
 * **one** write surface, so their specs share one preamble: the endpoint
 * constants, the §0.3 credential builder, the four resolved route handlers, the
 * `app`/database lifecycle, and the `world`/seed row builders every case starts
 * from. That preamble used to open
 * `../integration/internal-worker-endpoints.test.ts`; ADR-0843 split that file
 * into four behaviour specs and moved the preamble here, byte for byte, so a
 * case still reads exactly as it read before (ADR-0830 §2).
 *
 * **The lifecycle hooks run at import time and therefore register per spec
 * file**, so each of the four specs gets its own `app`, its own database prefix
 * and its own teardown — the isolation the single file used to give for free.
 *
 * `driverFindOne` / `driverUpdateOne` are captured **once, at module
 * evaluation**, before any spec installs its `Collection.prototype.findOne` /
 * `updateOne` spy. The F4a, F-A and F-B pins compare what the spy captured
 * against the captured original; a per-test capture would read the spy and pass
 * vacuously (ADR-0834 §2, ADR-0839 §3), so the trio must stay module-level and
 * must stay in this module that every pinning spec imports.
 */

import { createHash, createHmac } from "node:crypto";

import { Collection, ObjectId, type Document } from "mongodb";
import { afterAll, beforeAll, beforeEach } from "vitest";

import * as domainEventsRouteModule from "@/app/api/v1/internal/domain-events/route";
import * as derivativeCompleteRouteModule from "@/app/api/v1/internal/media/derivative-complete/route";
import * as heartbeatRouteModule from "@/app/api/v1/internal/worker/heartbeat/route";
import * as workerReportRouteModule from "@/app/api/v1/internal/worker/report/route";
import * as meRouteModule from "@/app/api/v1/p/events/[slug]/me/route";
import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import {
  invalidatePlatformSettings,
  seedPlatformSettings,
} from "@/server/settings/platform-settings";

import { APP_ORIGIN, startTestApp, type TestApp } from "./authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "./db";
import {
  bodyOf,
  confirmSelfie,
  createAttendeeSession,
  finishSelfieWorker,
  grantConsent,
  nextIp,
  requestFor,
  requireHandler,
  seedTenant,
  submitHappyPath,
  type RouteHandler,
  type SeededEvent,
} from "./selfie-flow";

/* ─────────────────────────────── constants ──────────────────────────────── */

export const DOMAIN_EVENTS_PATH = "/api/v1/internal/domain-events";
export const HEARTBEAT_PATH = "/api/v1/internal/worker/heartbeat";
export const REPORT_PATH = "/api/v1/internal/worker/report";
export const DERIVATIVE_PATH = "/api/v1/internal/media/derivative-complete";

/** The one event key the "new photos of you" arrival is recorded under (§7.6). */
export const MATCHES_NEW_EVENT = "attendee.matches.new";

/** The batch event key §10.3.2's own example uses. */
export const PIPELINE_INDEXED_EVENT = "pipeline.event.indexed";

/** An `eventKey` that is in no catalogue and never will be (§7.6 is closed). */
export const UNKNOWN_EVENT_KEY = "pipeline.event.not_a_real_key";

/** The worker that holds the lease in the cases that expect a write. */
export const LEASEHOLDER = "w-leaseholder";

/** The worker that does **not** hold the lease in I2. */
export const OTHER_WORKER = "w-other";

/** The three counters a batch answer carries (§10.3.2). */
export const BATCH_KEYS = ["accepted", "deduped", "rejected"];

/** The three counters a report answer carries (§10.3.2). */
export const REPORT_KEYS = ["applied", "leaseLost", "rejected"];

/** The five keys the heartbeat's configuration channel carries (§10.3.2). */
export const HEARTBEAT_KEYS = [
  "acknowledged",
  "activeSpaceKey",
  "leaseMinutes",
  "maxAttempts",
  "pauseRequested",
];

/** The selfie attempt budget a tenant with no gated plan gets (§14.1). */
export const ATTEMPTS_ALLOWED = 3;

/** The instant the pipeline's incremental run started, before its query ran. */
export const RUN_STARTED_AT = new Date("2026-09-25T09:18:00.000Z");

/* ────────────────────────────── credential ──────────────────────────────── */

/** The epoch-seconds `X-Timestamp` value §0.3 signs (§ADR-0028 §2). */
export function timestampHeader(at: Date): string {
  return String(Math.floor(at.getTime() / 1000));
}

/** The `X-Signature` header for a raw body: `sha256=<lowercase hex>`. */
export function signatureHeader(secret: string, raw: string): string {
  return `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
}

/** What a signed call may vary. */
export interface SigningOptions {
  /** The bearer presented; defaults to the real `INTERNAL_API_SECRET`. */
  readonly bearer?: string;
  /** The secret the body is signed with; defaults to the real internal secret. */
  readonly secret?: string;
  /** The instant `X-Timestamp` claims; defaults to now. */
  readonly signedAt?: Date;
}

/**
 * Build the `Request` the worker sends: JSON body, bearer, signature, timestamp.
 *
 * The body is serialised **once** and the signature is computed over those exact
 * bytes, because §0.3 signs the raw body rather than the parsed object.
 *
 * @param path - The route path.
 * @param body - The JSON body to serialise and sign.
 * @param options - The credential overrides a refusal case varies.
 * @returns The request to hand the route handler.
 */
export function signedPost(path: string, body: unknown, options: SigningOptions = {}): Request {
  const raw = JSON.stringify(body);
  const secret = options.secret ?? getConfig().internal.apiSecret;
  return new Request(new URL(path, APP_ORIGIN), {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.bearer ?? secret}`,
      "content-type": "application/json",
      "x-signature": signatureHeader(secret, raw),
      "x-timestamp": timestampHeader(options.signedAt ?? new Date()),
    },
    body: raw,
  });
}

/* ─────────────────────────── the four endpoints ─────────────────────────── */

/** One internal route, as the shared refusal ladder drives it. */
export interface InternalEndpoint {
  readonly name: string;
  readonly path: string;
  readonly handler: RouteHandler;
  /** A body the route would accept with a valid credential. */
  readonly body: Record<string, unknown>;
}

/** The four route handlers, resolved once so a case names the one it drives. */
export const domainEventsHandler = requireHandler(
  domainEventsRouteModule,
  "POST",
  DOMAIN_EVENTS_PATH
);
export const heartbeatHandler = requireHandler(heartbeatRouteModule, "POST", HEARTBEAT_PATH);
export const workerReportHandler = requireHandler(workerReportRouteModule, "POST", REPORT_PATH);
export const derivativeCompleteHandler = requireHandler(
  derivativeCompleteRouteModule,
  "POST",
  DERIVATIVE_PATH
);

/** The heartbeat body exactly as §10.3.2 documents it. */
export function documentedHeartbeatBody(): Record<string, unknown> {
  return {
    workerId: LEASEHOLDER,
    version: "1.4.2",
    modelKeys: {
      detection: "scrfd_10g_bnkps",
      recognition: "insightface-antelopev2-2026-03",
    },
    inFlight: 8,
    capacity: 16,
    throughputPerMin: 220,
    queueDepthObserved: { selfie: 0, image: 4120 },
    gpu: { present: true, utilizationPercent: 78, memoryUsedMb: 4120 },
  };
}

export const ENDPOINTS: readonly InternalEndpoint[] = [
  {
    name: "domain-events",
    path: DOMAIN_EVENTS_PATH,
    handler: domainEventsHandler,
    body: { events: [] },
  },
  {
    name: "worker/heartbeat",
    path: HEARTBEAT_PATH,
    handler: heartbeatHandler,
    body: documentedHeartbeatBody(),
  },
  {
    name: "worker/report",
    path: REPORT_PATH,
    handler: workerReportHandler,
    body: { workerId: LEASEHOLDER, items: [] },
  },
  {
    name: "media/derivative-complete",
    path: DERIVATIVE_PATH,
    handler: derivativeCompleteHandler,
    body: { assetId: new ObjectId().toHexString(), derivative: "thumbnail" },
  },
];

/** The §6.4 participation poll the report's write becomes visible through. */
export const meHandler = requireHandler(meRouteModule, "GET", "/api/v1/p/events/:slug/me");

/* ──────────────────────────────── harness ───────────────────────────────── */

export let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op135-internal" });
  // `domain_events.dedupeKey` is a UNIQUE partial index: the dedupe pins below
  // are only meaningful against the real schema.
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
    COLLECTIONS.consents,
    COLLECTIONS.selfies,
  ]) {
    await app.db.collection(name).deleteMany({});
  }
  // The settings singleton is platform state with a process-level read cache;
  // dropping the row without dropping the cache would leak one case's pause
  // switch into the next (§9.10, `invalidatePlatformSettings`).
  await settingsCollection().deleteMany({});
  invalidatePlatformSettings();
});

/** The `platformSettings` singleton handle (a string `_id`, ADR-0007). */
export function settingsCollection() {
  return app.db.collection<Document & { readonly _id: string }>("platformSettings");
}

/**
 * Seed the settings singleton and override the four values a worker is paced
 * by, then drop the read cache so the route sees them on its first read.
 *
 * @param overrides - The `face`/`pipeline` values this case needs.
 */
export async function seedPacing(
  overrides: {
    readonly activeSpaceKey?: string;
    readonly leaseMinutes?: number;
    readonly maxAttempts?: number;
    readonly pauseRequested?: boolean;
  } = {}
): Promise<void> {
  await seedPlatformSettings({ db: app.db });
  await settingsCollection().updateOne(
    { _id: "singleton" },
    {
      $set: {
        ...(overrides.activeSpaceKey === undefined
          ? {}
          : { "face.activeSpaceKey": overrides.activeSpaceKey }),
        ...(overrides.leaseMinutes === undefined
          ? {}
          : { "pipeline.leaseMinutes": overrides.leaseMinutes }),
        ...(overrides.maxAttempts === undefined
          ? {}
          : { "pipeline.maxAttempts": overrides.maxAttempts }),
        ...(overrides.pauseRequested === undefined
          ? {}
          : { "pipeline.pauseRequested": overrides.pauseRequested }),
      },
    }
  );
  invalidatePlatformSettings();
}

/* ───────────────────────────────── world ────────────────────────────────── */

/** A published event, its tenant and an attendee credential on it. */
export interface World {
  readonly tenantKey: string;
  readonly event: SeededEvent;
  readonly cookie: string;
  readonly ip: string;
}

/**
 * Seed a tenant with one published event and mint an anonymous attendee.
 *
 * @param prefix - The suite-local prefix for the seeded identities.
 * @returns The world.
 */
export async function world(prefix: string): Promise<World> {
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

/** A media asset row seeded for the derivative cases (§16.1). */
export interface SeededAsset {
  readonly assetId: ObjectId;
  readonly contentHash: string;
  readonly storageObjectKey: string;
}

/**
 * Seed one `media_assets` row in the state an upload leaves it.
 *
 * @param tenantKey - The owning tenant (a string, `TENANT_SCOPED_COLLECTIONS`).
 * @param tag - A per-case tag, so no two cases share a content hash.
 * @returns The asset's id, hash and original object key.
 */
export async function seedAsset(tenantKey: string, tag: string): Promise<SeededAsset> {
  const contentHash = createHash("sha256").update(tag).digest("hex");
  const storageObjectKey = `images/${contentHash}.jpg`;
  const assetId = new ObjectId();
  await app.db.collection(COLLECTIONS.mediaAssets).insertOne({
    _id: assetId,
    tenantId: tenantKey,
    contentHash,
    kind: "event_image",
    storage: {
      locationKey: "originals",
      objectKey: storageObjectKey,
      bytes: 4_096,
      contentType: "image/jpeg",
      checksum: contentHash,
      storedAt: new Date("2026-09-25T09:00:00.000Z"),
    },
    derivatives: {},
    imageMeta: {},
    status: "stored",
    refCount: 1,
    createdAt: new Date("2026-09-25T09:00:00.000Z"),
  });
  return { assetId, contentHash, storageObjectKey };
}

/**
 * The stored asset row, for the derivative assertions.
 *
 * @param assetId - The asset to read.
 * @returns The raw document.
 */
export async function assetRow(assetId: ObjectId): Promise<Document | null> {
  return await app.db.collection(COLLECTIONS.mediaAssets).findOne({ _id: assetId });
}

/**
 * Seed one `event_images` row already claimed by a worker (§18.2).
 *
 * @param tenantKey - The owning tenant.
 * @param event - The event the image belongs to.
 * @param assetId - The image's media asset.
 * @param workerId - The worker that holds the lease.
 * @returns The image row's id.
 */
export async function seedClaimedImage(
  tenantKey: string,
  event: SeededEvent,
  assetId: ObjectId,
  workerId: string
): Promise<ObjectId> {
  const _id = new ObjectId();
  const startedAt = new Date("2026-09-25T09:10:00.000Z");
  await app.db.collection(COLLECTIONS.eventImages).insertOne({
    _id,
    tenantId: tenantKey,
    eventId: event.id,
    assetId,
    uploadedByUserId: null,
    uploadBatchId: new ObjectId(),
    sequence: 1,
    processing: {
      status: "processing",
      priority: "normal",
      attempts: 1,
      maxAttempts: 5,
      leaseExpiresAt: new Date("2026-09-25T09:20:00.000Z"),
      workerId,
      queuedAt: startedAt,
      startedAt,
      finishedAt: null,
      durationMs: null,
      lastError: null,
      modelKeys: {},
    },
  });
  return _id;
}

/**
 * Play §10.3.1's atomic claim for one selfie row.
 *
 * The worker claims **before** it reports, so every report case starts from a
 * row this worker holds; a case that wants the refusal seeds another owner
 * instead.
 *
 * @param selfieId - The selfie to claim.
 * @param workerId - The worker taking the lease.
 */
export async function claimSelfie(selfieId: string, workerId: string): Promise<void> {
  const startedAt = new Date("2026-09-25T09:10:00.000Z");
  await app.db.collection(COLLECTIONS.selfies).updateOne(
    { _id: new ObjectId(selfieId) },
    {
      $set: {
        "processing.status": "processing",
        "processing.workerId": workerId,
        "processing.leaseExpiresAt": new Date("2026-09-25T09:20:00.000Z"),
        "processing.startedAt": startedAt,
      },
      $inc: { "processing.attempts": 1 },
    }
  );
}

/** The stored selfie row, as these cases read it (§16.4/§18.2). */
export interface SelfieRow {
  readonly _id: ObjectId;
  readonly embedding?: unknown;
  readonly processing?: {
    readonly status?: string;
    readonly workerId?: string;
    readonly lastError?: { readonly code?: string } | null;
  };
}

/** The stored attendee profile, as these cases read it (§15.3). */
export interface ProfileRow {
  readonly _id: ObjectId;
  readonly subject: Record<string, unknown>;
  readonly status: string;
  readonly matchCount: number;
  readonly lastMatchRunAt?: Date | null;
}

/** The `processing` half of a stored work item (§18.2). */
export interface StoredProcessing {
  readonly status?: string;
  readonly workerId?: string;
  readonly durationMs?: number | null;
  readonly finishedAt?: Date | null;
  readonly lastError?: { readonly code?: string } | null;
}

/** A stored `event_images` row, as these cases read it. */
export interface ImageRow {
  readonly _id: ObjectId;
  readonly processing?: StoredProcessing | null;
}

/** A stored outbox row, as these cases read it (§7.7). */
export interface DomainEventRow {
  readonly _id: ObjectId;
  readonly eventKey: string;
  readonly dedupeKey?: string;
}

/**
 * The one stored attendee profile these cases expect.
 *
 * @returns The profile row.
 */
export async function profileRow(): Promise<ProfileRow> {
  const rows = (await app.db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .find({})
    .toArray()) as unknown as ProfileRow[];
  const [row] = rows;
  if (row === undefined) {
    throw new Error(`expected a stored attendee profile, received ${String(rows.length)}`);
  }
  return row;
}

/**
 * The stored selfie row.
 *
 * @param selfieId - The selfie to read.
 * @returns The row, or `null`.
 */
export async function selfieRow(selfieId: string): Promise<SelfieRow | null> {
  return await app.db.collection(COLLECTIONS.selfies).findOne({ _id: new ObjectId(selfieId) });
}

/**
 * The §6.4 participation poll, as the attendee's browser makes it.
 *
 * @param slug - The event's active access-link slug.
 * @param caller - The attendee credential.
 * @returns The parsed `/me` body.
 */
export async function pollParticipation(
  slug: string,
  caller: { readonly cookie: string; readonly ip: string }
): Promise<Record<string, unknown>> {
  const response = await meHandler(
    requestFor(`/api/v1/p/events/${slug}/me`, "GET", {
      cookie: caller.cookie,
      ip: caller.ip,
      withoutIdempotencyKey: true,
    })
  );
  return bodyOf(response, 200, `GET /p/events/${slug}/me`);
}

/** A submitted (and optionally confirmed) selfie, with its worker handles. */
export interface SelfieFixture {
  readonly world: World;
  readonly selfieId: string;
  readonly profileId: string;
}

/**
 * Submit one selfie and leave it unconfirmed (`processing`, no worker yet).
 *
 * @param prefix - The suite-local prefix.
 * @param tag - A per-case byte tag.
 * @returns The fixture.
 */
export async function submittedSelfie(prefix: string, tag: string): Promise<SelfieFixture> {
  const seeded = await world(prefix);
  const submitted = await submitHappyPath(seeded.event.slug, {
    cookie: seeded.cookie,
    ip: seeded.ip,
    tag,
  });
  return { world: seeded, selfieId: submitted.selfieId, profileId: submitted.profileId };
}

/**
 * Confirm a selfie the worker has already embedded, so the confirmation
 * publishes the activation delivery (§6.3, ADR-0806).
 *
 * @param fixture - The submitted selfie.
 * @returns The fixture, unchanged.
 */
export async function confirmedWithWorkerResult(fixture: SelfieFixture): Promise<SelfieFixture> {
  const profile = await profileRow();
  await finishSelfieWorker(app, {
    selfieId: fixture.selfieId,
    profileId: fixture.profileId,
    eventId: fixture.world.event.id.toHexString(),
    tenantKey: fixture.world.tenantKey,
    subject: profile.subject,
    matches: 3,
  });
  await bodyOf(
    await confirmSelfie(fixture.world.event.slug, fixture.selfieId, {
      cookie: fixture.world.cookie,
      ip: fixture.world.ip,
    }),
    200,
    `POST confirm on ${fixture.world.event.slug}`
  );
  return fixture;
}

/**
 * The one delivery identity of an activation result (§10.3.2; ADR-0808 §3).
 *
 * @param eventId - The event the matches belong to.
 * @param profileId - The announced profile.
 * @param selfieId - The selfie whose activation produced the rows.
 * @returns The `dedupeKey` both publishers must carry.
 */
export function activationDeliveryKey(
  eventId: string,
  profileId: string,
  selfieId: string
): string {
  return `${MATCHES_NEW_EVENT}:${eventId}:${profileId}:${selfieId}`;
}

/**
 * The identity a **later arrival** for an already-announced selfie carries.
 *
 * ADR-0808 §3 leaves the shape to the incremental path but fixes the one rule:
 * it must not equal the activation key, or the unique partial index swallows
 * the second delivery. This fixture therefore appends a run discriminator.
 *
 * @param activationKey - The selfie's activation identity.
 * @param runId - The incremental run that produced the new matches.
 * @returns A delivery identity distinct from the activation key.
 */
export function incrementalDeliveryKey(activationKey: string, runId: string): string {
  return `${activationKey}:${runId}`;
}

/**
 * One §10.3.2 domain-event object, with the contract's own field set.
 *
 * @param eventKey - The catalogue key.
 * @param tenantKey - The owning tenant.
 * @param event - The event the payload describes.
 * @param overrides - The per-case payload/dedupe overrides.
 * @returns The event object.
 */
export function domainEvent(
  eventKey: string,
  tenantKey: string,
  event: SeededEvent,
  overrides: {
    readonly payload?: Record<string, unknown>;
    readonly dedupeKey?: string;
  } = {}
): Record<string, unknown> {
  const payload: Record<string, unknown> = overrides.payload ?? {
    eventId: event.id.toHexString(),
    eventName: event.name,
    imageCount: 1,
  };
  return {
    eventKey,
    tenantId: tenantKey,
    actorRef: { kind: "system", id: "worker" },
    subjectRef: { kind: "event", id: event.id.toHexString() },
    payload,
    occurredAt: "2026-09-25T09:41:00.000Z",
    ...(overrides.dedupeKey === undefined ? {} : { dedupeKey: overrides.dedupeKey }),
  };
}

/** §10.3.2's batch size: the cap `/internal/domain-events` already applies. */
export const REPORT_BATCH_CAP = 100;

/** The forward tolerance the outbox applies to a worker-supplied instant. */
export const EVENT_INSTANT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The `rejected[]` reason an out-of-window instant carries. */
export const OUT_OF_WINDOW_REASON = "occurred_at_out_of_window";

/** The driver's `findOne`, captured before any spec installs a spy over it. */
export const driverFindOne = ((): typeof Collection.prototype.findOne => {
  const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "findOne");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("the driver's Collection#findOne is missing from the prototype");
  }
  return descriptor.value as typeof Collection.prototype.findOne;
})();

/** The driver's `updateOne`, captured the same way. */
export const driverUpdateOne = ((): typeof Collection.prototype.updateOne => {
  const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "updateOne");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("the driver's Collection#updateOne is missing from the prototype");
  }
  return descriptor.value as typeof Collection.prototype.updateOne;
})();

/**
 * The `_id` a driver filter addresses, or `undefined` when it names none.
 *
 * @param filter - The filter as the driver received it.
 * @returns The id as 24-hex, or `undefined`.
 */
export function filterTargetId(filter: unknown): string | undefined {
  if (filter === null || typeof filter !== "object" || !("_id" in filter)) {
    return undefined;
  }
  const value: unknown = (filter as { _id?: unknown })._id;
  return value instanceof ObjectId ? value.toHexString() : undefined;
}
