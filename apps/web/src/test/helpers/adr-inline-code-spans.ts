/**
 * Guard — an **escaped inner backtick** (the byte pair backslash + `` ` ``) must
 * not appear on a prose line of any repository markdown file.
 *
 * The rule exists because `prettier@3.9.9` reads `` \` `` inside a
 * single-backtick inline code span as a *closing* delimiter and then **drops the
 * spaces adjacent to every inline code span in that paragraph**. The damaged
 * text is a stable prettier fixpoint, so `prettier --check` reports the glued
 * prose as clean: no formatter gate can see the defect, which is how it shipped
 * in seven records before the sweep in `585`/`608`. Renderers show the escaped
 * backtick as a literal backtick, which is what the author meant, so the
 * construct looks right in review and only the space loss is wrong. The fix is
 * to widen the span's delimiters to two backticks each side, or to fenced code.
 *
 * The rationale lives here rather than in a record on purpose: the card that
 * added this guard forbids minting a number, and this family keeps each
 * invariant's rationale in the module and spec that pin it. See
 * {@link checkMarkdownInlineCodeDelimiters} and
 * {@link checkRepositoryInlineCodeDelimiters}.
 *
 * Fences are code, not inline spans: an escaped backtick inside a **matched**
 * fenced block is silent (a shell snippet legitimately needs it to suppress
 * command substitution) and is counted separately in `fencedOccurrences`, so the
 * skip is visible in the report. An **unmatched** opening fence is not a fence —
 * its lines stay prose, so one dropped closing delimiter cannot silence the rest
 * of a file. Only fenced blocks are recognised: an indented (four-space) code
 * block is read as prose, unless the fence itself is indented (nested in a list
 * item), which is matched.
 *
 * This module opens no new `fs` call site: it reads directories and files only
 * through `readDirectoryEntries` and `readTextFile`, the two wrappers
 * `adr-source-references.ts` exposes, so the security preset keeps one warning
 * per API instead of one per sweep.
 */

import { join, relative, sep } from "node:path";

import { compareStrings } from "./adr-guard-types.js";
import { readDirectoryEntries, readTextFile } from "./adr-source-references.js";

/** One markdown file handed to the rule. */
export interface MarkdownFileText {
  /** Repo-relative POSIX path, e.g. `docs/adr/README.md`. */
  path: string;

  /** The file's whole markdown; lines are split on `"\n"`. */
  text: string;
}

/**
 * One escaped inner backtick — one issue per **occurrence**, so a line carrying
 * three of them reports three places to fix.
 */
export interface EscapedBacktickIssue {
  /** Always `"escaped-backtick"`. */
  code: "escaped-backtick";

  /** Repo-relative POSIX path of the file that carries the pair. */
  file: string;

  /** 1-based line number of the pair, matching an editor's gutter. */
  line: number;

  /** 1-based column of the **backslash** — the first byte of the pair. */
  column: number;
}

/**
 * The report shape returned by both entry points.
 *
 * `occurrences` counts every byte pair the sweep saw, fenced blocks included;
 * `fencedOccurrences` is the fenced subset, so
 * `issues.length + fencedOccurrences === occurrences` always holds.
 */
export interface EscapedBacktickResult {
  /** `true` exactly when {@link EscapedBacktickResult.issues} is empty. */
  ok: boolean;

  /** One entry per prose occurrence, sorted by `file`, then `line`, then `column`. */
  issues: EscapedBacktickIssue[];

  /** Every occurrence the sweep saw, inside and outside a fenced block. */
  occurrences: number;

  /** The occurrences skipped because they sit inside a fenced block. */
  fencedOccurrences: number;

  /** Markdown files swept, so "no issues" can never be a vacuous pass. */
  scannedFiles: number;

  /** Prose lines scanned (fence delimiters and fenced content excluded). */
  checkedLines: number;
}

/** The byte pair under the ban: a backslash immediately followed by a backtick. */
const ESCAPED_BACKTICK = "\\`";

