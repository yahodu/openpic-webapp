import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join, posix, relative, sep } from "node:path";

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
 *      intersecting closed ranges (`lane-range-overlap`), and a range-shaped row
 *      that does not parse is reported rather than skipped
 *      (`lane-range-malformed`) (ADR-0300 §10);
 *   4. every `ADR-NNNN` reference inside a source file resolves to a
 *      `docs/adr/ADR-NNNN-*.md` file (`dangling-reference`, finding F6-b);
 *   5. every such reference that resolves to a record declaring a `Consumers:`
 *      field is made by a file that record names (`consumer-mismatch`, finding
 *      F-N1). A citation of a record that declares no `Consumers:` field is
 *      `unlisted-consumer`: reported and counted, not failed;
 *   6. every **markdown link target** inside a `docs/adr/ADR-*.md` record names
 *      a file that exists (`dangling-reference`, finding F3). The records are
 *      the one tree the source sweep never read, so a renamed record's links rot
 *      in silence — three OP-129 records pointed at pre-rename files while every
 *      guard stayed green. `docs/adr/README.md` is deliberately out (its ledger
 *      notes keep the old names on purpose), and a link shape inside a code span
 *      or a fenced block is prose. See {@link checkAdrRecordLinks} and
 *      {@link checkRepositoryAdrLinks}.
 *
 * The third check parses exactly one table shape from the ledger: a pipe row
 * whose second cell is a closed `` `NNNN`–`NNNN` `` pair. It cannot see a
 * *file* whose number sits inside another lane's range — the guard has no
 * file→lane map, and a lane's `Next free` cell is not its range end — so range
 * *membership* and `origin/main` freshness stay review-time obligations
 * (`docs/CONVENTIONS.md` §11). Range *disjointness* no longer is.
 *
 * The fourth check answers the question the first three cannot: "does the ADR
 * this comment cites still exist?" It was added because the OP-128 round-1
 * renumber left five shipped comments citing `0764`/`0765` after those
 * decisions moved to `0766`/`0767` — and `0764`/`0765` belong to
 * sibling lanes, so the comments pointed at the wrong decisions. Nothing read
 * the references; now the sweep does. See {@link checkSourceAdrReferences} and
 * {@link checkRepositoryAdrReferences}.
 *
 * The fifth answers the question the fourth cannot: "is the record this comment
 * cites the *right* record?" Existence is not accuracy. Nine OP-129 spec headers
 * cited a number that had never been minted; when a record with that number was
 * minted for the OP-128 lane, all nine silently became "valid" references to a
 * decision about a different feature, and the fourth check's real-tree case
 * stayed green. The accuracy rule is decidable only where a record states its
 * own consumers, so it is opt-in per record: a record carrying a `Consumers:`
 * field is hard-checked against every file that cites it, and a record without
 * one is counted as `unlisted-consumer` so the debt stays visible. See
 * {@link checkSourceAdrConsumers} and {@link checkRepositoryAdrConsumers}.
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
   * (ADR-0300 §10), reported with `number: null` and the two `holders`;
   * `lane-range-malformed` — one ledger row is range-shaped but not an accepted
   * closed ascending pair (finding F1), reported with `number: null` and that
   * row's holder once.
   */
  code: "duplicate" | "malformed" | "lane-range-overlap" | "lane-range-malformed";

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
 * row shape). Not exported: {@link parseLaneRanges} keeps the parser contract,
 * and {@link checkAdrDirectory} needs both halves in one pass.
 */
