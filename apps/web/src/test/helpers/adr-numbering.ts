import { readdirSync } from "node:fs";

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
 *   2. every in-scope `ADR-*.md` file name is well-formed.
 *
 * Everything else — whether a number sits inside its lane's reserved range, and
 * whether the number is already used on `origin/main` — stays a review-time
 * obligation: the range ledger is prose in `docs/adr/README.md`, and parsing
 * prose in CI is brittle.
 *
 * @see docs/CONVENTIONS.md §11 (ADR numbering)
 * @see docs/adr/ADR-0300-adr-number-range-allocation-policy.md
 * @see apps/web/src/test/unit/adr-numbering.test.ts
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
   * `malformed` — one in-scope file name does not match the strict pattern.
   */
  code: "duplicate" | "malformed";

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
 * Read exactly one directory and apply {@link checkAdrNumbers} to its entries.
 *
 * The read is synchronous and **never recurses**: subdirectory entries are
 * dropped, so a nested `archive/` copy of an ADR cannot produce a phantom
 * duplicate.
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

  return checkAdrNumbers(fileNames);
}
