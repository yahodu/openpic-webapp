import { createHash, createHmac } from "node:crypto";

import { ObjectId, type Document } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

import { APP_ORIGIN, startTestApp, type TestApp } from "../helpers/authed-app";
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
  requireHandler,
  seedTenant,
  submitHappyPath,
  type RouteHandler,
  type SeededEvent,
} from "../helpers/selfie-flow";

/**
 * Integration / contract — the four internal M2M endpoints the Python worker
 * and the thumbnail processor call (OP-135; contract §0.3, §7.6, §10.3.2,
 * §10.3.3; schema §16.1, §18.2; ADR-0028, ADR-0808, ADR-0829).
 *
 * The worker is a **separate process**: it must never embed a notification
 * client, so every cross-boundary fact it produces is written through one of
 * these four routes. That makes the routes the whole write surface of the
 * pipeline, and this file the contract for it. Each route is driven exactly as
 * the worker drives it — imported handler, real `Request`, `Bearer` +
 * `X-Signature` + `X-Timestamp` headers built from `getConfig()` — so the pins
 * are on the observable HTTP answer and on the rows the answer leaves behind,
 * never on a helper.
 *
 * ## What is decided here (and why)
 *
 * - **`workerId` is a top-level field of the report body.** §10.3.2's sample
 *   shows `{items: [...]}` only, but §10.3.1's lease is held by *one worker*
 *   (`processing.workerId`), and the GREEN card's §3 says the report applies
 *   outcomes "with a lease check (workerId + processing status)". A per-item
 *   owner would let one request be two workers' work; the heartbeat already
 *   carries `workerId` at the top level, so the report mirrors it.
 * - **The worker claims before it reports.** These cases set
 *   `processing.workerId`/`leaseExpiresAt` themselves, exactly as §10.3.1's
 *   atomic claim does, because a report is only meaningful for an item a worker
 *   holds. A report for an item someone else holds is `leaseLost`, never a
 *   write (I2).
 * - **`objectKeyRef` is an opaque handle, not a key.** §10.3.2 sends a handle
 *   and the stored `derivatives.<variant>.objectKey` is a key, so the two are
 *   different strings by construction; the pin is that neither the request nor
 *   the answer carries the resolved key (I3).
 * - **A withdrawn profile's late result is discarded.** Consent withdrawal
 *   deletes the selfie rows and their matches (§6.2, ADR-0798), so a report
 *   that lands afterwards must not re-create the data it deleted. The I8 case
 *   builds the race window deliberately — the profile is already `withdrawn`
 *   while the claimed selfie row still exists — because that is the moment the
 *   guard has to hold.
 * - **The selfie arm is what makes a late result visible (§6.4).** A profile
 *   confirmed before its worker ran stays `processing`; only the report can
 *   write `status: ready`, `matchCount` and `lastMatchRunAt`. The watermark is
 *   the run's own `matchRunStartedAt`, never the report instant (§10.3.3).
 *
 * The four routes are `POST` only: the worker writes, it never reads back.
 */

/* ─────────────────────────────── constants ──────────────────────────────── */

const DOMAIN_EVENTS_PATH = "/api/v1/internal/domain-events";
const HEARTBEAT_PATH = "/api/v1/internal/worker/heartbeat";
const REPORT_PATH = "/api/v1/internal/worker/report";
const DERIVATIVE_PATH = "/api/v1/internal/media/derivative-complete";

/** The one event key the "new photos of you" arrival is recorded under (§7.6). */
const MATCHES_NEW_EVENT = "attendee.matches.new";

/** The batch event key §10.3.2's own example uses. */
const PIPELINE_INDEXED_EVENT = "pipeline.event.indexed";

/** An `eventKey` that is in no catalogue and never will be (§7.6 is closed). */
const UNKNOWN_EVENT_KEY = "pipeline.event.not_a_real_key";

/** The worker that holds the lease in the cases that expect a write. */
const LEASEHOLDER = "w-leaseholder";

/** The worker that does **not** hold the lease in I2. */
const OTHER_WORKER = "w-other";

/** The three counters a batch answer carries (§10.3.2). */
const BATCH_KEYS = ["accepted", "deduped", "rejected"];

