/**
 * Integration / contract — the bounds a worker report may not exceed (OP-135).
 *
 * Three findings of the review of the OP-135 GREEN live here, each stated as the
 * **observable** a caller sees rather than as the code path that produces it: F3,
 * the §10.3.2 batch cap of 100 items, refused by body validation before the first
 * read; F4, the lease decided at **write** time, so two reports for one leased item
 * cannot both apply and the loser cannot overwrite the winner; and F6, the
 * one-sided 24 h event-instant window, refused in the item's own `rejected[]` slot
 * while the rest of the batch commits.
 *
 * The file is one of the four the OP-135 spec was split into (ADR-0843): the
 * harness it imports holds the preamble, the seeds, the credential builder and the
 * module-level `Collection.prototype` capture the lease pin compares against. The
 * case text, titles, assertions and fixtures are `internal-worker-endpoints.test.ts`'s,
 * unchanged; the reasoning docblock for F2/F3/F4/F6 opens F2 in
 * `internal-worker-derivative.test.ts`.
 */

import { Collection, ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { getPlatformSettings } from "@/server/settings/platform-settings";

import {
  DOMAIN_EVENTS_PATH,
  REPORT_PATH,
  PIPELINE_INDEXED_EVENT,
  LEASEHOLDER,
  REPORT_BATCH_CAP,
  EVENT_INSTANT_WINDOW_MS,
  OUT_OF_WINDOW_REASON,
  signedPost,
  domainEventsHandler,
  workerReportHandler,
  app,
  world,
  seedAsset,
  seedClaimedImage,
  domainEvent,
  driverFindOne,
  filterTargetId,
  type ImageRow,
} from "../helpers/internal-worker-harness.js";
import { bodyOf, errorBody } from "../helpers/selfie-flow";

/* ───────── F3: the report batch is capped, before the first read ────────── */

describe("when a report carries more items than the worker's batch size", () => {
  it("F3: refuses a report one item over the cap before any write", async () => {
    const seeded = await world("op135-f3-over");
    const asset = await seedAsset(seeded.tenantKey, "op135-f3-over");
    const imageId = await seedClaimedImage(
      seeded.tenantKey,
      seeded.event,
      asset.assetId,
      LEASEHOLDER
    );
    const before = await app.db.collection(COLLECTIONS.eventImages).findOne({ _id: imageId });
    const item = {
      kind: "event_image",
      id: imageId.toHexString(),
      outcome: "done",
      faceCount: 3,
      durationMs: 3_400,
    };

    const response = await workerReportHandler(
      signedPost(REPORT_PATH, {
        workerId: LEASEHOLDER,
        items: Array.from({ length: REPORT_BATCH_CAP + 1 }, () => ({ ...item })),
      })
    );

    // §10.3.2's cap is a body rule, so the refusal is the pipeline's 422 — and
    // it happens before the loop reads anything.
    expect(response.status).toBe(422);
    expect((await errorBody(response)).code).toBe("validation_failed");
    expect(await app.db.collection(COLLECTIONS.eventImages).findOne({ _id: imageId })).toEqual(
      before
    );
  });

  it("F3: accepts a report of exactly the cap and applies every item", async () => {
    const seeded = await world("op135-f3-at-cap");
    const items = await Promise.all(
      Array.from({ length: REPORT_BATCH_CAP }, async () => {
        // One leased row per item: `event_images` is unique on (eventId,
        // assetId), so every row needs its own asset id.
        const rowId = await seedClaimedImage(
          seeded.tenantKey,
          seeded.event,
          new ObjectId(),
          LEASEHOLDER
        );
        return {
          kind: "event_image",
          id: rowId.toHexString(),
          outcome: "done",
          faceCount: 1,
          durationMs: 1_200,
        };
      })
    );

    const response = await workerReportHandler(
      signedPost(REPORT_PATH, { workerId: LEASEHOLDER, items })
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response, 200, "POST internal worker/report at the cap")).toEqual({
      applied: REPORT_BATCH_CAP,
      leaseLost: 0,
      rejected: [],
    });
    expect(
      await app.db
        .collection(COLLECTIONS.eventImages)
        .countDocuments({ "processing.status": "done" })
    ).toBe(REPORT_BATCH_CAP);
  });
});

/* ──────────── F4: the lease decides at write time, not at read ──────────── */

