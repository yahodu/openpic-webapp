/**
 * OP-140 TEST — pin the ADR ledger's **row shape** (S1), the record-`Status:` ↔
 * ledger-cell **agreement** (S2), and the **rowless-record** hard failure (S3).
 *
 * **Why this exists.** The other landed `adr-*` guards check number uniqueness,
 * file-name shape, lane ranges, links, citations, consumers, item sections,
 * gate conditions and code-span hygiene. Not one reads a ledger row as a table
 * row, and not one reads a record's `Status:` line, so the same defect shipped
 * four times:
 *
 * - `0892` (`README.md:550` before the repair) had **no status cell and no
 *   trailing pipe** → GitHub renders the Status column empty;
 * - **19** rows carried an unescaped `|` in the title (`0664`, `0665`, `0686`,
 *   `0763`, `0812`, `0814`, `0824`, `0834`, `0845`, `0855`, `0857`, `0858`,
 *   `0860`, `0866`, `0875`, `0882`, `0897`, `0899`, `0941`) → the row splits
 *   into more cells than the header has, and GFM **drops every cell past the
 *   header's column count**, rendering a title fragment in the Status column;
 * - `0893`'s cell said `Draft (RED pins; a GREEN is owed)` while its record said
 *   `Accepted`.
 *
 * The render proof is GitHub's own renderer, which is what makes this a defect
 * rather than a style preference:
 *
 * ```
 * gh api -X POST markdown -F text=@probe.md -f mode=gfm
 * ```
 *
 * **The rule.** Pure, over the ledger text and the records' text:
 *
 * ```
 * module  apps/web/src/test/helpers/adr-ledger-shape.ts
 *
 * checkAdrLedgerRowShape(ledger: { path, text }): AdrLedgerRowShapeResult
 * checkAdrLedgerStatusAgreement(ledger, records: { fileName, text }[]): AdrLedgerStatusResult
 * findAdrRecordsWithoutLedgerRow(ledger, records): { number, file }[]
 * checkRepositoryAdrLedgerShape(root: string): { shape, status, missingRows }
 * adrStatusWord(value: string): string
 * ```
 *
 * **S1 — every row renders a status.** The header is `| ADR | Title | Status |`
 * (`docs/adr/README.md:130` at this head), so a correct row splits on
 * **unescaped** `|` into `columns + 2` parts: the two boundary empties plus one
 * per header cell. Every `| [NNNN](ADR-*.md) |` row must split into exactly that
 * count and carry a non-empty status cell (part `columns`). A ledger whose
 * header carries **no rows** is `ok: false`, not a vacuous green, and a document
 * with no header throws rather than reporting zero rows.
 *
 * **S1c — the ledger block stays one table.** Between the header's delimiter
 * row and the last ledger row in the document, every non-empty line must itself
 * be a ledger row. A blank line ends a GFM table, so every row below it renders
 * as a **paragraph** — and the guard's own purpose, "every row renders a
 * status", is then not served at all. On the squash `fc8fab29` (PR #931) a blank
 * line between the `0987` and the `0988` rows made GitHub render **3** `<tr>`
 * (header, `0986`, `0987`) and the `0988` row as `<p>…| Accepted (GREEN) |</p>`,
 * while S1 read all four rows as well formed and the ten `adr-*` guards stayed
 * at `340 passed`. The render proof is the same GitHub renderer S1's cases cite:
 *
 * ```
 * { sed -n '158,159p' docs/adr/README.md; sed -n '650,653p' docs/adr/README.md; } > probe.md
 * gh api -X POST markdown -F text=@probe.md -f mode=gfm
 * ```
 *
 * The rule reports into **S1's own `issues` array** — `{ line, reason }`, with
 * `reason` `blank-line` for an empty line and `non-row` for a non-empty line
 * that is not a `| [NNNN](ADR-*.md) | …` row — so the **one** real-tree case
 * below (`expect(shape.issues).toEqual([])`, reading the whole tree through
 * {@link checkRepositoryAdrLedgerShape}) covers row shape and contiguity
 * together and no second real-tree case is written. A row whose cell count is
 * wrong stays S1's `cell-count` report and is not repeated here; a blank line
 * *after* the last ledger row is the prose that separates the table from its
 * notes, not a detachment, so the block ends at the last row-shaped line in the
 * document (`README.md:653` at this cut).
 *
 * **The census at this cut** (`origin/main` `e7e92304`, which carries the README
 * repair `bc399470` plus #933 and #936): header `README.md:158`, delimiter
 * `:159`, **494** ledger rows on `:160`–`:653`, and **0** blank or non-row lines
 * between them, so the real-tree case is green — measured in this checkout. The
 * rule is not vacuous and not tree-shaped: the synthetic cases below report a
 * blank line and an interrupting prose line, and the negative control proves
 * contiguous rows are silent. Replayed with the defect restored it is
 * load-bearing — one blank line re-inserted above the `0988` row gives
 * `[{ line: 653, reason: "blank-line" }]` and `1 failed | 342 passed (343)`,
 * the real-tree case being **the only red**, and the `fc8fab29` blob gives
 * `[{ line: 652, reason: "blank-line" }]`.
 *
 * **The header's delimiter row is read too.** S1c's sweep starts at
 * `headerLine + 2`, so the line directly under the header (`headerLine + 1`)
 * sat outside **every** rule: no guard read the delimiter row. Measured on the
 * trunk `cd878591`: a copy of `docs/adr/README.md` with `:159` deleted and a
 * second copy whose `:159` reads `| --- |` both returned
 * `{ ok: true, columns: 3, rows: 494, issues: [] }` from
 * {@link checkAdrLedgerRowShape}, and the ten `adr-*` guards stayed
 * `10 passed (10)` / `343 passed (343)`. GitHub's own renderer, over the
 * five-line excerpt `:158`–`:162` (`gh api -X POST markdown -f mode=gfm`),
 * emitted **4** `<tr>` and **9** `<td>` for the control and **0** `<tr>`,
 * **0** `<td>` and **1** `<p>` for each mutation — the whole ledger as one
 * paragraph: no table, no status column. Same "renders nothing" class as S1c,
 * one line above its scope.
 *
 * The rule is **decided** on this card and reports into S1's own `issues`
 * array, in the same `{ line, reason }` shape: `delimiter-missing` when
 * `headerLine + 1` is empty or is not a `|`-delimited line of dashes at all,
 * `delimiter-cells` when that line is a delimiter row whose cell count differs
 * from the header's. The reported `line` is the delimiter line, `ok` stays
 * `rows > 0 && issues.length === 0`, and the array stays sorted by line. No
 * second real-tree census case is added: these reasons report into the same
 * `shape.issues` array the real-tree case above already asserts empty, so that
 * one case covers them as well.
 *
 * **Which delimiter shapes are *accepted* is pinned too.** The rule's cell
 * pattern (`/^:?-+:?$/u`) admits one dash or more per cell with optional `:`
 * alignment, so `| :--- | :---: | ---: |`, `| - | - | - |` and
 * `| -- |   -----   | ------ |` are all delimiter rows. Each shape has its own
 * case in the S1d block, because a later tightening (say `/^-{3,}$/u`, or a
 * dropped `:` alternative) would otherwise reject valid GFM delimiter rows with
 * the whole suite still green — the silent-narrowing class this guard exists to
 * stop. The cases are proven load-bearing by mutating the pattern, not by a red
 * handoff: the landed rule already accepts these shapes. The **whitespace** half
 * of the rule is pinned the same way: a delimiter row indented by two spaces
 * (`"  | --- | ----- | ------ |"`) and one carrying trailing spaces after its
 * closing pipe (`"| --- | ----- | ------ |   "`) are both accepted, because
 * `tableCellsOf` trims the line before it splits on `|`.
 *
 * **The block-end boundary is frozen, not moved.** S1c's block closes at the
 * **last row-shaped line in the document**, so prose carrying a row-shaped
 * example is *inside* the block: `header + two rows + "" + "Notes: a new record
 * is added as" + "" + one row-shaped example line` reports exactly three issues
 * — `blank-line`, `non-row`, `blank-line` — measured at `0ccc18f4` and again on
 * this cut. The characterization case at the end of the S1c block pins that
 * reading so a later change to it must be deliberate. It demands no behaviour
 * change, and the decided position stands: a stray example row fails loudly
 * and is moved out of the table.
 *
 * **S1e — the ledger ascends, with gaps allowed.** Taken in file order, the
 * ledger's `NNNN` values must be **strictly increasing**: a row whose number is
 * lower than its predecessor's makes a reader who scans the ledger by number
 * jump backwards. Two such rows shipped green — `0973` before `0971`/`0972`
 * (PR #885, repaired by #941) and `0989` before `0986` (PR #933, repaired by
 * #937) — and all ten `adr-*` guards answered `340 passed (340)` on both trees,
 * so nothing compared consecutive numbers. **Gaps are allowed**: a number is
 * skipped while it is in flight, so the ledger is not a contiguous census. The
 * precedent is ADR-0986's round-1 review sign-off, which reads `0982`, `0983`,
 * `0986` *ascending with `0986` directly after `0983` because `0984`/`0985` are
 * then still reserved in flight*, and the four pool-mirror cells legitimately
 * sit **ahead** of the last row (`0991` beside the `0990` row at this cut). A
 * **repeated** number is reported too: it is neither ascending nor a gap.
 *
 * The issue lands in S1's own `issues` array as `{ line, reason }` — the
 * offending row's own line, and a reason naming both lines — so the **one**
 * real-tree case above covers it as well: `{ line: 636, reason: "0971 precedes
 * 0973 on line 635" }` for a descent, `{ line: 4, reason: "0970 repeats on
 * line 3" }` for a repeat. The rule is derived from the parsed row sequence,
 * never from a row's position or the table's line numbers, so inserting a row
 * cannot shift it.
 *
 * **The census at this cut** (`origin/main` `2345326c`): header `README.md:158`,
 * delimiter `:159`, **495** ledger rows on `:160`–`:654`, numbering `0001`–`0990`
 * with **0** descents and **0** repeated numbers — measured over the whole
 * ledger in this checkout. Replayed on the defective tree `e7e92304`
 * (`git show e7e92304:docs/adr/README.md`, **494** rows) the rule reports
 * exactly **two** issues: `{ line: 636, reason: "0971 precedes 0973 on line
 * 635" }` and `{ line: 651, reason: "0986 precedes 0989 on line 650" }`. That
 * replay is not a committed case — `HEAD^` does not exist in the `ci` job's
 * `fetch-depth: 1` checkout — so the synthetic cases below are the in-suite
 * proof that the rule is not vacuous.
 *
 * **S2 — the record and the cell agree on their first word.** Both sides are
 * normalised by {@link adrStatusWord} (strip `**`, strip a leading `-`/`*`,
 * cut at `(`/`:`/`—`/`,`/`;`/`·`, lowercase) and the cell's first word must
 * equal the record's **or** be `superseded` — the `0092` exception, where the
 * record says `Accepted` and the cell says `Superseded (part) by 0127` because
 * the supersession happened after the acceptance. That exception is pinned here
 * as load-bearing: the two words really differ, and only the cell's
 * `superseded` makes it green.
 *
 * **S3 — a missing row is a failure.** Every record under `docs/adr/` carries
 * its own ledger row, added by the same pull request, so the record set equals
 * the row set at every merged head and the rowless-record list over the real
 * tree must be **empty** — `expect(missingRows).toEqual([])`. The list keeps
 * its `{ number, file }` shape (the docs card's own verification reads it), and
 * the synthetic cases below prove the rule is not vacuous in either direction:
 * a record with no row is reported once, a record with its row is not reported.
 *
 * **S2 still reads only rows that exist.** The earlier card body asked S2 to
 * treat a missing ledger row as an S2 issue; the reviewer's comment
 * (`2026-11-23`) narrowed that, and the narrowing stands: S2 is hard over rows
 * that **exist**, and a rowless record is S3's business. That is why
 * `findAdrRecordsWithoutLedgerRow` is a separate function with its own `it()`,
 * and why S2's report stays green while S3 hard-fails on the same tree.
 *
 * **The census at this branch head** (`origin/main` `66fa387c`, the release
 * squash on top of PR #844): **460** records under `docs/adr/`, **460** ledger
 * rows, **0** shape issues, **0** agreement issues, **0** rowless records —
 * measured in this checkout with {@link checkRepositoryAdrLedgerShape} plus the
 * two raw counts (`ls docs/adr | grep -c '^ADR-'` and the number of
 * `| [NNNN](…) |` rows in `docs/adr/README.md`), both 460. So S3's real-tree
 * case is **green** at this head — `expect(missingRows).toEqual([])` — and that
 * is the **decided** state, not a coincidence: ADR-0319 (`1260f008`, PR #842)
 * makes every record carry its ledger row, added by the same pull request, so
 * no trunk commit is red in between and no repair is owed. S1 and S2 are not
 * vacuous either — replayed against the
 * pre-repair bytes
 * (`d507965f^`) the same rules report **20** shape-defective rows (the 19 stray
 * pipes plus `0892`'s three-cell row) and **21** agreement failures (those 20,
 * whose status cell is unreadable, plus `0893`'s `Accepted`/`Draft`). That
 * replay is not a committed case: `HEAD^` does not exist in the `ci` job's
 * `fetch-depth: 1` checkout, so it would be a false pass there. The synthetic
 * three-row case below is the in-suite proof that the parser is not vacuous.
 *
 * **Out of scope, stated so it is not mistaken for a gap.** No `docs/adr/`
 * byte is edited here (the gated docs card owned the row and landed it as
 * ADR-0319); the ledger's *prose*
 * blocks are not read as tables; and a row-shaped line **inside a fenced block
 * is read on purpose** — kept by decision (`t_942aa8e6`, F2) because fence
 * tracking's failure mode is a mis-tracked fence hiding a **real** row, the one
 * false green this guard exists to prevent, while a stray example row instead
 * fails loudly and is fixed by moving the example out of the table. The census
 * when the rule was pinned (`9f51c3bb`) was 455 row-shaped lines outside fences
 * and **0** inside — 455 row-shaped lines, 455 ledger rows — so no real row is
 * hidden by the scan. A record's multi-`Status:` value is read from its
 * canonical **bulleted** `- **Status:**` line: the first bulleted line wins, a
 * bare `Status:` line after it is prose and never overrides it, and only a
 * record that carries **no** bulleted line falls back to its first match
 * anywhere — all three clauses are pinned below (F3 of `t_942aa8e6`). And the
 * missing-row policy is **decided** (ADR-0319): every record carries its row,
 * so this spec, not the helper, fails on a rowless one.
 *
 * **The one residual of S1, stated so the shape-only contract is not
 * over-read.** S1 is **shape-only**: a row with one unescaped title pipe **and**
 * a dropped status cell splits into 5 parts, so S1 reads a title fragment as
 * the status and passes — `{ ok: true, columns: 3, rows: 1, issues: [] }` for
 * `| [0105](ADR-0105-x.md) | the change is |accepted |`. **S2 is the semantic
 * backstop** for that class, and a status vocabulary was considered and
 * **rejected**: it is subsumed by S2 — every real row has a record, and the
 * real first words are `accepted` ×454 / `proposed` ×2 in the records and
 * `accepted` ×452 / `superseded` ×1 / `proposed` ×2 in the cells, so any
 * vocabulary admits exactly what S2 already admits — while the case that
 * survives both rules needs an exact-cell match, which would red the real rows
 * whose status legitimately reads `Accepted (GREEN landed: …)`.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRepoRoot, realAdrDir, repoRoot, tempDirs } from "../helpers/adr-guard-fixtures.js";
import type { AdrLedgerRowShapeResult } from "../helpers/adr-ledger-shape.js";
import {
  ADR_LEDGER_PATH,
  adrStatusWord,
  checkAdrLedgerRowShape,
  checkAdrLedgerStatusAgreement,
  checkRepositoryAdrLedgerShape,
  findAdrRecordsWithoutLedgerRow,
} from "../helpers/adr-ledger-shape.js";
import { readTextFile } from "../helpers/adr-source-references.js";

/** The ledger header a synthetic fixture carries, exactly as the real one reads. */
const HEADER_LINE = "| ADR | Title | Status |";

