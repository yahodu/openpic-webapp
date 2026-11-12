/**
 * ADR guard, invariant (vi) — every markdown link target inside a record
 * resolves (finding F3). The guard's six invariants are tabulated once, in
 * `0302` §1; the decision detail for this one is §7.
 *
 * The records are the one tree the source sweep never read, so a renamed
 * record's links rot in silence — three OP-129 records pointed at pre-rename
 * files while every guard stayed green. A bare (`](x.md)`), titled
 * (`](x.md "title")`) and angle-bracket (`](<x.md>)`) inline target is read; a
 * `./` path-bearing target, a reference-style `[label][ref]` and its definition,
 * a bare autolink `<x.md>` and a target containing `(`/`)` are not, and a link
 * shape inside a code span or a fenced block is prose. `docs/adr/README.md` is
 * deliberately out (its ledger notes keep the old names on purpose). See
 * {@link checkAdrRecordLinks} and {@link checkRepositoryAdrLinks}.
 */

import { join } from "node:path";

import type {
  AdrRecordLinkFileText,
  AdrRecordLinkIssue,
  AdrRecordLinkResult,
} from "./adr-guard-types.js";
import { compareStrings, IN_SCOPE_ADR_NAME_PATTERN } from "./adr-guard-types.js";
import { readDirectoryEntries, readTextFile } from "./adr-source-references.js";

/**
 * A markdown inline link's text: everything between `](` and the first `)`.
 * {@link linkTarget} peels the target out of it, because the link can carry a
 * title (`](x.md "title")`, not part of the file name) or angle brackets
 * (`](<x.md>)`, which are markdown's way to quote the target).
 *
 * The angle brackets are stripped and the first whitespace-separated token is
 * the target, so all three markdown title styles (`"title"`, `'title'`,
 * `(title)`) are dropped and a `#fragment` stays part of the target.
 *
 * shortcut: a target that itself contains a space is cut at the first one;
 * widen if a record ever needs such a name.
 */
const MARKDOWN_LINK_TEXT_PATTERN = /\]\(([^)]*)\)/g;

/**
 * The target half of a link's text — the angle brackets and any link title
 * removed, so a report quotes `ADR-….md` and never `<ADR-….md> "title"`. The
 * `#fragment` is part of the target and stays. Out of scope, so never a target:
 * a `./ADR-….md` path-bearing name (rejected by {@link adrLinkLeaf}), a
 * reference-style `[label][ref]` and its `[ref]: ADR-….md` definition, a bare
 * autolink `<ADR-….md>`, and a target containing `(` or `)`.
 */
function linkTarget(text: string): string {
  const bracketed = text.startsWith("<") && text.includes(">");
  const target = bracketed ? text.slice(1, text.indexOf(">")) : text;

  return target.split(/\s+/)[0] ?? "";
}

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
 * A target is read from the three inline shapes a link can carry: a bare
 * `](target)`, a titled target (`](target "title")`, whose title is not part of
 * the file name) and an angle-bracket target (`](<target>)`, whose brackets are
 * stripped). A `#fragment` is stripped for resolution and kept in the report.
 * Out of scope, so never read: a `./ADR-….md` path-bearing target (rejected by
 * {@link adrLinkLeaf}), a reference-style `[label][ref]` plus its
 * `[ref]: ADR-….md` definition, a bare autolink `<ADR-….md>`, and a target that
 * itself contains `(` or `)`.
 *
 * A target is counted only when its leaf, after any `#fragment` is stripped, is
 * a same-directory `ADR-*.md` file name; a `README.md` link, an anchor, a
 * path-bearing relative link and an external URL are not record files and are
 * not counted. Fenced code blocks and inline code spans are prose and are never
 * read. Resolution is exact file-name equality — never a prefix or a number-only
 * match, which would accept a renamed record's old slug whenever its number is
 * still in use.
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
      for (const match of line.matchAll(MARKDOWN_LINK_TEXT_PATTERN)) {
        const target = linkTarget(match[1] ?? "");
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