function scanLaneLedger(markdown: string): LaneLedgerScan {
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
function findLaneRangeOverlaps(ranges: readonly LaneRange[]): AdrNumberIssue[] {
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
 * The module's one directory-read call site. `checkAdrDirectory` and the source
 * sweep both go through it: the security preset flags every `readdirSync` with a
 * non-literal argument, so a second call site would add a warning for nothing.
 *
 * @param dir - Absolute or relative path to the directory to list.
 * @returns The raw directory entries (`fs.Dirent`s, so callers can tell a file
 * from a directory from a symlink without another `stat`).
 * @throws If `dir` cannot be read (missing directory, permission denied).
 */
function readDirectoryEntries(dir: string): Dirent[] {
  return readdirSync(dir, { withFileTypes: true });
}

/**
 * The module's one file-read call site (see {@link readDirectoryEntries}).
 *
 * @param filePath - Absolute or relative path to the file.
 * @returns The file's whole text, UTF-8.
 * @throws If `filePath` cannot be read.
 */
function readTextFile(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

/**
 * Read exactly one directory and apply {@link checkAdrNumbers} to its entries.
 *
 * The read is synchronous and **never recurses**: subdirectory entries are
 * dropped, so a nested `archive/` copy of an ADR cannot produce a phantom
 * duplicate.
 *
 * When the directory carries a `README.md`, its reserved-range ledger is parsed
 * as well: one `lane-range-overlap` issue per intersecting pair and one
 * `lane-range-malformed` issue per range-shaped row that does not parse (see
 * {@link parseLaneRanges}). A malformed row never feeds the overlap predicate. A
 * missing README, or one with no parseable row, adds nothing.
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
  const fileNames = readDirectoryEntries(dir)
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  const numbering = checkAdrNumbers(fileNames);
  const readmePath = join(dir, "README.md");
  if (!existsSync(readmePath)) {
    return numbering;
  }

  const scan = scanLaneLedger(readTextFile(readmePath));
  const issues = [
    ...numbering.issues,
    ...findLaneRangeOverlaps(scan.ranges),
    ...scan.malformedHolders.map((holder) => ({
      code: "lane-range-malformed" as const,
      number: null,
      files: [holder],
    })),
  ];
  issues.sort(compareIssues);

  return { ok: issues.length === 0, issues };
}

/* ------------------------------------------------------------------------- *
 * Invariant 4 — every in-source `ADR-NNNN` reference resolves (finding F6-b)
 * ------------------------------------------------------------------------- */

/**
 * One source file handed to {@link checkSourceAdrReferences}. `path` is carried
 * through into the report verbatim (repo-relative, POSIX separators), so the
 * caller decides how a file is named and the check stays pure.
 */
export interface SourceFileText {
  /** Repo-relative POSIX path, e.g. `apps/web/src/server/notifications/digest.ts`. */
  path: string;

  /** The whole file text; lines are split on `"\n"`. */
  text: string;
}

/**
 * One in-source `ADR-NNNN` reference with no `docs/adr/ADR-NNNN-*.md` file.
 *
 * `number` keeps the digits **as written** (leading zeros included) so the
 * failure message can be pasted into a search; `line` is 1-based so it matches
 * an editor's gutter.
 */
export interface SourceAdrReferenceIssue {
  /** Always `"dangling-reference"`; the discriminant for this issue family. */
  code: "dangling-reference";

  /** Repo-relative POSIX path of the source file that carries the reference. */
  file: string;

  /** 1-based line number of the reference. */
  line: number;

  /** The four-digit ADR number as written, e.g. `"0764"`. */
  number: string;
}

/** The report shape returned by {@link checkSourceAdrReferences}. */
export interface SourceAdrReferenceResult {
  /** `true` exactly when {@link SourceAdrReferenceResult.issues} is empty. */
  ok: boolean;

  /**
   * One entry per dangling reference — not per number and not per file — sorted
   * by `file`, then `line`, then `number`, so the report is identical for the
   * same sources in any input order.
   */
  issues: SourceAdrReferenceIssue[];

  /** References the rule evaluated (exempt ones are counted separately). */
  checkedReferences: number;

  /** References skipped because a fixture-tree line carries the marker. */
  exemptReferences: number;
}

/** Source-file extensions the repository sweep reads. */
const SOURCE_FILE_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * The top-level trees the sweep walks. Deliberately not the whole repository:
 * `scripts/` and the docs are outside the application's source, so a reference
 * there is not a shipped comment.
 */
const SOURCE_SWEEP_ROOTS: readonly string[] = ["apps", "packages"];

/**
 * Directory names the sweep never descends into, at any depth. Dependencies and
 * build output: `apps/web/.next/**` holds copies of the source, and counting
 * them twice would make the sweep depend on whether a build ran.
 */
const SKIPPED_SOURCE_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".next",
  ".worktrees",
  "coverage",
  "dist",
  "build",
  ".turbo",
  "playwright-report",
  "test-results",
]);

/**
 * The reference token: a case-sensitive `ADR-` followed by exactly four digits
 * that are not followed by a fifth. The lookahead keeps a five-digit shape
 * fixture (`ADR-12345`) from masquerading as a reference to `1234`; the
 * case-sensitivity matches {@link checkAdrNumbers}, where `adr-…` is not an ADR
 * file either.
 */
const SOURCE_ADR_REFERENCE_PATTERN = /ADR-(\d{4})(?!\d)/g;

/**
 * The fixture marker. A source line **inside the guard's own test tree** whose
 * text contains this marker is exempt from the reference rule: those specs are
 * full of synthetic numbers (`0000`/`9999` shape fixtures, sibling-lane numbers
 * that only exist on an unmerged branch) that must never resolve. The module's
 * own prose cites numbers without the `ADR-` prefix for the same reason — a
 * docblock needs no marker and must never be able to hide a real pointer.
 *
 * The exemption is per **line text** *and* per **path**, deliberately: not a
 * line number (which goes stale when a fixture moves), not a number range
 * (which would hide a real defect behind it) and not a whole file. An unmarked
 * line in a marked file still fails, and a real pointer in shipped source fails
 * even when its line carries the marker (finding F-M1: the marker used to be an
 * unscoped substring test over every swept file, so appending it to a stale
 * comment silenced the guard).
 */
const SOURCE_ADR_REFERENCE_FIXTURE_MARKER = "adr-fixture";

/**
 * The only tree in which {@link SOURCE_ADR_REFERENCE_FIXTURE_MARKER} exempts a
 * line: the guard's own fixtures. Helpers, unit and integration specs all live
 * under `apps/web/src/test`, and nothing else does. Matched as a directory
 * boundary on the normalized repo-relative POSIX path, so `src/test-tools/x.ts`
 * and a `..` segment that leaves the tree are both *outside* it.
 */
const SOURCE_ADR_REFERENCE_FIXTURE_ROOT = "apps/web/src/test";

/** Is `path` inside {@link SOURCE_ADR_REFERENCE_FIXTURE_ROOT}? */
function isSourceAdrFixturePath(path: string): boolean {
  const normalized = posix.normalize(path);

  return (
    normalized === SOURCE_ADR_REFERENCE_FIXTURE_ROOT ||
    normalized.startsWith(`${SOURCE_ADR_REFERENCE_FIXTURE_ROOT}/`)
  );
}

/**
 * The numbers that {@link checkSourceAdrReferences} treats as resolvable: the
 * digits of every **well-formed** ADR file name. Malformed names are already a
 * `malformed` issue in {@link checkAdrNumbers}, so they resolve nothing here
 * and the two guards agree instead of contradicting each other.
 */
function resolvableAdrNumbers(adrFileNames: readonly string[]): Set<string> {
  const numbers = new Set<string>();

  for (const fileName of adrFileNames) {
    const digits = adrDigitsOf(fileName);
    if (digits !== null) {
      numbers.add(digits);
    }
  }

  return numbers;
}

/** Order source-reference issues: file, then line, then number. */
function compareSourceIssues(
  left: { readonly file: string; readonly line: number; readonly number: string },
  right: { readonly file: string; readonly line: number; readonly number: string }
): number {
  const byFile = compareStrings(left.file, right.file);
  if (byFile !== 0) {
    return byFile;
  }
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return compareStrings(left.number, right.number);
}

/**
 * Check that every `ADR-NNNN` reference in `sources` resolves to one of
 * `adrFileNames` (bare names from `docs/adr/`). Pure — it never touches the
 * filesystem, so the rule is testable without fixtures on disk.
 *
 * One `dangling-reference` issue per **occurrence**: two comments citing the
 * same missing number are two issues, and two files citing it are two issues,
 * because each one is a separate wrong pointer to fix. References inside the
 * guard's own test tree (`apps/web/src/test`) on a line that carries the fixture
 * marker are skipped and counted in `exemptReferences`; every other reference is
 * counted in `checkedReferences`, including a marked line in shipped source.
 *
 * @param sources - The source files to scan, in any order.
 * @param adrFileNames - Bare file names from the ADR directory.
 * @returns `ok: true` with no issues when every reference resolves.
 * @example
 * ```ts
 * checkSourceAdrReferences(
 *   [{ path: "apps/web/src/server/x.ts", text: "// see ADR-0146-a.md" }],
 *   ["ADR-0146-a.md"]
 * );
 * // { ok: true, issues: [], checkedReferences: 1, exemptReferences: 0 }
 * ```
 */
export function checkSourceAdrReferences(
  sources: readonly SourceFileText[],
  adrFileNames: readonly string[]
): SourceAdrReferenceResult {
  const resolvable = resolvableAdrNumbers(adrFileNames);
  const issues: SourceAdrReferenceIssue[] = [];
  let checkedReferences = 0;
  let exemptReferences = 0;

  for (const source of sources) {
    for (const [index, line] of source.text.split("\n").entries()) {
      const references = [...line.matchAll(SOURCE_ADR_REFERENCE_PATTERN)];
      if (references.length === 0) {
        continue;
      }

      if (
        isSourceAdrFixturePath(source.path) &&
        line.includes(SOURCE_ADR_REFERENCE_FIXTURE_MARKER)
      ) {
        exemptReferences += references.length;
        continue;
      }

      for (const reference of references) {
        checkedReferences += 1;
        const number = reference[1] ?? "";
        if (!resolvable.has(number)) {
          issues.push({ code: "dangling-reference", file: source.path, line: index + 1, number });
        }
      }
    }
  }

  issues.sort(compareSourceIssues);

  return { ok: issues.length === 0, issues, checkedReferences, exemptReferences };
}

/**
 * Walk one directory tree for source files, appending repo-relative POSIX paths
 * to `collected`. Skips {@link SKIPPED_SOURCE_DIRECTORIES} by name at any depth
 * and every file whose extension is not in {@link SOURCE_FILE_EXTENSIONS}.
 */
function collectSourceFiles(root: string, dir: string, collected: string[]): void {
  for (const entry of readDirectoryEntries(dir)) {
    const entryPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!SKIPPED_SOURCE_DIRECTORIES.has(entry.name)) {
        collectSourceFiles(root, entryPath, collected);
      }
      continue;
    }

    if (entry.isFile() && SOURCE_FILE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      collected.push(relative(root, entryPath).split(sep).join("/"));
    }
  }
}