/** The header's delimiter row as the real ledger writes it (`README.md:159`). */
const DELIMITER_LINE = "| --- | ----- | ------ |";

/** The two lines a synthetic ledger starts with, header then delimiter. */
const HEADER_LINES = [HEADER_LINE, DELIMITER_LINE];

/** A synthetic ledger document built from its lines, kept out of `docs/adr/`. */
function syntheticLedger(lines: string[]): { path: string; text: string } {
  return { path: ADR_LEDGER_PATH, text: lines.join("\n") };
}

/** The real ledger's whole text, read from this checkout. */
function realLedger(): { path: string; text: string } {
  return { path: ADR_LEDGER_PATH, text: readTextFile(join(realAdrDir, "README.md")) };
}

/** One real record, as S2 reads it. */
function realRecord(fileName: string): { fileName: string; text: string } {
  return { fileName, text: readTextFile(join(realAdrDir, fileName)) };
}

/**
 * One row of the **real** ledger, with the status cell a renderer would show
 * (the line's last cell — a well-formed row's status cell) and the record file
 * its link names. Throws when the number has no row, so a characterisation case
 * can never pass because the row moved away.
 */
function realLedgerRow(number: string): { line: string; cell: string; record: string } {
  const line = realLedger()
    .text.split("\n")
    .find((candidate) => candidate.trimStart().startsWith(`| [${number}](`));

  if (line === undefined) {
    throw new Error(`the real ledger carries no row for ${number}`);
  }

  const cell = /\|\s*([^|\n]+?)\s*\|\s*$/u.exec(line.trim())?.[1] ?? "";
  const record = /\]\(([^)]*\.md)\)/u.exec(line)?.[1] ?? "";

  return { line, cell, record };
}

