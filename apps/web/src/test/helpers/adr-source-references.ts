/**
 * ADR guard, invariant (iv) — every in-source `ADR-NNNN` reference resolves
 * (finding F6-b). The guard's invariants are tabulated once, in `0302`
 * (`## Decision`, the invariant table); the decision detail for this
 * one is §8.
 *
 * The check answers the question the numbering guard cannot: "does the ADR this
 * comment cites still exist?" It was added because the OP-128 round-1 renumber
 * left five shipped comments citing `0764`/`0765` after those decisions moved to
 * `0766`/`0767` — and `0764`/`0765` belong to sibling lanes, so the comments
 * pointed at the wrong decisions. Nothing read the references; now the sweep
 * does. See {@link checkSourceAdrReferences} and
 * {@link checkRepositoryAdrReferences}.
 *
 * This module also owns the guard family's two filesystem call sites —
 * {@link readDirectoryEntries} and {@link readTextFile} — and the tree walk
 * {@link collectSourceFiles}: the numbering guard, the citation-accuracy sweep
 * and the record-link sweep all read through them, so there is one place a
 * security preset can see a non-literal `fs` call.
 *
 * It also owns the family's **measured-count provenance clause** (`ADR-0302`
 * §12): a record that quotes a suite count must name the head commit it was
 * measured at. The clause lives here because it is a reference rule over the
 * records and because this module already owns the directory read and the file
 * read that the rule needs; it has no invariant row of its own on purpose.
 */

import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, join, posix, relative, sep } from "node:path";

import type {
  MeasuredCommitCheck,
  MeasuredCommitIssue,
  MeasuredCommitResult,
  SourceAdrReferenceIssue,
  SourceAdrReferenceResult,
  SourceFileText,
} from "./adr-guard-types.js";
import {
  adrDigitsOf,
  compareSourceIssues,
  compareStrings,
  IN_SCOPE_ADR_NAME_PATTERN,
} from "./adr-guard-types.js";

/**
 * The guard family's one directory-read call site. `checkAdrDirectory` and
 * both source sweeps go through it: the security preset flags every
 * `readdirSync` with a non-literal argument, so a second call site would add a
 * warning for nothing.
 *
 * @param dir - Absolute or relative path to the directory to list.
 * @returns The raw directory entries (`fs.Dirent`s, so callers can tell a file
 * from a directory from a symlink without another `stat`).
 * @throws If `dir` cannot be read (missing directory, permission denied).
 */
export function readDirectoryEntries(dir: string): Dirent[] {
  return readdirSync(dir, { withFileTypes: true });
}

/**
 * The guard family's one file-read call site (see {@link readDirectoryEntries}).
 *
 * @param filePath - Absolute or relative path to the file.
 * @returns The file's whole text, UTF-8.
 * @throws If `filePath` cannot be read.
 */