/**
 * Apply {@link checkSourceAdrReferences} to a real working tree: read the
 * resolvable numbers out of `<root>/docs/adr/`, then every source file under
 * `<root>/apps/` and `<root>/packages/`.
 *
 * Nothing is hardcoded, so the pin follows the tree it runs in — a worktree, the
 * shared checkout, or a CI clone. A build output copy (`apps/web/.next/**`, and
 * the `.worktrees/` of a shared checkout) is never read, so the result does not
 * depend on whether a build ran.
 *
 * @param root - Absolute path to the repository root.
 * @returns The same report shape as {@link checkSourceAdrReferences}.
 * @throws If `docs/adr`, `apps` or `packages` cannot be read — a wrong root must
 * fail loudly instead of sweeping nothing and reporting a vacuous pass.
 */
export function checkRepositoryAdrReferences(root: string): SourceAdrReferenceResult {
  // The ADR directory is read first on purpose: a bad root throws here, before
  // any source is collected, so "no references found" can never be a false pass.
  const adrFileNames = readDirectoryEntries(join(root, "docs/adr"))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  const paths: string[] = [];
  for (const top of SOURCE_SWEEP_ROOTS) {
    collectSourceFiles(root, join(root, top), paths);
  }
  paths.sort(compareStrings);

  const sources = paths.map((path) => ({ path, text: readTextFile(join(root, path)) }));

  return checkSourceAdrReferences(sources, adrFileNames);
}

/* ------------------------------------------------------------------------- *
 * Invariant 5 — every citation of a declaring record names the citing file
 * (finding F-N1)
 * ------------------------------------------------------------------------- */

/**
 * One ADR record as the accuracy sweep reads it: the bare file name (so a
 * report can say *which* record a citation resolved to) and the whole
 * markdown. The caller decides where the text comes from, so
 * {@link checkSourceAdrConsumers} stays pure and testable without fixtures on
 * disk.
 */
