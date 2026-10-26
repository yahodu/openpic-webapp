import { describe, expect, it } from "vitest";

import * as updateModule from "@/server/events/update";
import * as windowsModule from "@/server/events/windows";

/**
 * Unit / contract — the event-update surface (OP-117 U1–U3, contract §4.1,
 * schema §15.1, ADR-0580).
 *
 * Three pure behaviours the PATCH / archive / delete routes lean on:
 *
 * - **U1 `recomputeWindows`** (`@/server/events/windows`): a date edit moves
 *   `endAt`, so both materialised windows — `uploadWindowEndsAt = endAt +
 *   events.post_upload_days` and `retentionExpiresAt = endAt +
 *   gallery.retention_days` — are recomputed from the **new** end instant and
 *   the plan's entitlements in one call. `null` post-upload days (unlimited)
 *   materialises `uploadWindowEndsAt: null`; `null` retention days
 *   materialises `retentionExpiresAt: null` (the DTO already carries both
 *   windows nullable). Whole-day shifts preserve the time of day.
 * - **U2 the editable-field whitelist** (`@/server/events/update`): the PATCH
 *   route must reject any supplied key outside the §4.1 editable set with
 *   `422 forbidden_field`; `EVENT_EDITABLE_FIELDS` names that set and
 *   `findForbiddenEditableFields` is the pure filter the route runs
 *   (a supplied key whose value is `undefined` is invisible to it, mirroring
 *   the `PATCH /me` precedent).
 * - **U3 the start-lock** (`@/server/events/update`): once `now >= startAt`
 *   the event has started and a `startAt` change must be refused with
 *   `409 event_already_started`; `isEventLocked` is the boundary predicate
 *   — **exactly** at `now === startAt` the event is already locked.
 *
 * ## Contract expected of the implementation
 *
 * - `@/server/events/update` (new) exports `EVENT_EDITABLE_FIELDS` (the ten
 *   field names of contract §4.1), `findForbiddenEditableFields(supplied)`
 *   and `isEventLocked(now, startAt)`.
 * - `@/server/events/windows` additionally exports
 *   `recomputeWindows(input)`.
 */
interface RecomputeWindowsInput {
  readonly endAt: Date;
  readonly postUploadDays: number | null;
  readonly retentionDays: number | null;
}

interface RecomputeWindowsResult {
  readonly uploadWindowEndsAt: Date | null;
  readonly retentionExpiresAt: Date | null;
}

/**
 * Read a module export with a named failure, so a missing export (or module)
 * fails with a message that tells the implementer what to build.
 */
function requireExport(module: object, name: string, path: string): unknown {
  const value = (module as Record<string, unknown>)[name];
  if (value === undefined) {
    throw new Error(`expected ${path} to export ${name}`);
  }
  return value;
}

const recomputeWindows = requireExport(
  windowsModule,
  "recomputeWindows",
  "@/server/events/windows"
) as (input: RecomputeWindowsInput) => RecomputeWindowsResult;

const EVENT_EDITABLE_FIELDS = requireExport(
  updateModule,
  "EVENT_EDITABLE_FIELDS",
  "@/server/events/update"
) as readonly string[];

const findForbiddenEditableFields = requireExport(
  updateModule,
  "findForbiddenEditableFields",
  "@/server/events/update"
) as (supplied: Record<string, unknown>) => string[];

const isEventLocked = requireExport(updateModule, "isEventLocked", "@/server/events/update") as (
  now: Date,
  startAt: Date
) => boolean;

/** The §4.1 editable set, verbatim. */
const CONTRACT_EDITABLE_FIELDS = [
  "name",
  "description",
  "startAt",
  "endAt",
  "displayTimeZone",
  "logoAssetId",
  "watermarkAssetId",
  "thumbnailPreset",
  "visibilityDefaults",
  "status",
] as const;

