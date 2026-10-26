import { describe, expect, it } from "vitest";

import {
  computeDurationDays,
  computeRetentionExpiresAt,
  computeUploadWindowEndsAt,
} from "@/server/events/windows";

/**
 * Unit — event window computation (OP-115 U1/U2, contract §4.1, schema §15.1).
 *
 * The create route materialises two windows at creation: the upload window
 * (`uploadWindowEndsAt = endAt + events.post_upload_days`) and the gallery
 * retention (`retentionExpiresAt = endAt + gallery.retention_days`), and it
 * refuses a duration longer than `events.duration_days` computed as
 * `ceil((endAt - startAt) / 1 day)`.
 *
 * U1 pins the window arithmetic, including the **unlimited** post-upload case
 * (`null` entitlement limit → a `null` window, not a Date); U2 pins the ceil
 * rule. The values 2026-11-23T18:00:00.000Z / 2027-02-14T18:00:00.000Z are the
 * contract §4.1 worked example (endAt 2026-11-16T18:00:00Z, +7 and +90 days).
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/events/windows
 *   computeUploadWindowEndsAt(endAt: Date, postUploadDays: number | null): Date | null
 *   computeRetentionExpiresAt(endAt: Date, retentionDays: number): Date
 *   computeDurationDays(startAt: Date, endAt: Date): number   // Math.ceil over ms-per-day
 * ```
 */

describe("computeUploadWindowEndsAt (U1)", () => {
  it("materialises the upload window as endAt plus the post-upload days, keeping the time-of-day", () => {
    expect(computeUploadWindowEndsAt(new Date("2026-11-16T18:00:00.000Z"), 7)).toEqual(
      new Date("2026-11-23T18:00:00.000Z")
    );
  });

  it("keeps the end instant for a zero-day post-upload window", () => {
    expect(computeUploadWindowEndsAt(new Date("2026-11-16T18:00:00.000Z"), 0)).toEqual(
      new Date("2026-11-16T18:00:00.000Z")
    );
  });

  it("returns null when the post-upload entitlement is unlimited (postUploadDays null)", () => {
    expect(computeUploadWindowEndsAt(new Date("2026-11-16T18:00:00.000Z"), null)).toBeNull();
  });
});

describe("computeRetentionExpiresAt (U1)", () => {
  it("materialises the gallery expiry as endAt plus the retention days", () => {
    expect(computeRetentionExpiresAt(new Date("2026-11-16T18:00:00.000Z"), 90)).toEqual(
      new Date("2027-02-14T18:00:00.000Z")
    );
  });
});

describe("computeDurationDays (U2 — ceil rule)", () => {
  it("counts an exact day boundary as one day", () => {
    expect(
      computeDurationDays(
        new Date("2026-11-14T12:00:00.000Z"),
        new Date("2026-11-15T12:00:00.000Z")
      )
    ).toBe(1);
  });

  it("counts a same-day span (08:00 → 17:00) as one day", () => {
    expect(
      computeDurationDays(
        new Date("2026-11-14T08:00:00.000Z"),
        new Date("2026-11-14T17:00:00.000Z")
      )
    ).toBe(1);
  });

  it("rounds the contract §4.1 example (2 days 6 hours) up to 3 days", () => {
    expect(
      computeDurationDays(
        new Date("2026-11-14T12:00:00.000Z"),
        new Date("2026-11-16T18:00:00.000Z")
      )
    ).toBe(3);
  });

  it("rounds two days plus one millisecond up to three days", () => {
    expect(
      computeDurationDays(
        new Date("2026-11-14T12:00:00.000Z"),
        new Date("2026-11-16T12:00:00.001Z")
      )
    ).toBe(3);
  });

  it("returns the exact whole-day count for an exact boundary", () => {
    expect(
      computeDurationDays(
        new Date("2026-11-14T12:00:00.000Z"),
        new Date("2026-11-16T12:00:00.000Z")
      )
    ).toBe(2);
  });

  it("returns 45 for a 45-day span (an over-limit duration I11 depends on)", () => {
    expect(
      computeDurationDays(
        new Date("2026-11-01T00:00:00.000Z"),
        new Date("2026-12-16T00:00:00.000Z")
      )
    ).toBe(45);
  });
});
