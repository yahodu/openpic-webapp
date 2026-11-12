import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import { AppError } from "@/server/http/app-error";
import type { Cursor } from "@/server/http/cursor";
import { buildEventImageListFilter } from "@/server/images/filters";

/**
 * U1 — the `?cursor=&limit=&status=&visibility=&uploadedBy=&batchId=&sort=`
 * filter builder (OP-127 U1, contract §4.4 and §0.8, schema §16.3).
 *
 * The list endpoint is the organizer's curation surface: it pages the event's
 * live images newest-first by `sequence` (the monotonic ordering key, not the
 * timestamps a batch upload shares) and narrows by the five filters the
 * contract names. Every query shape the route sends to MongoDB is decided here,
 * so the pins are the builder's returned clauses rather than a route invocation:
 * one pure function, one reviewable contract.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/images/filters` must export:
 *
 * ```ts
 * interface EventImageListParams {
 *   readonly eventId: ObjectId;
 *   readonly status?: "queued" | "processing" | "done" | "failed" | "skipped";
 *   readonly visibility?: "visible" | "hidden";
 *   readonly uploadedBy?: string;   // the caller's 24-hex user id
 *   readonly batchId?: string;      // 24-hex or a UUIDv4 (§5.2 accepts both)
 *   readonly sort?: "sequence_desc" | "sequence_asc";
 *   readonly cursor?: Cursor | null;
 * }
 * interface EventImageListQuery {
 *   readonly filter: Record<string, unknown>;
 *   readonly sort: Readonly<Record<string, 1 | -1>>;
 * }
 * function buildEventImageListFilter(params: EventImageListParams): EventImageListQuery;
 * ```
 *
 * ## Assumptions (ADR-0762)
 *
 * - A1 — a soft-deleted image (`deletedAt != null`) is never listed: the base
 *   filter always carries `deletedAt: null`, which also matches the `event_images`
 *   rows OP-124 writes without the field at all.
 * - A2 — the default order is `sequence` **descending** with `_id` as the
 *   tiebreaker, matching the `{eventId:1, sequence:-1}` index; `sort=sequence_asc`
 *   flips both.
 * - A3 — a `batchId` is matched in **both** stored shapes (`$in` of the
 *   `ObjectId` and the client's string), because §16.3 declares an `ObjectId`
 *   while a UUIDv4 is stored verbatim (`batchIdValue`, ADR-0721 A3).
 * - A4 — the cursor is the §0.8 compound key `{c: <sequence>, i: <id>}`; a
 *   cursor whose `c` is not a sequence number is a foreign cursor, i.e.
 *   `400 invalid_cursor`, never a silent full scan.
 */

const EVENT_ID = new ObjectId("6704aa000000000000000001");
const UPLOADER_ID = "6704aa0000000000000000a1";
const BATCH_ID = "6704aa0000000000000000b1";
const BATCH_UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const IMAGE_ID = "6704aa0000000000000000c1";