export interface AdrRecordText {
  /** Bare file name, e.g. `ADR-0302-adr-number-guard-contract.md`. */
  fileName: string;

  /** The record's whole markdown. */
  text: string;
}

/**
 * One accuracy finding.
 *
 * `consumer-mismatch` — the cited record declares a `Consumers:` field and does
 * not name the citing file. `consumers-malformed` — a record carries a
 * `Consumers`-shaped line that is not the canonical field, so reading it as "no
 * declaration" would enforce nothing without saying so. Both are failures.
 * `unlisted-consumer` — the cited record declares no `Consumers:` field at all,
 * so there is no claim to check; the citation is reported (and counted) in its
 * own channel, never as a failure, because 1206 of this head's 1238 references
 * point at records written before the field existed and a hard failure would
 * demand a 175-record docs programme. Enforcement is therefore **per record**:
 * the moment a record adds `Consumers:`, every citation of it is hard-checked,
 * and nothing is exempt by file or directory.
 */
export interface SourceAdrConsumerIssue {
  /** `consumer-mismatch` and `consumers-malformed` fail; `unlisted-consumer` is reported only. */
  code: "consumer-mismatch" | "unlisted-consumer" | "consumers-malformed";

  /** Repo-relative POSIX path of the citing file; for `consumers-malformed`, the record's file name. */
  file: string;

  /** 1-based line of the reference; for `consumers-malformed`, of the offending line in the record. */
  line: number;

  /** The four digits as written, e.g. `"0786"`. */
  number: string;

  /** The cited record's bare file name; for `consumers-malformed`, the record's own. */
  record: string;
}

/** The report shape returned by {@link checkSourceAdrConsumers}. */
export interface SourceAdrConsumerResult {
  /** `true` exactly when {@link SourceAdrConsumerResult.issues} is empty. */
  ok: boolean;

  /** One `consumer-mismatch` per citation the declaring record does not claim, plus one `consumers-malformed` per non-canonical field. */
  issues: SourceAdrConsumerIssue[];

  /** One `unlisted-consumer` per citation of a record that declares nothing. */
  unlisted: SourceAdrConsumerIssue[];

  /** References the accuracy rule evaluated (the cited record exists, not exempt). */
  checkedReferences: number;

  /** References skipped because a fixture-tree line carries the marker. */
  exemptReferences: number;

  /**
   * References whose record does not exist. Invariant 4 owns them; this counter
   * lets the two reports be reconciled
   * (`checkedReferences + danglingReferences === checkSourceAdrReferences(...).checkedReferences`).
   */
  danglingReferences: number;

  /** Evaluated references the cited record names. */
  verifiedReferences: number;

  /** Numbers (as written) of the records that declare consumers, ascending. */
  declaredRecords: string[];
}

/**
 * The consumer declaration: exactly the `Consumers:` field label opening a list
 * item at column 0. `Consumes:` is a different field (what the decision consumes,
 * not who consumes it) and must never be read as one of these.
 */
const CONSUMERS_FIELD_PATTERN = /^-\s+\*\*Consumers:\*\*/;

/**
 * Is `line` a `Consumers` field in a plausible but non-canonical shape — an
 * indented or `*`/`+` bullet, a `>` blockquote level, an ordered-list marker,
 * `__…__` bold, the colon outside the bold, no bullet, a plain unbolded label,
 * or a heading? Reported as `consumers-malformed`, so one punctuation slip
 * cannot silently switch the rule off for its record (finding F2).
 *
 * Recognition is deliberately wider than canonicality and the peels run in
 * sequence, so the shapes compose: the caller has already ruled out the
 * column-0 canonical form, hence anything recognized here is malformed by
 * construction. Prose is not a field shape: once the markers are gone the label
 * must open the line and, unless the line is a heading, carry its colon.
 */
function isMalformedConsumersField(line: string): boolean {
  const trimmed = line.trim();
  if (/^#{1,6}[ \t]+\*{0,2}Consumers\b/.test(trimmed)) {
    return true;
  }

  let body = trimmed;
  while (body.startsWith(">")) {
    body = body.slice(1).trimStart(); // one blockquote level
  }
  body = body.replace(/^(?:\d+[.)]|[-*+])[ \t]+/, "").replace(/^[*_]+/, "");
  return /^Consumers[*_]{0,3}\s*:/.test(body);
}

/**
 * A repo-relative path token in a record, e.g. `apps/web/src/server/x.ts`.
 * Brackets are part of the path (Next.js route segments), so they stay in.
 */
const RECORD_PATH_TOKEN_PATTERN = /(?:apps|packages)\/[A-Za-z0-9_./[\]-]+/g;

/**
 * A module specifier in a record, e.g. `` `@/server/rate-limit/classes` ``. A
 * trailing `[...]` group is an annotation (`@/api/v1/p/attendee-sessions[/current]`
 * names the route and its child), so it is stripped before resolution.
 */
const RECORD_SPECIFIER_TOKEN_PATTERN = /@\/[A-Za-z0-9_./[\]-]+/g;

/** A backticked identifier in a record, e.g. `` `AUTH_ERROR_CODES` ``. */
const RECORD_BACKTICKED_NAME_PATTERN = /`([A-Za-z_$][A-Za-z0-9_$]*)`/g;

/** An exported declaration in a source file, e.g. `export function gate(`. */
const SOURCE_EXPORTED_DECLARATION_PATTERN =
  /\bexport\s+(?:const|let|var|function|class|interface|type|enum)\b|\bexport\s+async\s+function\b/g;