/** A record's `Status:` value as written, first match only. */
function recordStatusValue(recordText: string): string {
  return /\*\*Status:\*\*\s*(.*)/u.exec(recordText)?.[1] ?? "";
}

/**
 * One ledger carrying the real row under test, so a characterisation case reads
 * the **real** cell against the **real** record and nothing else.
 */
function ledgerWithRow(rowLine: string): { path: string; text: string } {
  return syntheticLedger([...HEADER_LINES, rowLine]);
}

/* ------------------------------------------------------------------------- *
 * S1 — the row shape, at the pure seam
 * ------------------------------------------------------------------------- */

describe("checkAdrLedgerRowShape — a ledger row renders its status", () => {
  it("reports a short row and a row with an unescaped `|` in its title, and leaves the correct row out", () => {
    // Arrange — three rows: one short (no status cell, no trailing pipe), one
    // whose title carries an unescaped pipe, one correct. This is the defect
    // class in miniature; the correct row must not be reported.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0101](ADR-0101-short.md) | a row with no status cell |", // adr-fixture: synthetic row, no such record
      "| [0102](ADR-0102-stray-pipe.md) | POST /me/invitations/{id}/accept|reject | Accepted |", // adr-fixture: synthetic row, no such record
      "| [0103](ADR-0103-correct.md) | a correct row | Accepted |", // adr-fixture: synthetic row, no such record
    ]);

    // Act
    const result = checkAdrLedgerRowShape(ledger);

    // Assert — exactly the two defective rows, on their own lines, and the
    // correct row absent. `status: ""` on both: neither has a cell a renderer
    // would show.
    expect(result).toEqual({
      ok: false,
      columns: 3,
      rows: 3,
      issues: [
        { number: "0101", line: 3, cells: 4, status: "", issues: ["cell-count"] },
        { number: "0102", line: 4, cells: 6, status: "", issues: ["cell-count"] },
      ],
    });
  });

  it("reports a row whose status cell is empty even though its cell count is right", () => {
    // Arrange — the other half of the defect: the pipes are all there, the cell
    // is not. GFM renders an empty Status cell, which is the `0892` symptom
    // without the missing pipe.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0104](ADR-0104-empty.md) | a title with a status cell |  |", // adr-fixture: synthetic row, no such record
    ]);

    // Act
    const result = checkAdrLedgerRowShape(ledger);

    // Assert
    expect(result).toEqual({
      ok: false,
      columns: 3,
      rows: 1,
      issues: [{ number: "0104", line: 3, cells: 5, status: "", issues: ["empty-status"] }],
    });
  });

  it("does not pass a ledger that carries the header but no rows", () => {
    // Arrange — the vacuous-green shape: a header and nothing to check.
    const ledger = syntheticLedger([...HEADER_LINES, ""]);

    // Act
    const result = checkAdrLedgerRowShape(ledger);

    // Assert — zero rows is a failure, never `ok: true`.
    expect(result).toEqual({ ok: false, columns: 3, rows: 0, issues: [] });
  });

  it("throws when the document carries no ledger header", () => {
    // Arrange — a wrong document must fail loudly, not report zero rows.
    const ledger = syntheticLedger(["# notes", "", "- [0101](ADR-0101-short.md) — prose"]); // adr-fixture: synthetic row, no such record

    // Act + Assert
    expect(() => checkAdrLedgerRowShape(ledger)).toThrow(/no ledger table header/u);
  });
});

