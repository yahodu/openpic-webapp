/**
 * ADR guard, invariant (vii) — a `§N item M` citation of an ADR-0300 item must
 * name the section that holds that item (finding F2 of the review of
 * `t_8ed66b5c`). The guard's seven invariants are tabulated once, in `0302`
 * (`## Decision`, the seven-row invariant table), and that row is this
 * invariant's whole decision record: the rule below states it.
 *
 * The guard's other invariants read citations of *records* — (iv) resolves an
 * in-source `ADR-NNNN` to a file, (v) checks that a declaring record names its
 * citing file — but nothing read a citation of an ADR-0300 *item*, so a
 * `§N item M` naming the wrong section was invisible: the review of
 * `t_8ed66b5c` repaired `docs/CONVENTIONS.md` §9.1 G7's `§9 item 23` (item 23
 * is in §12), and its census of the same head found the same-record pair still
 * citing the pre-merge command as a §12 item although item 12 is in §9. A
 * reader who follows the wrong section lands in a section that does not state
 * the rule being cited.
 *
 * The rule is textual, exactly as (iv)'s is: `§`, an **integer** section
 * number, whitespace, the lowercase word `item`, whitespace, then the item
 * number as digits. An integer section keeps a contract-section cite such as
 * `§10.2 item 12` from parsing (`§10` is followed by `.`, not whitespace), and
 * the map is the only oracle for which items exist, so a citation of an item
 * ADR-0300 does not define is ignored, never guessed. See
 * {@link checkItemSectionCitations} and
 * {@link checkRepositoryItemSectionCitations}.
 */

import { join, relative, sep } from "node:path";

import type { SourceFileText } from "./adr-guard-types.js";
import { compareStrings } from "./adr-guard-types.js";
import { readDirectoryEntries, readTextFile } from "./adr-source-references.js";

/**
 * One mismatched item citation.
 *
 * The sections and the item keep their **written** form (`§12`, `12`) so the
 * failure message can be pasted into a search; `line` is 1-based so it matches
 * an editor's gutter.
 */
export interface ItemSectionIssue {
  /** Always `"item-section-mismatch"`; the discriminant for this issue family. */
  code: "item-section-mismatch";

  /** Repo-relative POSIX path of the citing markdown. */
  file: string;

  /** 1-based line number of the citation. */
  line: number;

  /** The section the citation names, e.g. `"§12"`. */
  citedSection: string;

  /** The item number as written, e.g. `"12"`. */
  item: string;

  /** The section that holds the item, e.g. `"§9"`. */
  actualSection: string;
}

/**
 * The citation: `§`, the section digits, whitespace, `item`, whitespace, the
 * item digits. `§10.2 item 12` does not match, because `§10` is followed by
 * `.`; the plural `§11 items 18–21` does not match, because `item` is followed
 * by `s`. Both are out of scope, not silently tolerated.
 */
const ITEM_CITATION_PATTERN = /§(\d+)\s+item\s+(\d+)/g;

/** A section heading of the policy record: `## §9 — …`. */
const SECTION_HEADING_PATTERN = /^## §(\d+)(?:\s|$)/;

/** A record's numbered item line: `12. **Pre-merge …**`. */
const ITEM_LINE_PATTERN = /^(\d+)\.\s+\S/;

/** Order item-section issues: file, then line, then item as written. */
function compareItemSectionIssues(
  left: { readonly file: string; readonly line: number; readonly item: string },
  right: { readonly file: string; readonly line: number; readonly item: string }
): number {
  const byFile = compareStrings(left.file, right.file);
  if (byFile !== 0) {
    return byFile;
  }
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return compareStrings(left.item, right.item);
}

/**
 * The item-to-section map of a policy record (ADR-0300): every numbered item
 * written under a `## §N` heading, keyed by its digits as written and valued in
 * `§N` form.
 *
 * An item before the first `## §N` heading — or under any `## ` heading that
 * carries no section number, such as the record's own `## Decision` list — is
 * in no section and is never mapped, so a citation of it cannot be reported.
 */
function itemSectionsOf(policyText: string): Map<string, string> {
  const itemSections = new Map<string, string>();
  let section: string | null = null;

  for (const line of policyText.split("\n")) {
    if (line.startsWith("## ")) {
      const heading = SECTION_HEADING_PATTERN.exec(line);
      section = heading === null ? null : `§${heading[1] ?? ""}`;
      continue;
    }

    const item = ITEM_LINE_PATTERN.exec(line);
    if (item !== null && section !== null) {
      itemSections.set(item[1] ?? "", section);
    }
  }

  return itemSections;
}