/** The identifier a declaration introduces, read from the text after it. */
const EXPORTED_IDENTIFIER_PATTERN = /^\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/;

/** An export list in a source file, e.g. `export { a, b as c }`. */
const SOURCE_EXPORT_LIST_PATTERN = /\bexport\s*\{([^}]*)\}/g;

/**
 * The identifier floor for the exported-symbol channel. Short generic names
 * (`GET`, `rate`, `db`) appear in hundreds of records and would verify
 * arbitrary files; six characters is the point where a name is specific enough
 * to identify a file's API. Deliberate leniency in one direction only: a false
 * accept hides a citation the record does talk about, a false failure would get
 * silenced with a wider exemption.
 */
const MIN_EXPORTED_SYMBOL_LENGTH = 6;

/** Trim the punctuation a prose mention leaves on a path token. */
function trimPathToken(token: string): string {
  return token.replace(/[.,;:]+$/, "");
}

/** The last segment of a path, after POSIX normalization. */
function bareFileName(path: string): string {
  const normalized = posix.normalize(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/**
 * Read a record's `Consumers` field: does it declare (canonically or in a
 * malformed shape), and which lines carry a malformed shape? A malformed field
 * still declares — a slip must not switch enforcement off as a side effect of
 * being reported (finding F2).
 */
function consumersField(text: string): { declares: boolean; malformedLines: number[] } {
  const malformedLines: number[] = [];
  let declares = false;

  for (const [index, line] of text.split("\n").entries()) {
    if (CONSUMERS_FIELD_PATTERN.test(line)) {
      declares = true;
    } else if (isMalformedConsumersField(line)) {
      declares = true;
      malformedLines.push(index + 1);
    }
  }

  return { declares, malformedLines };
}

/** Strip a trailing `[...]` annotation group from a module specifier. */
function stripSpecifierAnnotation(specifier: string): string {
  return specifier.replace(/\[[^\]]*\]$/, "");
}

/** The facts a record contributes to the accuracy rule, computed once. */
interface RecordConsumerFacts {
  /** The record's file name, reported verbatim. */
  fileName: string;

  /** Does the record declare consumers, canonically or in a malformed shape? */
  declaresConsumers: boolean;

  /** 1-based lines of `Consumers`-shaped fields that are not the canonical one. */
  malformedConsumersLines: number[];

  /** Repo-relative path tokens, trimmed. */
  paths: string[];

  /** `@/…` specifiers mapped to `apps/web/src/…` and de-annotated. */
  specifiers: string[];

  /** The backticked identifiers the record names. */
  symbols: ReadonlySet<string>;

  /** The whole markdown, for the bare-file-name channel. */
  text: string;
}

/** Read one record's identification surface. */
function recordConsumerFacts(record: AdrRecordText): RecordConsumerFacts {
  const paths = [...record.text.matchAll(RECORD_PATH_TOKEN_PATTERN)]
    .map((match) => trimPathToken(match[0]))
    .filter((token) => token.length > "apps/".length);

  const specifiers = [...record.text.matchAll(RECORD_SPECIFIER_TOKEN_PATTERN)]
    .map((match) => stripSpecifierAnnotation(trimPathToken(match[0])))
    .filter((token) => token.length > "@/".length)
    // `@/x` names `apps/web/src/x` for a module, and `apps/web/src/app/x` for an
    // App Router route: records write `@/api/v1/p/attendee-sessions[/current]`
    // for the route as well as `@/server/db/indexes` for the module, and both
    // must resolve or the channel would only ever work for one of them.
    .flatMap((token) => [`apps/web/src/${token.slice(2)}`, `apps/web/src/app/${token.slice(2)}`]);

  const symbols = new Set(
    [...record.text.matchAll(RECORD_BACKTICKED_NAME_PATTERN)].map((match) => match[1] ?? "")
  );
  symbols.delete("");

  const consumers = consumersField(record.text);

  return {
    fileName: record.fileName,
    declaresConsumers: consumers.declares,
    malformedConsumersLines: consumers.malformedLines,
    paths,
    specifiers,
    symbols,
    text: record.text,
  };
}

/** Does `text` mention `token` as a whole name (not as part of a longer one)? */
function mentionsToken(text: string, token: string): boolean {
  const isNameCharacter = (character: string): boolean => /[A-Za-z0-9_$-]/.test(character);
  let index = text.indexOf(token);

  while (index !== -1) {
    const before = text.charAt(index - 1);
    const after = text.charAt(index + token.length);
    const boundaryBefore = before === "" || (!isNameCharacter(before) && before !== ".");
    const boundaryAfter = after === "" || !isNameCharacter(after);

    if (boundaryBefore && boundaryAfter) {
      return true;
    }
    index = text.indexOf(token, index + 1);
  }

  return false;
}

/** The identifiers a source file exports, minus the ones below the floor. */
function exportedIdentifiers(text: string): string[] {
  const names = new Set<string>();

  for (const match of text.matchAll(SOURCE_EXPORTED_DECLARATION_PATTERN)) {
    const rest = text.slice(match.index + match[0].length);
    const declared = EXPORTED_IDENTIFIER_PATTERN.exec(rest)?.[1];
    if (declared !== undefined) {
      names.add(declared);
    }
  }

  for (const list of text.matchAll(SOURCE_EXPORT_LIST_PATTERN)) {
    for (const entry of (list[1] ?? "").split(",")) {
      const alias =
        entry
          .trim()
          .split(/\s+as\s+/)
          .pop() ?? "";
      const name = alias.replace(/^type\s+/, "").trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
        names.add(name);
      }
    }
  }

  return [...names].filter((name) => name.length >= MIN_EXPORTED_SYMBOL_LENGTH);
}