/* ------------------------------------------------------------------------- *
 * S1 — the real ledger
 * ------------------------------------------------------------------------- */

describe("checkAdrLedgerRowShape — the real ledger", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("splits every row of the real ledger into the header's cells with a non-empty status", () => {
    // Arrange + Act — the whole tree.
    const { shape } = checkRepositoryAdrLedgerShape(repoRoot);

    // Assert — the defect class is empty after the repair card, and the census
    // proves the rule read the ledger: 455 rows measured at `d507965f`. The
    // floor carries headroom for a record that is added later, never for a row
    // that stops being read. S1c reports into this same array, so this is the
    // case that reds on a detached row: one blank line re-inserted above the
    // `0988` row makes it fail with `[{ line: 653, reason: "blank-line" }]`.
    expect(shape.issues).toEqual([]);
    expect(shape.ok).toBe(true);
    expect(shape.columns).toBe(3);
    expect(shape.rows).toBeGreaterThanOrEqual(455);
  });

  it("throws an ENOENT error when the tree carries no ledger", () => {
    // Arrange — a repository with records but no `docs/adr/README.md`.
    const root = makeTempRepoRoot({
      "docs/adr/ADR-0300-alpha.md": "# alpha", // adr-fixture: fixture record name
    });

    // Act + Assert — a tree with no ledger is a failure, not a zero-row pass.
    expect(() => checkRepositoryAdrLedgerShape(root)).toThrow(
      expect.objectContaining({ code: "ENOENT" })
    );
  });
});

/* ------------------------------------------------------------------------- *
 * S1c — the ledger block stays one table: a blank line detaches the rows below
 * ------------------------------------------------------------------------- */

describe("checkAdrLedgerRowShape — the ledger block stays one table", () => {
  it("reports the blank line that detaches a row, and still counts both rows", () => {
    // Arrange — the shape of `fc8fab29` (PR #931): a blank line between two
    // ledger rows. GFM ends a table at a blank line, so the second row renders
    // as a paragraph while S1 alone reads both rows as well formed — the
    // `gh api -X POST markdown -F text=@probe.md -f mode=gfm` probe in the
    // module docblock returned 3 `<tr>` and emitted that row as `<p>…</p>`.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0300](ADR-0300-alpha.md) | the first row | Accepted |", // adr-fixture: synthetic row, no such record
      "",
      "| [0301](ADR-0301-beta.md) | the detached row | Accepted |", // adr-fixture: synthetic row, no such record
    ]);

    // Act
    const result = checkAdrLedgerRowShape(ledger);

    // Assert — one issue, on the blank line's own line and with the documented
    // reason. Both rows are still counted: this reports the blank line that
    // detaches them, never the rows themselves.
    expect(result).toEqual({
      ok: false,
      columns: 3,
      rows: 2,
      issues: [{ line: 4, reason: "blank-line" }],
    });
  });

  it("reports a non-row line that interrupts the block", () => {
    // Arrange — the same detachment from the other direction: prose left
    // between two rows ends the table just as a blank line does, so the row
    // below it is detached and renders as a paragraph too.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0300](ADR-0300-alpha.md) | the first row | Accepted |", // adr-fixture: synthetic row, no such record
      "A paragraph left between the ledger's rows.",
      "| [0301](ADR-0301-beta.md) | the detached row | Accepted |", // adr-fixture: synthetic row, no such record
    ]);

    // Act
    const result = checkAdrLedgerRowShape(ledger);

    // Assert — the interrupting line, and only it.
    expect(result).toEqual({
      ok: false,
      columns: 3,
      rows: 2,
      issues: [{ line: 4, reason: "non-row" }],
    });
  });

  it("reports nothing when the ledger rows are contiguous", () => {
    // Arrange — the negative control: the same two rows with nothing between
    // them. Without this case the rule above would be satisfied by a report
    // that fires on every ledger, so the pair is what makes it load-bearing.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0300](ADR-0300-alpha.md) | the first row | Accepted |", // adr-fixture: synthetic row, no such record
      "| [0301](ADR-0301-beta.md) | the second row | Accepted |", // adr-fixture: synthetic row, no such record
    ]);

    // Act + Assert — no issue, and the rows are counted.
    expect(checkAdrLedgerRowShape(ledger)).toEqual({
      ok: true,
      columns: 3,
      rows: 2,
      issues: [],
    });
  });

  it("reads a row-shaped example line under the notes as inside the block — the frozen block end", () => {
    // Arrange — the boundary F-R2 measured at `0ccc18f4`: the block closes at
    // the **last row-shaped line in the document**, so the notes a ledger
    // carries between its table and an example row are *inside* the block.
    // Characterization, not a demand: it freezes today's reading so a later
    // change to it must be deliberate, and it is green before and after the
    // delimiter rule.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0300](ADR-0300-alpha.md) | the first row | Accepted |", // adr-fixture: synthetic row, no such record
      "| [0301](ADR-0301-beta.md) | the second row | Accepted |", // adr-fixture: synthetic row, no such record
      "",
      "Notes: a new record is added as",
      "",
      "| [0302](ADR-0302-gamma.md) | an example row, outside the table | Accepted |", // adr-fixture: synthetic row, no such record
    ]);

    // Act
    const result = checkAdrLedgerRowShape(ledger);

    // Assert — exactly the three lines between the second row and the example
    // line: the blank line, the prose, the blank line. The example row is
    // itself row-shaped, so it is never reported here whatever its cell count.
    expect(result).toEqual({
      ok: false,
      columns: 3,
      rows: 3,
      issues: [
        { line: 5, reason: "blank-line" },
        { line: 6, reason: "non-row" },
        { line: 7, reason: "blank-line" },
      ],
    });
  });
});

/* ------------------------------------------------------------------------- *
 * S1 — the header's delimiter row: without it the header is not a table
 * ------------------------------------------------------------------------- */

