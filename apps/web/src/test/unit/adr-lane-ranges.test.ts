import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  laneLedger,
  makeTempAdrDir,
  makeTempAdrDirWithReadme,
  realAdrDir,
  repoRoot,
  tempDirs,
} from "../helpers/adr-guard-fixtures.js";
import type { AdrNumberIssue } from "../helpers/adr-guard-types.js";
import { checkAdrDirectory } from "../helpers/adr-numbering.js";
import { parseLaneRanges, type LaneRange } from "../helpers/adr-lane-ranges.js";

/**
 * ADR guard, invariant (iii) — the guard's six invariants are tabulated once, in
 * `ADR-0302` §1. This file owns one of them: no two rows of the reserved-range
 * ledger in `<dir>/README.md` may reserve intersecting **closed** ranges. Both
 * halves live here — the `parseLaneRanges` parser, and the `checkAdrDirectory`
 * cases that report `lane-range-overlap` / `lane-range-malformed`.
 *
 * What the guard still cannot see: a *file* whose number sits inside another
 * lane's reserved range — it has no file→lane map, so range membership stays a
 * review-time obligation (ADR-0302 §4).
 */

/**
 * Unit contract — `parseLaneRanges` in `src/test/helpers/adr-lane-ranges.ts`
 * (ledger finding F-L1, OP-96).
 *
 * **Why this exists.** `docs/adr/README.md` § "Reserved ranges" is the ledger
 * that makes per-lane ADR numbering (ADR-0300) work: every lane owns a closed
 * block of numbers and mints inside it. Nothing read that table, so two lanes
 * could reserve **intersecting** ranges and only discover it later, as two ADRs
 * minted the same number. That happened: the OP-126 uploads lane reserved
 * `0760`–`0779` while the OP-129 attendee-identity lane reserved `0769`–`0788`,
 * and `0770` now exists twice in flight. Neither row is on `main`, so the
 * defect is invisible from the trunk — only a check that *reads the table* can
 * see it. This spec pins the parser half and the checker half: `parseLaneRanges`
 * below, and the `checkAdrDirectory` cases that report `lane-range-overlap`.
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

  it("drops an inverted pair instead of returning the inverted span", () => {
    // Arrange — the parser contract changed with review finding F1: this pair
    // used to come back as `{ start: 780, end: 760 }`, a span no lane holds and
    // one the overlap predicate would read as intersecting a real reservation.
    // The descending pair is now dropped outright, so a later "tidy-up" cannot
    // quietly restore the inverted range.
    const markdown = ledgerTable(["| OP-201 alpha lane | `0780`-`0760` | `0781` |"]);

    // Act
    const ranges = parseLaneRanges(markdown);

    // Assert
    expect(ranges).toEqual([]);
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
/* ------------------------------------------------------------------------- *
 * Invariant (iii) — the checker half: lane-range overlaps (F-L1) and the
 * range-shaped rows that do not parse (F1).
 * ------------------------------------------------------------------------- */

/**
 * Compile-time pin of the widened issue union: `AdrNumberIssue["code"]` must
 * admit `"lane-range-overlap"`, so an implementation that appends an overlap
 * issue without widening the type fails `tsc`, not just a runtime assertion.
 */
const overlapCode: AdrNumberIssue["code"] = "lane-range-overlap";

/**
 * Compile-time pin of the F1 follow-up's union widening: a ledger row that
 * obviously intends a reservation but does not parse is reported as
 * `lane-range-malformed`, so `AdrNumberIssue["code"]` must admit it. An
 * implementation that appends the issue without widening the union fails `tsc`
 * (`TS2322` on this line), not only a runtime assertion.
 */
const malformedCode: AdrNumberIssue["code"] = "lane-range-malformed";