/**
 * Does `facts` identify the file at `sourcePath`, given the identifiers that
 * file exports? The four channels are, in the order the module docblock states
 * them: repo-relative path (exact or directory prefix), `@/` module specifier
 * (exact, plus a swept extension, or directory prefix), the bare file name as a
 * whole token — only when that name is in `uniqueBareNames` — and an exported
 * identifier the record names in backticks.
 *
 * The bare-name gate is finding F1: a name several swept files share names none
 * of them, or one record's mention of `route.ts` would verify every route in the
 * tree.
 */
function identifiesFile(
  facts: RecordConsumerFacts,
  sourcePath: string,
  exported: readonly string[],
  uniqueBareNames: ReadonlySet<string>
): boolean {
  const normalized = posix.normalize(sourcePath);

  if (
    facts.paths.some(
      (candidate) =>
        normalized === candidate || normalized.startsWith(`${candidate.replace(/\/+$/, "")}/`)
    )
  ) {
    return true;
  }

  if (
    facts.specifiers.some(
      (candidate) =>
        normalized === candidate ||
        normalized.startsWith(`${candidate.replace(/\/+$/, "")}/`) ||
        normalized.startsWith(`${candidate}.`)
    )
  ) {
    return true;
  }

  const bareName = bareFileName(sourcePath);
  if (bareName.length > 0 && uniqueBareNames.has(bareName) && mentionsToken(facts.text, bareName)) {
    return true;
  }

  return exported.some((name) => facts.symbols.has(name));
}

/**
 * Check that every `ADR-NNNN` reference in `sources` points at a record that
 * names the citing file, when the record declares who its consumers are
 * (finding F-N1). Pure — it never touches the filesystem.
 *
 * The reference population is exactly {@link checkSourceAdrReferences}'s, with
 * the same per-line `adr-fixture` exemption inside `apps/web/src/test` and the
 * same case-sensitive token, so the two reports reconcile. Each citation is
 * classified once: a reference whose record is missing is counted in
 * `danglingReferences` and left to invariant 4; a citation of a record without a
 * `Consumers:` field is `unlisted-consumer`; a citation of a declaring record
 * that identifies the file is `verifiedReferences`; everything else is a
 * `consumer-mismatch` issue. A record whose `Consumers` field is not the
 * canonical shape still declares and still hard-checks its citations, and its
 * offending line is an `issues` entry of its own (`consumers-malformed`), so a
 * hand-written slip fails the report instead of silently disabling the rule.
 *
 * Duplicate numbers do not make this throw or go vacuous: a citation is declared
 * when *any* record with that number declares, and verified when any of them
 * identifies the citing file — reporting duplicates stays
 * {@link checkAdrNumbers}' job.
 *
 * @param sources - The source files to scan, in any order.
 * @param records - The `docs/adr` records: bare file name plus whole text.
 * @returns The accuracy report; `ok` is `false` exactly when a declaring record
 * does not claim a file that cites it.
 * @example
 * ```ts
 * checkSourceAdrConsumers(
 *   [{ path: "apps/web/src/server/x.ts", text: "// see ADR-0146-a.md" }],
 *   [{ fileName: "ADR-0146-a.md", text: "- **Consumers:** `apps/web/src/server/x.ts`" }]
 * );
 * // { ok: true, issues: [], verifiedReferences: 1, declaredRecords: ["0146"], … }
 * ```
 */
export function checkSourceAdrConsumers(
  sources: readonly SourceFileText[],
  records: readonly AdrRecordText[]
): SourceAdrConsumerResult {
  const factsByNumber = new Map<string, RecordConsumerFacts[]>();
  for (const record of [...records].sort((left, right) =>
    compareStrings(left.fileName, right.fileName)
  )) {
    const digits = adrDigitsOf(record.fileName);
    if (digits === null) {
      continue;
    }
    const seen = factsByNumber.get(digits);
    const facts = recordConsumerFacts(record);
    if (seen === undefined) {
      factsByNumber.set(digits, [facts]);
    } else {
      seen.push(facts);
    }
  }

  const declaredRecords = [...factsByNumber.entries()]
    .filter(([, facts]) => facts.some((entry) => entry.declaresConsumers))
    .map(([digits]) => digits)
    .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));

  const issues: SourceAdrConsumerIssue[] = [];
  const unlisted: SourceAdrConsumerIssue[] = [];
  let checkedReferences = 0;
  let exemptReferences = 0;
  let danglingReferences = 0;
  let verifiedReferences = 0;

  // The bare-name channel only identifies a file whose bare name is unique
  // across the swept population (finding F1).
  const bareNameCounts = new Map<string, number>();
  for (const source of sources) {
    const name = bareFileName(source.path);
    bareNameCounts.set(name, (bareNameCounts.get(name) ?? 0) + 1);
  }
  const uniqueBareNames = new Set(
    [...bareNameCounts].filter(([, count]) => count === 1).map(([name]) => name)
  );

  // Reported per record, not per citation: a malformed field in a record nobody
  // cites is still a failure (finding F2).
  for (const [digits, facts] of factsByNumber) {
    for (const entry of facts) {
      for (const line of entry.malformedConsumersLines) {
        issues.push({
          code: "consumers-malformed",
          file: entry.fileName,
          line,
          number: digits,
          record: entry.fileName,
        });
      }
    }
  }

  for (const source of sources) {
    const exported = exportedIdentifiers(source.text);

    for (const [index, line] of source.text.split("\n").entries()) {
      const references = [...line.matchAll(SOURCE_ADR_REFERENCE_PATTERN)];
      if (references.length === 0) {
        continue;
      }

      if (
        isSourceAdrFixturePath(source.path) &&
        line.includes(SOURCE_ADR_REFERENCE_FIXTURE_MARKER)
      ) {
        exemptReferences += references.length;
        continue;
      }

      for (const reference of references) {
        const number = reference[1] ?? "";
        const facts = factsByNumber.get(number);
        if (facts === undefined) {
          danglingReferences += 1;
          continue;
        }

        checkedReferences += 1;
        const citedRecord = facts[0]?.fileName ?? "";
        if (!facts.some((entry) => entry.declaresConsumers)) {
          unlisted.push({
            code: "unlisted-consumer",
            file: source.path,
            line: index + 1,
            number,
            record: citedRecord,
          });
          continue;
        }

        if (facts.some((entry) => identifiesFile(entry, source.path, exported, uniqueBareNames))) {
          verifiedReferences += 1;
          continue;
        }

        issues.push({
          code: "consumer-mismatch",
          file: source.path,
          line: index + 1,
          number,
          record: citedRecord,
        });
      }
    }
  }

  issues.sort(compareSourceIssues);
  unlisted.sort(compareSourceIssues);

  return {
    ok: issues.length === 0,
    issues,
    unlisted,
    checkedReferences,
    exemptReferences,
    danglingReferences,
    verifiedReferences,
    declaredRecords,
  };
}