describe("checkAdrLedgerRowShape — the header's delimiter row", () => {
  it("reports delimiter-missing when the line under the header is empty", () => {
    // Arrange — the shape measured on the trunk `cd878591`: `README.md:159`,
    // the `| --- | ---- | ------ |` row, deleted. GitHub then renders the whole
    // ledger as one `<p>` — 0 `<tr>`, 0 `<td>` — while the ten `adr-*` guards
    // stay green, so no status column exists and no row is read as a table row.
    const ledger = syntheticLedger([
      HEADER_LINE,
      "",
      "| [0300](ADR-0300-alpha.md) | the first row | Accepted |", // adr-fixture: synthetic row, no such record
      "| [0301](ADR-0301-beta.md) | the second row | Accepted |", // adr-fixture: synthetic row, no such record
    ]);

    // Act
    const result = checkAdrLedgerRowShape(ledger);

    // Assert — one issue, on the delimiter's own line (`headerLine + 1`), and
    // both rows are still counted: the rows are well formed, the table is not.
    // Typed, so the decided reason is part of the contract and not only a
    // string a loosened assertion would accept.
    const expected: AdrLedgerRowShapeResult = {
      ok: false,
      columns: 3,
      rows: 2,
      issues: [{ line: 2, reason: "delimiter-missing" }],
    };
    expect(result).toEqual(expected);
  });

  it("reports delimiter-cells when the line under the header is a one-cell delimiter row", () => {
    // Arrange — the second measured shape: `README.md:159` replaced by
    // `| --- |`, a delimiter row of one cell under a three-cell header. The
    // render is the same as a missing row — 0 `<tr>`, the ledger as one `<p>`.
    const ledger = syntheticLedger([
      HEADER_LINE,
      "| --- |",
      "| [0300](ADR-0300-alpha.md) | the first row | Accepted |", // adr-fixture: synthetic row, no such record
      "| [0301](ADR-0301-beta.md) | the second row | Accepted |", // adr-fixture: synthetic row, no such record
    ]);

    // Act
    const result = checkAdrLedgerRowShape(ledger);

    // Assert — the same line, the distinct reason: the line *is* a delimiter
    // row, so the defect is its cell count and not its presence.
    const expected: AdrLedgerRowShapeResult = {
      ok: false,
      columns: 3,
      rows: 2,
      issues: [{ line: 2, reason: "delimiter-cells" }],
    };
    expect(result).toEqual(expected);
  });

  it("reports nothing when an empty line above the header precedes a correct delimiter", () => {
    // Arrange — the negative control: a leading blank line above the header,
    // then the header and its correct delimiter. A reader that measures the
    // line above the header, or that reads the blank line as the delimiter,
    // reds here while the two cases above stay green, so the pair is what
    // makes the rule load-bearing.
    const ledger = syntheticLedger([
      "",
      HEADER_LINE,
      DELIMITER_LINE,
      "| [0300](ADR-0300-alpha.md) | the first row | Accepted |", // adr-fixture: synthetic row, no such record
      "| [0301](ADR-0301-beta.md) | the second row | Accepted |", // adr-fixture: synthetic row, no such record
    ]);

    // Act + Assert — no issue at all, and both rows are counted.
    expect(checkAdrLedgerRowShape(ledger)).toEqual({
      ok: true,
      columns: 3,
      rows: 2,
      issues: [],
    });
  });

  it("accepts an aligned delimiter row (`:` on either side of the dashes)", () => {
    // Arrange — GFM alignment: `:---` left, `:---:` centre, `---:` right. Forbids
    // tightening the cell pattern to a bare `/^-+$/u` (no `:` alternative), which
    // would reject a valid delimiter row and take the whole ledger out of the table.
    const ledger = syntheticLedger([
      HEADER_LINE,
      "| :--- | :---: | ---: |",
      "| [0300](ADR-0300-alpha.md) | the first row | Accepted |", // adr-fixture: synthetic row, no such record
      "| [0301](ADR-0301-beta.md) | the second row | Accepted |", // adr-fixture: synthetic row, no such record
    ]);

    // Act
    const result = checkAdrLedgerRowShape(ledger);

    // Assert — the aligned row *is* a delimiter row, so the table exists and no
    // issue is reported. Typed, so the whole result is the contract.
    const expected: AdrLedgerRowShapeResult = { ok: true, columns: 3, rows: 2, issues: [] };
    expect(result).toEqual(expected);
  });

  it("accepts a one-dash delimiter cell (`| - | - | - |`, GFM's one dash or more)", () => {
    // Arrange — GFM admits a single dash per cell. Forbids tightening the cell
    // pattern to `/^-{3,}$/u` (the shape the real ledger happens to use), which
    // would reject a minimum-width but valid delimiter row.
    const ledger = syntheticLedger([
      HEADER_LINE,
      "| - | - | - |",
      "| [0300](ADR-0300-alpha.md) | the first row | Accepted |", // adr-fixture: synthetic row, no such record
      "| [0301](ADR-0301-beta.md) | the second row | Accepted |", // adr-fixture: synthetic row, no such record
    ]);

    // Act
    const result = checkAdrLedgerRowShape(ledger);

    // Assert — accepted, so the row is read as a table's delimiter and no issue lands.
    const expected: AdrLedgerRowShapeResult = { ok: true, columns: 3, rows: 2, issues: [] };
    expect(result).toEqual(expected);
  });

  it("accepts mixed dash counts and padded cells (`| -- |   -----   | ------ |`)", () => {
    // Arrange — dash count is free per cell and a cell may carry spaces around its
    // dashes. Forbids a per-cell exact-width pattern (`/^-{3}$/u`) or one that
    // forgets to trim before matching, either of which would reject this row.
    const ledger = syntheticLedger([
      HEADER_LINE,
      "| -- |   -----   | ------ |",
      "| [0300](ADR-0300-alpha.md) | the first row | Accepted |", // adr-fixture: synthetic row, no such record
      "| [0301](ADR-0301-beta.md) | the second row | Accepted |", // adr-fixture: synthetic row, no such record
    ]);

    // Act
    const result = checkAdrLedgerRowShape(ledger);

    // Assert — accepted; three cells of unequal dash counts are still one delimiter row.
    const expected: AdrLedgerRowShapeResult = { ok: true, columns: 3, rows: 2, issues: [] };
    expect(result).toEqual(expected);
  });

  it("accepts an indented delimiter row (`  | --- | ----- | ------ |`, GFM's up-to-three-space indent)", () => {
    // Arrange — a GFM table may be indented by up to three spaces, and
    // `LEDGER_ROW_PATTERN` deliberately allows leading whitespace on rows, so the
    // delimiter row may be indented too. Forbids a reader that drops the
    // line-level `trim()`/`trimStart()` in `tableCellsOf`: it would reject this
    // row and take a GFM-legal indented table out of the renderer.
    const ledger = syntheticLedger([
      HEADER_LINE,
      "  | --- | ----- | ------ |",
      "| [0300](ADR-0300-alpha.md) | the first row | Accepted |", // adr-fixture: synthetic row, no such record
      "| [0301](ADR-0301-beta.md) | the second row | Accepted |", // adr-fixture: synthetic row, no such record
    ]);

    // Act
    const result = checkAdrLedgerRowShape(ledger);

    // Assert — accepted: the indented row is the table's delimiter, so no issue.
    const expected: AdrLedgerRowShapeResult = { ok: true, columns: 3, rows: 2, issues: [] };
    expect(result).toEqual(expected);
  });

  it("accepts a delimiter row with trailing spaces after its closing pipe", () => {
    // Arrange — trailing spaces after the closing `|` are invisible to the
    // renderer, so the row is still the table's delimiter. Forbids a reader that
    // trims the start only (`trimStart()`), which would reject this row.
    const ledger = syntheticLedger([
      HEADER_LINE,
      "| --- | ----- | ------ |   ",
      "| [0300](ADR-0300-alpha.md) | the first row | Accepted |", // adr-fixture: synthetic row, no such record
      "| [0301](ADR-0301-beta.md) | the second row | Accepted |", // adr-fixture: synthetic row, no such record
    ]);

    // Act
    const result = checkAdrLedgerRowShape(ledger);

    // Assert — accepted: trailing spaces do not make the delimiter row invalid.
    const expected: AdrLedgerRowShapeResult = { ok: true, columns: 3, rows: 2, issues: [] };
    expect(result).toEqual(expected);
  });
});