/** The three counters a report answer carries (§10.3.2). */
const REPORT_KEYS = ["applied", "leaseLost", "rejected"];

/** The five keys the heartbeat's configuration channel carries (§10.3.2). */
const HEARTBEAT_KEYS = [
  "acknowledged",
  "activeSpaceKey",
  "leaseMinutes",
  "maxAttempts",
  "pauseRequested",
];

/** The selfie attempt budget a tenant with no gated plan gets (§14.1). */
const ATTEMPTS_ALLOWED = 3;

/** The instant the pipeline's incremental run started, before its query ran. */
const RUN_STARTED_AT = new Date("2026-09-25T09:18:00.000Z");

/* ────────────────────────────── credential ──────────────────────────────── */

/** The epoch-seconds `X-Timestamp` value §0.3 signs (§ADR-0028 §2). */
function timestampHeader(at: Date): string {
  return String(Math.floor(at.getTime() / 1000));
}

/** The `X-Signature` header for a raw body: `sha256=<lowercase hex>`. */
function signatureHeader(secret: string, raw: string): string {
  return `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
}

/** What a signed call may vary. */
interface SigningOptions {
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
function signedPost(path: string, body: unknown, options: SigningOptions = {}): Request {
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
interface InternalEndpoint {
  readonly name: string;
  readonly path: string;
  readonly handler: RouteHandler;
  /** A body the route would accept with a valid credential. */
  readonly body: Record<string, unknown>;
}

/** The four route handlers, resolved once so a case names the one it drives. */
const domainEventsHandler = requireHandler(domainEventsRouteModule, "POST", DOMAIN_EVENTS_PATH);
const heartbeatHandler = requireHandler(heartbeatRouteModule, "POST", HEARTBEAT_PATH);
const workerReportHandler = requireHandler(workerReportRouteModule, "POST", REPORT_PATH);
const derivativeCompleteHandler = requireHandler(
  derivativeCompleteRouteModule,
  "POST",
  DERIVATIVE_PATH
);

/** The heartbeat body exactly as §10.3.2 documents it. */
function documentedHeartbeatBody(): Record<string, unknown> {
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

const ENDPOINTS: readonly InternalEndpoint[] = [
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
const meHandler = requireHandler(meRouteModule, "GET", "/api/v1/p/events/:slug/me");

/* ──────────────────────────────── harness ───────────────────────────────── */

let app: TestApp;

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
function settingsCollection() {
  return app.db.collection<Document & { readonly _id: string }>("platformSettings");
}

/**
 * Seed the settings singleton and override the four values a worker is paced
 * by, then drop the read cache so the route sees them on its first read.
 *
 * @param overrides - The `face`/`pipeline` values this case needs.
 */
async function seedPacing(
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
interface World {
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
async function world(prefix: string): Promise<World> {
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
interface SeededAsset {
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
async function seedAsset(tenantKey: string, tag: string): Promise<SeededAsset> {
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
async function assetRow(assetId: ObjectId): Promise<Document | null> {
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
async function seedClaimedImage(
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
async function claimSelfie(selfieId: string, workerId: string): Promise<void> {
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
interface SelfieRow {
  readonly _id: ObjectId;
  readonly embedding?: unknown;
  readonly processing?: {
    readonly status?: string;
    readonly workerId?: string;
    readonly lastError?: { readonly code?: string } | null;
  };
}

/** The stored attendee profile, as these cases read it (§15.3). */
interface ProfileRow {
  readonly _id: ObjectId;
  readonly subject: Record<string, unknown>;
  readonly status: string;
  readonly matchCount: number;
  readonly lastMatchRunAt?: Date | null;
}

/** The `processing` half of a stored work item (§18.2). */
interface StoredProcessing {
  readonly status?: string;
  readonly workerId?: string;
  readonly durationMs?: number | null;
  readonly finishedAt?: Date | null;
  readonly lastError?: { readonly code?: string } | null;
}

/** A stored `event_images` row, as these cases read it. */
interface ImageRow {
  readonly _id: ObjectId;
  readonly processing?: StoredProcessing | null;
}

/** A stored outbox row, as these cases read it (§7.7). */
interface DomainEventRow {
  readonly _id: ObjectId;
  readonly eventKey: string;
  readonly dedupeKey?: string;
}

/**
 * The one stored attendee profile these cases expect.
 *
 * @returns The profile row.
 */
async function profileRow(): Promise<ProfileRow> {
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
async function selfieRow(selfieId: string): Promise<SelfieRow | null> {
  return await app.db.collection(COLLECTIONS.selfies).findOne({ _id: new ObjectId(selfieId) });
}

/**
 * The §6.4 participation poll, as the attendee's browser makes it.
 *
 * @param slug - The event's active access-link slug.
 * @param caller - The attendee credential.
 * @returns The parsed `/me` body.
 */
async function pollParticipation(
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
interface SelfieFixture {
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
async function submittedSelfie(prefix: string, tag: string): Promise<SelfieFixture> {
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
async function confirmedWithWorkerResult(fixture: SelfieFixture): Promise<SelfieFixture> {
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
function activationDeliveryKey(eventId: string, profileId: string, selfieId: string): string {
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
function incrementalDeliveryKey(activationKey: string, runId: string): string {
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
function domainEvent(
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

/* ────────────────────── I5: the shared refusal ladder ───────────────────── */

/**
 * §0.3's machine credential for every internal route.
 *
 * Four shapes are refused, and each one is a distinct hole: no credential, a
 * wrong bearer, a body signed with another secret, and the Vercel `CRON_SECRET`
 * bearer. The last one is the exception ADR-0028 §1 deliberately scopes to
 * `GET /api/v1/internal/cron/**` — "it cannot be replayed against
 * `/internal/domain-events` or `/internal/worker/*`" — so every one of these
 * four routes must refuse it.
 */
describe("when an internal endpoint is called without a valid machine credential", () => {
  it.each(ENDPOINTS)(
    "I5: $name refuses a request with no credential as internal_auth_failed",
    async (endpoint) => {
      const response = await endpoint.handler(
        new Request(new URL(endpoint.path, APP_ORIGIN), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(endpoint.body),
        })
      );

      expect(response.status).toBe(401);
      expect((await errorBody(response)).code).toBe("internal_auth_failed");
    }
  );

  it.each(ENDPOINTS)(
    "I5: $name refuses a wrong bearer as internal_auth_failed",
    async (endpoint) => {
      const response = await endpoint.handler(
        signedPost(endpoint.path, endpoint.body, {
          bearer: "not-the-internal-api-secret-000000000000",
        })
      );

      expect(response.status).toBe(401);
      expect((await errorBody(response)).code).toBe("internal_auth_failed");
    }
  );

  it.each(ENDPOINTS)(
    "I5: $name refuses a body signed with another secret as invalid_signature",
    async (endpoint) => {
      const response = await endpoint.handler(
        signedPost(endpoint.path, endpoint.body, {
          secret: "wrong-signing-secret-0000000000000000",
        })
      );

      expect(response.status).toBe(401);
      expect((await errorBody(response)).code).toBe("invalid_signature");
    }
  );

  it.each(ENDPOINTS)(
    "I5: $name refuses the CRON_SECRET bearer, so the cron exception cannot be replayed",
    async (endpoint) => {
      const cronSecret = getConfig().cron.secret;
      const response = await endpoint.handler(
        signedPost(endpoint.path, endpoint.body, {
          bearer: cronSecret,
          secret: cronSecret,
        })
      );

      expect(response.status).toBe(401);
      expect((await errorBody(response)).code).toBe("internal_auth_failed");
    }
  );
});