/**
 * Apply {@link checkSourceAdrConsumers} to a real working tree: read the records
 * out of `<root>/docs/adr/`, then every source file under `<root>/apps/` and
 * `<root>/packages/` — the same roots, extensions and skipped directories as
 * {@link checkRepositoryAdrReferences}, so the two sweeps see one population.
 *
 * @param root - Absolute path to the repository root.
 * @returns The same report shape as {@link checkSourceAdrConsumers}.
 * @throws If `docs/adr`, `apps` or `packages` cannot be read, so a wrong root
 * fails loudly instead of reporting a vacuous pass.
 */
export function checkRepositoryAdrConsumers(root: string): SourceAdrConsumerResult {
  // Read the ADR directory first: a bad root throws here, before any source is
  // collected, so "nothing to check" can never be a false pass.
  const records: AdrRecordText[] = readDirectoryEntries(join(root, "docs/adr"))
    .filter((entry) => entry.isFile() && IN_SCOPE_ADR_NAME_PATTERN.test(entry.name))
    .map((entry) => ({
      fileName: entry.name,
      text: readTextFile(join(root, "docs/adr", entry.name)),
    }));

  const paths: string[] = [];
  for (const top of SOURCE_SWEEP_ROOTS) {
    collectSourceFiles(root, join(root, top), paths);
  }
  paths.sort(compareStrings);

  const sources = paths.map((path) => ({ path, text: readTextFile(join(root, path)) }));

  return checkSourceAdrConsumers(sources, records);
}

/* ------------------------------------------------------------------------- *
 * Invariant 6 — every markdown link target inside a record resolves (F3)
 * ------------------------------------------------------------------------- */

/**
 * One markdown record handed to {@link checkAdrRecordLinks}.
 *
 * `path` is carried through into the report verbatim (repo-relative, POSIX
 * separators), so the caller decides how a record is named and the check stays
 * pure — it never touches the filesystem.
 */
export interface AdrRecordLinkFileText {
  /** Repo-relative POSIX path, e.g. `docs/adr/ADR-0782-op129-attendee-session-edge-pins.md`. */
  path: string;

  /** The record's whole markdown; lines are split on `"\n"`. */
  text: string;
}

/**
 * One markdown link target in a record with no `docs/adr` file of that exact
 * name (finding F3).
 *
 * `target` keeps the target **as written** (`#fragment` included) so the reader
 * can paste it back into the record, while `file` and `line` name the record and
 * the line that carries it.
 */
export interface AdrRecordLinkIssue {
  /** Always `"dangling-reference"`; the same discriminant the source sweep uses. */
  code: "dangling-reference";

  /** Repo-relative POSIX path of the record that carries the link. */
  file: string;

  /** 1-based line number of the link, matching an editor's gutter. */
  line: number;

  /**
   * The link target as written, `#fragment` included, so a report can quote it
   * back into the record, e.g. a renamed record's old file name.
   */
  target: string;
}

/** The report shape returned by {@link checkAdrRecordLinks}. */
export interface AdrRecordLinkResult {
  /** `true` exactly when {@link AdrRecordLinkResult.issues} is empty. */
  ok: boolean;

  /**
   * One entry per dangling link **occurrence** — not per target and not per
   * record — sorted by `file`, then `line`, then `target`.
   */
  issues: AdrRecordLinkIssue[];

  /** ADR-shaped link targets the rule evaluated. */
  checkedLinks: number;

  /** Records swept, so "no issues" can never be a vacuous pass. */
  scannedRecords: number;
}

/**
 * A markdown inline link target: the text between `](` and the first `)` or
 * whitespace. A link title (`](x.md "title")`) therefore stops before the space,
 * and a URL is read whole.
 */
const MARKDOWN_LINK_TARGET_PATTERN = /\]\(([^)\s]+)\)/g;

/** The delimiter that opens and closes a fenced code block. */
const FENCE_DELIMITER = "```";