describe("U1: recomputeWindows — the PATCH date-edit recompute (contract §4.1)", () => {
  it("recomputes both windows from a moved endAt (the contract worked example)", () => {
    expect(
      recomputeWindows({
        endAt: new Date("2026-11-16T18:00:00.000Z"),
        postUploadDays: 7,
        retentionDays: 90,
      })
    ).toEqual({
      uploadWindowEndsAt: new Date("2026-11-23T18:00:00.000Z"),
      retentionExpiresAt: new Date("2027-02-14T18:00:00.000Z"),
    });
  });

  it("materialises uploadWindowEndsAt null when postUploadDays is unlimited (null)", () => {
    const result = recomputeWindows({
      endAt: new Date("2026-11-16T18:00:00.000Z"),
      postUploadDays: null,
      retentionDays: 90,
    });
    expect(result.uploadWindowEndsAt).toBeNull();
    expect(result.retentionExpiresAt).toEqual(new Date("2027-02-14T18:00:00.000Z"));
  });

  it("materialises retentionExpiresAt null when retentionDays is unlimited (null)", () => {
    const result = recomputeWindows({
      endAt: new Date("2026-11-16T18:00:00.000Z"),
      postUploadDays: 7,
      retentionDays: null,
    });
    expect(result.uploadWindowEndsAt).toEqual(new Date("2026-11-23T18:00:00.000Z"));
    expect(result.retentionExpiresAt).toBeNull();
  });

  it("shifts whole days while preserving the time of day to the millisecond", () => {
    expect(
      recomputeWindows({
        endAt: new Date("2026-11-16T09:05:00.123Z"),
        postUploadDays: 1,
        retentionDays: 1,
      })
    ).toEqual({
      uploadWindowEndsAt: new Date("2026-11-17T09:05:00.123Z"),
      retentionExpiresAt: new Date("2026-11-17T09:05:00.123Z"),
    });
  });

  it("keeps both windows at the end instant when the entitlement is zero days", () => {
    expect(
      recomputeWindows({
        endAt: new Date("2026-11-16T18:00:00.000Z"),
        postUploadDays: 0,
        retentionDays: 0,
      })
    ).toEqual({
      uploadWindowEndsAt: new Date("2026-11-16T18:00:00.000Z"),
      retentionExpiresAt: new Date("2026-11-16T18:00:00.000Z"),
    });
  });
});

describe("U2: the editable-field whitelist (contract §4.1)", () => {
  it("names exactly the ten §4.1 editable fields", () => {
    expect([...EVENT_EDITABLE_FIELDS]).toEqual([...CONTRACT_EDITABLE_FIELDS]);
  });

  it("accepts a body that only carries editable fields", () => {
    const supplied: Record<string, unknown> = {
      name: "Rahul & Priya's Wedding",
      description: "Reception photos",
      startAt: "2026-11-14T12:00:00.000Z",
      endAt: "2026-11-16T18:00:00.000Z",
      displayTimeZone: "Asia/Kolkata",
      logoAssetId: null,
      watermarkAssetId: null,
      thumbnailPreset: "default",
      visibilityDefaults: { showOriginal: true },
      status: "published",
    };
    expect(findForbiddenEditableFields(supplied)).toEqual([]);
  });

  it("rejects a single supplied key outside the editable set", () => {
    expect(findForbiddenEditableFields({ name: "Wedding", contactEmail: "a@b.example" })).toEqual([
      "contactEmail",
    ]);
  });

  it("rejects an unknown key that rides alongside editable fields", () => {
    expect(
      findForbiddenEditableFields({
        name: "Wedding",
        description: "Reception photos",
        startAt: "2026-11-14T12:00:00.000Z",
        bannedField: 1,
      })
    ).toEqual(["bannedField"]);
  });

  it("reports every unknown field, whatever the order", () => {
    expect([...findForbiddenEditableFields({ bannedA: 1, name: "x", bannedB: 2 })].sort()).toEqual([
      "bannedA",
      "bannedB",
    ]);
  });

  it("ignores a supplied key whose value is undefined (the PATCH /me precedent)", () => {
    expect(findForbiddenEditableFields({ name: undefined, banned: undefined })).toEqual([]);
  });
});

describe("U3: isEventLocked — the start boundary (now >= startAt)", () => {
  const startAt = new Date("2026-11-14T12:00:00.000Z");

  it("locks the event exactly at the boundary, when now equals startAt", () => {
    expect(isEventLocked(new Date("2026-11-14T12:00:00.000Z"), startAt)).toBe(true);
  });

  it("locks the event a millisecond after the start", () => {
    expect(isEventLocked(new Date("2026-11-14T12:00:00.001Z"), startAt)).toBe(true);
  });

  it("locks the event an hour after the start", () => {
    expect(isEventLocked(new Date("2026-11-14T13:00:00.000Z"), startAt)).toBe(true);
  });

  it("does not lock the event a millisecond before the start", () => {
    expect(isEventLocked(new Date("2026-11-14T11:59:59.999Z"), startAt)).toBe(false);
  });

  it("does not lock the event a day before the start", () => {
    expect(isEventLocked(new Date("2026-11-13T12:00:00.000Z"), startAt)).toBe(false);
  });
});