/**
 * Check that every `§N item M` citation in `files` names the section that
 * holds item `M`. Pure — it never touches the filesystem, so the rule is
 * testable without fixtures on disk.
 *
 * One issue per mismatched **occurrence**, not per item and not per file: two
 * lines citing the same wrong section are two issues, because each one is a
 * separate wrong pointer to fix. A citation whose item is not a key of
 * `itemSections` is ignored — the map is the only oracle for which items exist.
 *
 * @param files - The markdown files to scan, in any order.
 * @param itemSections - Item number as written, to the `§N` that holds it.
 * @returns The mismatches, sorted by file, then line, then item; `[]` when
 * every citation is section-accurate.
 * @example
 * ```ts
 * checkItemSectionCitations(
 *   [{ path: "docs/adr/ADR-0302-a.md", text: "supersedes ADR-0300 §12 item 12" }],
 *   new Map([["12", "§9"]])
 * );
 * // [{ code: "item-section-mismatch", file: "docs/adr/ADR-0302-a.md", line: 1,
 * //    citedSection: "§12", item: "12", actualSection: "§9" }]
 * ```
 */
export function checkItemSectionCitations(
  files: SourceFileText[],
  itemSections: Map<string, string>
): ItemSectionIssue[] {
  const issues: ItemSectionIssue[] = [];

  for (const file of files) {
    for (const [index, line] of file.text.split("\n").entries()) {
      for (const match of line.matchAll(ITEM_CITATION_PATTERN)) {
        const item = match[2] ?? "";
        const actualSection = itemSections.get(item);
        if (actualSection === undefined) {
          continue;
        }

        const citedSection = `§${match[1] ?? ""}`;
        if (citedSection === actualSection) {
          continue;
        }

        issues.push({
          code: "item-section-mismatch",
          file: file.path,
          line: index + 1,
          citedSection,
          item,
          actualSection,
        });
      }
    }
  }

  issues.sort(compareItemSectionIssues);

  return issues;
}

/**
 * Walk one directory tree for markdown files, appending repo-relative POSIX
 * paths to `collected`. Reads through the guard family's one directory call
 * site, so the security preset still sees a single non-literal `fs` call.
 */
function collectMarkdownFiles(root: string, dir: string, collected: string[]): void {
  for (const entry of readDirectoryEntries(dir)) {
    const entryPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      collectMarkdownFiles(root, entryPath, collected);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      collected.push(relative(root, entryPath).split(sep).join("/"));
    }
  }
}

/**
 * Apply {@link checkItemSectionCitations} to a real working tree: build the
 * item map from the tree's own `docs/adr/ADR-0300-*.md`, then sweep every
 * `docs/**\/*.md` file.
 *
 * Nothing is hardcoded, so the pin follows the tree it runs in. A file outside
 * `docs/` is not swept: the records, the ledger, `docs/CONVENTIONS.md` and the
 * design and contract documents are the places ADR citations point into.
 *
 * @param root - Absolute path to the repository root.
 * @returns The same report as {@link checkItemSectionCitations}.
 * @throws If `docs/adr` cannot be read, or carries no `ADR-0300` policy record:
 * a wrong root must fail loudly instead of sweeping nothing with an empty map
 * and reporting a vacuous pass.
 */
export function checkRepositoryItemSectionCitations(root: string): ItemSectionIssue[] {
  // The directory read comes first on purpose: a bad root throws here, before
  // any markdown is collected, so "no citations found" can never be a false pass.
  const policyRecord = readDirectoryEntries(join(root, "docs/adr")).find(
    (entry) => entry.isFile() && entry.name.startsWith("ADR-0300-") && entry.name.endsWith(".md")
  );
  if (policyRecord === undefined) {
    throw new Error(`no ADR-0300 policy record under ${join(root, "docs/adr")}`);
  }

  const paths: string[] = [];
  collectMarkdownFiles(root, join(root, "docs"), paths);
  paths.sort(compareStrings);

  const files = paths.map((path) => ({ path, text: readTextFile(join(root, path)) }));

  return checkItemSectionCitations(
    files,
    itemSectionsOf(readTextFile(join(root, "docs/adr", policyRecord.name)))
  );
}
