import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseLaneRanges, type LaneRange } from "../helpers/adr-numbering.js";

/**
 * Unit contract — `parseLaneRanges` in `src/test/helpers/adr-numbering.ts`
 * (ledger finding F-L1, OP-96).
 *
 * **Why this exists.** `docs/adr/README.md` § "Reserved ranges" is the ledger
 * that makes per-lane ADR numbering (ADR-0300) work: every lane owns a closed
 * block of numbers and mints inside it. Nothing read that table, so two lanes
 * could reserve **intersecting** ranges and only discover it later, as two ADRs
 * minted the same number. That happened: the OP-126 uploads lane reserved
 * `0760`–`0779` while the OP-129 attendee-identity lane reserved `0769`–`0788`,
 * and `ADR-0770` now exists twice in flight. Neither row is on `main`, so the
 * defect is invisible from the trunk — only a check that *reads the table* can
 * see it. This spec pins the parser half of that check; the checker half lives
 * in `adr-numbering.test.ts` (`checkAdrDirectory` → `lane-range-overlap`).
 *
 * **Contract pinned here** (RED and GREEN must not diverge):
 *
 * ```
 * interface LaneRange { holder: string; start: number; end: number }
 * parseLaneRanges(markdown: string): LaneRange[]
 * ```
 *
 * `markdown` is the text of `docs/adr/README.md` (or any fragment of it). A
 * **row** is a pipe-table line — it starts with `|` — whose second cell is a
 * closed pair `` `NNNN`–`NNNN` `` of four-digit numbers in backticks, with
 * `–` (U+2013 en dash) or a plain `-` as the separator, allowing arbitrary
 * column padding and spaces around the separator. For each such row the parser
 * returns `{ holder, start, end }`:
 *   - `holder` is the first cell, trimmed, verbatim (`"OP-126 uploads lane"`);
 *   - `start` / `end` are the two numbers with leading zeros dropped
 *     (`"0760"` → `760`);
 *   - document order is preserved (the real ledger is *not* numerically
 *     ascending — its first row is `0300`–`0319` and its second `0146`–`0179`).
 *
 * Rows that are not a closed pair are **skipped, never thrown on**: the header
 * row, the `---` separator row, a cell holding a single backticked number, a
 * number that is not four digits, and the open-ended
 * `unallocated (future lanes)` row (`` `0700`+ (20 per lane, in order) ``).
 * `""` and a table with no parseable row both yield `[]`. A prose mention of a
 * range (`the OP-129 lane holds `0769`–`0788``) is not a row: it is not a pipe
 * line, so it yields nothing.
 *
 * **Assumptions resolved in this spec** (flagged in the handoff):
 *   - The parser is **row-shape based, not heading-scoped**: it does not
 *     require the `### Reserved ranges` heading, because the heading text
 *     carries a date and is edited more often than the row shape. A table row
 *     is what makes a reservation; a heading is not. The fixtures therefore
 *     include the heading where they mirror the real document and omit it where
 *     the case is about row shape only.
 *   - Ranges are compared as **closed** intervals: `0760`–`0779` and
 *     `0780`–`0798` are disjoint (they touch and do not intersect).
 */

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

/**
 * One `readFileSync` call site — the security preset flags every non-literal
 * `fs` path, so the real-ledger pins share this reader instead of each reaching
 * for the file (precedent: `workflow-shell-safety.test.ts`).
 */
const readAdrReadme = (): string => readFileSync(join(repoRoot, "docs/adr/README.md"), "utf8");

/**
 * The ledger's reserved-range table as markdown: heading, header row, separator
 * row, then `rows` verbatim. Fixture factory only — every row is written by the
 * case that uses it, so a case reads as the table it pins.
 */
function ledgerTable(rows: string[]): string {
  return [
    "### Reserved ranges (effective 2026-10-20)",
    "",
    "| Holder (lane)                       | Reserved range | Next free |",
    "| ----------------------------------- | -------------- | --------- |",
    ...rows,
  ].join("\n");
}

/**
 * One closed-pair data row, the same shape the parser must accept, with the
 * holder and the two numbers captured so an expectation can be derived from the
 * ledger itself instead of being fossilised in this spec. Rows that are not a
 * closed pair — the header, the `---` separator, the open-ended pool row, the
 * ADR index — simply do not match.
 */
const CLOSED_ROW_PATTERN = /^\|\s*([^|]+?)\s*\|\s*`(\d{4})`\s*[–-]\s*`(\d{4})`\s*\|/;