/* ─────────────── I1 + ADR-0808: the worker's domain-event batch ─────────── */

describe("when the worker flushes a batch of domain events", () => {
  it("I1: accepts the rest of the batch and rejects only the unknown event key", async () => {
    const seeded = await world("op135-de-batch");
    const eventId = seeded.event.id.toHexString();
    const response = await domainEventsHandler(
      signedPost(DOMAIN_EVENTS_PATH, {
        events: [
          domainEvent(PIPELINE_INDEXED_EVENT, seeded.tenantKey, seeded.event),
          domainEvent(PIPELINE_INDEXED_EVENT, seeded.tenantKey, seeded.event, {
            dedupeKey: `${PIPELINE_INDEXED_EVENT}:${eventId}`,
          }),
          domainEvent(UNKNOWN_EVENT_KEY, seeded.tenantKey, seeded.event),
        ],
      })
    );

    // §10.3.2: a bad key never fails the batch.
    expect(response.status).toBe(202);
    const body = await bodyOf(response, 202, "POST internal domain-events");
    expect(keysOf(body)).toEqual(BATCH_KEYS);
    expect(body.accepted).toBe(2);
    expect(body.deduped).toBe(0);
    expect(body.rejected).toEqual([
      { index: 2, eventKey: UNKNOWN_EVENT_KEY, reason: "unknown_event_key" },
    ]);

    const stored = (await app.db
      .collection(COLLECTIONS.domainEvents)
      .find({ tenantId: seeded.tenantKey })
      .sort({ _id: 1 })
      .toArray()) as unknown as DomainEventRow[];
    expect(stored).toHaveLength(2);
    expect(stored.map((row) => row.eventKey)).toEqual([
      PIPELINE_INDEXED_EVENT,
      PIPELINE_INDEXED_EVENT,
    ]);
  });

  it("counts a repeat of the same dedupeKey as deduped and keeps one row", async () => {
    const seeded = await world("op135-de-dedupe");
    const activation = activationDeliveryKey(
      seeded.event.id.toHexString(),
      new ObjectId().toHexString(),
      new ObjectId().toHexString()
    );
    const batch = {
      events: [
        domainEvent(MATCHES_NEW_EVENT, seeded.tenantKey, seeded.event, {
          dedupeKey: activation,
        }),
      ],
    };

    const first = await bodyOf(
      await domainEventsHandler(signedPost(DOMAIN_EVENTS_PATH, batch)),
      202,
      "POST internal domain-events (first)"
    );
    expect(first).toEqual({ accepted: 1, deduped: 0, rejected: [] });

    // The retried delivery is still an accepted *request*; the item is deduped.
    const second = await bodyOf(
      await domainEventsHandler(signedPost(DOMAIN_EVENTS_PATH, batch)),
      202,
      "POST internal domain-events (repeat)"
    );
    expect(second).toEqual({ accepted: 0, deduped: 1, rejected: [] });

    expect(await app.db.collection(COLLECTIONS.domainEvents).countDocuments({})).toBe(1);
  });

  it("dedupes the activation identity a confirmation has already published (ADR-0808 §3)", async () => {
    const fixture = await confirmedWithWorkerResult(
      await submittedSelfie("op135-de-confirm-first", "op135-de-confirm-first")
    );
    const rows = (await app.db
      .collection(COLLECTIONS.domainEvents)
      .find({ eventKey: MATCHES_NEW_EVENT })
      .sort({ _id: 1 })
      .toArray()) as unknown as DomainEventRow[];
    expect(rows).toHaveLength(1);
    const confirmed = rows[0];
    if (confirmed === undefined) {
      throw new Error("expected the confirmation to publish one attendee.matches.new row");
    }

    const response = await domainEventsHandler(
      signedPost(DOMAIN_EVENTS_PATH, {
        events: [
          domainEvent(MATCHES_NEW_EVENT, fixture.world.tenantKey, fixture.world.event, {
            payload: { eventId: fixture.world.event.id.toHexString(), count: 3 },
            dedupeKey: activationDeliveryKey(
              fixture.world.event.id.toHexString(),
              fixture.profileId,
              fixture.selfieId
            ),
          }),
        ],
      })
    );

    expect(response.status).toBe(202);
    const body = await bodyOf(response, 202, "POST internal domain-events (after confirm)");
    expect(body).toEqual({ accepted: 0, deduped: 1, rejected: [] });

    // One activation result, one delivery — and the survivor is the confirm's.
    const after = (await app.db
      .collection(COLLECTIONS.domainEvents)
      .find({ eventKey: MATCHES_NEW_EVENT })
      .sort({ _id: 1 })
      .toArray()) as unknown as DomainEventRow[];
    expect(after).toHaveLength(1);
    expect(after[0]?._id.toString()).toBe(confirmed._id.toString());
  });

  it("records a later arrival for an already-announced selfie as a second delivery", async () => {
    const fixture = await confirmedWithWorkerResult(
      await submittedSelfie("op135-de-arrival", "op135-de-arrival")
    );
    const eventId = fixture.world.event.id.toHexString();
    const activation = activationDeliveryKey(eventId, fixture.profileId, fixture.selfieId);

    const response = await domainEventsHandler(
      signedPost(DOMAIN_EVENTS_PATH, {
        events: [
          domainEvent(MATCHES_NEW_EVENT, fixture.world.tenantKey, fixture.world.event, {
            payload: { eventId, count: 2 },
            // The incremental run's own identity, never `selfieId` alone.
            dedupeKey: incrementalDeliveryKey(activation, "run-2"),
          }),
        ],
      })
    );

    expect(response.status).toBe(202);
    expect(await bodyOf(response, 202, "POST internal domain-events (arrival)")).toEqual({
      accepted: 1,
      deduped: 0,
      rejected: [],
    });

    const rows = (await app.db
      .collection(COLLECTIONS.domainEvents)
      .find({ eventKey: MATCHES_NEW_EVENT })
      .sort({ _id: 1 })
      .toArray()) as unknown as DomainEventRow[];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row._id.toString())).size).toBe(2);
    // The two deliveries are distinguished by their key, not by their subject.
    expect(rows.map((row) => row.dedupeKey)).toEqual([activation, `${activation}:run-2`]);
  });
});

