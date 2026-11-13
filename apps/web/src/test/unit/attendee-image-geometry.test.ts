import { describe, expect, it } from "vitest";

import { displayGeometry } from "@/server/attendee/image-geometry";

/**
 * Unit contract — the gallery's display geometry and aspect ratio
 * (OP-133 U2; contract §6.5 "width/height/orientation/aspectRatio are mandatory";
 * schema §16.1 `imageMeta`; PRD "correct orientation, layout and padding";
 * ADR-0793 §2).
 *
 * **Why this exists.** The gallery grid reserves space for every tile *before*
 * the bytes arrive, which is the whole "no layout shift" promise. That only
 * works when the numbers the API sends describe the image **as it will be
 * displayed**. A phone photo is stored as `4000×6000` with EXIF
 * `orientation: 6`, but it is displayed as `6000×4000`; sending the stored pair
 * makes the browser reserve a portrait tile for a landscape photo and the grid
 * jumps on every load.
 *
 * **Contract pinned here.**
 *
 * ```
 * displayGeometry({ width, height, orientation }): { width, height, aspectRatio }
 * ```
 *
 * - EXIF orientations `5`, `6`, `7`, `8` transpose the image, so the displayed
 *   `width`/`height` are the stored pair swapped; `1`, `2`, `3`, `4` do not.
 * - `aspectRatio` is `width / height` **after** the transpose, rounded to four
 *   decimal places — §6.5's own example (`4000×6000` → `0.6667`) is why.
 * - A missing/unknown `orientation` is treated as `1` (the EXIF default), and a
 *   degenerate `width`/`height` (`0`, negative, non-finite) falls back to
 *   `aspectRatio: 1` with the numbers kept as given, because a `NaN` ratio
 *   would collapse the whole grid.
 */

/** A stored portrait photo, as the pipeline records it (schema §16.1). */
const STORED_PORTRAIT = { width: 4000, height: 6000, orientation: 1 } as const;

describe("displayGeometry", () => {
  it("keeps the stored pair for an upright image and rounds the ratio to four decimals", () => {
    expect(displayGeometry(STORED_PORTRAIT)).toEqual({
      width: 4000,
      height: 6000,
      aspectRatio: 0.6667,
    });
  });

  it("swaps width and height for EXIF orientation 6", () => {
    // A photo taken with the phone rotated 90°: stored portrait, shown landscape.
    expect(displayGeometry({ width: 4000, height: 6000, orientation: 6 })).toEqual({
      width: 6000,
      height: 4000,
      aspectRatio: 1.5,
    });
  });

  it("swaps width and height for EXIF orientation 8", () => {
    expect(displayGeometry({ width: 4000, height: 6000, orientation: 8 })).toEqual({
      width: 6000,
      height: 4000,
      aspectRatio: 1.5,
    });
  });

  it.each<readonly [number, number, number, number, number]>([
    // orientation, stored width, stored height, displayed width, displayed height
    [1, 4032, 3024, 4032, 3024],
    [2, 4032, 3024, 4032, 3024],
    [3, 4032, 3024, 4032, 3024],
    [4, 4032, 3024, 4032, 3024],
    [5, 4032, 3024, 3024, 4032],
    [6, 4032, 3024, 3024, 4032],
    [7, 4032, 3024, 3024, 4032],
    [8, 4032, 3024, 3024, 4032],
  ])(
    "treats orientation %i as %ix%i stored → %ix%i displayed",
    (orientation, storedWidth, storedHeight, shownWidth, shownHeight) => {
      const geometry = displayGeometry({
        width: storedWidth,
        height: storedHeight,
        orientation,
      });

      expect([geometry.width, geometry.height]).toEqual([shownWidth, shownHeight]);
    }
  );

  it("answers a square tile for a square photo whatever the orientation", () => {
    expect(displayGeometry({ width: 3000, height: 3000, orientation: 6 })).toEqual({
      width: 3000,
      height: 3000,
      aspectRatio: 1,
    });
  });

  it("rounds a landscape ratio to four decimals", () => {
    expect(displayGeometry({ width: 3024, height: 4032, orientation: 6 })).toEqual({
      width: 4032,
      height: 3024,
      aspectRatio: 1.3333,
    });
  });

  it("treats an absent orientation as upright", () => {
    const geometry = displayGeometry({ width: 4000, height: 6000 });

    expect([geometry.width, geometry.height, geometry.aspectRatio]).toEqual([4000, 6000, 0.6667]);
  });

  it("treats an unknown orientation as upright rather than transposing", () => {
    const geometry = displayGeometry({ width: 4000, height: 6000, orientation: 42 });

    expect([geometry.width, geometry.height]).toEqual([4000, 6000]);
  });

  it("falls back to a ratio of 1 when the stored height is degenerate", () => {
    // A malformed row must not send `Infinity` into the grid: every tile would
    // collapse to zero height.
    const geometry = displayGeometry({ width: 4000, height: 0, orientation: 1 });

    expect(geometry.aspectRatio).toBe(1);
    expect(Number.isFinite(geometry.aspectRatio)).toBe(true);
  });

  it("falls back to a ratio of 1 when the stored width is degenerate", () => {
    const geometry = displayGeometry({ width: 0, height: 6000, orientation: 6 });

    expect(geometry.aspectRatio).toBe(1);
    expect(Number.isFinite(geometry.aspectRatio)).toBe(true);
  });
});
