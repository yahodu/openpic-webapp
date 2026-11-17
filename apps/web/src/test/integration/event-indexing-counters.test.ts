import { createHmac } from "node:crypto";

import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as workerReportRouteModule from "@/app/api/v1/internal/worker/report/route";
import * as publicEventRouteModule from "@/app/api/v1/p/events/[slug]/route";
import { eventIndexingComplete } from "@/server/attendee/poll-policy";
import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";

import { galleryHandlers, seedAnonymousGallery } from "../helpers/attendee-gallery-flow";
import { APP_ORIGIN, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
  bodyOf,
  nextIp,
  requestFor,
  requireHandler,
  seedTenant,
  type RouteHandler,
  type SeededEvent,
} from "../helpers/selfie-flow";

/**
 * Integration / contract — the worker report is what advances the event's
 * image-processing counters, and both attendee readers answer one drained
 * predicate (OP-135 F5; contract §6.1, §6.4, §10.3.2; schema §15.1, §18.2;
 * ADR-0314 §Decision).
 *
 * **Why this exists.** `events.counters.processedImageCount` and
 * `failedImageCount` are read by six shipped surfaces — `/me`'s
 * `indexingComplete`/`pollIntervalMs`, the gallery summary, the public landing
 * page, `derivePipelineStatus` and the organizer images list — and before this
 * record **nothing advanced them**. The event creation route seeds all three to
 * `0`; only `imageCount`/`storageBytes` are ever written (upload registration
 * and the image delete). So `indexingComplete` was `false` for every event that
 * ever had an image, `pollIntervalMs` stayed `15_000`, and the gallery's "still
 * indexing" state never settled until the nightly `counter-reconcile` ran.
 *
 * **The decision these cases pin.** The fact is set where it is produced: after
 * the report has applied its items, the route recounts, per distinct event that
 * had at least one applied `event_image` item,
 *
 * ```
 * processedImageCount = countDocuments({ eventId, deletedAt: null, "processing.status": "done" })
 * failedImageCount    = countDocuments({ eventId, deletedAt: null, "processing.status": "failed" })
 * ```
 *
 * and `$set`s both onto `events.counters`. A **recount, never a blind `$inc`**:
 * `resetProcessingForReprocess` returns a row to `processing.status: "queued"`,
 * so an increment double-counts across a reprocess re-entry and `indexingComplete`
 * then reads `true` while an image is still queued — the attendee is told the
 * gallery is complete and photos are missing from it (P3). The recount is
 * idempotent, so a duplicate, retried or replayed report cannot move a counter
 * twice (P2), and it is the same rule the nightly repair runs.
 *
 * `imageCount`/`storageBytes` keep their existing owners (upload registration and
 * the image delete, both transactional); these cases pin that the report never
 * writes them (P1).
 *
 * Every case drives the route exactly as the worker does — imported handler, a
 * real `Request`, `Bearer` + `X-Signature` + `X-Timestamp` from `getConfig()` —
 * and reads the stored `events` document, so the assertion is on the fact a
 * consumer sees, never on a helper.
 */

/* ─────────────────────────────── constants ──────────────────────────────── */

const REPORT_PATH = "/api/v1/internal/worker/report";

/** The worker that holds the lease in every case that expects a write. */
const LEASEHOLDER = "w-counters";

/** §6.4's cadence while the event is still indexing. */
const INDEXING_MS = 15_000;

/** §6.4's cadence once nothing can change without the attendee acting. */
const SETTLED_MS = 60_000;

/** The instant the seeded rows were queued, so no case depends on the wall clock. */
const QUEUED_AT = new Date("2026-09-25T09:10:00.000Z");

/* ────────────────────────────── credential ──────────────────────────────── */

/** The epoch-seconds `X-Timestamp` value §0.3 signs (ADR-0028 §2). */
function timestampHeader(at: Date): string {
  return String(Math.floor(at.getTime() / 1000));
}