describe("checkAdrDirectory — lane-range overlaps (ledger finding F-L1)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports one overlap issue for the live OP-126 / OP-129 intersection", () => {
    // Arrange — the measured in-flight state: the uploads lane reserved
    // 0760-0779 and the attendee-identity lane reserved 0769-0788, which is how
    // 0770 came to exist twice. README order is deliberately reversed, so
    // the issue's holder order pins the ascending sort.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-op126-uploads-green.md"], // adr-fixture
      laneLedger([
        "| OP-129 attendee identity lane | `0769`–`0788` | `0770` |",
        "| OP-126 uploads lane           | `0760`–`0779` | `0771` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: overlapCode,
          number: null,
          files: ["OP-126 uploads lane", "OP-129 attendee identity lane"],
        },
      ],
    });
  });

  it("reports no overlap for ranges that touch without intersecting", () => {
    // Arrange — 0760-0779 and 0780-0798 are adjacent, so they are disjoint
    // (this is the boundary the F-L1 repair relies on).
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger([
        "| OP-126 uploads lane           | `0760`–`0779` | `0771` |",
        "| OP-129 attendee identity lane | `0780`–`0798` | `0782` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("reports no overlap for a single reserved range", () => {
    // Arrange
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger(["| OP-126 uploads lane | `0760`–`0779` | `0771` |"])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("reports no overlap when the README table has no parseable row", () => {
    // Arrange — header and `---` separator only.
    const dir = makeTempAdrDirWithReadme(["ADR-0760-a.md"], laneLedger([])); // adr-fixture

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("reports no overlap when the README only mentions ranges in prose", () => {
    // Arrange — an empty README and a prose-only one both carry no reservation.
    const emptyDir = makeTempAdrDirWithReadme(["ADR-0760-a.md"], ""); // adr-fixture
    const proseDir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      "The OP-129 lane holds `0769`-`0788`; the uploads lane holds `0760`-`0779`."
    );

    // Act
    const emptyResult = checkAdrDirectory(emptyDir);
    const proseResult = checkAdrDirectory(proseDir);

    // Assert
    expect(emptyResult).toEqual({ ok: true, issues: [] });
    expect(proseResult).toEqual({ ok: true, issues: [] });
  });

  it("reports no overlap for a directory that has no README at all", () => {
    // Arrange — a bare ADR directory must not throw on the missing ledger.
    const dir = makeTempAdrDir(["ADR-0760-a.md"]); // adr-fixture

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("reports one issue per intersecting pair when three reserved ranges overlap", () => {
    // Arrange — every pair of these three intersects, so the report carries
    // three issues, not one per row.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger([
        "| OP-201 alpha lane | `0760`–`0779` | `0761` |",
        "| OP-202 beta lane  | `0769`–`0788` | `0770` |",
        "| OP-203 gamma lane | `0775`–`0795` | `0776` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(3);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        {
          code: overlapCode,
          number: null,
          files: ["OP-201 alpha lane", "OP-202 beta lane"],
        },
        {
          code: overlapCode,
          number: null,
          files: ["OP-201 alpha lane", "OP-203 gamma lane"],
        },
        {
          code: overlapCode,
          number: null,
          files: ["OP-202 beta lane", "OP-203 gamma lane"],
        },
      ])
    );
  });

  it("reports a duplicate number and a lane-range overlap from the same directory", () => {
    // Arrange — the two invariants are independent: a directory can break both,
    // and the range check must not swallow the numbering report (or vice versa).
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0146-a.md", "ADR-0146-b.md"],
      laneLedger([
        "| OP-126 uploads lane           | `0760`–`0779` | `0771` |",
        "| OP-129 attendee identity lane | `0769`–`0788` | `0770` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        {
          code: "duplicate",
          number: "0146",
          files: ["ADR-0146-a.md", "ADR-0146-b.md"],
        },
        {
          code: overlapCode,
          number: null,
          files: ["OP-126 uploads lane", "OP-129 attendee identity lane"],
        },
      ])
    );
  });
});