describe("when two reports for one leased item both read the lease", () => {
  it("F4: applies exactly one and never lets the loser overwrite the winner", async () => {
    const seeded = await world("op135-f4-lease-race");
    const asset = await seedAsset(seeded.tenantKey, "op135-f4-lease-race");
    const imageId = await seedClaimedImage(
      seeded.tenantKey,
      seeded.event,
      asset.assetId,
      LEASEHOLDER
    );
    const parkedItem = {
      kind: "event_image",
      id: imageId.toHexString(),
      outcome: "done",
      faceCount: 3,
      durationMs: 3_400,
    };
    const competingItem = {
      kind: "event_image",
      id: imageId.toHexString(),
      outcome: "failed",
      faceCount: 0,
      durationMs: 9_900,
      error: { code: "face_detection_failed", message: "no face found", retryable: false },
    };

    // The window: this request's own lease read is held open, the competing
    // report reads and commits in the meantime, and only then does the held
    // read resolve with the row as it was **before** that commit. Any write
    // that repeats the read's verdict instead of re-checking it at write time
    // now lands on top of a lease it no longer holds.
    let competingAnswer: Record<string, unknown> | undefined;
    let parked = false;
    const findOneSpy = vi.spyOn(Collection.prototype, "findOne").mockImplementation(function (
      this: Collection,
      ...args: Parameters<typeof driverFindOne>
    ) {
      if (parked || this.collectionName !== COLLECTIONS.eventImages) {
        return driverFindOne.call(this, ...args);
      }
      if (filterTargetId(args[0]) !== imageId.toHexString()) {
        return driverFindOne.call(this, ...args);
      }
      parked = true;
      return (async () => {
        const snapshot = await driverFindOne.call(this, ...args);
        competingAnswer = await workerReportHandler(
          signedPost(REPORT_PATH, { workerId: LEASEHOLDER, items: [competingItem] })
        ).then((response) => bodyOf(response, 200, "POST internal worker/report (competing)"));
        return snapshot;
      })();
    } as never);

    let parkedAnswer: Record<string, unknown> | undefined;
    try {
      parkedAnswer = await workerReportHandler(
        signedPost(REPORT_PATH, { workerId: LEASEHOLDER, items: [parkedItem] })
      ).then((response) => bodyOf(response, 200, "POST internal worker/report (parked)"));
    } finally {
      findOneSpy.mockRestore();
    }

    if (competingAnswer === undefined) {
      throw new Error("the competing report never ran inside the held lease read");
    }

    // One winner, one loser — the same worker may not apply a lease twice.
    expect([parkedAnswer, competingAnswer]).toEqual([
      { applied: 0, leaseLost: 1, rejected: [] },
      { applied: 1, leaseLost: 0, rejected: [] },
    ]);

    // The loser's verdict is not the stored one: the winner's failure stands.
    const stored = (await app.db
      .collection(COLLECTIONS.eventImages)
      .findOne({ _id: imageId })) as unknown as ImageRow | null;
    expect(stored?.processing).toMatchObject({
      status: "failed",
      durationMs: 9_900,
      lastError: { code: "face_detection_failed" },
    });
  });
});

/* ──────────── F6: the worker's instant is bounded, the TTL follows ──────── */

/** The outbox row's two instants, as these cases read them (§18.3). */
interface DomainEventInstantRow {
  readonly occurredAt?: Date;
  readonly expireAt?: Date;
}

describe("when a worker sends an event instant outside the outbox window", () => {
  it("F6: rejects that item only and commits the rest of the batch", async () => {
    const seeded = await world("op135-f6-skew");
    const insideAt = new Date(Date.now() - 60 * 60 * 1000);
    const aheadAt = new Date(Date.now() + EVENT_INSTANT_WINDOW_MS + 60 * 60 * 1000);

    const response = await domainEventsHandler(
      signedPost(DOMAIN_EVENTS_PATH, {
        events: [
          {
            ...domainEvent(PIPELINE_INDEXED_EVENT, seeded.tenantKey, seeded.event),
            occurredAt: insideAt.toISOString(),
          },
          {
            ...domainEvent(PIPELINE_INDEXED_EVENT, seeded.tenantKey, seeded.event),
            occurredAt: aheadAt.toISOString(),
          },
        ],
      })
    );

    // A bad instant refuses its own item, exactly as a bad key does (§10.3.2).
    expect(response.status).toBe(202);
    expect(
      await bodyOf(response, 202, "POST internal domain-events (instant ahead of the window)")
    ).toEqual({
      accepted: 1,
      deduped: 0,
      rejected: [{ index: 1, eventKey: PIPELINE_INDEXED_EVENT, reason: OUT_OF_WINDOW_REASON }],
    });

    // The refused item left no row; the accepted one did.
    expect(
      await app.db
        .collection(COLLECTIONS.domainEvents)
        .countDocuments({ tenantId: seeded.tenantKey })
    ).toBe(1);
  });

  it("F6: stamps occurredAt and expireAt from the worker's instant inside the window", async () => {
    const seeded = await world("op135-f6-instant");
    const occurredAt = new Date(Date.now() - 5 * 60 * 1000);

    const response = await domainEventsHandler(
      signedPost(DOMAIN_EVENTS_PATH, {
        events: [
          {
            ...domainEvent(PIPELINE_INDEXED_EVENT, seeded.tenantKey, seeded.event),
            occurredAt: occurredAt.toISOString(),
          },
        ],
      })
    );

    expect(response.status).toBe(202);
    expect(
      await bodyOf(response, 202, "POST internal domain-events (instant inside the window)")
    ).toEqual({ accepted: 1, deduped: 0, rejected: [] });

    const stored = (await app.db
      .collection(COLLECTIONS.domainEvents)
      .findOne({ tenantId: seeded.tenantKey })) as unknown as DomainEventInstantRow | null;
    const settings = await getPlatformSettings({ db: app.db });
    const retentionMs = settings.retention.domainEventDays * 24 * 60 * 60 * 1000;

    // §10.3.2: the worker's own instant is the event's `occurredAt` — never the
    // server's — and the outbox TTL is derived from it.
    expect(stored?.occurredAt).toEqual(occurredAt);
    expect(stored?.expireAt).toEqual(new Date(occurredAt.getTime() + retentionMs));
  });
});
