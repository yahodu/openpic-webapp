/**
 * ADR guard, invariant (iv) — every in-source `ADR-NNNN` reference resolves
 * (finding F6-b). The guard's six invariants are tabulated once, in `0302`
 * §1; the decision detail for this one is §8.
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
 */

import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join, posix, relative, sep } from "node:path";

import type {
  SourceAdrReferenceIssue,
  SourceAdrReferenceResult,
  SourceFileText,
} from "./adr-guard-types.js";
import { adrDigitsOf, compareSourceIssues, compareStrings } from "./adr-guard-types.js";

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