/** The `X-Signature` header for a raw body: `sha256=<lowercase hex>`. */
function signatureHeader(secret: string, raw: string): string {
  return `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
}

/** One item of §10.3.2's report body. */
interface ReportItem {
  readonly kind: "event_image" | "selfie";
  readonly id: string;
  readonly outcome: "done" | "failed" | "skipped";
  readonly faceCount?: number;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

/** The report body §10.3.2 documents: one lease per worker, so `workerId` is top-level. */
interface ReportBody {
  readonly workerId: string;
  readonly items: readonly ReportItem[];
}

/**
 * Build the `Request` the worker sends to the report route.
 *
 * The body is serialised **once** and signed over those exact bytes, because
 * §0.3 signs the raw body rather than the parsed object.
 *
 * @param body - The items and the reporting worker.
 * @returns The request to hand the route handler.
 */
function signedReport(body: ReportBody): Request {
  const raw = JSON.stringify(body);
  const secret = getConfig().internal.apiSecret;
  return new Request(new URL(REPORT_PATH, APP_ORIGIN), {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "x-signature": signatureHeader(secret, raw),
      "x-timestamp": timestampHeader(new Date()),
    },
    body: raw,
  });
}

/** The report handler, resolved once so a case names the route it drives. */
const reportHandler: RouteHandler = requireHandler(workerReportRouteModule, "POST", REPORT_PATH);

/** The public landing read whose `gallery.indexingComplete` must agree with `/me`. */
const publicEventHandler: RouteHandler = requireHandler(
  publicEventRouteModule,
  "GET",
  "/api/v1/p/events/:slug"
);

/* ──────────────────────────────── harness ───────────────────────────────── */

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op135-counters" });
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
});

/* ───────────────────────────────── world ────────────────────────────────── */

/** A published event and its owning tenant. */
interface World {
  readonly tenantKey: string;
  readonly event: SeededEvent;
}

/**
 * Seed a tenant with one published event, as an organizer's upload would exist.
 *
 * @param prefix - The case-local identity/slug prefix.
 * @returns The tenant key and the event.
 */
async function world(prefix: string): Promise<World> {
  const { tenantKey, events } = await seedTenant(app, prefix);
  const [event] = events;
  if (event === undefined) {
    throw new Error("expected one seeded event");
  }
  return { tenantKey, event };
}

/** The `processing.status` a seeded `event_images` row carries (§18.2). */
type RowStatus = "queued" | "processing" | "done" | "failed";

/** What one seeded `event_images` row states. */
interface ImageSeed {
  readonly sequence: number;
  readonly status: RowStatus;
  /** The worker holding the lease; a `queued` row has none. */
  readonly workerId?: string;
}

/**
 * Seed one `event_images` row in the state the pipeline leaves it (§18.2).
 *
 * The `_id` rides the insert document: the driver mints a random one otherwise
 * and every later `findOne({ _id })` would read `null`.
 *
 * @param tenantKey - The owning tenant (a string, `TENANT_SCOPED_COLLECTIONS`).
 * @param event - The event the image belongs to.
 * @param seed - The row's sequence, status and lease holder.
 * @returns The row's id.
 */
async function seedImage(
  tenantKey: string,
  event: SeededEvent,
  seed: ImageSeed
): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.eventImages).insertOne({
    _id,
    tenantId: tenantKey,
    eventId: event.id,
    assetId: new ObjectId(),
    uploadedByUserId: null,
    uploadBatchId: new ObjectId(),
    sequence: seed.sequence,
    deletedAt: null,
    processing: {
      status: seed.status,
      priority: "normal",
      attempts: seed.status === "queued" ? 0 : 1,
      maxAttempts: 5,
      leaseExpiresAt: seed.status === "queued" ? null : new Date("2026-09-25T09:20:00.000Z"),
      workerId: seed.workerId ?? null,
      queuedAt: QUEUED_AT,
      startedAt: seed.status === "queued" ? null : QUEUED_AT,
      finishedAt: null,
      durationMs: null,
      lastError: null,
      modelKeys: {},
    },
  });
  return _id;
}

/**
 * Play the lease handover a claim (or a reprocess re-entry) performs (§10.3.1).
 *
 * @param imageId - The row being handed to the worker.
 * @param workerId - The worker taking the lease.
 */
async function lease(imageId: ObjectId, workerId: string): Promise<void> {
  await app.db.collection(COLLECTIONS.eventImages).updateOne(
    { _id: imageId },
    {
      $set: {
        "processing.status": "processing",
        "processing.workerId": workerId,
        "processing.leaseExpiresAt": new Date("2026-09-25T09:20:00.000Z"),
        "processing.startedAt": QUEUED_AT,
      },
    }
  );
}

/** The `events.counters` fields these cases read (§15.1). */
interface StoredCounters {
  readonly imageCount?: number;
  readonly processedImageCount?: number;
  readonly failedImageCount?: number;
  readonly storageBytes?: number;
}

/**
 * Set the counters an event's uploads would have produced.
 *
 * Upload registration owns `imageCount`/`storageBytes` (§Decision item 4); the
 * processing counters start at the `0` the create route seeds.
 *
 * @param eventId - The event to update.
 * @param counts - The counters to store.
 */
async function setCounters(
  eventId: ObjectId,
  counts: {
    readonly imageCount: number;
    readonly processedImageCount: number;
    readonly failedImageCount: number;
  }
): Promise<void> {
  await app.db.collection(COLLECTIONS.events).updateOne(
    { _id: eventId },
    {
      $set: {
        "counters.imageCount": counts.imageCount,
        "counters.processedImageCount": counts.processedImageCount,
        "counters.failedImageCount": counts.failedImageCount,
      },
    }
  );
}

/**
 * Read the stored `events.counters` of one event.
 *
 * @param eventId - The event to read.
 * @returns The counters as stored.
 */
async function readCounters(eventId: ObjectId): Promise<StoredCounters> {
  const row = (await app.db
    .collection(COLLECTIONS.events)
    .findOne({ _id: eventId }, { projection: { counters: 1 } })) as {
    readonly counters?: StoredCounters;
  } | null;
  if (row?.counters === undefined) {
    throw new Error(`expected the event ${eventId.toHexString()} to carry counters`);
  }
  return row.counters;
}

/**
 * POST one report and answer its parsed body, failing loudly on a non-`200`.
 *
 * @param body - The items and the reporting worker.
 * @returns The parsed §10.3.2 answer.
 */
async function report(body: ReportBody): Promise<Record<string, unknown>> {
  const response = await reportHandler(signedReport(body));
  return bodyOf(response, 200, `POST ${REPORT_PATH}`);
}

/**
 * The `done` verdict §10.3.2 sends for one image.
 *
 * @param imageId - The image the verdict is about.
 * @returns The report item.
 */
function doneItem(imageId: ObjectId): ReportItem {
  return {
    kind: "event_image",
    id: imageId.toHexString(),
    outcome: "done",
    faceCount: 2,
  };
}

/* ───────────────── P1 — the fact is set where it is produced ────────────── */

describe("when a done report lands for one of the event's images (P1)", () => {
  it("recounts processedImageCount from source and leaves imageCount alone", async () => {
    const { tenantKey, event } = await world("op135-p1");
    const reported = await seedImage(tenantKey, event, {
      sequence: 1,
      status: "processing",
      workerId: LEASEHOLDER,
    });
    await seedImage(tenantKey, event, { sequence: 2, status: "queued" });
    // The state upload registration leaves: two images counted, none processed.
    await setCounters(event.id, { imageCount: 2, processedImageCount: 0, failedImageCount: 0 });

    const answer = await report({ workerId: LEASEHOLDER, items: [doneItem(reported)] });

    expect(answer.applied).toBe(1);
    const counters = await readCounters(event.id);
    expect(counters.processedImageCount).toBe(1);
    expect(counters.failedImageCount).toBe(0);
    // §Decision item 4: upload registration owns this one; the report never writes it.
    expect(counters.imageCount).toBe(2);
  });
});

/* ─────────────── P2 — a replayed report cannot move it twice ────────────── */

describe("when the same report is delivered twice (P2)", () => {
  it("refuses the replay as leaseLost and keeps processedImageCount at one", async () => {
    const { tenantKey, event } = await world("op135-p2");
    const reported = await seedImage(tenantKey, event, {
      sequence: 1,
      status: "processing",
      workerId: LEASEHOLDER,
    });
    await seedImage(tenantKey, event, { sequence: 2, status: "queued" });
    await setCounters(event.id, { imageCount: 2, processedImageCount: 0, failedImageCount: 0 });
    const body: ReportBody = { workerId: LEASEHOLDER, items: [doneItem(reported)] };

    const first = await report(body);
    const replay = await report(body);

    expect(first.applied).toBe(1);
    expect(replay.applied).toBe(0);
    expect(replay.leaseLost).toBe(1);
    // A recount is idempotent; a second increment would read 2 here.
    expect((await readCounters(event.id)).processedImageCount).toBe(1);
  });
});

/* ────────── P3 — a reprocess re-entry does not double count ─────────────── */

describe("when a done image is reprocessed and reported done again (P3)", () => {
  it("keeps processedImageCount at the live done rows, never two", async () => {
    const { tenantKey, event } = await world("op135-p3");
    const reported = await seedImage(tenantKey, event, {
      sequence: 1,
      status: "processing",
      workerId: LEASEHOLDER,
    });
    await seedImage(tenantKey, event, { sequence: 2, status: "queued" });
    await setCounters(event.id, { imageCount: 2, processedImageCount: 0, failedImageCount: 0 });
    await report({ workerId: LEASEHOLDER, items: [doneItem(reported)] });

    // What `resetProcessingForReprocess` stores (reprocess.ts:49-66): the row goes
    // back to `queued` with no lease, and the queue publisher re-leases it.
    await app.db.collection(COLLECTIONS.eventImages).updateOne(
      { _id: reported },
      {
        $set: {
          "processing.status": "queued",
          "processing.workerId": null,
          "processing.attempts": 0,
          "processing.startedAt": null,
          "processing.finishedAt": null,
        },
      }
    );
    await lease(reported, LEASEHOLDER);

    const again = await report({ workerId: LEASEHOLDER, items: [doneItem(reported)] });

    expect(again.applied).toBe(1);
    // One row is `done` for this event: a guarded `$inc` would read 2 here, and
    // `indexingComplete` would then claim the gallery is complete.
    expect((await readCounters(event.id)).processedImageCount).toBe(1);
  });
});

/* ───────────── P4 — a failed image drains the event ─────────────────────── */

describe("when the last outstanding image fails permanently (P4)", () => {
  it("advances failedImageCount and drains the event", async () => {
    const { tenantKey, event } = await world("op135-p4");
    const processed = await seedImage(tenantKey, event, {
      sequence: 1,
      status: "processing",
      workerId: LEASEHOLDER,
    });
    const failing = await seedImage(tenantKey, event, {
      sequence: 2,
      status: "processing",
      workerId: LEASEHOLDER,
    });
    await setCounters(event.id, { imageCount: 2, processedImageCount: 0, failedImageCount: 0 });
    await report({ workerId: LEASEHOLDER, items: [doneItem(processed)] });

    const answer = await report({
      workerId: LEASEHOLDER,
      items: [
        {
          kind: "event_image",
          id: failing.toHexString(),
          outcome: "failed",
          error: {
            code: "decode_failed",
            message: "the worker could not decode the image",
            retryable: false,
          },
        },
      ],
    });

    expect(answer.applied).toBe(1);
    const counters = await readCounters(event.id);
    expect(counters.failedImageCount).toBe(1);
    expect(counters.processedImageCount).toBe(1);
    // These two rows are the whole event, so the pipeline has drained it. Before
    // ADR-0314 §Decision item 5 this read `1 >= 2` → still indexing, forever.
    const indexing: {
      readonly imageCount: number;
      readonly processedImageCount: number;
      readonly failedImageCount: number;
    } = {
      imageCount: counters.imageCount ?? 0,
      processedImageCount: counters.processedImageCount ?? 0,
      failedImageCount: counters.failedImageCount ?? 0,
    };
    expect(eventIndexingComplete(indexing)).toBe(true);
  });
});

/* ───────────────── P5 — both attendee readers agree ────────────────────── */

describe("when both attendee readers read the same drained event (P5)", () => {
  it("answers one indexingComplete for /me and the public landing page", async () => {
    const seeded = await seedAnonymousGallery(app, "op135-p5", { matches: 0 });
    // Five images, four processed, one permanently failed: as complete as this
    // event will ever be.
    await setCounters(seeded.event.id, {
      imageCount: 5,
      processedImageCount: 4,
      failedImageCount: 1,
    });

    const me = await bodyOf(
      await galleryHandlers.participation(
        requestFor(`/api/v1/p/events/${seeded.event.slug}/me`, "GET", {
          cookie: seeded.cookie,
          ip: nextIp(),
          withoutIdempotencyKey: true,
        })
      ),
      200,
      "GET /api/v1/p/events/:slug/me"
    );
    const landing = await bodyOf(
      await publicEventHandler(
        requestFor(`/api/v1/p/events/${seeded.event.slug}`, "GET", {
          ip: nextIp(),
          withoutIdempotencyKey: true,
        })
      ),
      200,
      "GET /api/v1/p/events/:slug"
    );

    const gallery = landing.gallery as { readonly indexingComplete?: boolean } | undefined;
    expect(gallery?.indexingComplete).toBe(true);
    expect(me.indexingComplete).toBe(true);
    // The two attendee-facing readers cannot disagree about one event.
    expect(me.indexingComplete).toBe(gallery?.indexingComplete);
    // §6.4: a settled gallery polls at 60 s, not at the 15 s indexing cadence.
    expect(me.pollIntervalMs).toBe(SETTLED_MS);
    expect(me.pollIntervalMs).not.toBe(INDEXING_MS);
  });
});

/* ─────────── P6 — one recount per event per batch, not per item ─────────── */

describe("when one batch carries two done items of the same event (P6)", () => {
  it("recounts the event once and reports both rows as processed", async () => {
    const { tenantKey, event } = await world("op135-p6");
    const first = await seedImage(tenantKey, event, {
      sequence: 1,
      status: "processing",
      workerId: LEASEHOLDER,
    });
    const second = await seedImage(tenantKey, event, {
      sequence: 2,
      status: "processing",
      workerId: LEASEHOLDER,
    });
    await setCounters(event.id, { imageCount: 2, processedImageCount: 0, failedImageCount: 0 });

    const answer = await report({
      workerId: LEASEHOLDER,
      items: [doneItem(first), doneItem(second)],
    });

    expect(answer.applied).toBe(2);
    // A per-item `$set` of that item's own contribution would read 1 here, and
    // `indexingComplete` would then under-report a finished event.
    expect((await readCounters(event.id)).processedImageCount).toBe(2);
  });
});