export function readTextFile(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

/** Source-file extensions the repository sweep reads. */
const SOURCE_FILE_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * The top-level trees the sweep walks. Deliberately not the whole repository:
 * `scripts/` and the docs are outside the application's source, so a reference
 * there is not a shipped comment.
 */
export const SOURCE_SWEEP_ROOTS: readonly string[] = ["apps", "packages"];

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
export const SOURCE_ADR_REFERENCE_PATTERN = /ADR-(\d{4})(?!\d)/g;

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
export const SOURCE_ADR_REFERENCE_FIXTURE_MARKER = "adr-fixture";

/**
 * The only tree in which {@link SOURCE_ADR_REFERENCE_FIXTURE_MARKER} exempts a
 * line: the guard's own fixtures. Helpers, unit and integration specs all live
 * under `apps/web/src/test`, and nothing else does. Matched as a directory
 * boundary on the normalized repo-relative POSIX path, so `src/test-tools/x.ts`
 * and a `..` segment that leaves the tree are both *outside* it.
 */
const SOURCE_ADR_REFERENCE_FIXTURE_ROOT = "apps/web/src/test";

/** Is `path` inside {@link SOURCE_ADR_REFERENCE_FIXTURE_ROOT}? */
export function isSourceAdrFixturePath(path: string): boolean {
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
export function collectSourceFiles(root: string, dir: string, collected: string[]): void {
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

/**
 * A suite-count quote: a digit run, whitespace, `passed`, whitespace, `(`.
 *
 * That is vitest's own summary (`Tests  15 passed (15)`, `1 failed | 14 passed
 * (15)`, `3 skipped | 3398 passed (3401)`) including a quote whose parenthesis
 * wrapped onto the next line, which the trunk does twice. The parenthesis is
 * part of the shape so bare prose — "the 3 passed cases" — is never a quote. It
 * is deliberately not a `/\d+ passed \(/` (one space) pattern: four records write
 * a double space or a wrap there, and a census that cannot see their counts
 * cannot hold them to a head.
 */
const SUITE_COUNT_QUOTE_PATTERN = /\d[\d,]*\s+passed\s+\(/;

/**
 * A head commit reference: a lowercase hexadecimal run of 7 to 40 characters
 * that carries at least one `a`–`f` letter.
 *
 * Each bound is load-bearing. The letter requirement rejects a bare digit run —
 * four trunk records match the looser `\b[0-9a-f]{7,40}\b` on an epoch
 * (`1792924295000`), a byte count (`53687091200`), a magic number and a
 * placeholder (`0123456789`) — none of which pins a commit. The 7-character floor
 * rejects a six-character prefix, which cannot pin one. The 40-character ceiling
 * rejects a 64-character blob hash, which is a file's digest, not a commit.
 * Lowercase only: this repository writes SHAs lowercase, and an uppercase token
 * is a typo to report rather than a head to accept.
 */
const HEAD_COMMIT_PATTERN = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/;

/**
 * The records the rule cannot enforce today, as bare four-digit record numbers.
 *
 * Each one quotes a suite count and names no head commit at `f0422e2e` — the
 * eighteen the provenance clause's census found. A number is the right key and a
 * file name is not: a record number is unique on the trunk (invariant (i)), so a
 * number identifies exactly one file, and naming the eighteen files here would
 * make this helper their declared **consumer** — invariant (v) reported three
 * `consumer-mismatch` issues when it did, because three of them list their
 * consumers and this helper is not one. Skipping by number is what the follow-up
 * card allows, and it keeps the record↔citation contract honest.
 *
 * The list can only shrink: the spec pins it equal to the tree's actual offender
 * numbers, so repairing a record reds until its number leaves this list, and a
 * stale number (a record that is now clean, retired, or renumbered) reds the same
 * way. A cut-off — "enforce above the highest number at writing" — was rejected
 * because it enforces nothing until the next record is minted, while this list
 * enforces the rule over the other 297 records on the trunk today.
 */
export const MEASURED_COMMIT_EXEMPTIONS: readonly string[] = [
  "0046",
  "0323",
  "0383",
  "0385",
  "0393",
  "0420",
  "0440",
  "0442",
  "0460",
  "0465",
  "0480",
  "0520",
  "0580",
  "0780",
  "0784",
  "0830",
  "0833",
  "0972",
];

/**
 * Check that every record which quotes a suite count also names the head commit
 * it was measured at — the measured-count provenance clause of the ADR guard
 * (`ADR-0302` §12). Pure: it never touches the filesystem.
 *
 * A record that quotes no suite count is out of scope and never appears in
 * `checked`, so a design record without a measurement cannot look checked. A
 * record that quotes counts and names a head reports that head; one that names
 * none reports a `missing-head-commit` issue. Only the record's **first** quote is
 * named in the report — a record has one measured head, so one defect — and only
 * the first head-shaped token is reported, in document order. Fenced code blocks
 * and inline code spans are read, unlike invariant (vi): a record's counts and its
 * head live in fences and backticks.
 *
 * @param records - The `docs/adr` records to scan, in any order.
 * @returns The report, sorted by record path.
 * @example
 * ```ts
 * checkMeasuredCommitCitations([
 *   { path: "docs/adr/ADR-0302-a.md", text: "Tests  15 passed (15)\n\nAt `e91cfed7`." },
 * ]);
 * // { ok: true, issues: [], checked: [{ file: "docs/adr/ADR-0302-a.md",
 * //   line: 1, quoted: "15 passed", head: "e91cfed7" }], scannedRecords: 1 }
 * ```
 */
export function checkMeasuredCommitCitations(
  records: readonly SourceFileText[]
): MeasuredCommitResult {
  const checked: MeasuredCommitCheck[] = [];
  const issues: MeasuredCommitIssue[] = [];

  for (const record of records) {
    const quote = SUITE_COUNT_QUOTE_PATTERN.exec(record.text);
    if (quote === null) {
      continue;
    }

    const line = record.text.slice(0, quote.index).split("\n").length;
    const quoted = quote[0]
      .replace(/\s+\($/, "")
      .replace(/\s+/g, " ")
      .trim();
    const head = HEAD_COMMIT_PATTERN.exec(record.text);

    checked.push({ file: record.path, line, quoted, head: head === null ? null : head[0] });
    if (head === null) {
      issues.push({ code: "missing-head-commit", file: record.path, line, quoted });
    }
  }

  checked.sort((left, right) => compareStrings(left.file, right.file));
  issues.sort((left, right) => compareStrings(left.file, right.file));

  return { ok: issues.length === 0, issues, checked, scannedRecords: records.length };
}

/**
 * Apply {@link checkMeasuredCommitCitations} to a real working tree: read the
 * `ADR-*.md` records out of `<root>/docs/adr/` — the same in-scope name predicate
 * the numbering and record-link guards use, so the three agree on what a record
 * is — and drop the records on `exemptions` from the report.
 *
 * `docs/adr/README.md` is deliberately not read: the ledger's notes quote other
 * heads' counts on purpose, and holding them to one head would force the ledger to
 * stop describing the deliveries it records.
 *
 * An exempt record is read off the tree and then dropped: it appears in neither
 * `checked` nor `issues`, so repairing one cannot look like a pass, while
 * `scannedRecords` still counts it.
 *
 * @param root - Absolute path to the repository root.
 * @param exemptions - Bare four-digit record numbers the rule skips; defaults to
 * {@link MEASURED_COMMIT_EXEMPTIONS}. Pass `[]` to enumerate every offender.
 * @returns The same report shape as {@link checkMeasuredCommitCitations}.
 * @throws If `docs/adr` cannot be read — a wrong root must fail loudly instead of
 * sweeping nothing and reporting a vacuous pass.
 */
export function checkRepositoryMeasuredCommitCitations(
  root: string,
  exemptions: readonly string[] = MEASURED_COMMIT_EXEMPTIONS
): MeasuredCommitResult {
  // The directory read comes first on purpose: a bad root throws here, before any
  // record is read, so "nothing to report" can never be a false pass.
  const records: SourceFileText[] = readDirectoryEntries(join(root, "docs/adr"))
    .filter((entry) => entry.isFile() && IN_SCOPE_ADR_NAME_PATTERN.test(entry.name))
    .map((entry) => ({
      path: `docs/adr/${entry.name}`,
      text: readTextFile(join(root, "docs/adr", entry.name)),
    }));

  const report = checkMeasuredCommitCitations(records);
  if (exemptions.length === 0) {
    return report;
  }

  const exempt = new Set(exemptions);
  const kept = (path: string): boolean => {
    const digits = adrDigitsOf(basename(path));
    return digits === null || !exempt.has(digits);
  };

  return {
    ok: report.issues.every((issue) => !kept(issue.file)),
    issues: report.issues.filter((issue) => kept(issue.file)),
    checked: report.checked.filter((check) => kept(check.file)),
    scannedRecords: report.scannedRecords,
  };
}
