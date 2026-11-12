import { ObjectId, type ClientSession, type Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { appError } from "@/server/http/errors";
import { tenantRepo } from "@/server/repos";
import { consumeEntitlement } from "@/server/services/entitlements";

import { allocateSequence } from "./sequence";

/**
 * Attaching one stored asset to one event (OP-124 I1/I4/I5, contract §5.3;
 * ADR-0721 D2).
 *
 * The write half of both registration paths — `complete` (bytes just uploaded)
 * and `uploads:link` (bytes already stored) — is identical: consume
 * `images.per_event`, mint the event's next `sequence`, insert the
 * `event_images` join row and advance the event's counters. Only the caller
 * knows whether `storage.bytes` also moves, so that consumption stays with it
 * and the caller passes the amount it must add to `counters.storageBytes`.
 *
 * Every call joins the caller's transaction, so the entitlement, the insert and
 * the two counters commit or abort together (ADR-0340).
 */

/** The `events` fields the attach path reads and writes. */
interface EventRow {
  readonly _id: ObjectId;
  readonly sequence: number;
  readonly counters: { readonly imageCount: number };
}

/** The `event_images` row the attach path returns. */
export interface AttachedImageRow {
  readonly _id: ObjectId;
  readonly assetId: ObjectId;
  readonly uploadedByUserId: ObjectId;
  readonly uploadBatchId: unknown;
  readonly sequence: number;
  readonly faceCount?: number;
  readonly visibility?: string;
  readonly processing?: { readonly status?: string; readonly attempts?: number };
  readonly createdAt: Date;
}

/** The inputs one attach needs. */
export interface AttachImageInput {
  readonly session: ClientSession;
  readonly db: Db;
  /** The **event's** tenant — never the caller's own workspace (ADR-0721 D3). */
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly assetId: ObjectId;
  readonly actorUserId: string;
  readonly uploadBatchId: ObjectId | string;
  /** Bytes the event's `counters.storageBytes` gains; `0` for a link-only attach. */
  readonly storageBytes: number;
  readonly now: Date;
}

/**
 * Consume one image slot and insert the event's join row for an asset.
 *
 * @param input - The transaction, the event, the asset and the actor.
 * @returns The inserted `event_images` row.
 * @throws {AppError} `plan_limit_exceeded` when `images.per_event` is spent,
 *   `internal_error` when the event row is gone or its sequence counter is
 *   corrupt.
 */
export async function attachImage(input: AttachImageInput): Promise<AttachedImageRow> {
  const { session, db, tenantKey, eventId, now } = input;
  const eventIdHex = eventId.toHexString();

  const event = (await tenantRepo(tenantKey, db)
    .collection(COLLECTIONS.events)
    .findOne({ _id: eventId }, { session })) as EventRow | null;
  if (event === null) {
    throw appError("not_found");
  }

  // `images.per_event` is event-scoped, so the event's own counter is the usage.
  await consumeEntitlement(
    session,
    tenantKey,
    "images.per_event",
    1,
    {
      counts: event.counters.imageCount,
      subjectRef: { kind: "event", id: eventIdHex },
      actorRef: { kind: "user", id: input.actorUserId },
    },
    { db }
  );

  const allocation = allocateSequence(event.sequence);
  const row: AttachedImageRow = {
    _id: new ObjectId(),
    assetId: input.assetId,
    uploadedByUserId: new ObjectId(input.actorUserId),
    uploadBatchId: input.uploadBatchId,
    sequence: allocation.sequence,
    processing: { status: "queued", attempts: 0 },
    faceCount: 0,
    visibility: "visible",
    createdAt: now,
  };

  await tenantRepo(tenantKey, db)
    .collection(COLLECTIONS.eventImages)
    .insertOne(
      {
        ...row,
        tenantId: tenantKey,
        eventId,
      },
      { session }
    );

  await tenantRepo(tenantKey, db)
    .collection(COLLECTIONS.events)
    .updateOne(
      { _id: eventId },
      {
        $set: { sequence: allocation.nextCounter, updatedAt: now },
        $inc: { "counters.imageCount": 1, "counters.storageBytes": input.storageBytes },
      },
      { session }
    );

  return row;
}
