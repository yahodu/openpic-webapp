/**
 * ADR guard, invariant (vi)'s **ledger half** — every markdown link target
 * inside `docs/adr/README.md` names a file that exists, or a file the repository
 * carried and renamed. The six invariants are tabulated once, in `0302`
 * (`## Decision`, the six-row invariant table); `ADR-0895` records this half and
 * `0893` records its pins.
 *
 * **Why it is a separate module.** `checkRepositoryAdrLinks`
 * (`adr-record-links.ts`) sweeps `docs/adr/ADR-*.md` and deliberately never
 * reads the ledger, because the ledger's notes keep pre-rename record names on
 * purpose. A dangling link one file over was therefore invisible to the whole
 * guard family (measured: all six guards green at `236 passed (236)` while the
 * ledger pointed at a name suffix a record never had). This module reads that
 * one file and leaves the record sweep exactly as it was.
 *
 * **The history set is a union, and the complement is deliberate.** The
 * pre-rename names this ledger keeps are not reachable from `origin/main` — they
 * were added on lane branches and squash-merged away — and the `ci` job checks
 * out at `fetch-depth: 1`, where `git log --all` sees one commit and no
 * pre-rename name at all. A git-only oracle would report the three historical
 * targets in CI while passing locally, reddening the trunk it is meant to
 * accept. So {@link checkRepositoryAdrLedgerLinks} unions the git set with
 * {@link LEDGER_PRE_RENAME_FILE_NAMES}, a committed trust record. The git set
 * keeps a new pure rename working without an edit here, and a literal list
 * alone cannot pass the spec's synthetic `git mv` case.
 *
 * shortcut: the committed complement is a trust list (CI cannot check it against
 * history), and there is no disk-only integrity rule — an entry may share a
 * number with a live record, as `0770` does with the OP-128 record that took the
 * number. Extend the list when a ledger note gains another pre-rename name.
 *
 * See {@link checkAdrLedgerLinks} and {@link checkRepositoryAdrLedgerLinks}.
 */

import { execFileSync } from "node:child_process";
import { posix, join } from "node:path";

import type {
  AdrRecordLinkFileText,
  AdrRecordLinkIssue,
  AdrRecordLinkResult,
} from "./adr-guard-types.js";
import { compareStrings, IN_SCOPE_ADR_NAME_PATTERN } from "./adr-guard-types.js";
import { readDirectoryEntries, readTextFile } from "./adr-source-references.js";

/**
 * The ledger's path, and the `file` every issue it reports carries. The ledger
 * is one document, never a record.
 */
const LEDGER_PATH = "docs/adr/README.md";

/**
 * The `docs/adr` names the ledger keeps for records that were renamed away — the
 * class the ADR-0302 (vi) exclusion protects. Written as whole file names so the
 * rule keys on the name as the ledger writes it, and read only when the git set
 * cannot answer (a shallow clone).
 *
 * Every line carries the guard family's fixture marker because these numbers are
 * not live records on every surface.
 */
const LEDGER_PRE_RENAME_FILE_NAMES: readonly string[] = [
  "ADR-0769-op129-anonymous-attendee-sessions-red.md", // adr-fixture: pre-rename ledger target
  "ADR-0770-op129-anonymous-attendee-sessions-green.md", // adr-fixture: pre-rename ledger target
  "ADR-0820-op132-confirm-transaction-failure-pin.md", // adr-fixture: pre-rename ledger target
];

/**
 * A markdown inline link's text: everything between `](` and the first `)`.
 * Mirrors `adr-record-links.ts` so the two sweeps read one set of link shapes.
 */
const MARKDOWN_LINK_TEXT_PATTERN = /\]\(([^)]*)\)/g;

/** The delimiter that opens and closes a fenced code block. */
const FENCE_DELIMITER = "```";

/** An inline code span. Its contents are prose, never a link. */
const INLINE_CODE_SPAN_PATTERN = /`[^`]*`/g;

/**
 * The target half of a link's text — the angle brackets and any link title
 * removed, so a report quotes the target and never `<target> "title"`. The
 * `#fragment` is part of the target and stays.
 *
 * shortcut: a target that itself contains a space is cut at the first one;
 * widen if the ledger ever needs such a name.
 */
function linkTarget(text: string): string {
  const bracketed = text.startsWith("<") && text.includes(">");
  const target = bracketed ? text.slice(1, text.indexOf(">")) : text;

  return target.split(/\s+/)[0] ?? "";
}

/**
 * The leaf of a same-directory ADR link target, or `null` when the target is not
 * one. Applied after any `#fragment` is stripped, and deliberately strict: no
 * path separator, a case-sensitive `ADR-` prefix and a `.md` suffix.
 */
function adrLinkLeaf(target: string): string | null {
  const leaf = target.split("#")[0] ?? "";

  if (leaf.includes("/") || !leaf.startsWith("ADR-") || !leaf.endsWith(".md")) {
    return null;
  }

  return leaf;
}