/**
 * The real ledger's closed-pair rows, in document order, derived from the file
 * with the row shape above. The structural pins use it so that a new lane row
 * cannot turn the guard's own spec red while the guard still reports the ledger
 * clean: the ledger is the board's most-edited file and new lanes are inserted
 * between the `OP-122` row and the pool row, not appended below both.
 */
function closedRows(markdown: string): LaneRange[] {
  return markdown.split("\n").flatMap((line) => {
    const [, holder, start, end] = CLOSED_ROW_PATTERN.exec(line) ?? [];
    return holder === undefined
      ? []
      : [{ holder: holder.trim(), start: Number(start), end: Number(end) }];
  });
}

describe("parseLaneRanges — the repository's ledger", () => {
  it("returns one range per closed row of the reserved-range table, in document order", () => {
    // Arrange — the real ledger, read from disk: no hard-coded copy can drift.
    const markdown = readAdrReadme();
    const expectedRows = closedRows(markdown);

    // Act
    const ranges: LaneRange[] = parseLaneRanges(markdown);

    // Assert — every closed row is parsed (count equality catches both a
    // skipped row and an over-parse of the header / pool / ADR-index rows).
    expect(expectedRows.length).toBeGreaterThan(0);
    expect(ranges).toHaveLength(expectedRows.length);

    // The first row is the board-wide reservation by convention; the last one is
    // whatever row the ledger currently ends with. It is derived from the file,
    // not pinned: the ledger grows by inserting lane rows above the pool row.
    expect(ranges[0]).toEqual({
      holder: "board-wide / process (orchestrator)",
      start: 300,
      end: 319,
    });
    expect(ranges.at(-1)).toEqual(expectedRows.at(-1));
  });

  it.each<[string, number, number]>([
    ["board-wide / process (orchestrator)", 300, 319],
    ["OP-96 notifications follow-up", 146, 179],
    ["OP-122 queue lane", 680, 699],
  ])("parses the %s row as %s-%s", (holder, start, end) => {
    // Act
    const range = parseLaneRanges(readAdrReadme()).find((candidate) => candidate.holder === holder);

    // Assert
    expect(range).toEqual({ holder, start, end });
  });

  it("does not parse the open-ended unallocated (future lanes) pool row", () => {
    // Act — the pool cell is `` `0700`+ (20 per lane, in order) ``: not a closed
    // pair, so the pool has no end and must never become a "range".
    const ranges = parseLaneRanges(readAdrReadme());

    // Assert
    expect(ranges.filter((range) => range.holder.toLowerCase().includes("unallocated"))).toEqual(
      []
    );
  });

  it("finds no intersecting pair among the repository's reserved ranges", () => {
    // Arrange — the merged-tree acceptance proof for the F-L1 repair: once the
    // OP-129 row and the uploads rows are both on `main`, this must stay empty.
    const ranges: LaneRange[] = parseLaneRanges(readAdrReadme());

    // Act — every unordered pair whose closed intervals intersect.
    const overlappingPairs = ranges.flatMap((left, index) =>
      ranges
        .slice(index + 1)
        .filter((right) => left.start <= right.end && right.start <= left.end)
        .map((right) => [left.holder, right.holder])
    );

    // Assert
    expect(overlappingPairs).toEqual([]);
  });
});