/** Run `fn` and return whatever it throws (`undefined` when it does not throw). */
function caught(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

/** The `uploadBatchId` `$in` candidates, so both stored shapes are inspectable. */
function batchCandidates(filter: Record<string, unknown>): readonly unknown[] {
  const clause = filter.uploadBatchId;
  if (typeof clause !== "object" || clause === null || !("$in" in clause)) {
    return [];
  }
  const inValues = (clause as { readonly $in?: unknown }).$in;
  return Array.isArray(inValues) ? inValues : [];
}

describe("buildEventImageListFilter — the base page", () => {
  it("U1: defaults to the event's live images newest-first by sequence, never by timestamp", () => {
    // Act
    const query = buildEventImageListFilter({ eventId: EVENT_ID });

    // Assert — the whole clause, not a subset: an extra filter would silently
    // hide rows from the organizer's grid.
    expect(query.filter).toEqual({ eventId: EVENT_ID, deletedAt: null });
    expect(query.sort).toEqual({ sequence: -1, _id: -1 });
  });

  it("U1: sort=sequence_asc flips both the sequence and the id tiebreaker", () => {
    // Act
    const query = buildEventImageListFilter({ eventId: EVENT_ID, sort: "sequence_asc" });

    // Assert
    expect(query.sort).toEqual({ sequence: 1, _id: 1 });
  });
});

describe("buildEventImageListFilter — the five documented filters", () => {
  it("U1: status narrows on processing.status, not on a top-level status field", () => {
    // Act
    const query = buildEventImageListFilter({ eventId: EVENT_ID, status: "failed" });

    // Assert — `processing.status` is the durable pipeline field (§18.2).
    expect(query.filter).toEqual({
      eventId: EVENT_ID,
      deletedAt: null,
      "processing.status": "failed",
    });
  });

  it("U1: visibility narrows to the organizer's hidden images without excluding them from the page", () => {
    // Act
    const query = buildEventImageListFilter({ eventId: EVENT_ID, visibility: "hidden" });

    // Assert — hiding is not deletion, so no `deletedAt` widening appears.
    expect(query.filter).toEqual({
      eventId: EVENT_ID,
      deletedAt: null,
      visibility: "hidden",
    });
  });

  it("U1: uploadedBy narrows on the attribution id as an ObjectId", () => {
    // Act
    const query = buildEventImageListFilter({ eventId: EVENT_ID, uploadedBy: UPLOADER_ID });

    // Assert — `event_images.uploadedByUserId` is stored as an `ObjectId` (§16.3).
    expect(query.filter).toEqual({
      eventId: EVENT_ID,
      deletedAt: null,
      uploadedByUserId: new ObjectId(UPLOADER_ID),
    });
  });

  it("U1: a 24-hex batchId matches both stored shapes", () => {
    // Act
    const query = buildEventImageListFilter({ eventId: EVENT_ID, batchId: BATCH_ID });
    const candidates = batchCandidates(query.filter);

    // Assert — the ObjectId (schema §16.3) and the string a UUID-shaped batch id
    // would leave behind (ADR-0721 A3) both select the row.
    expect(candidates).toHaveLength(2);
    expect(candidates).toContainEqual(new ObjectId(BATCH_ID));
    expect(candidates).toContainEqual(BATCH_ID);
  });

  it("U1: a UUIDv4 batchId is matched verbatim, with no undoable ObjectId cast", () => {
    // Act
    const query = buildEventImageListFilter({ eventId: EVENT_ID, batchId: BATCH_UUID });
    const candidates = batchCandidates(query.filter);

    // Assert — a UUID cannot be an ObjectId, so only the raw string may appear.
    expect(candidates).toContainEqual(BATCH_UUID);
    expect(candidates.every((value) => typeof value === "string")).toBe(true);
  });

  it("U1: all five filters compose into one clause", () => {
    // Act
    const query = buildEventImageListFilter({
      eventId: EVENT_ID,
      status: "done",
      visibility: "visible",
      uploadedBy: UPLOADER_ID,
      batchId: BATCH_ID,
      sort: "sequence_asc",
    });

    // Assert
    expect(query.filter).toEqual({
      eventId: EVENT_ID,
      deletedAt: null,
      "processing.status": "done",
      visibility: "visible",
      uploadedByUserId: new ObjectId(UPLOADER_ID),
      uploadBatchId: { $in: [new ObjectId(BATCH_ID), BATCH_ID] },
    });
    expect(query.sort).toEqual({ sequence: 1, _id: 1 });
  });
});

describe("buildEventImageListFilter — the compound cursor (§0.8)", () => {
  it("U1: a descending cursor continues strictly below the last sequence", () => {
    // Arrange
    const cursor: Cursor = { c: "4120", i: IMAGE_ID };

    // Act
    const query = buildEventImageListFilter({ eventId: EVENT_ID, cursor });

    // Assert — the sequence gap alone would skip a row that shares sequence
    // 4120, so the tiebreaker pair must be in the same `$or`.
    expect(query.filter).toEqual({
      eventId: EVENT_ID,
      deletedAt: null,
      $or: [{ sequence: { $lt: 4120 } }, { sequence: 4120, _id: { $lt: new ObjectId(IMAGE_ID) } }],
    });
    expect(query.sort).toEqual({ sequence: -1, _id: -1 });
  });

  it("U1: an ascending cursor continues strictly above the last sequence", () => {
    // Arrange
    const cursor: Cursor = { c: "4120", i: IMAGE_ID };

    // Act
    const query = buildEventImageListFilter({
      eventId: EVENT_ID,
      sort: "sequence_asc",
      cursor,
    });

    // Assert
    expect(query.filter.$or).toEqual([
      { sequence: { $gt: 4120 } },
      { sequence: 4120, _id: { $gt: new ObjectId(IMAGE_ID) } },
    ]);
  });

  it("U1: the cursor composes with a status filter instead of replacing it", () => {
    // Arrange
    const cursor: Cursor = { c: "4120", i: IMAGE_ID };

    // Act
    const query = buildEventImageListFilter({ eventId: EVENT_ID, status: "failed", cursor });

    // Assert
    expect(query.filter).toEqual({
      eventId: EVENT_ID,
      deletedAt: null,
      "processing.status": "failed",
      $or: [{ sequence: { $lt: 4120 } }, { sequence: 4120, _id: { $lt: new ObjectId(IMAGE_ID) } }],
    });
  });

  it.each([
    ["a page token instead of a sequence", "page-2"],
    ["a decimal that is not an integer", "4120.5"],
    ["an empty sort value", ""],
  ])("U1: a foreign cursor (%s) is a 400 invalid_cursor", (_label, sortValue) => {
    // Arrange
    const cursor: Cursor = { c: sortValue, i: IMAGE_ID };

    // Act
    const error = caught(() => buildEventImageListFilter({ eventId: EVENT_ID, cursor }));

    // Assert — never a silent full scan (§0.8).
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "invalid_cursor", status: 400 });
  });
});