/* ─────────────── I4: the heartbeat's configuration channel ──────────────── */

describe("when the worker sends a heartbeat", () => {
  it("I4: answers pauseRequested true and the configured pacing", async () => {
    await seedPacing({
      activeSpaceKey: "arcface_r100_512_v2",
      leaseMinutes: 7,
      maxAttempts: 3,
      pauseRequested: true,
    });

    const response = await heartbeatHandler(signedPost(HEARTBEAT_PATH, documentedHeartbeatBody()));

    expect(response.status).toBe(200);
    const body = await bodyOf(response, 200, "POST internal worker/heartbeat");
    expect(keysOf(body)).toEqual(HEARTBEAT_KEYS);
    expect(body).toEqual({
      acknowledged: true,
      activeSpaceKey: "arcface_r100_512_v2",
      leaseMinutes: 7,
      maxAttempts: 3,
      pauseRequested: true,
    });
  });

  it("answers pauseRequested false, with the documented defaults, when nothing is set", async () => {
    await seedPacing();

    const response = await heartbeatHandler(signedPost(HEARTBEAT_PATH, documentedHeartbeatBody()));

    expect(response.status).toBe(200);
    const body = await bodyOf(response, 200, "POST internal worker/heartbeat");
    expect(body).toEqual({
      acknowledged: true,
      activeSpaceKey: "arcface_r100_512",
      leaseMinutes: 10,
      maxAttempts: 5,
      pauseRequested: false,
    });
  });
});

