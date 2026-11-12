import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Mechanical ADR-number guard for `docs/adr/` (review finding R-1, OP-96).
 *
 * **Why this exists.** ADR numbers used to be allocated by "take the lowest free
 * number at commit time", a rule no tool can enforce. On 2026-10-20 that cost a
 * day of rebases — four renumbers in one afternoon and a genuine collision on
 * `0144` that left PR #225 CONFLICTING. ADR-0300 replaces the rule with per-lane
 * reserved ranges (`docs/adr/README.md` § "ADR number allocation"); this module
 * pins the one *mechanical* half of that policy so CI catches the mistake
 * instead of a reviewer:
 *
 *   1. no two in-scope files share an `ADR-NNNN` number;
 *   2. every in-scope `ADR-*.md` file name is well-formed;
 *   3. no two rows of the reserved-range ledger in `docs/adr/README.md` reserve
 *      intersecting closed ranges (`lane-range-overlap`, ADR-0300 §10).
 *
 * The third check parses exactly one table shape from the ledger: a pipe row
 * whose second cell is a closed `` `NNNN`–`NNNN` `` pair. It cannot see a
 * *file* whose number sits inside another lane's range — the guard has no
 * file→lane map, and a lane's `Next free` cell is not its range end — so range
 * *membership* and `origin/main` freshness stay review-time obligations
 * (`docs/CONVENTIONS.md` §11). Range *disjointness* no longer is.
 *
 * @see docs/CONVENTIONS.md §11 (ADR numbering)
 * @see docs/adr/ADR-0300-adr-number-range-allocation-policy.md
 * @see docs/adr/ADR-0302-adr-number-guard-contract.md
 * @see apps/web/src/test/unit/adr-numbering.test.ts
 * @see apps/web/src/test/unit/adr-lane-ranges.test.ts
 */

/**
 * The strict, canonical ADR file name: a four-digit number and a lowercase
 * `[a-z0-9]`-only dashed slug ending in `.md`. Deliberately anchored — a wrong
 * number length, an uppercase slug or another extension is malformed.
 */
