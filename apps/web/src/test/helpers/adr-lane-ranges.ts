/**
 * ADR guard, invariant (iii) — reserved-range disjointness in the ledger
 * (ADR-0300 §10). The guard's six invariants are tabulated once, in `0302`
 * §1; the decision detail for this one is §6.
 *
 * One `lane-range-overlap` issue per pair of rows whose **closed** ranges
 * intersect (touching neighbours are disjoint), and one `lane-range-malformed`
 * issue per range-shaped row that is not an accepted closed ascending pair — so
 * a hand-written row is reported instead of skipped.
 *
 * {@link parseLaneRanges} parses exactly one table shape from the ledger: a pipe
 * row whose second cell is a closed `` `NNNN`–`NNNN` `` pair. It cannot see a
 * *file* whose number sits inside another lane's range — the guard has no
 * file→lane map, and a lane's `Next free` cell is not its range end — so range
 * *membership* and `origin/main` freshness stay review-time obligations
 * (`docs/CONVENTIONS.md` §11). Range *disjointness* no longer is.
 */

import type { AdrNumberIssue } from "./adr-guard-types.js";
import { compareStrings } from "./adr-guard-types.js";

/**
 * One row of the reserved-range ledger in `docs/adr/README.md` (ADR-0300).
 * `start`/`end` are inclusive and have their leading zeros dropped.
 */
export interface LaneRange {
  /** The first cell, trimmed verbatim, e.g. `"OP-126 uploads lane"`. */
  holder: string;

  /** The first number of the block, e.g. `760` for `` `0760` ``. */
  start: number;

  /** The last number of the block, e.g. `779` for `` `0779` ``. */
  end: number;
}

/**
 * The range cell of a reserved-range row: a closed pair of four-digit numbers
 * in backticks, `–` (U+2013) or `-` as the separator, spaces allowed. Anything
 * else — a single backticked number, the open-ended `` `0700`+ … `` pool cell, a
 * non-four-digit pair — is not a reservation.
 */
const LANE_RANGE_CELL_PATTERN = /^`(\d{4})`\s*[–-]\s*`(\d{4})`$/;

/**
 * The range *shape*: two backticked 3–4 digit tokens with one dash-family
 * separator (`–`, `-`, `—`, `−`, `~`) between them. A cell that matches this
 * *intends* a reservation even when {@link LANE_RANGE_CELL_PATTERN} rejects it,
 * so the row is reported (`lane-range-malformed`) instead of vanishing.
 *
 * Deliberately not "any non-alphanumeric separator": a dash is range notation,
 * while the ADR index row that quotes `` `402`/`403` `` is prose. The fully
 * anchored cell is the second guard — an annotated range such as
 * `` `0789`-`0808` (20 per lane) `` is not a reservation cell, so it stays
 * silent too.
 */
const LANE_RANGE_SHAPE_PATTERN = /^`(\d{3,4})`\s*[–—−~-]\s*`(\d{3,4})`$/;

/**
 * Parse the closed ranges out of the reserved-range ledger's markdown.
 *
 * Row-shape based, not heading-scoped: a table row *is* the reservation, and
 * the heading carries a date that is edited more often than the row shape. Only
 * a line starting with `|` whose second cell is a closed `` `NNNN`–`NNNN` ``
 * pair counts; everything else is skipped, never thrown on. A pair whose start
 * is above its end does not parse either — it is dropped here and reported by
 * {@link checkAdrDirectory} as `lane-range-malformed`. Document order is
 * preserved (the ledger is not numerically ascending).
 *
 * @param markdown - The text of `docs/adr/README.md`, or any fragment of it.
 * @returns One entry per closed reserved-range row; `[]` for text with none.
 * @example
 * ```ts
 * parseLaneRanges("| OP-126 uploads lane | `0760`–`0779` | `0771` |");
 * // [{ holder: "OP-126 uploads lane", start: 760, end: 779 }]
 * ```
 */
export function parseLaneRanges(markdown: string): LaneRange[] {
  return scanLaneLedger(markdown).ranges;
}

/**
 * Both halves of the ledger read: the rows that parse into a closed range and
 * the holders of range-shaped rows that do not. One pass, because a malformed
 * row must not be fed to the overlap predicate — `0780`-`0760` would otherwise
 * parse as an inverted span and could invent an overlap that the lane never
 * reserved.
 */
interface LaneLedgerScan {
  /** One entry per accepted, ascending closed range, in document order. */
  ranges: LaneRange[];

  /** One entry per range-shaped row that is not an accepted pair, in document order. */
  malformedHolders: string[];
}

/**
 * Classify every pipe row of the ledger (see {@link parseLaneRanges} for the
 * row shape). Exported for the composition root only: {@link parseLaneRanges}
 * keeps the parser contract, and `checkAdrDirectory` needs both halves in one
 * pass.
 */
export function scanLaneLedger(markdown: string): LaneLedgerScan {
  const ranges: LaneRange[] = [];
  const malformedHolders: string[] = [];

  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) {
      continue;
    }

    const cells = line.split("|");
    const holder = cells[1];
    const cell = cells[2]?.trim();
    if (holder === undefined || cell === undefined) {
      continue;
    }

    const match = LANE_RANGE_CELL_PATTERN.exec(cell);
    const start = Number.parseInt(match?.[1] ?? "", 10);
    const end = Number.parseInt(match?.[2] ?? "", 10);
    if (match !== null && start <= end) {
      ranges.push({ holder: holder.trim(), start, end });
    } else if (LANE_RANGE_SHAPE_PATTERN.test(cell)) {
      malformedHolders.push(holder.trim());
    }
  }

  return { ranges, malformedHolders };
}

/**
 * One `lane-range-overlap` issue per pair of reserved rows whose **closed**
 * ranges intersect (touching neighbours are disjoint). Holders are sorted so
 * the report does not depend on ledger row order.
 */
export function findLaneRangeOverlaps(ranges: readonly LaneRange[]): AdrNumberIssue[] {
  return ranges.flatMap((left, index) =>
    ranges
      .slice(index + 1)
      .filter((right) => left.start <= right.end && right.start <= left.end)
      .map((right) => ({
        code: "lane-range-overlap" as const,
        number: null,
        files: [left.holder, right.holder].sort(compareStrings),
      }))
  );
}
