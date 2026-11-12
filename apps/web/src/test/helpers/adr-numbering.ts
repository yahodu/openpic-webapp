/**
 * The ADR-number guard's public entry point and frozen barrel (`0302` §10).
 *
 * **Why the guard exists.** ADR numbers used to be allocated by "take the lowest
 * free number at commit time", a rule no tool can enforce. On 2026-10-20 that
 * cost a day of rebases — four renumbers in one afternoon and a genuine
 * collision on `0144` that left PR #225 CONFLICTING. ADR-0300 replaces the rule
 * with per-lane reserved ranges (`docs/adr/README.md` § "ADR number
 * allocation"); this module pins the first two invariants of the mechanical half
 * of that policy and composes the third into the directory read:
 *
 *   1. no two in-scope files share an `ADR-NNNN` number;
 *   2. every in-scope `ADR-*.md` file name is well-formed;
 *   3. the ledger's reserved ranges are disjoint, and a range-shaped row that
 *      does not parse is reported rather than skipped (`0300` §10) — the rows
 *      are read by {@link parseLaneRanges} and reported by
 *      {@link checkAdrDirectory}.
 *
 * The six invariants, and the module each one lives in, are tabulated once, in
 * `0302` (`## Decision`, the six-row invariant table). Every other invariant is
 * implemented in its own module and re-exported below.
 *
 * **The barrel is frozen.** New invariants are imported from their own module
 * and are added to this barrel only if an external caller needs them. The
 * re-exports at the bottom exist because the specs and the `0300` §12 pre-merge
 * command import from this path — not because appending here is how the guard
 * grows. A new invariant is a new module, its own spec, and one row in that
 * six-row table.
 *
 * @see docs/CONVENTIONS.md §11 (ADR numbering)
 * @see docs/adr/ADR-0300-adr-number-range-allocation-policy.md
 * @see docs/adr/ADR-0302-adr-number-guard-contract.md
 * @see apps/web/src/test/unit/adr-numbering.test.ts
 * @see apps/web/src/test/unit/adr-lane-ranges.test.ts
 * @see apps/web/src/test/unit/adr-source-references.test.ts
 * @see apps/web/src/test/unit/adr-consumers.test.ts
 * @see apps/web/src/test/unit/adr-record-links.test.ts
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { AdrCheckResult, AdrNumberIssue } from "./adr-guard-types.js";
import { adrDigitsOf, compareStrings, IN_SCOPE_ADR_NAME_PATTERN } from "./adr-guard-types.js";
import { findLaneRangeOverlaps, scanLaneLedger } from "./adr-lane-ranges.js";
import { readDirectoryEntries, readTextFile } from "./adr-source-references.js";

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

/*
 * The frozen barrel (`0302` §10). Sorted by module, then by name; the union of
 * these names is the guard's public surface and must not grow without a caller.
 */

export type {
  AdrCheckResult,
  AdrNumberIssue,
  AdrRecordLinkFileText,
  AdrRecordLinkIssue,
  AdrRecordLinkResult,
  AdrRecordText,
  SourceAdrConsumerIssue,
  SourceAdrConsumerResult,
  SourceAdrReferenceIssue,
  SourceAdrReferenceResult,
  SourceFileText,
} from "./adr-guard-types.js";
export type { LaneRange } from "./adr-lane-ranges.js";
export { parseLaneRanges } from "./adr-lane-ranges.js";
export { checkAdrRecordLinks, checkRepositoryAdrLinks } from "./adr-record-links.js";
export { checkRepositoryAdrReferences, checkSourceAdrReferences } from "./adr-source-references.js";
export { checkRepositoryAdrConsumers, checkSourceAdrConsumers } from "./adr-consumers.js";
