/**
 * ADR guard, the ledger's **row shape** and its **status agreement** — the
 * ledger-row-shape guard, recorded by `ADR-0319` and outside the `0302`
 * invariant table, and the first one that reads a record's `Status:` line.
 *
 * **Why it is a separate module.** The other guard modules
 * (`adr-numbering`, `adr-record-links`, `adr-ledger-links`, `adr-lane-ranges`,
 * `adr-source-references`, `adr-consumers`, `adr-item-sections`,
 * `adr-gate-conditions`, `adr-inline-code-spans`) check number uniqueness,
 * file-name shape, lane ranges, links, citations, consumers, item section
 * claims, gate conditions and code-span hygiene. None of them reads a ledger
 * row as a **table row**, so the same defect shipped four times unnoticed: a row
 * whose title carries an unescaped `|` splits into more cells than the header
 * has, and GitHub's GFM renderer drops every cell past the header's column
 * count — the Status column then renders a **title fragment**, or nothing at
 * all (`0892` had no status cell and no trailing pipe). The ledger is a rendered
 * document; a row that renders the wrong status is wrong even though the bytes
 * are valid markdown.
 *
 * **The two rules.**
 *
 * - **S1, row shape.** Locate the ledger header (`| ADR | Title | Status |`) and
 *   its column count. Every row shaped `| [NNNN](ADR-*.md) | …` must split on
 *   **unescaped** `|` into exactly `columns + 2` parts — the two boundary
 *   empties plus one part per header cell — and its status cell (part
 *   `columns`) must be non-empty after trimming. A ledger with a header but no
 *   rows is **not** a pass: `ok` is `rows > 0 && issues.length === 0`, so an
 *   empty or mis-rooted tree cannot report a vacuous green.
 *
 *   **S1 is shape-only**, and that boundary is deliberate. One variant of its
 *   own defect class stays invisible: a row with one unescaped title pipe
 *   **and** a dropped status cell splits into 5 parts, so S1 reads a title
 *   fragment as the status and passes —
 *   `{ ok: true, columns: 3, rows: 1, issues: [] }` for
 *   `| [0105](ADR-0105-x.md) | the change is |accepted |`. **S2 is the semantic
 *   backstop** for that class. A status **vocabulary** was considered and
 *   **rejected**: it is subsumed by S2 (every real row has a record, and the
 *   real first words are `accepted` ×454 / `proposed` ×2 in the records and
 *   `accepted` ×452 / `superseded` ×1 / `proposed` ×2 in the cells, so a
 *   vocabulary admits exactly what S2 already admits), and the case that
 *   survives both rules needs an exact-cell match, which would red the real
 *   rows whose status legitimately reads `Accepted (GREEN landed: …)`.
 *
 * - **S2, status agreement.** For every ledger row whose link names a record
 *   present in `records`, the record's `**Status:**` value and the row's status
 *   cell must agree on their **first word** after normalisation, or the cell's
 *   first word must be `superseded` — the `0092` exception, where the record
 *   says `Accepted` and the cell says `Superseded (part) by 0127` because the
 *   supersession happened *after* the record was accepted. A row whose record
 *   file is missing, and a record with no `Status:` line at all, are issues too:
 *   both mean the agreement cannot be checked.
 *
 * - **S3, a missing row is a failure.** Every record carries its own ledger
 *   row, written by the same pull request, so the record set equals the row set
 *   at every merged head. That convention is **decided** (ADR-0319): the case
 *   ADR-0910's prose left open — `0911` had a row and its GREEN sibling `0963`
 *   did not — is closed by the rule that a GREEN landing a record lands its row
 *   in the same commit, and the spec hard-pins the real tree
 *   (`expect(missingRows).toEqual([])`).
 *   {@link findAdrRecordsWithoutLedgerRow} keeps returning the list, unchanged:
 *   it reports, the spec fails. `0892`'s
 *   pre-repair malformed row still **counted** as a row (the defect was its
 *   shape, not its absence), and that reading is preserved by keying on the
 *   `[NNNN](…)` prefix rather than on a well-formed table split.
 *
 * **Fenced blocks are scanned on purpose.** A row-shaped line inside a fenced
 * block is read as a ledger row: the census when this rule was pinned was 455
 * row-shaped lines outside fences and **0** inside — 455 row-shaped lines, 455
 * rows — and fence tracking was rejected because its failure mode is a
 * mis-tracked fence hiding a **real** row, a false green, which is the one
 * failure this guard exists to prevent; a stray example row instead fails
 * loudly and is fixed by moving the example out of the table.
 *
 * **Normalisation** ({@link adrStatusWord}) strips `**`, a leading `-`/`*`
 * bullet, then cuts at the first `(`, `:`, `—`, `,`, `;` or `·` and lowercases
 * the remainder. That is what makes `Accepted (GREEN landed: PR #830 …)` and
 * `Accepted (pins)` both `accepted`, and `Superseded (part) by 0127`
 * `superseded`.
 *
 * **Determinism.** Reports are sorted: S1 and S2 by ledger line, S3 by number
 * then file name, so the same tree always produces one report.
 *
 * **Scope.** Pure, except {@link checkRepositoryAdrLedgerShape} which reads one
 * directory and one file set. It never writes, and a root with no
 * `docs/adr/README.md` throws (`ENOENT`) rather than sweeping nothing.
 *
 * @module
 */

