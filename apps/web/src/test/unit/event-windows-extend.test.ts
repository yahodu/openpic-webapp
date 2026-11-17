import { describe, expect, it } from "vitest";

import * as eventWindows from "@/server/events/windows";

/**
 * Unit — extend an event's upload window (OP-117 §3 E7, contract §4.1).
 *
 * `POST /api/v1/events/{eventId}/upload-window:extend` materially moves the
 * stored `uploadWindowEndsAt` by `additionalDays` **whole days**, keeping the
 * time of day (the create route's per-window helpers already do exactly that:
 * `endAt + events.post_upload_days`). The arithmetic is pinned here so the
 * route spec can stay about admission, refusal and persistence.
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/events/windows
 *   extendUploadWindow(uploadWindowEndsAt: Date, additionalDays: number): Date
 * ```
 *
 * The helper is pure: it must not mutate its argument. A caller only reaches
 * it with a positive whole `additionalDays` (the route refuses anything else
 * with `422 validation_failed`), so this file pins only the shift itself.
 *
 * ## Assumption
 *
 * The GREEN may inline this arithmetic instead of exporting a helper. If it
 * does, the behaviour above must still be reachable as this export — the pin is
 * on the day-shift contract, not on the call site.
 */

/** The export this file pins, read through a guard so the RED names it. */
type ExtendUploadWindow = (uploadWindowEndsAt: Date, additionalDays: number) => Date;

const exportedExtendUploadWindow = (
  eventWindows as unknown as { readonly extendUploadWindow?: ExtendUploadWindow }
).extendUploadWindow;

if (typeof exportedExtendUploadWindow !== "function") {
  throw new Error(
    "@/server/events/windows must export extendUploadWindow(uploadWindowEndsAt, additionalDays)"
  );
}

const extendUploadWindow: ExtendUploadWindow = exportedExtendUploadWindow;

describe("extendUploadWindow (E7) — shift the upload window by whole days", () => {
  it("moves the close by N whole days, keeping the time of day", () => {
    expect(extendUploadWindow(new Date("2026-11-23T18:00:00.000Z"), 7)).toEqual(
      new Date("2026-11-30T18:00:00.000Z")
    );
  });

  it("lands on the next calendar day across a month boundary, keeping the time of day", () => {
    expect(extendUploadWindow(new Date("2026-11-30T23:45:00.000Z"), 1)).toEqual(
      new Date("2026-12-01T23:45:00.000Z")
    );
  });

  it("adds exactly N × 86,400,000 ms to a far-future close", () => {
    const close = new Date("2027-01-15T06:30:00.000Z");
    const extended = extendUploadWindow(close, 30);
    expect(extended.getTime() - close.getTime()).toBe(30 * 86_400_000);
    expect(extended.toISOString()).toBe("2027-02-14T06:30:00.000Z");
  });

  it("does not mutate the instant it is given", () => {
    const close = new Date("2026-11-23T18:00:00.000Z");
    const before = close.getTime();
    extendUploadWindow(close, 3);
    expect(close.getTime()).toBe(before);
  });
});