/* ------------------------------------------------------------------------- *
 * S1e — the ledger ascends: a lower number after a higher one is a defect
 * ------------------------------------------------------------------------- */

describe("checkAdrLedgerRowShape — the ledger ascends, with gaps allowed", () => {
  it("reports the descent when a row's number is lower than its predecessor's", () => {
    // Arrange — the `0973`/`0971` shape in miniature: `0970`, then `0973`,
    // then the late `0971`. A guard that parses the rows but never compares
    // consecutive numbers (the state before this rule) reports nothing here.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0970](ADR-0970-alpha.md) | the first row | Accepted |", // adr-fixture: synthetic row, no such record
      "| [0973](ADR-0973-gamma.md) | the row that landed early | Accepted |", // adr-fixture: synthetic row, no such record
      "| [0971](ADR-0971-beta.md) | the row that slipped in late | Accepted |", // adr-fixture: synthetic row, no such record
    ]);

    // Act
    const result = checkAdrLedgerRowShape(ledger);

    // Assert — exactly one issue, on the descending row's own line, with a
    // reason that names both lines so the message explains itself.
    const expected: AdrLedgerRowShapeResult = {
      ok: false,
      columns: 3,
      rows: 3,
      issues: [{ line: 5, reason: "0971 precedes 0973 on line 4" }],
    };
    expect(result).toEqual(expected);
  });

  it("reports a repeated number as an issue too", () => {
    // Arrange — the same `NNNN` twice. Equal is neither ascending nor a gap,
    // so it is a defect of the same class: two rows claim one number.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0970](ADR-0970-alpha.md) | the row | Accepted |", // adr-fixture: synthetic row, no such record
      "| [0970](ADR-0970-alpha-again.md) | the same number again | Accepted |", // adr-fixture: synthetic row, no such record
    ]);

    // Act
    const result = checkAdrLedgerRowShape(ledger);

    // Assert — one issue, on the repeat's line, naming the line it repeats.
    const expected: AdrLedgerRowShapeResult = {
      ok: false,
      columns: 3,
      rows: 2,
      issues: [{ line: 4, reason: "0970 repeats on line 3" }],
    };
    expect(result).toEqual(expected);
  });

  it("reports nothing when a number is skipped — a gap is not a defect", () => {
    // Arrange — the negative control: `0970`, `0973`, `0974`. `0971`/`0972`
    // are in flight, so the sequence is ascending with a gap. Without this
    // case the rule above would be satisfied by a contiguity check that fires
    // on every real ledger, whose pool cells sit ahead of the last row.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0970](ADR-0970-alpha.md) | the first row | Accepted |", // adr-fixture: synthetic row, no such record
      "| [0973](ADR-0973-gamma.md) | a skipped number is fine | Accepted |", // adr-fixture: synthetic row, no such record
      "| [0974](ADR-0974-delta.md) | the next row | Accepted |", // adr-fixture: synthetic row, no such record
    ]);

    // Act + Assert — no issue at all, and all three rows are counted.
    expect(checkAdrLedgerRowShape(ledger)).toEqual({
      ok: true,
      columns: 3,
      rows: 3,
      issues: [],
    });
  });

  it("reads the real ledger as ascending, over every row it counts", () => {
    // Arrange — an independent count of the ledger's row-shaped lines, so an
    // empty issue list cannot be a sweep that read nothing.
    const rowLines = realLedger()
      .text.split("\n")
      .filter((line) => /^\s*\|\s*\[\d{4}\]\(ADR-[^)\s]*\.md\)/u.test(line));

    // Act
    const { shape } = checkRepositoryAdrLedgerShape(repoRoot);

    // Assert — the census at this cut is 495 rows, `0001`–`0990`, 0 descents
    // and 0 repeats; the equal count is the rule's own reading of the tree.
    expect(shape.rows).toBe(rowLines.length);
    expect(shape.rows).toBeGreaterThanOrEqual(495);
    expect(shape.issues).toEqual([]);
    expect(shape.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------------- *
 * S2 — the agreement, at the pure seam
 * ------------------------------------------------------------------------- */

describe("checkAdrLedgerStatusAgreement — a record's Status first word and its cell", () => {
  it("reports a record whose status disagrees with its ledger cell", () => {
    // Arrange — `0893`'s shape: the record was accepted, the cell still says
    // draft.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0200](ADR-0200-alpha.md) | the record | Draft (RED pins; a GREEN is owed) |", // adr-fixture: synthetic row, no such record
    ]);
    const records = [
      {
        fileName: "ADR-0200-alpha.md", // adr-fixture: fixture record name
        text: "- **Status:** Accepted (RED by design)\n",
      },
    ];

    // Act
    const result = checkAdrLedgerStatusAgreement(ledger, records);

    // Assert — both normalised words are quoted so the message explains itself.
    expect(result).toEqual({
      ok: false,
      checkedRows: 1,
      issues: [
        {
          number: "0200",
          line: 3,
          record: "ADR-0200-alpha.md", // adr-fixture: synthetic record name
          recordStatus: "accepted",
          cellStatus: "draft",
          issues: ["status-mismatch"],
        },
      ],
    });
  });

  it("accepts a cell that starts with Superseded, the 0092 lifecycle exception", () => {
    // Arrange — the record was accepted, the cell records the later
    // supersession. Legitimate annotation, not a defect.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0092](ADR-0092-op94-notification-fan-out-green.md) | the fan-out | Superseded (part) by 0127 |",
    ]);
    const records = [
      {
        fileName: "ADR-0092-op94-notification-fan-out-green.md",
        text: "- **Status:** Accepted · **Date:** 2026-10-05\n",
      },
    ];

    // Act
    const result = checkAdrLedgerStatusAgreement(ledger, records);

    // Assert — green, and the row was really read.
    expect(result).toEqual({ ok: true, checkedRows: 1, issues: [] });
  });

  it("reports a row whose record file is missing", () => {
    // Arrange — the row exists, the record does not: the agreement cannot be
    // checked at all.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0201](ADR-0201-missing.md) | a row with no record | Accepted |", // adr-fixture: synthetic row, no such record
    ]);

    // Act
    const result = checkAdrLedgerStatusAgreement(ledger, []);

    // Assert
    expect(result).toEqual({
      ok: false,
      checkedRows: 1,
      issues: [
        {
          number: "0201",
          line: 3,
          record: "ADR-0201-missing.md", // adr-fixture: synthetic record name
          recordStatus: "",
          cellStatus: "accepted",
          issues: ["missing-record"],
        },
      ],
    });
  });

  it("reports a record that carries no Status line", () => {
    // Arrange — a record without the field is unreadable, not accepted.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0202](ADR-0202-no-status.md) | the record | Accepted |", // adr-fixture: synthetic row, no such record
    ]);
    const records = [
      {
        fileName: "ADR-0202-no-status.md", // adr-fixture: fixture record name
        text: "# 0202\n\nNo status field here.\n",
      },
    ];

    // Act
    const result = checkAdrLedgerStatusAgreement(ledger, records);

    // Assert
    expect(result).toEqual({
      ok: false,
      checkedRows: 1,
      issues: [
        {
          number: "0202",
          line: 3,
          record: "ADR-0202-no-status.md", // adr-fixture: synthetic record name
          recordStatus: "",
          cellStatus: "accepted",
          issues: ["missing-status-line"],
        },
      ],
    });
  });

  it("cuts a parenthesised qualifier and a `·`-separated field on both sides", () => {
    // Arrange — the shipped shapes: a record's `Accepted · **Date:** …` and a
    // cell's `Accepted (pins)` are the same word.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0203](ADR-0203-alpha.md) | the record | Accepted (pins) |", // adr-fixture: synthetic row, no such record
    ]);
    const records = [
      {
        fileName: "ADR-0203-alpha.md", // adr-fixture: fixture record name
        text: "- **Status:** Accepted · **Date:** 2026-10-05\n",
      },
    ];

    // Act
    const result = checkAdrLedgerStatusAgreement(ledger, records);

    // Assert
    expect(result).toEqual({ ok: true, checkedRows: 1, issues: [] });
  });

  it("reads a record's canonical bulleted Status line, not a prose mention of the word above it", () => {
    // Arrange — F3 of `t_942aa8e6`: the record's prose mentions `Status:` before
    // its canonical field. Only a **bulleted** `- **Status:**` line is the field;
    // the bare line is prose and must not decide the agreement.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0105](ADR-0105-x.md) | the change | Accepted |", // adr-fixture: synthetic row, no such record
    ]);
    const records = [
      {
        fileName: "ADR-0105-x.md", // adr-fixture: fixture record name
        text: "# rec\n\nStatus: Draft as first written\n\n- **Status:** Accepted\n",
      },
    ];

    // Act
    const result = checkAdrLedgerStatusAgreement(ledger, records);

    // Assert — the canonical field wins, so the cell agrees. Today the first
    // `Status:` match anywhere yields `recordStatus: "draft as first written"`
    // and a `status-mismatch` against the `accepted` cell.
    expect(result).toEqual({ ok: true, checkedRows: 1, issues: [] });
  });

  it("prefers the first bulleted Status line when a record carries two", () => {
    // Arrange — a record that was accepted and later rewritten to propose a
    // change. The canonical field is the **first** bulleted line, so a reader
    // that keeps the last match reads `Proposed` and disagrees with the cell.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0106](ADR-0106-first-bulleted.md) | the record | Accepted |", // adr-fixture: synthetic row, no such record
    ]);
    const records = [
      {
        fileName: "ADR-0106-first-bulleted.md", // adr-fixture: fixture record name
        text: "# rec\n\n- **Status:** Accepted\n\nRevision note\n\n- **Status:** Proposed\n",
      },
    ];

    // Act
    const result = checkAdrLedgerStatusAgreement(ledger, records);

    // Assert — the first bulleted line decides, so the cell agrees.
    expect(result).toEqual({ ok: true, checkedRows: 1, issues: [] });
  });

  it("falls back to a bare Status line when the record carries no bulleted one", () => {
    // Arrange — a record written without the bullet: no `- **Status:**` line
    // exists, so the fallback is the only reading and it must still be read.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0107](ADR-0107-bare-only.md) | the record | Accepted |", // adr-fixture: synthetic row, no such record
    ]);
    const records = [
      {
        fileName: "ADR-0107-bare-only.md", // adr-fixture: fixture record name
        text: "# rec\n\nStatus: Accepted\n",
      },
    ];

    // Act
    const result = checkAdrLedgerStatusAgreement(ledger, records);

    // Assert — a bulleted-only reader with no fallback reports the field as
    // missing and fails here.
    expect(result).toEqual({ ok: true, checkedRows: 1, issues: [] });
  });

  it("a bare Status line after the bulleted field does not override it", () => {
    // Arrange — the mirror of the prose-before-field case: a bare line *after*
    // the canonical field is prose too, and a last-match reader would take it.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0108](ADR-0108-bare-after.md) | the record | Accepted |", // adr-fixture: synthetic row, no such record
    ]);
    const records = [
      {
        fileName: "ADR-0108-bare-after.md", // adr-fixture: fixture record name
        text: "# rec\n\n- **Status:** Accepted\n\nStatus: Draft as first written\n",
      },
    ];

    // Act
    const result = checkAdrLedgerStatusAgreement(ledger, records);

    // Assert — the bulleted field wins, so the cell agrees.
    expect(result).toEqual({ ok: true, checkedRows: 1, issues: [] });
  });

  it.each([
    ["Accepted (GREEN landed: PR #830 620e4bb9; RED #828 draft)", "accepted"],
    ["Superseded (part) by 0127", "superseded"],
    ["Proposed — one row is RED until the GREEN lands", "proposed"],
    ["Accepted · **Date:** 2026-10-05", "accepted"],
    ["**Accepted**", "accepted"],
    ["rejected, and the reason follows", "rejected"],
    ["", ""],
  ])("normalises %j to %j", (value: string, expected: string) => {
    // Arrange + Act + Assert — one table, no hidden branches.
    expect(adrStatusWord(value)).toBe(expected);
  });
});

