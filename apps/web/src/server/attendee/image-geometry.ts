/**
 * The gallery tile's display geometry (OP-133; contract §6.5; schema §16.1;
 * ADR-0794 §2).
 *
 * The grid reserves space for every tile before the bytes arrive, which is the
 * whole "no layout shift" promise. That only works when the numbers describe the
 * image **as displayed**: a phone photo stored as `4000×6000` with EXIF
 * `orientation: 6` is shown landscape, so the stored pair must be transposed.
 */

/** The stored dimensions and EXIF orientation of one image (schema §16.1). */
export interface StoredGeometry {
  readonly width: number;
  readonly height: number;
  readonly orientation?: number | null;
}

/** The dimensions and ratio the grid lays a tile out with. */
export interface DisplayGeometry {
  readonly width: number;
  readonly height: number;
  /** `width / height` after the transpose, to four decimals. */
  readonly aspectRatio: number;
}

/** The four EXIF orientations that transpose the image (§16.1). */
const TRANSPOSING_ORIENTATIONS: ReadonlySet<number> = new Set([5, 6, 7, 8]);

/** The ratio's precision; §6.5's own example (`4000×6000` → `0.6667`). */
const RATIO_DECIMALS = 4;

/**
 * The dimensions a tile is drawn with, and its aspect ratio.
 *
 * @param stored - The stored pair and its EXIF orientation.
 * @returns The displayed pair and the ratio, never `NaN`/`Infinity`.
 */
export function displayGeometry(stored: StoredGeometry): DisplayGeometry {
  const transpose = TRANSPOSING_ORIENTATIONS.has(stored.orientation ?? 1);
  const width = transpose ? stored.height : stored.width;
  const height = transpose ? stored.width : stored.height;
  const scale = 10 ** RATIO_DECIMALS;
  // A malformed row must not send `Infinity` into the grid: every tile would
  // collapse to zero height.
  const aspectRatio =
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? Math.round((width / height) * scale) / scale
      : 1;
  return { width, height, aspectRatio };
}
