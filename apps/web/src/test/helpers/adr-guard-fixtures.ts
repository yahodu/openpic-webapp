import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fixtures shared by the ADR guard's per-invariant specs (ADR-0302, `## Decision`
 * six-row invariant table).
 *
 * The guard's spec used to be a single file; it is now one spec per invariant,
 * so everything the five specs share lives here: the repository root, the real
 * `docs/adr` directory, the throwaway-directory factories and the lane-ledger
 * factory. `repoRoot` keeps the five-level depth of `helpers/`
 * (`src/test/helpers` -> repository root), so it resolves from this module
 * exactly as it did from `src/test/unit`.
 *
 * Data and factories only — no `describe` or `it` in this module.
 */

export const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
export const realAdrDir = join(repoRoot, "docs/adr");

/**
 * Every temp directory these factories created. A spec's `afterEach` splices it,
 * so each factory's output is removed whether the case passed or threw.
 */
export const tempDirs: string[] = [];

/**
 * The one `mkdirSync` + `writeFileSync` call site in this module. Every fixture
 * write goes through it, so the security preset's non-literal-`fs` warnings
 * stay countable and no new one appears per fixture factory.
 */
export function writeFixtureFile(filePath: string, text: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, text);
}

export function makeTempAdrDir(fileNames: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "adr-numbering-"));
  tempDirs.push(dir);
  for (const fileName of fileNames) {
    writeFixtureFile(join(dir, fileName), "");
  }
  return dir;
}

/**
 * A temp ADR directory that also carries a `README.md` with `readmeMarkdown`
 * (F-L1: the lane ledger the range check reads).
 */
export function makeTempAdrDirWithReadme(fileNames: string[], readmeMarkdown: string): string {
  const dir = makeTempAdrDir(fileNames);
  writeFixtureFile(join(dir, "README.md"), readmeMarkdown);
  return dir;
}

/**
 * A throwaway repository root for the source-reference sweep: `files` maps a
 * repo-relative POSIX path to its text, and every parent directory is created.
 */
export function makeTempRepoRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "adr-source-refs-"));
  tempDirs.push(root);
  for (const [relativePath, text] of Object.entries(files)) {
    writeFixtureFile(join(root, relativePath), text);
  }
  return root;
}

/**
 * The `### Reserved ranges` table as markdown — header row, `---` separator row,
 * then `rows` verbatim. Fixture factory only: the case that uses it writes every
 * lane row it pins.
 */
export function laneLedger(rows: string[]): string {
  return [
    "### Reserved ranges (effective 2026-10-20)",
    "",
    "| Holder (lane)                       | Reserved range | Next free |",
    "| ----------------------------------- | -------------- | --------- |",
    ...rows,
  ].join("\n");
}