describe("parseLaneRanges — row shape", () => {
  it("parses a two-lane table, keeping the holders verbatim and the document order", () => {
    // Arrange — column padding is deliberately uneven: the ledger is hand-edited.
    const markdown = ledgerTable([
      "| OP-126 uploads lane           | `0760`–`0779`                     | `0771`    |",
      "| OP-129 attendee identity lane | `0769`–`0788` | `0770` |",
    ]);

    // Act
    const ranges = parseLaneRanges(markdown);

    // Assert
    expect(ranges).toEqual([
      { holder: "OP-126 uploads lane", start: 760, end: 779 },
      { holder: "OP-129 attendee identity lane", start: 769, end: 788 },
    ]);
  });

  it("accepts a plain hyphen as the range separator", () => {
    // Arrange — a lane may type `-` instead of the ledger's en dash.
    const markdown = ledgerTable([
      "| OP-201 alpha lane | `0760`-`0779` | `0761` |",
      "| OP-202 beta lane  | `0780`-`0799` | `0781` |",
    ]);

    // Act
    const ranges = parseLaneRanges(markdown);

    // Assert
    expect(ranges).toEqual([
      { holder: "OP-201 alpha lane", start: 760, end: 779 },
      { holder: "OP-202 beta lane", start: 780, end: 799 },
    ]);
  });

  it("accepts spaces around the range separator", () => {
    // Arrange
    const markdown = ledgerTable(["| OP-201 alpha lane | `0760` – `0779` | `0761` |"]);

    // Act
    const ranges = parseLaneRanges(markdown);

    // Assert
    expect(ranges).toEqual([{ holder: "OP-201 alpha lane", start: 760, end: 779 }]);
  });

  it("drops the leading zeros of the range numbers", () => {
    // Arrange
    const markdown = ledgerTable(["| OP-201 alpha lane | `0007`–`0019` | `0008` |"]);

    // Act
    const ranges = parseLaneRanges(markdown);

    // Assert
    expect(ranges).toEqual([{ holder: "OP-201 alpha lane", start: 7, end: 19 }]);
  });

  it("returns no range for a table with only a header and separator row", () => {
    // Arrange
    const markdown = ledgerTable([]);

    // Act
    const ranges = parseLaneRanges(markdown);

    // Assert
    expect(ranges).toEqual([]);
  });

  it("returns no range for an empty string", () => {
    // Act
    const ranges = parseLaneRanges("");

    // Assert
    expect(ranges).toEqual([]);
  });

  it("ignores a range that is only mentioned in prose", () => {
    // Arrange — the ledger's lane notes name ranges in running text; a note is
    // not a reservation row, so it must never be read as one.
    const markdown = [
      "### Reserved ranges (effective 2026-10-20)",
      "",
      "The OP-129 attendee identity lane holds `0769`-`0788` and mints `0770` next.",
      "",
      "_Frozen pre-policy numbers held by in-flight refs:_ `0143`-`0145`.",
    ].join("\n");

    // Act
    const ranges = parseLaneRanges(markdown);

    // Assert
    expect(ranges).toEqual([]);
  });

  it("skips a row whose range cell is a single number rather than a closed pair", () => {
    // Arrange — the pool row shape and a lone "next free" cell are not ranges.
    const markdown = ledgerTable([
      "| unallocated (future lanes) | `0700`+ (20 per lane, in order) | `0700` |",
      "| OP-201 alpha lane          | `0780`                          | `0781` |",
    ]);

    // Act
    const ranges = parseLaneRanges(markdown);

    // Assert
    expect(ranges).toEqual([]);
  });

  it("skips a range whose numbers are not four digits", () => {
    // Arrange — the ledger's numbers are zero-padded to four digits; a short
    // number is a typo, not a reservation.
    const markdown = ledgerTable([
      "| OP-201 alpha lane | `760`-`779` | `761` |",
      "| OP-202 beta lane  | `0780`-`0799` | `0781` |",
    ]);

    // Act
    const ranges = parseLaneRanges(markdown);

    // Assert
    expect(ranges).toEqual([{ holder: "OP-202 beta lane", start: 780, end: 799 }]);
  });

  it("ignores the rows of the ADR index table", () => {
    // Arrange — the same file carries the ADR index below the ledger; its rows
    // have no reserved-range cell and must not be read as reservations.
    const markdown = [
      ledgerTable(["| OP-201 alpha lane | `0760`–`0779` | `0761` |"]),
      "",
      "| ADR                                                                    | Title                    | Status   |",
      "| ---------------------------------------------------------------------- | ------------------------ | -------- |",
      "| [0001](ADR-0001-ports-and-adapters.md)                                 | Ports and adapters       | Accepted |",
    ].join("\n");

    // Act
    const ranges = parseLaneRanges(markdown);

    // Assert
    expect(ranges).toEqual([{ holder: "OP-201 alpha lane", start: 760, end: 779 }]);
  });

  it("parses reservation rows that are not under the reserved-range heading", () => {
    // Arrange — a row's shape is what makes it a reservation, not the heading
    // above it: the heading carries a date and is re-worded more often than the
    // rows are written.
    const markdown = [
      "| OP-201 alpha lane | `0760`–`0779` | `0761` |",
      "| OP-202 beta lane  | `0780`–`0799` | `0781` |",
    ].join("\n");

    // Act
    const ranges = parseLaneRanges(markdown);

    // Assert
    expect(ranges).toEqual([
      { holder: "OP-201 alpha lane", start: 760, end: 779 },
      { holder: "OP-202 beta lane", start: 780, end: 799 },
    ]);
  });
});