/* ------------------------------------------------------------------------- *
 * S2 — the shapes that must stay green, on the real bytes
 * ------------------------------------------------------------------------- */

describe("checkAdrLedgerStatusAgreement — the real shapes that must stay green", () => {
  it("keeps 0092 green although its cell says Superseded and its record says Accepted", () => {
    // Arrange — the real row and the real record.
    const row = realLedgerRow("0092");
    const record = realRecord(row.record);
    const recordWord = adrStatusWord(recordStatusValue(record.text));
    const cellWord = adrStatusWord(row.cell);

    // Act
    const result = checkAdrLedgerStatusAgreement(ledgerWithRow(row.line), [record]);

    // Assert — the two words really differ: the exception is load-bearing, not
    // a case that would pass anyway.
    expect(cellWord).toBe("superseded");
    expect(recordWord).toBe("accepted");
    expect(cellWord).not.toBe(recordWord);
    expect(result).toEqual({ ok: true, checkedRows: 1, issues: [] });
  });

  it.each(["0771", "0772"])(
    "keeps %s green, where the record and the cell both say Proposed",
    (number: string) => {
      // Arrange — the real row and the real record.
      const row = realLedgerRow(number);
      const record = realRecord(row.record);

      // Act
      const result = checkAdrLedgerStatusAgreement(ledgerWithRow(row.line), [record]);

      // Assert — both words equal and the report clean; the cell is the only
      // status source here, so a cell edit moves this case.
      expect(adrStatusWord(recordStatusValue(record.text))).toBe("proposed");
      expect(adrStatusWord(row.cell)).toBe("proposed");
      expect(result).toEqual({ ok: true, checkedRows: 1, issues: [] });
    }
  );

  it("keeps 0910 green, where the record and the cell both say Accepted with a parenthesised qualifier", () => {
    // Arrange — the GREEN landed shape.
    const row = realLedgerRow("0910");
    const record = realRecord(row.record);

    // Act
    const result = checkAdrLedgerStatusAgreement(ledgerWithRow(row.line), [record]);

    // Assert
    expect(adrStatusWord(recordStatusValue(record.text))).toBe("accepted");
    expect(adrStatusWord(row.cell)).toBe("accepted");
    expect(result).toEqual({ ok: true, checkedRows: 1, issues: [] });
  });

  it("keeps 0893 green, whose stale Draft cell the repair card rewrote", () => {
    // Arrange — the row the repair card fixed; the pin must watch it stay fixed.
    const row = realLedgerRow("0893");
    const record = realRecord(row.record);

    // Act
    const result = checkAdrLedgerStatusAgreement(ledgerWithRow(row.line), [record]);

    // Assert — the cell no longer reads `draft`.
    expect(adrStatusWord(row.cell)).toBe("accepted");
    expect(adrStatusWord(row.cell)).not.toBe("draft");
    expect(adrStatusWord(recordStatusValue(record.text))).toBe("accepted");
    expect(result).toEqual({ ok: true, checkedRows: 1, issues: [] });
  });
});