const ADR_FILE_NAME_PATTERN = /^ADR-(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/**
 * The scope predicate: which file names the guard even looks at. Case-sensitive,
 * so a lowercase `adr-…` is not an ADR reference; `docs/adr/README.md` and any
 * other non-ADR markdown are ignored silently.
 */
const IN_SCOPE_ADR_NAME_PATTERN = /^ADR-.*\.md$/;

/** A single numbering defect found by {@link checkAdrNumbers}. */
export interface AdrNumberIssue {
  /**
   * `duplicate` — two or more well-formed file names share one number;
   * `malformed` — one in-scope file name does not match the strict pattern;
   * `lane-range-overlap` — two ledger rows reserve intersecting closed ranges
   * (ADR-0300 §10), reported with `number: null` and the two `holders`.
   */
  code: "duplicate" | "malformed" | "lane-range-overlap";

  /** The shared four-digit prefix, e.g. `"0146"`; `null` when unparseable. */
  number: string | null;

  /** The file names that triggered the issue, sorted ascending. */
  files: string[];
}

/** The report shape returned by {@link checkAdrNumbers} and {@link checkAdrDirectory}. */
export interface AdrCheckResult {
  /** `true` exactly when {@link AdrCheckResult.issues} is empty. */
  ok: boolean;

  /** The defects found, deterministically ordered (see {@link checkAdrNumbers}). */
  issues: AdrNumberIssue[];
}

/**
 * Extract the four-digit prefix of a *well-formed* ADR file name.
 *
 * @param fileName - A bare file name (no directory), e.g. `ADR-0146-a.md`.
 * @returns The four-digit prefix as written, e.g. `"0146"`; `null` when the name
 * does not match the strict pattern.
 */
function adrDigitsOf(fileName: string): string | null {
  const match = ADR_FILE_NAME_PATTERN.exec(fileName);
  if (match === null) {
    return null;
  }
  return match[1] ?? null;
}

/**
 * Parse the number of a *well-formed* ADR file name, leading zeros dropped.
 *
 * @param fileName - A bare file name (no directory), e.g. `ADR-0146-a.md`.
 * @returns The number without leading zeros (`146`), or `null` for anything
 * that is not a well-formed ADR name — a wrong-length number (`ADR-96-x.md`,
 * `ADR-12345-x.md`), a non-lowercase slug (`ADR-0146-X.md`), a non-`.md` file,
 * or a name that does not start with a case-sensitive `ADR-`.
 * @example
 * ```ts
 * parseAdrNumber("ADR-0300-adr-number-range-allocation-policy.md"); // 300
 * parseAdrNumber("README.md"); // null
 * ```
 */
export function parseAdrNumber(fileName: string): number | null {
  const digits = adrDigitsOf(fileName);
  if (digits === null) {
    return null;
  }
  return Number.parseInt(digits, 10);
}

/** Deterministic, locale-independent string order (CI logs must be stable). */
function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Order issues for a stable report: ascending numeric ADR number, malformed
 * (`number === null`) last, then by `code` and finally by the first file name.
 * `fs.readdir` order is not guaranteed, so the input order must never leak into
 * the output.
 */
function compareIssues(left: AdrNumberIssue, right: AdrNumberIssue): number {
  const leftNumber =
    left.number === null ? Number.POSITIVE_INFINITY : Number.parseInt(left.number, 10);
  const rightNumber =
    right.number === null ? Number.POSITIVE_INFINITY : Number.parseInt(right.number, 10);

  if (leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }

  const byCode = compareStrings(left.code, right.code);
  if (byCode !== 0) {
    return byCode;
  }

  return compareStrings(left.files[0] ?? "", right.files[0] ?? "");
}

/**
 * Check a list of file names for duplicate and malformed ADR numbers. Pure — it
 * never touches the filesystem.
 *
 * Names not matching `^ADR-.*\.md$` (case-sensitive) are ignored silently.
 * Well-formed names group by their four-digit prefix: two or more sharing a
 * prefix produce **one** `duplicate` issue listing them sorted. Each in-scope
 * name that is not well-formed produces **one** `malformed` issue; a malformed
 * name never joins a duplicate group. The report is identical for the same
 * names in any input order.
 *
 * @param fileNames - Bare file names, typically from a directory read.
 * @returns `{ ok: true, issues: [] }` when the guard finds nothing wrong.
 * @example
 * ```ts
 * checkAdrNumbers(["ADR-0146-a.md", "ADR-0146-b.md"]);
 * // { ok: false, issues: [{ code: "duplicate", number: "0146",
 * //     files: ["ADR-0146-a.md", "ADR-0146-b.md"] }] }
 * ```
 */
export function checkAdrNumbers(fileNames: string[]): AdrCheckResult {
  const filesByNumber = new Map<string, string[]>();
  const malformed: string[] = [];

  for (const fileName of fileNames) {
    if (!IN_SCOPE_ADR_NAME_PATTERN.test(fileName)) {
      continue;
    }

    const digits = adrDigitsOf(fileName);
    if (digits === null) {
      malformed.push(fileName);
      continue;
    }

    const seen = filesByNumber.get(digits);
    if (seen === undefined) {
      filesByNumber.set(digits, [fileName]);
    } else {
      seen.push(fileName);
    }
  }

  const issues: AdrNumberIssue[] = [];

  for (const [number, files] of filesByNumber) {
    if (files.length > 1) {
      issues.push({ code: "duplicate", number, files: [...files].sort(compareStrings) });
    }
  }

  for (const fileName of malformed) {
    issues.push({ code: "malformed", number: null, files: [fileName] });
  }

  issues.sort(compareIssues);

  return { ok: issues.length === 0, issues };
}

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
 * Parse the closed ranges out of the reserved-range ledger's markdown.
 *
 * Row-shape based, not heading-scoped: a table row *is* the reservation, and
 * the heading carries a date that is edited more often than the row shape. Only
 * a line starting with `|` whose second cell is a closed `` `NNNN`–`NNNN` ``
 * pair counts; everything else is skipped, never thrown on. Document order is
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
  return markdown.split("\n").flatMap((line) => {
    const cells = line.split("|");
    const holder = cells[1];
    const cell = cells[2]?.trim();
    const match = cell === undefined ? null : LANE_RANGE_CELL_PATTERN.exec(cell);
    if (!line.startsWith("|") || holder === undefined || match === null) {
      return [];
    }
    const [, start, end] = match;
    return [
      {
        holder: holder.trim(),
        start: Number.parseInt(start ?? "", 10),
        end: Number.parseInt(end ?? "", 10),
      },
    ];
  });
}

/**
 * One `lane-range-overlap` issue per pair of reserved rows whose **closed**
 * ranges intersect (touching neighbours are disjoint). Holders are sorted so
 * the report does not depend on ledger row order.
 */
function findLaneRangeOverlaps(markdown: string): AdrNumberIssue[] {
  const ranges = parseLaneRanges(markdown);

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

/**
 * Read exactly one directory and apply {@link checkAdrNumbers} to its entries.
 *
 * The read is synchronous and **never recurses**: subdirectory entries are
 * dropped, so a nested `archive/` copy of an ADR cannot produce a phantom
 * duplicate.
 *
 * When the directory carries a `README.md`, its reserved-range ledger is parsed
 * as well and one `lane-range-overlap` issue is added per intersecting pair
 * (see {@link parseLaneRanges}). A missing README, or one with no parseable
 * row, adds nothing.
 *
 * @param dir - Absolute or relative path to the ADR directory to check.
 * @returns The same report shape as {@link checkAdrNumbers}.
 * @throws If `dir` cannot be read (missing directory, permission denied).
 * @example
 * ```ts
 * checkAdrDirectory("docs/adr"); // { ok: true, issues: [] } for this repository
 * ```
 */
export function checkAdrDirectory(dir: string): AdrCheckResult {
  const fileNames = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  const numbering = checkAdrNumbers(fileNames);
  const readmePath = join(dir, "README.md");
  if (!existsSync(readmePath)) {
    return numbering;
  }

  const issues = [...numbering.issues, ...findLaneRangeOverlaps(readFileSync(readmePath, "utf8"))];
  issues.sort(compareIssues);

  return { ok: issues.length === 0, issues };
}