/* ───────────── I2, I6, I8: applying the worker's report ─────────────────── */

describe("when the worker reports an event-image outcome", () => {
  it("marks the image done when the reporter holds the lease", async () => {
    const seeded = await world("op135-report-done");
    const asset = await seedAsset(seeded.tenantKey, "op135-report-done");
    const imageId = await seedClaimedImage(
      seeded.tenantKey,
      seeded.event,
      asset.assetId,
      LEASEHOLDER
    );

    const response = await workerReportHandler(
      signedPost(REPORT_PATH, {
        workerId: LEASEHOLDER,
        items: [
          {
            kind: "event_image",
            id: imageId.toHexString(),
            outcome: "done",
            faceCount: 3,
            durationMs: 3_400,
            modelKeys: {
              detection: "scrfd_10g_bnkps",
              recognition: "insightface-antelopev2-2026-03",
            },
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    const body = await bodyOf(response, 200, "POST internal worker/report");
    expect(keysOf(body)).toEqual(REPORT_KEYS);
    expect(body).toEqual({ applied: 1, leaseLost: 0, rejected: [] });

    const stored = (await app.db
      .collection(COLLECTIONS.eventImages)
      .findOne({ _id: imageId })) as unknown as ImageRow | null;
    expect(stored?.processing).toMatchObject({
      status: "done",
      durationMs: 3_400,
      lastError: null,
    });
    expect(stored?.processing?.finishedAt).toBeInstanceOf(Date);
  });

  it("I2: reports leaseLost and writes nothing when another worker holds the lease", async () => {
    const seeded = await world("op135-report-lease");
    const asset = await seedAsset(seeded.tenantKey, "op135-report-lease");
    const imageId = await seedClaimedImage(
      seeded.tenantKey,
      seeded.event,
      asset.assetId,
      OTHER_WORKER
    );
    const before = await app.db.collection(COLLECTIONS.eventImages).findOne({ _id: imageId });

    const response = await workerReportHandler(
      signedPost(REPORT_PATH, {
        workerId: LEASEHOLDER,
        items: [
          {
            kind: "event_image",
            id: imageId.toHexString(),
            outcome: "done",
            faceCount: 3,
            durationMs: 3_400,
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response, 200, "POST internal worker/report")).toEqual({
      applied: 0,
      leaseLost: 1,
      rejected: [],
    });

    // A lease-lost report never overwrites: the row is byte-identical.
    expect(await app.db.collection(COLLECTIONS.eventImages).findOne({ _id: imageId })).toEqual(
      before
    );
  });
});

describe("when the worker reports a selfie outcome", () => {
  it("makes a late result visible on the poll: ready, matchCount and lastMatchRunAt", async () => {
    const fixture = await submittedSelfie("op135-report-visible", "op135-report-visible");
    // Confirmed *before* the worker ran, so the confirmation could not publish a
    // result: the profile is left `processing` (§6.3/§6.4).
    await bodyOf(
      await confirmSelfie(fixture.world.event.slug, fixture.selfieId, {
        cookie: fixture.world.cookie,
        ip: fixture.world.ip,
      }),
      200,
      `POST confirm on ${fixture.world.event.slug}`
    );
    const beforeReport = await pollParticipation(fixture.world.event.slug, fixture.world);
    expect(beforeReport.status).toBe("processing");
    expect(beforeReport.matchCount).toBe(0);

    await claimSelfie(fixture.selfieId, LEASEHOLDER);
    const response = await workerReportHandler(
      signedPost(REPORT_PATH, {
        workerId: LEASEHOLDER,
        items: [
          {
            kind: "selfie",
            id: fixture.selfieId,
            outcome: "done",
            quality: { faceCount: 1, accepted: true },
            liveness: { passed: true, score: 0.91 },
            matchesCreated: 3,
            matchRunStartedAt: RUN_STARTED_AT.toISOString(),
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response, 200, "POST internal worker/report")).toEqual({
      applied: 1,
      leaseLost: 0,
      rejected: [],
    });

    const afterReport = await pollParticipation(fixture.world.event.slug, fixture.world);
    expect(afterReport.status).toBe("ready");
    expect(afterReport.matchCount).toBe(3);
    // The watermark is the run's own start instant, never the report instant.
    expect(afterReport.lastMatchRunAt).toBe(RUN_STARTED_AT.toISOString());
  });

  it("I6: a liveness-failed report leaves no embedding, fails the profile and spends the attempt", async () => {
    const fixture = await submittedSelfie("op135-report-liveness", "op135-report-liveness");
    await bodyOf(
      await confirmSelfie(fixture.world.event.slug, fixture.selfieId, {
        cookie: fixture.world.cookie,
        ip: fixture.world.ip,
      }),
      200,
      `POST confirm on ${fixture.world.event.slug}`
    );
    await claimSelfie(fixture.selfieId, LEASEHOLDER);

    const response = await workerReportHandler(
      signedPost(REPORT_PATH, {
        workerId: LEASEHOLDER,
        items: [
          {
            kind: "selfie",
            id: fixture.selfieId,
            outcome: "failed",
            error: { code: "liveness_failed", message: "screen replay detected", retryable: false },
            liveness: { passed: false, score: 0.11 },
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response, 200, "POST internal worker/report")).toEqual({
      applied: 1,
      leaseLost: 0,
      rejected: [],
    });

    // No biometric artefact is written for a selfie the platform rejected.
    const stored = await selfieRow(fixture.selfieId);
    expect(stored?.embedding).toBeUndefined();
    expect(stored?.processing).toMatchObject({
      status: "failed",
      lastError: { code: "liveness_failed" },
    });

    const profile = await profileRow();
    expect(profile.status).toBe("failed");

    // §6.4 renders the failure from the pipeline's code, and the failed attempt
    // is spent — an attempt is a stored selfie row (§6.3/§14.1, ADR-0792).
    const participation = await pollParticipation(fixture.world.event.slug, fixture.world);
    expect(participation.status).toBe("failed");
    expect(participation.statusDetail).toMatchObject({ code: "liveness_failed" });
    const selfie = participation.selfie as { attemptsUsed?: unknown; attemptsRemaining?: unknown };
    expect(selfie.attemptsUsed).toBe(1);
    expect(selfie.attemptsRemaining).toBe(ATTEMPTS_ALLOWED - 1);
  });

  it("I8: discards a report for a withdrawn profile: nothing written, nothing emitted", async () => {
    const fixture = await submittedSelfie("op135-report-withdrawn", "op135-report-withdrawn");
    await bodyOf(
      await confirmSelfie(fixture.world.event.slug, fixture.selfieId, {
        cookie: fixture.world.cookie,
        ip: fixture.world.ip,
      }),
      200,
      `POST confirm on ${fixture.world.event.slug}`
    );
    await claimSelfie(fixture.selfieId, LEASEHOLDER);

    // The race window: the withdrawal has committed its `withdrawn` status while
    // the claimed selfie row the worker is finishing still exists.
    const profileBefore = await profileRow();
    await app.db
      .collection(COLLECTIONS.attendeeEventProfiles)
      .updateOne({ _id: profileBefore._id }, { $set: { status: "withdrawn" } });
    const withdrawnProfile = await profileRow();
    const selfieBefore = await selfieRow(fixture.selfieId);
    const eventsBefore = await app.db.collection(COLLECTIONS.domainEvents).countDocuments({});

    const response = await workerReportHandler(
      signedPost(REPORT_PATH, {
        workerId: LEASEHOLDER,
        items: [
          {
            kind: "selfie",
            id: fixture.selfieId,
            outcome: "done",
            quality: { faceCount: 1, accepted: true },
            liveness: { passed: true, score: 0.94 },
            matchesCreated: 3,
            matchRunStartedAt: RUN_STARTED_AT.toISOString(),
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    const body = await bodyOf(response, 200, "POST internal worker/report");
    expect(body).toEqual({
      applied: 0,
      leaseLost: 0,
      rejected: [{ index: 0, id: fixture.selfieId, reason: "profile_withdrawn" }],
    });

    // The projection, the row and the outbox are all untouched.
    expect(await profileRow()).toEqual(withdrawnProfile);
    expect(await selfieRow(fixture.selfieId)).toEqual(selfieBefore);
    expect(await app.db.collection(COLLECTIONS.faceMatches).countDocuments({})).toBe(0);
    expect(await app.db.collection(COLLECTIONS.domainEvents).countDocuments({})).toBe(eventsBefore);

    // ...and the attendee's own surface still reports the withdrawal.
    const participation = await pollParticipation(fixture.world.event.slug, fixture.world);
    expect(participation.status).toBe("withdrawn");
    expect(participation.matchCount).toBe(0);
  });
});

/* ──────────── I3, I7: the thumbnail processor's derivative report ───────── */

describe("when the thumbnail processor reports a generated derivative", () => {
  it("I3: records the thumbnail and advances the asset to derivatives_ready", async () => {
    const seeded = await world("op135-deriv-thumb");
    const asset = await seedAsset(seeded.tenantKey, "op135-deriv-thumb");

    const response = await derivativeCompleteHandler(
      signedPost(DERIVATIVE_PATH, {
        assetId: asset.assetId.toHexString(),
        derivative: "thumbnail",
        // §10.3.2: an opaque handle, never the object key.
        objectKeyRef: "hnd_9f2c1d4b7a6e5f80",
        bytes: 48_120,
        width: 600,
        height: 900,
        format: "webp",
        processorVersion: 3,
        watermarkVersion: 2,
        contentHash: asset.contentHash,
      })
    );

    expect(response.status).toBe(200);

    const stored = await assetRow(asset.assetId);
    expect(stored?.status).toBe("derivatives_ready");
    expect(stored?.derivatives).toMatchObject({
      thumbnail: {
        bytes: 48_120,
        width: 600,
        height: 900,
        format: "webp",
        processorVersion: 3,
        watermarkVersion: 2,
      },
    });
    const thumbnail = (stored?.derivatives as { thumbnail?: Record<string, unknown> } | undefined)
      ?.thumbnail;
    expect(thumbnail?.generatedAt).toBeInstanceOf(Date);
    expect(typeof thumbnail?.objectKey).toBe("string");
    // The original descriptor is not clobbered by the derivative.
    expect((stored?.storage as { objectKey?: unknown } | undefined)?.objectKey).toBe(
      asset.storageObjectKey
    );
    // No raw object key crosses the wire back to the processor (§0.15).
    expect(await response.text()).not.toContain(String(thumbnail?.objectKey));
  });

  it("I7: records a preview derivative without disturbing the thumbnail", async () => {
    const seeded = await world("op135-deriv-preview");
    const asset = await seedAsset(seeded.tenantKey, "op135-deriv-preview");
    const thumbnail = {
      locationKey: "thumbnails",
      objectKey: `thumbnails/${asset.contentHash}.webp`,
      bytes: 48_120,
      width: 600,
      height: 900,
      format: "webp",
      processorVersion: 3,
      watermarkVersion: 2,
      generatedAt: new Date("2026-09-25T09:30:00.000Z"),
    };
    await app.db
      .collection(COLLECTIONS.mediaAssets)
      .updateOne(
        { _id: asset.assetId },
        { $set: { derivatives: { thumbnail }, status: "derivatives_ready" } }
      );

    const response = await derivativeCompleteHandler(
      signedPost(DERIVATIVE_PATH, {
        assetId: asset.assetId.toHexString(),
        derivative: "preview",
        objectKeyRef: "hnd_1a2b3c4d5e6f7081",
        bytes: 152_480,
        width: 1_200,
        height: 1_800,
        format: "webp",
        processorVersion: 3,
        watermarkVersion: 2,
        contentHash: asset.contentHash,
      })
    );

    expect(response.status).toBe(200);

    const stored = await assetRow(asset.assetId);
    expect(stored?.status).toBe("derivatives_ready");
    expect(stored?.derivatives).toMatchObject({
      thumbnail,
      preview: {
        bytes: 152_480,
        width: 1_200,
        height: 1_800,
        format: "webp",
        processorVersion: 3,
        watermarkVersion: 2,
      },
    });
  });

  it("refuses a body that carries a raw object key instead of the opaque reference", async () => {
    const seeded = await world("op135-deriv-rawkey");
    const asset = await seedAsset(seeded.tenantKey, "op135-deriv-rawkey");

    const response = await derivativeCompleteHandler(
      signedPost(DERIVATIVE_PATH, {
        assetId: asset.assetId.toHexString(),
        derivative: "thumbnail",
        // A raw key where the contract requires a handle (§10.3.2, §0.15).
        objectKey: `thumbnails/${asset.contentHash}.webp`,
        bytes: 48_120,
        width: 600,
        height: 900,
        format: "webp",
        processorVersion: 3,
        watermarkVersion: 2,
        contentHash: asset.contentHash,
      })
    );

    expect(response.status).toBe(422);
    expect((await errorBody(response)).code).toBe("validation_failed");

    const stored = await assetRow(asset.assetId);
    expect(stored?.status).toBe("stored");
    expect(stored?.derivatives).toEqual({});
  });
});