import { join } from "node:path";

import { IN_SCOPE_ADR_NAME_PATTERN, compareStrings } from "./adr-guard-types.js";
import { readDirectoryEntries, readTextFile } from "./adr-source-references.js";

/** The ledger's path, and the `path` every report about it carries. */
export const ADR_LEDGER_PATH = "docs/adr/README.md";

/**
 * The ledger header's cells, in order. The column count is this array's
 * length — the value every row is measured against.
 */
const LEDGER_HEADER_CELLS: readonly string[] = ["ADR", "Title", "Status"];

/**
 * A ledger row's prefix: the boundary pipe, the `[NNNN]` label and the
 * same-directory record link. Deliberately shape-agnostic past the link, so a
 * row with a missing status cell is still *a row* (that is S3's reading).
 */
const LEDGER_ROW_PATTERN = /^\s*\|\s*\[(\d{4})\]\((ADR-[^)\s]*\.md)\)/u;

/**
 * A record's status field: an optional bullet, an optional `**` around the
 * label, then the value to the end of the line.
 */
const STATUS_LINE_PATTERN = /^\s*(?:[-*]\s*)?(?:\*\*)?Status:(?:\*\*)?\s*(.*)$/u;

/**
 * A record's canonical status field: {@link STATUS_LINE_PATTERN} with the
 * bullet mandatory. A bare `Status:` line is prose, never the field.
 */
const BULLETED_STATUS_LINE_PATTERN = /^\s*[-*]\s*(?:\*\*)?Status:(?:\*\*)?\s*(.*)$/u;

/**
 * Where a status value stops being a status word. `Accepted (GREEN …)` is
 * `accepted`; `Accepted · **Date:** …` is `accepted`; an em dash separates a
 * qualifier from the word.
 */