describe("checkAdrDirectory — range-shaped rows that do not parse (review finding F1)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an inverted range as one lane-range-malformed issue naming its holder", () => {
    // Arrange — `0780`-`0760` obviously intends a reservation, but it is
    // inverted, so today it parses as { start: 780, end: 760 } and the span the
    // lane meant is invisible: the ledger is reported clean. A row that does not
    // parse must be named, not dropped, or a typo silently disables the guard.
    // One issue per row, carrying that row's holder once — not the two holders
    // an overlap issue carries.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger([
        "| OP-201 alpha lane | `0780`-`0760` | `0781` |",
        "| OP-202 beta lane  | `0760`–`0779` | `0761` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [{ code: malformedCode, number: null, files: ["OP-201 alpha lane"] }],
    });
  });

  it("reports only the malformed row when the inverted span would intersect a real lane", () => {
    // Arrange — the discriminating fixture for the rule "a malformed row never
    // feeds the overlap predicate": the inverted row is paired with a lane that
    // its *inverted* span would intersect. `0780`-`0760` read as
    // { start: 780, end: 760 } against 0760-0799 answers
    // `780 <= 799 && 760 <= 760` — an overlap no lane reserved. The `0799` end is
    // load-bearing: against 0760-0779 the predicate answers false for both rows,
    // so the case would stay green under an implementation that feeds malformed
    // rows to the predicate. Expected: the malformed row alone, no overlap.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger([
        "| OP-201 alpha lane | `0780`-`0760` | `0781` |",
        "| OP-204 delta lane | `0760`-`0799` | `0781` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert — exactly one issue, carrying the malformed row's holder once; a
    // `lane-range-overlap` here would be a phantom the ledger never reserved.
    expect(result).toEqual({
      ok: false,
      issues: [{ code: malformedCode, number: null, files: ["OP-201 alpha lane"] }],
    });
  });

  it("stays silent for an indented row: the row shape requires a leading pipe", () => {
    // Arrange — a row pushed in by two spaces is not a pipe-table row, so it is
    // neither a reservation nor a malformed one: Markdown does not read it as a
    // table row either. Silence is the contract, and a false positive here would
    // make every indented snippet in the ledger's notes fail the guard.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger(["  | OP-201 alpha lane | `0780`-`0760` | `0781` |"])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("still parses the valid rows of a ledger that carries one malformed row", () => {
    // Arrange — a malformed row must not poison the rows around it: the two
    // valid rows still overlap, so the report carries both the malformed row and
    // the intersection the guard exists to catch.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger([
        "| OP-201 alpha lane | `0780`-`0760` | `0781` |",
        "| OP-202 beta lane  | `0760`–`0779` | `0761` |",
        "| OP-203 gamma lane | `0770`–`0785` | `0776` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert — both issues carry `number: null`, so the shared
    // (number, code, files[0]) ordering key puts `lane-range-malformed` first.
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: malformedCode, number: null, files: ["OP-201 alpha lane"] },
        { code: overlapCode, number: null, files: ["OP-202 beta lane", "OP-203 gamma lane"] },
      ],
    });
  });

  it.each<[string, string]>([
    ["the em dash (U+2014)", "\u2014"],
    ["the minus sign (U+2212)", "\u2212"],
    ["a tilde", "~"],
  ])("reports a row whose range separator is %s", (_label, separator) => {
    // Arrange — "two backticked numbers with one non-alphanumeric separator
    // between them" is what makes a row range-shaped, whatever the separator
    // is. Only `–` (U+2013) and `-` are accepted, so every other separator is a
    // reservation the parser cannot see.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger([`| OP-201 alpha lane | \`0760\`${separator}\`0779\` | \`0761\` |`])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [{ code: malformedCode, number: null, files: ["OP-201 alpha lane"] }],
    });
  });

  it("reports a three-digit pair as lane-range-malformed", () => {
    // Arrange — the ledger's numbers are zero-padded to four digits, so
    // `760`-`779` is a typo that reserves nothing today.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger([
        "| OP-201 alpha lane | `760`-`779` | `761` |",
        "| OP-202 beta lane  | `0780`-`0799` | `0781` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert — the valid row is untouched, so exactly one issue is reported.
    expect(result).toEqual({
      ok: false,
      issues: [{ code: malformedCode, number: null, files: ["OP-201 alpha lane"] }],
    });
  });

  it("reports one issue per offending row, ordered by holder", () => {
    // Arrange — README order is deliberately reversed: the two rows tie on
    // (number, code), so the report must order them by `files[0]`.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger([
        "| OP-203 gamma lane | `0780`-`0760` | `0781` |",
        "| OP-201 alpha lane | `760`-`779` | `761` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: malformedCode, number: null, files: ["OP-201 alpha lane"] },
        { code: malformedCode, number: null, files: ["OP-203 gamma lane"] },
      ],
    });
  });

  it("reports no malformed row for a ledger whose rows all use the accepted form", () => {
    // Arrange — no false positives: en dash, plain hyphen and a spaced en dash
    // are all accepted, and none of them is reported.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger([
        "| OP-201 alpha lane | `0760`–`0779` | `0761` |",
        "| OP-202 beta lane  | `0780`-`0799` | `0781` |",
        "| OP-203 gamma lane | `0800` – `0819` | `0801` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("reports no malformed row for the repository's real ledger", () => {
    // Act — the zero-false-positive proof on the board's most-edited table: any
    // row of `docs/adr/README.md` misread as range-shaped would show up here.
    const result = checkAdrDirectory(realAdrDir);

    // Assert (the same report is pinned by the plain `checkAdrDirectory` block
    // above; this case names the malformed-row code so a false positive is
    // diagnosable from the failing case alone).
    expect(result.issues.filter((issue) => issue.code === malformedCode)).toEqual([]);
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("reports a duplicate number and a malformed range from the same directory", () => {
    // Arrange — the two invariants are independent: neither may swallow the
    // other. `duplicate` sorts first (it carries a number; both null-number
    // issues come last).
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0146-a.md", "ADR-0146-b.md"],
      laneLedger(["| OP-201 alpha lane | `0780`-`0760` | `0781` |"])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "duplicate",
          number: "0146",
          files: ["ADR-0146-a.md", "ADR-0146-b.md"],
        },
        { code: malformedCode, number: null, files: ["OP-201 alpha lane"] },
      ],
    });
  });

  it("reports nothing for rows that are not range-shaped", () => {
    // Arrange — the non-vacuity control for the whole rule: the header row, the
    // `---` separator row, the open-ended pool cell, a cell holding a single
    // backticked number, a prose mention and the ADR index rows all stay silent.
    // Only two backticked numbers with a non-alphanumeric separator between them
    // make a row range-shaped.
    const markdown = [
      laneLedger([
        "| unallocated (future lanes) | `0700`+ (20 per lane, in order) | `0700` |",
        "| OP-201 alpha lane          | `0780`                          | `0781` |",
      ]),
      "",
      "The OP-129 lane holds `0769`-`0788`; the uploads lane holds `0760`-`0779`.",
      "",
      "| ADR                                                                    | Title                    | Status   |",
      "| ---------------------------------------------------------------------- | ------------------------ | -------- |",
      "| [0001](ADR-0001-ports-and-adapters.md)                                 | Ports and adapters       | Accepted |",
    ].join("\n");
    const dir = makeTempAdrDirWithReadme(["ADR-0760-a.md"], markdown); // adr-fixture

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("keeps an ADR index row whose title quotes two numbers with a slash silent", () => {
    // Arrange — measured on the real ledger: the ADR-0341 index row's title cell
    // reads "the `402`/`403` denial split". Read purely literally ("two
    // backticked number tokens with a non-alphanumeric separator between them")
    // that row is range-shaped, so reporting it would make the real ledger fail
    // the clean-report pin above. A slash is not range notation, and an index
    // row is not a reservation: it must stay silent.
    const markdown = [
      "| ADR                                          | Title                                                                  | Status   |",
      "| -------------------------------------------- | ---------------------------------------------------------------------- | -------- |",
      "| [0341](ADR-0341-op103-entitlements-green.md) | OP-103 GREEN: the `402`/`403` denial split and the registry extensions | Accepted |", // adr-fixture
    ].join("\n");
    const dir = makeTempAdrDirWithReadme(["ADR-0760-a.md"], markdown); // adr-fixture

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });
});