/**
 * The ledger's lines with its prose blanked: a fenced code block and every
 * inline code span are replaced, so a `](…)` shape that documents a link is never
 * read as one. Line count and indexes are preserved.
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

/** Order ledger-link issues: path, then line, then target. */
function compareLedgerLinkIssues(
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
 * Check that every markdown link target inside `ledger` names a file present in
 * `adrFileNames`, or one present in `everAddedAdrFileNames` — a record the
 * repository added under that name and renamed later, which the ledger's notes
 * are allowed to describe. Pure: it never touches the filesystem.
 *
 * Per target, in this order: the leaf resolves against `adrFileNames` → no
 * issue; it does not resolve but is in `everAddedAdrFileNames` → renamed away, no
 * issue; neither → one `dangling-reference` issue carrying the ledger's own
 * path, the 1-based line and the target as written.
 *
 * `checkedLinks` counts the targets evaluated in all three classes and
 * `scannedRecords` is `1`, so `ok: true` can never be a vacuous pass. The link
 * shapes, the `#fragment` handling, the same-directory leaf predicate and the
 * prose rules are exactly `adr-record-links.ts`'s, so the two sweeps agree on
 * what a link is.
 *
 * @param ledger - The ledger document: its repo-relative path and whole text.
 * @param adrFileNames - Bare file names present in `docs/adr` now.
 * @param everAddedAdrFileNames - ADR file names added under `docs/adr` at any
 * commit reachable from the repository's refs, renamed-away names included.
 * @returns `ok: true` with no issues when every target resolves or was renamed.
 * @example
 * ```ts
 * checkAdrLedgerLinks(
 *   { path: "docs/adr/README.md", text: "- [0146](ADR-0146-a.md)" },
 *   ["ADR-0146-a.md"],
 *   []
 * );
 * // { ok: true, issues: [], checkedLinks: 1, scannedRecords: 1 }
 * ```
 */
export function checkAdrLedgerLinks(
  ledger: AdrRecordLinkFileText,
  adrFileNames: readonly string[],
  everAddedAdrFileNames: readonly string[]
): AdrRecordLinkResult {
  const resolvable = new Set(adrFileNames);
  const everAdded = new Set(everAddedAdrFileNames);
  const issues: AdrRecordLinkIssue[] = [];
  let checkedLinks = 0;

  for (const [index, line] of proseStrippedLines(ledger.text).entries()) {
    for (const match of line.matchAll(MARKDOWN_LINK_TEXT_PATTERN)) {
      const target = linkTarget(match[1] ?? "");
      const leaf = adrLinkLeaf(target);
      if (leaf === null) {
        continue;
      }

      checkedLinks += 1;
      if (resolvable.has(leaf) || everAdded.has(leaf)) {
        continue;
      }

      issues.push({ code: "dangling-reference", file: ledger.path, line: index + 1, target });
    }
  }

  issues.sort(compareLedgerLinkIssues);

  return { ok: issues.length === 0, issues, checkedLinks, scannedRecords: 1 };
}

/**
 * The names `root`'s own git history added under `docs/adr`, read with
 * `git log --all --diff-filter=A --name-only` so a pure `git mv` still reports
 * the old name from its own add commit (`git rev-list --objects` lists one object
 * under one path and hides it).
 *
 * An empty set is not a failure: history is the tolerance source, and the ledger
 * read is the loud gate. A shallow clone answers with what its one commit
 * carries, which is why {@link LEDGER_PRE_RENAME_FILE_NAMES} is unioned in.
 */
function gitAddedAdrFileNames(root: string): string[] {
  let output: string;
  try {
    output = execFileSync(
      "git",
      ["log", "--all", "--diff-filter=A", "--name-only", "--format=", "--", "docs/adr"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch {
    return [];
  }

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("docs/adr/"))
    .map((line) => posix.basename(line))
    .filter((name) => IN_SCOPE_ADR_NAME_PATTERN.test(name));
}

/**
 * Apply {@link checkAdrLedgerLinks} to a real working tree: the file names in
 * `<root>/docs/adr`, the text of `<root>/docs/adr/README.md`, and the history set
 * as the union of the git set and
 * {@link LEDGER_PRE_RENAME_FILE_NAMES}.
 *
 * @param root - Absolute path to the repository root.
 * @returns The same report shape as {@link checkAdrLedgerLinks}.
 * @throws If `docs/adr` or `docs/adr/README.md` cannot be read — a wrong root
 * must fail loudly instead of sweeping nothing and reporting a vacuous pass.
 */
export function checkRepositoryAdrLedgerLinks(root: string): AdrRecordLinkResult {
  // The directory read comes first on purpose: a bad root throws here, before
  // the ledger is read, so "no links found" can never be a false pass.
  const adrFileNames = readDirectoryEntries(join(root, "docs/adr"))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  const ledger = { path: LEDGER_PATH, text: readTextFile(join(root, LEDGER_PATH)) };
  const everAdded = [...gitAddedAdrFileNames(root), ...LEDGER_PRE_RENAME_FILE_NAMES];

  return checkAdrLedgerLinks(ledger, adrFileNames, everAdded);
}