const STATUS_WORD_DELIMITERS = /[(:—,;·]/u;

/** One ledger document: its repo-relative path and whole text. */
export interface AdrLedgerFileText {
  /** Repo-relative POSIX path, e.g. `docs/adr/README.md`. */
  path: string;

  /** The whole ledger markdown; lines are split on `"\n"`. */
  text: string;
}

/** What is wrong with one ledger row, as a machine-readable code. */
export type AdrLedgerRowDefect =
  /** The row did not split into `columns + 2` unescaped-`|` parts. */
  | "cell-count"
  /** The row split correctly but its status cell is empty. */
  | "empty-status";

/** One ledger row that S1 rejects. */
export interface AdrLedgerRowShapeIssue {
  /** The four digits in the row's `[NNNN]` label, as written. */
  number: string;

  /** 1-based line in the ledger, matching an editor's gutter. */
  line: number;

  /** The parts the row split into — `columns + 2` on a correct row. */
  cells: number;

  /** The status cell as written; `""` when the count was wrong or the cell empty. */
  status: string;

  /** One or more of {@link AdrLedgerRowDefect}. */
  issues: AdrLedgerRowDefect[];
}

/** The report shape returned by {@link checkAdrLedgerRowShape}. */
export interface AdrLedgerRowShapeResult {
  /** `true` exactly when rows were read and none was rejected. */
  ok: boolean;

  /** The header's column count (`3` for the ADR ledger). */
  columns: number;

  /** Ledger rows the rule read, so "no issues" can never be a vacuous pass. */
  rows: number;

  /** The rejected rows, ascending by ledger line. */
  issues: AdrLedgerRowShapeIssue[];
}

/** One record as S2 reads it: the bare file name a row links and its markdown. */
export interface AdrRecordStatusText {
  /** Bare file name, e.g. `ADR-0092-op94-notification-fan-out-green.md`. */
  fileName: string;

  /** The record's whole markdown. */
  text: string;
}

/** Why a row's status cell and its record's status do not agree. */
export type AdrLedgerStatusDefect =
  /** Both sides were readable and their first words differ (and the cell is not `superseded`). */
  | "status-mismatch"
  /** The record file exists but carries no `Status:` line. */
  | "missing-status-line"
  /** The row links a record file that is not in the record set. */
  | "missing-record";

/** One ledger row whose status agreement fails. */
export interface AdrLedgerStatusIssue {
  /** The four digits in the row's `[NNNN]` label, as written. */
  number: string;

  /** 1-based ledger line of the row. */
  line: number;

  /** The record file name the row links, as written. */
  record: string;

  /** The record's normalised first word; `""` when absent or unreadable. */
  recordStatus: string;

  /** The row's normalised status-cell first word; `""` when it has no status cell. */
  cellStatus: string;

  /** One or more of {@link AdrLedgerStatusDefect}. */
  issues: AdrLedgerStatusDefect[];
}

/** The report shape returned by {@link checkAdrLedgerStatusAgreement}. */
export interface AdrLedgerStatusResult {
  /** `true` exactly when every read row agreed. */
  ok: boolean;

  /** Ledger rows the rule evaluated. */
  checkedRows: number;

  /** The failing rows, ascending by ledger line. */
  issues: AdrLedgerStatusIssue[];
}

/** One record that carries no ledger row. A warning, never a failure. */
export interface AdrMissingLedgerRow {
  /** The record's four-digit number, from its file name. */
  number: string;

  /** The record's bare file name. */
  file: string;
}

/** What {@link checkRepositoryAdrLedgerShape} reads off one working tree. */
export interface AdrRepositoryLedgerShapeResult {
  /** S1 over the real ledger. */
  shape: AdrLedgerRowShapeResult;

  /** S2 over the real ledger and the real records. */
  status: AdrLedgerStatusResult;

  /** S3's missing-row list over the real tree. */
  missingRows: AdrMissingLedgerRow[];
}

/** One ledger row as the three rules read it. */
interface LedgerRow {
  readonly number: string;
  readonly line: number;
  readonly record: string;
  readonly cells: readonly string[];
}

/** One ledger table: the header's column count and every ADR row. */
interface LedgerTable {
  readonly columns: number;
  readonly rows: readonly LedgerRow[];
}

/**
 * Split one markdown table line on its **unescaped** `|`. A backslash escapes
 * the next character, so `\|` stays inside the cell — that is exactly the
 * distinction the defect class turns on.
 */
function splitTableLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (char === "\\" && index + 1 < line.length) {
      current += char + (line[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  cells.push(current);
  return cells;
}

/**
 * The trimmed cells of a table line that opens and closes with `|`, or `null`
 * when the line is not one. The two boundary empties are dropped.
 */
function tableCellsOf(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return null;
  }

  const parts = splitTableLine(trimmed);
  if (parts.length < 3 || parts[0]?.trim() !== "" || parts[parts.length - 1]?.trim() !== "") {
    return null;
  }

  return parts.slice(1, -1).map((cell) => cell.trim());
}

/** `true` when `line` is the ledger header the other three rules measure against. */
function isLedgerHeader(line: string, columns: number): boolean {
  const cells = tableCellsOf(line);
  if (cells?.length !== columns) {
    return false;
  }
  return cells.every((cell, index) => cell === LEDGER_HEADER_CELLS[index]);
}

/**
 * The ledger's table: the header's column count and every `| [NNNN](ADR-….md) |`
 * row with the parts it really splits into.
 *
 * @throws If the ledger carries no `| ADR | Title | Status |` header — a wrong
 * document must fail loudly instead of yielding zero rows and a green report.
 */
function ledgerTableOf(text: string): LedgerTable {
  const lines = text.split("\n");
  const columns = LEDGER_HEADER_CELLS.length;
  const headerIndex = lines.findIndex((line) => isLedgerHeader(line, columns));
  if (headerIndex === -1) {
    throw new Error(`no ledger table header (| ${LEDGER_HEADER_CELLS.join(" | ")} |) was found`);
  }

  const rows: LedgerRow[] = [];
  for (const [index, line] of lines.entries()) {
    const match = LEDGER_ROW_PATTERN.exec(line);
    if (match === null) {
      continue;
    }
    rows.push({
      number: match[1] ?? "",
      line: index + 1,
      record: match[2] ?? "",
      cells: splitTableLine(line.trim()),
    });
  }

  return { columns, rows };
}

/**
 * The status cell of a row **only when the row is well formed**: a row with the
 * wrong number of parts has no status cell a renderer would show, which is the
 * whole defect.
 */
function statusCellOf(row: LedgerRow, columns: number): string {
  if (row.cells.length !== columns + 2) {
    return "";
  }
  return (row.cells[columns] ?? "").trim();
}

/**
 * The first word of a status value, normalised so a record and a ledger cell
 * can be compared literally: `**` removed, a leading `-`/`*` bullet removed,
 * cut at the first `(`, `:`, `—`, `,`, `;` or `·`, trimmed and lowercased.
 *
 * @param value - A status value as written, e.g. `Accepted (GREEN landed: PR #830)`.
 * @returns The normalised first word, e.g. `"accepted"`; `""` when the value
 * carries none.
 * @example
 * ```ts
 * adrStatusWord("Superseded (part) by 0127"); // "superseded"
 * ```
 */
export function adrStatusWord(value: string): string {
  const stripped = value.replaceAll("**", "").trim();
  const withoutBullet = stripped.replace(/^[-*]\s*/u, "");
  const [first] = withoutBullet.split(STATUS_WORD_DELIMITERS);

  return (first ?? "").trim().toLowerCase();
}

/**
 * The value of a record's `Status:` line, as written, or `null` when the record
 * carries none.
 *
 * The first **bulleted** `Status:` line (`- **Status:** Accepted`) wins: that
 * is the record's canonical field. A bare `Status:` line is prose, never the
 * field — a record that mentions the word before its field, e.g.
 * `Status: Draft as first written` above `- **Status:** Accepted`, is read from
 * the bulleted line. Only a record that carries **no** bulleted line falls back
 * to its first match anywhere.
 *
 * @param recordText - The record's whole markdown.
 */
function recordStatusValueOf(recordText: string): string | null {
  let firstAnyForm: string | null = null;

  for (const line of recordText.split("\n")) {
    const bulleted = BULLETED_STATUS_LINE_PATTERN.exec(line);
    if (bulleted !== null) {
      return bulleted[1] ?? "";
    }

    const match = STATUS_LINE_PATTERN.exec(line);
    if (match !== null) {
      firstAnyForm ??= match[1] ?? "";
    }
  }

  return firstAnyForm;
}

/** Order S1 issues by ledger line. */
function compareRowShapeIssues(
  left: AdrLedgerRowShapeIssue,
  right: AdrLedgerRowShapeIssue
): number {
  return left.line - right.line;
}

/** Order S2 issues by ledger line. */
function compareStatusIssues(left: AdrLedgerStatusIssue, right: AdrLedgerStatusIssue): number {
  return left.line - right.line;
}

/**
 * S1 — every ledger row renders a status. Pure.
 *
 * Locates the `| ADR | Title | Status |` header, measures every
 * `| [NNNN](ADR-*.md) | …` row against its column count, and reports each row
 * that does not split into `columns + 2` parts or whose status cell is empty.
 *
 * `ok` is `rows > 0 && issues.length === 0`: a document whose header carries no
 * rows is a failure, never a pass.
 *
 * @param ledger - The ledger's repo-relative path and whole text.
 * @returns The report, sorted by ledger line.
 * @throws If the document carries no ledger header (see {@link ledgerTableOf}).
 * @example
 * ```ts
 * checkAdrLedgerRowShape({ path: "docs/adr/README.md", text: ledgerMarkdown });
 * // { ok: true, columns: 3, rows: 455, issues: [] }
 * ```
 */
export function checkAdrLedgerRowShape(ledger: AdrLedgerFileText): AdrLedgerRowShapeResult {
  const { columns, rows } = ledgerTableOf(ledger.text);
  const issues: AdrLedgerRowShapeIssue[] = [];

  for (const row of rows) {
    const defects: AdrLedgerRowDefect[] = [];
    const status = statusCellOf(row, columns);

    if (row.cells.length !== columns + 2) {
      defects.push("cell-count");
    }
    if (row.cells.length === columns + 2 && status === "") {
      defects.push("empty-status");
    }

    if (defects.length > 0) {
      issues.push({
        number: row.number,
        line: row.line,
        cells: row.cells.length,
        status,
        issues: defects,
      });
    }
  }

  issues.sort(compareRowShapeIssues);

  return { ok: rows.length > 0 && issues.length === 0, columns, rows: rows.length, issues };
}

/**
 * S2 — a record's `Status:` first word agrees with its ledger cell. Pure.
 *
 * Only rows that **exist** are in scope; a record with no row is S3's warning
 * list, not this report's failure. Per row: a missing record file is
 * `missing-record`; a record with no `Status:` line is `missing-status-line`;
 * both readable but different first words are `status-mismatch` — unless the
 * cell's first word is `superseded`, the `0092` lifecycle exception.
 *
 * A malformed row (no status cell) therefore mismatches: the cell word is `""`
 * and the record's is not, which is the rendered defect.
 *
 * @param ledger - The ledger's repo-relative path and whole text.
 * @param records - Every record the tree carries, bare file name and markdown.
 * @returns The report, sorted by ledger line.
 * @throws If the document carries no ledger header.
 * @example
 * ```ts
 * checkAdrLedgerStatusAgreement(ledger, [
 *   { fileName: "ADR-0092-op94-notification-fan-out-green.md", text: recordMarkdown },
 * ]);
 * // ok: true — the cell says "Superseded (part) by 0127", the record "Accepted"
 * ```
 */
export function checkAdrLedgerStatusAgreement(
  ledger: AdrLedgerFileText,
  records: readonly AdrRecordStatusText[]
): AdrLedgerStatusResult {
  const { columns, rows } = ledgerTableOf(ledger.text);
  const textByFileName = new Map(records.map((record) => [record.fileName, record.text]));
  const issues: AdrLedgerStatusIssue[] = [];

  for (const row of rows) {
    const cellStatus = adrStatusWord(statusCellOf(row, columns));
    const recordText = textByFileName.get(row.record);
    const defects: AdrLedgerStatusDefect[] = [];
    let recordStatus = "";

    if (recordText === undefined) {
      defects.push("missing-record");
    } else {
      const value = recordStatusValueOf(recordText);
      if (value === null) {
        defects.push("missing-status-line");
      } else {
        recordStatus = adrStatusWord(value);
        if (recordStatus !== cellStatus && cellStatus !== "superseded") {
          defects.push("status-mismatch");
        }
      }
    }

    if (defects.length > 0) {
      issues.push({
        number: row.number,
        line: row.line,
        record: row.record,
        recordStatus,
        cellStatus,
        issues: defects,
      });
    }
  }

  issues.sort(compareStatusIssues);

  return { ok: issues.length === 0, checkedRows: rows.length, issues };
}

/**
 * S3 — the records that carry no ledger row, as a list. Pure.
 *
 * A row is counted as present by its `[NNNN](…)` prefix, not by its shape, so
 * `0892`'s pre-repair three-cell row is **not** missing. The list is not itself
 * a failure — the spec fails on it, because every record carries its row
 * (ADR-0319; see the module docblock).
 *
 * @param ledger - The ledger's repo-relative path and whole text.
 * @param records - Every record the tree carries, bare file name and markdown.
 * @returns One entry per rowless record, ascending by number then file.
 * @throws If the document carries no ledger header.
 */
export function findAdrRecordsWithoutLedgerRow(
  ledger: AdrLedgerFileText,
  records: readonly AdrRecordStatusText[]
): AdrMissingLedgerRow[] {
  const { rows } = ledgerTableOf(ledger.text);
  const rowNumbers = new Set(rows.map((row) => row.number));
  const missing: AdrMissingLedgerRow[] = [];

  for (const record of records) {
    const number = /^ADR-(\d{4})-/u.exec(record.fileName)?.[1];
    if (number !== undefined && !rowNumbers.has(number)) {
      missing.push({ number, file: record.fileName });
    }
  }

  missing.sort((left, right) => {
    const byNumber = compareStrings(left.number, right.number);
    return byNumber !== 0 ? byNumber : compareStrings(left.file, right.file);
  });

  return missing;
}

/** The `docs/adr` records of one tree, sorted by file name. */
function recordsOf(root: string): AdrRecordStatusText[] {
  return readDirectoryEntries(join(root, "docs/adr"))
    .filter((entry) => entry.isFile() && IN_SCOPE_ADR_NAME_PATTERN.test(entry.name))
    .map((entry) => ({
      fileName: entry.name,
      text: readTextFile(join(root, "docs/adr", entry.name)),
    }))
    .sort((left, right) => compareStrings(left.fileName, right.fileName));
}

/**
 * Read one real working tree and apply S1, S2 and S3.
 *
 * The `docs/adr` directory is read first, so a wrong root fails before any
 * report exists.
 *
 * @param root - Absolute path to the repository root.
 * @returns The three reports, each in its pure shape.
 * @throws If `docs/adr` or `docs/adr/README.md` cannot be read — a wrong root
 * must fail loudly instead of sweeping nothing and reporting a vacuous pass.
 */
export function checkRepositoryAdrLedgerShape(root: string): AdrRepositoryLedgerShapeResult {
  const records = recordsOf(root);
  const ledger: AdrLedgerFileText = {
    path: ADR_LEDGER_PATH,
    text: readTextFile(join(root, ADR_LEDGER_PATH)),
  };

  return {
    shape: checkAdrLedgerRowShape(ledger),
    status: checkAdrLedgerStatusAgreement(ledger, records),
    missingRows: findAdrRecordsWithoutLedgerRow(ledger, records),
  };
}