/* ------------------------------------------------------------------------- *
 * S2 — the real ledger
 * ------------------------------------------------------------------------- */

describe("checkAdrLedgerStatusAgreement — the real ledger", () => {
  it("agrees for every row whose record exists", () => {
    // Arrange + Act — the whole tree.
    const { shape, status } = checkRepositoryAdrLedgerShape(repoRoot);

    // Assert — no mismatch, no missing record, no missing status field, and the
    // row counts reconcile so a narrowed sweep cannot report a clean ledger.
    expect(status.issues).toEqual([]);
    expect(status.ok).toBe(true);
    expect(status.checkedRows).toBe(shape.rows);
    expect(shape.rows).toBeGreaterThanOrEqual(455);
  });
});

/* ------------------------------------------------------------------------- *
 * S3 — a rowless record is a failure: the record set equals the row set
 * ------------------------------------------------------------------------- */

describe("findAdrRecordsWithoutLedgerRow — a rowless record is a failure", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts a malformed row as present and lists only the record with no row", () => {
    // Arrange — `0892`'s pre-repair shape: a row that is present but wrong. It
    // must not be reported as missing; `0900` really has no row.
    const ledger = syntheticLedger([
      ...HEADER_LINES,
      "| [0892](ADR-0892-a.md) | a title, no status cell and no trailing pipe |", // adr-fixture: synthetic row, no such record
    ]);
    const records = [
      { fileName: "ADR-0892-a.md", text: "- **Status:** Accepted\n" }, // adr-fixture: fixture record name
      { fileName: "ADR-0900-b.md", text: "- **Status:** Accepted\n" }, // adr-fixture: fixture record name
    ];

    // Act
    const missing = findAdrRecordsWithoutLedgerRow(ledger, records);

    // Assert — the rowless record is reported with its `{ number, file }` pair.
    expect(missing).toEqual([{ number: "0900", file: "ADR-0900-b.md" }]); // adr-fixture: synthetic record name
  });

  it("reports exactly the one record of a fixture tree that carries no row", () => {
    // Arrange — a throwaway tree with one record and a ledger that carries the
    // header but no row for it.
    const root = makeTempRepoRoot({
      "docs/adr/ADR-0302-beta.md": "- **Status:** Accepted\n", // adr-fixture: fixture record name
      "docs/adr/README.md": [...HEADER_LINES, ""].join("\n"),
    });

    // Act
    const { shape, missingRows } = checkRepositoryAdrLedgerShape(root);

    // Assert — exactly one entry, and the sweep really read the ledger.
    expect(shape.rows).toBe(0);
    expect(missingRows).toEqual([{ number: "0302", file: "ADR-0302-beta.md" }]); // adr-fixture: synthetic record name
  });

  it("reports no record when the fixture tree's only record carries its row", () => {
    // Arrange — the same tree with the row written, so the empty list below
    // cannot be a sweep that read nothing.
    const root = makeTempRepoRoot({
      "docs/adr/ADR-0301-alpha.md": "- **Status:** Accepted\n", // adr-fixture: fixture record name
      "docs/adr/README.md": [
        ...HEADER_LINES,
        "| [0301](ADR-0301-alpha.md) | the record | Accepted |", // adr-fixture: synthetic row, no such record
        "",
      ].join("\n"),
    });

    // Act
    const { shape, missingRows } = checkRepositoryAdrLedgerShape(root);

    // Assert — the row was counted and nothing is missing.
    expect(shape.rows).toBe(1);
    expect(missingRows).toEqual([]);
  });

  it("reports no record of the real tree as rowless", () => {
    // Arrange + Act — the whole tree.
    const { shape, missingRows } = checkRepositoryAdrLedgerShape(repoRoot);

    // Assert — every record under `docs/adr/` carries its own ledger row, added
    // by the same pull request (ADR-0319, `1260f008`), so this list must be
    // empty and nothing is owed: a record without its row fails here.
    expect(shape.rows).toBeGreaterThanOrEqual(455);
    expect(missingRows).toEqual([]);
  });
});