/**
 * The opening or closing line of a fenced code block: any leading whitespace
 * (a fence nested in a list item is indented by the container's width, and
 * `ADR-0300` carries one at four spaces), then a run of three or more backticks
 * or three or more tildes. The rest of the line is the info string on an
 * opening fence and must be blank on a closing one (see
 * {@link fencedLineIndexes}).
 */
const FENCE_PATTERN = /^(\s*)(`{3,}|~{3,})(.*)$/;

/** Directory names the sweep never descends into, at any depth. */
const SKIPPED_MARKDOWN_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".next",
  "dist",
  "coverage",
  "playwright-report",
  "test-results",
  ".git",
  ".worktrees",
  ".turbo",
  "build",
]);

/** The one extension the sweep reads. */
const MARKDOWN_EXTENSION = ".md";

/** A delimiter run read off one line: its character, its length and its tail. */
interface FenceRun {
  /** `` ` `` or `~`. */
  marker: string;

  /** How many delimiters the run holds; a close needs at least as many. */
  length: number;

  /** Everything after the run — the info string on an opening fence. */
  rest: string;
}

/**
 * The delimiter run on `line`, or `null` when the line does not start with one.
 *
 * @param line - One line, without its newline.
 * @returns The run's marker, length and tail, or `null` for a prose line.
 */
function fenceRun(line: string): FenceRun | null {
  const match = FENCE_PATTERN.exec(line);
  if (match === null) {
    return null;
  }

  const run = match[2] ?? "";

  return { marker: run.slice(0, 1), length: run.length, rest: match[3] ?? "" };
}

/**
 * The indexes of the lines that belong to a **matched** fenced code block — both
 * delimiter lines and everything between them.
 *
 * A fence closes only on a run of the same character at least as long as the
 * opening run with nothing but whitespace after it, so a three-backtick line
 * inside a four-backtick fence stays content and a `~~~` line inside a backtick
 * fence does too.
 *
 * An **unmatched** opening fence is not a fence at all: its lines are left out
 * of the result and are therefore read as prose. CommonMark would run that block
 * to the end of the file, but a guard must not let one dropped closing delimiter
 * silence everything below it — the same file usually also lost the content it
 * was supposed to fence, so failing loud is the only safe reading.
 *
 * @param lines - The file's lines, without newlines.
 * @returns The 0-based indexes of every line inside a matched fence.
 */
function fencedLineIndexes(lines: readonly string[]): Set<number> {
  const fenced = new Set<number>();
  let open: (FenceRun & { start: number }) | null = null;

  for (const [index, line] of lines.entries()) {
    const run = fenceRun(line);

    if (open === null) {
      if (run !== null) {
        open = { ...run, start: index };
      }
      continue;
    }

    const closes =
      run !== null &&
      run.marker === open.marker &&
      run.length >= open.length &&
      run.rest.trim() === "";

    if (closes) {
      for (let at = open.start; at <= index; at += 1) {
        fenced.add(at);
      }
      open = null;
    }
  }

  return fenced;
}

/**
 * The 1-based columns of every {@link ESCAPED_BACKTICK} pair in `line`, in
 * ascending order. Adjacent pairs are counted separately (`\`\`` is two
 * pairs at columns 1 and 3), because each one is a delimiter an author has to
 * replace.
 *
 * @param line - One line, without its newline.
 * @returns The 1-based column of each pair's backslash.
 */
function escapedBacktickColumns(line: string): number[] {
  const columns: number[] = [];

  for (
    let at = line.indexOf(ESCAPED_BACKTICK);
    at !== -1;
    at = line.indexOf(ESCAPED_BACKTICK, at + 1)
  ) {
    columns.push(at + 1);
  }

  return columns;
}

/** Order issues: file, then line, then column. */
function compareEscapedBacktickIssues(
  left: { readonly file: string; readonly line: number; readonly column: number },
  right: { readonly file: string; readonly line: number; readonly column: number }
): number {
  const byFile = compareStrings(left.file, right.file);
  if (byFile !== 0) {
    return byFile;
  }
  if (left.line !== right.line) {
    return left.line - right.line;
  }

  return left.column - right.column;
}