/** An inline code span. Its contents are prose, never a link. */
const INLINE_CODE_SPAN_PATTERN = /`[^`]*`/g;

/**
 * The leaf of a same-directory ADR link target, or `null` when the target is not
 * one.
 *
 * Applied **after** any `#fragment` is stripped, and deliberately strict: no
 * path separator (a `./` or `../` prefix or an external URL is not a record file
 * name), a case-sensitive `ADR-` prefix and a `.md` suffix. The leaf is then
 * compared with the directory's file names **exactly**, so a target that merely
 * shares a number with a record (`0029-domain-event-outbox.md` next to the real
 * `0029-domain-events-outbox.md`) or a name prefix of one is still dangling.
 */
function adrLinkLeaf(target: string): string | null {
  const leaf = target.split("#")[0] ?? "";

  if (leaf.includes("/") || !leaf.startsWith("ADR-") || !leaf.endsWith(".md")) {
    return null;
  }

  return leaf;
}

/**
 * The record's lines with its prose blanked: a fenced code block (the fence
 * lines and everything between them) and every inline code span are replaced, so
 * a `](…)` shape that *documents* a link is never read as one. Line count and
 * indexes are preserved, so a reported line number stays the editor's.
 */
function proseStrippedLines(text: string): string[] {
  const lines: string[] = [];
  let inFence = false;

  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith(FENCE_DELIMITER)) {
      inFence = !inFence;
      lines.push("");
      continue;
    }
    lines.push(inFence ? "" : line.replace(INLINE_CODE_SPAN_PATTERN, ""));
  }

  return lines;
}

/** Order record-link issues: record path, then line, then target. */
function compareAdrRecordLinkIssues(
  left: { readonly file: string; readonly line: number; readonly target: string },
  right: { readonly file: string; readonly line: number; readonly target: string }
): number {
  const byFile = compareStrings(left.file, right.file);
  if (byFile !== 0) {
    return byFile;
  }
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return compareStrings(left.target, right.target);
}

/**
 * Check that every markdown link target inside `records` names one of
 * `adrFileNames` — the file names present in the same `docs/adr` directory.
 * Pure: it never touches the filesystem, so the rule is testable without
 * fixtures on disk.
 *
 * A target is read only from a markdown inline link (`](target)`) and only when
 * its leaf, after any `#fragment` is stripped, is a same-directory `ADR-*.md`
 * file name; a `README.md` link, an anchor, a path-bearing relative link and an
 * external URL are not record files and are not counted. Fenced code blocks and
 * inline code spans are prose and are never read. Resolution is exact file-name
 * equality — never a prefix or a number-only match, which would accept a
 * renamed record's old slug whenever its number is still in use.
 *
 * @param records - The `docs/adr` records to scan, in any order.
 * @param adrFileNames - Bare file names present in `docs/adr`.
 * @returns `ok: true` with no issues when every link target resolves.
 * @example
 * ```ts
 * checkAdrRecordLinks(
 *   [{ path: "docs/adr/ADR-0146-a.md", text: "see [b](ADR-0147-b.md)" }],
 *   ["ADR-0146-a.md", "ADR-0147-b.md"]
 * );
 * // { ok: true, issues: [], checkedLinks: 1, scannedRecords: 1 }
 * ```
 */
export function checkAdrRecordLinks(
  records: readonly AdrRecordLinkFileText[],
  adrFileNames: readonly string[]
): AdrRecordLinkResult {
  const resolvable = new Set(adrFileNames);
  const issues: AdrRecordLinkIssue[] = [];
  let checkedLinks = 0;

  for (const record of records) {
    for (const [index, line] of proseStrippedLines(record.text).entries()) {
      for (const match of line.matchAll(MARKDOWN_LINK_TARGET_PATTERN)) {
        const target = match[1] ?? "";
        const leaf = adrLinkLeaf(target);
        if (leaf === null) {
          continue;
        }

        checkedLinks += 1;
        if (resolvable.has(leaf)) {
          continue;
        }

        issues.push({ code: "dangling-reference", file: record.path, line: index + 1, target });
      }
    }
  }

  issues.sort(compareAdrRecordLinkIssues);

  return { ok: issues.length === 0, issues, checkedLinks, scannedRecords: records.length };
}

/**
 * Apply {@link checkAdrRecordLinks} to a real working tree: read the file names
 * and the `ADR-*.md` records out of `<root>/docs/adr/` — the same in-scope name
 * predicate the numbering guard uses, so the two guards agree on what a record
 * is.
 *
 * `docs/adr/README.md` is deliberately **not** swept: the ledger's historical
 * notes keep pre-rename record names on purpose, and flagging them would force
 * the record of a collision to stop describing it.
 *
 * @param root - Absolute path to the repository root.
 * @returns The same report shape as {@link checkAdrRecordLinks}.
 * @throws If `docs/adr` cannot be read — a wrong root must fail loudly instead
 * of sweeping nothing and reporting a vacuous pass.
 */
export function checkRepositoryAdrLinks(root: string): AdrRecordLinkResult {
  // The directory read comes first on purpose: a bad root throws here, before
  // any record is read, so "no links found" can never be a false pass.
  const entries = readDirectoryEntries(join(root, "docs/adr"));
  const adrFileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);

  const records: AdrRecordLinkFileText[] = entries
    .filter((entry) => entry.isFile() && IN_SCOPE_ADR_NAME_PATTERN.test(entry.name))
    .map((entry) => ({
      path: `docs/adr/${entry.name}`,
      text: readTextFile(join(root, "docs/adr", entry.name)),
    }));

  return checkAdrRecordLinks(records, adrFileNames);
}