/**
 * Check that no prose line of `files` carries an escaped inner backtick. Pure —
 * it never touches the filesystem, so the rule is testable without fixtures on
 * disk.
 *
 * A fenced code block is code, not prose, so a pair inside a **matched** one is
 * skipped and counted in `fencedOccurrences`; every other pair is one
 * `escaped-backtick` issue, including any pair below an opening fence that is
 * never closed. Lines are read verbatim: an escaped backtick in a heading, a
 * table cell, a list item and a paragraph are the same defect, because prettier
 * re-parses all of them the same way.
 *
 * @param files - The markdown files to scan, in any order.
 * @returns `ok: true` with no issues when no prose line carries the pair.
 * @example
 * ```ts
 * checkMarkdownInlineCodeDelimiters([
 *   { path: "docs/adr/README.md", text: "add \\`link: \\`$URL\\`\\`" },
 * ]);
 * // { ok: false, issues: [{ code: "escaped-backtick", file: "docs/adr/README.md", … }], … }
 * ```
 */
export function checkMarkdownInlineCodeDelimiters(
  files: readonly MarkdownFileText[]
): EscapedBacktickResult {
  const issues: EscapedBacktickIssue[] = [];
  let occurrences = 0;
  let fencedOccurrences = 0;
  let checkedLines = 0;

  for (const file of files) {
    const lines = file.text.split("\n");
    const fenced = fencedLineIndexes(lines);

    for (const [index, line] of lines.entries()) {
      const columns = escapedBacktickColumns(line);
      occurrences += columns.length;

      if (fenced.has(index)) {
        fencedOccurrences += columns.length;
        continue;
      }

      checkedLines += 1;
      for (const column of columns) {
        issues.push({ code: "escaped-backtick", file: file.path, line: index + 1, column });
      }
    }
  }

  issues.sort(compareEscapedBacktickIssues);

  return {
    ok: issues.length === 0,
    issues,
    occurrences,
    fencedOccurrences,
    scannedFiles: files.length,
    checkedLines,
  };
}

/**
 * Walk one directory tree for markdown files, appending repo-relative POSIX
 * paths to `collected`. Skips {@link SKIPPED_MARKDOWN_DIRECTORIES} by name at any
 * depth and every file that is not `.md`. Symlinks are not followed (`isFile()`
 * is false for them), so the walk cannot loop and cannot leave the root.
 *
 * @param root - Absolute path to the repository root, used to relativize.
 * @param dir - The absolute directory to list.
 * @param collected - Appended with each markdown file's repo-relative POSIX path.
 * @returns Nothing; `collected` carries the result.
 */
function collectMarkdownFiles(root: string, dir: string, collected: string[]): void {
  for (const entry of readDirectoryEntries(dir)) {
    const entryPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!SKIPPED_MARKDOWN_DIRECTORIES.has(entry.name)) {
        collectMarkdownFiles(root, entryPath, collected);
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(MARKDOWN_EXTENSION)) {
      collected.push(relative(root, entryPath).split(sep).join("/"));
    }
  }
}

/**
 * Apply {@link checkMarkdownInlineCodeDelimiters} to a real working tree: read
 * every `*.md` file under `root`, skipping the trees
 * {@link SKIPPED_MARKDOWN_DIRECTORIES} names.
 *
 * Nothing is hardcoded beyond the skip list, so the pin follows the tree it runs
 * in — a worktree, the shared checkout, or a CI clone. Build output
 * (`apps/web/.next/**`), dependencies and the `.worktrees/` of a shared checkout
 * are never read, so the result does not depend on whether a build ran.
 *
 * @param root - Absolute path to the repository root.
 * @returns The same report shape as {@link checkMarkdownInlineCodeDelimiters}.
 * @throws If `root` cannot be read — a wrong root must fail loudly instead of
 * sweeping nothing and reporting a vacuous pass.
 */
export function checkRepositoryInlineCodeDelimiters(root: string): EscapedBacktickResult {
  const paths: string[] = [];
  collectMarkdownFiles(root, root, paths);
  paths.sort(compareStrings);

  const files = paths.map((path) => ({ path, text: readTextFile(join(root, path)) }));

  return checkMarkdownInlineCodeDelimiters(files);
}
