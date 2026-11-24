import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRepoRoot, repoRoot, tempDirs } from "../helpers/adr-guard-fixtures.js";
import type { SourceFileText } from "../helpers/adr-guard-types.js";
import {
  checkItemSectionCitations,
  checkRepositoryItemSectionCitations,
} from "../helpers/adr-item-sections.js";

/**
 * ADR guard, invariant (vii) — a `§N item M` citation of an ADR-0300 item must
 * name the section that holds that item (finding F2 of the review of
 * `t_8ed66b5c`). The guard's invariants are tabulated once, in `ADR-0302`
 * (`## Decision`, the invariant table); this file owns one of them.
 *
 * **Why this exists.** The guard reads citations of *records* — invariant (iv)
 * resolves an in-source `ADR-NNNN` to a file, invariant (v) checks a declaring
 * record names its citing file — but no invariant reads a citation of an
 * ADR-0300 *item*, so a `§N item M` that names the wrong section is invisible.
 * The defect class is real and repeated: the review of `t_8ed66b5c` fixed
 * `docs/CONVENTIONS.md` §9.1 G7's `§9 item 23` (item 23 is in §12), and its
 * census of the same head found `docs/adr/ADR-0302-adr-number-guard-contract.md`
 * still citing `ADR-0300 §12 item 12` (item 12 is in §9). A reader who follows
 * the wrong section lands in a section that does not state the rule being cited.
 *
 * **Contract pinned here** (RED and GREEN must not diverge):
 *
 * ```
 * interface ItemSectionIssue {
 *   code: "item-section-mismatch";
 *   file: string;          // repo-relative POSIX path of the citing markdown
 *   line: number;          // 1-based line of the citation
 *   citedSection: string;  // the section the citation names, e.g. "§12"
 *   item: string;          // the item number as written, e.g. "12"
 *   actualSection: string; // the section that holds the item, e.g. "§9"
 * }
 * checkItemSectionCitations(
 *   files: SourceFileText[],
 *   itemSections: Map<string, string>,
 * ): ItemSectionIssue[]
 * checkRepositoryItemSectionCitations(root: string): ItemSectionIssue[]
 * ```
 *
 * **The rule.** A citation is the literal `§`, an **integer** section number,
 * whitespace, the lowercase word `item`, whitespace, then the item number as
 * digits. The section must be an integer: a contract-section cite such as
 * `§10.2 item 12` or `§0.15 item 8` is not an ADR-0300 item cite, because the
 * character after the section digits is `.` and not whitespace. A citation is
 * checked only when its item number is a key of `itemSections`; the map is the
 * **only** thing that decides which items exist, so a citation of an item
 * ADR-0300 does not define (a contract-document item such as `§1 item 4`) is
 * ignored, never guessed. A citation that carries no section at all
 * (`ADR-0300 item 12`) names nothing to compare and is out of scope. The map's
 * value is the section that holds the item, in `§N` form, so the comparison is
 * exact string equality and `§09`/`§9` are not silently interchangeable.
 *
 * **`checkRepositoryItemSectionCitations`** builds that map from the tree's own
 * `docs/adr/ADR-0300-*.md` and sweeps every `docs/**\/*.md` file — the two
 * documents the guard already reads (`docs/CONVENTIONS.md` and the records) and
 * the design and contract documents citations also point into. Only items
 * written under a `## §N` heading are section items: ADR-0300's own
 * `## Decision` list items 1–7 sit in no section, so `§7 item 4` is not an
 * ADR-0300 item cite and must never be reported. Files outside `docs/` are not
 * swept. A root with no `docs/adr` throws (ENOENT): a wrong root must fail
 * loudly instead of sweeping nothing and reporting a vacuous pass.
 *
 * **Ordering.** The report is one entry per mismatched citation occurrence — not
 * per item and not per file — sorted by `file`, then `line`, then `item` as
 * written, so the same tree produces the same report whatever order the files
 * were collected in.
 *
 * **Assumptions resolved in this spec** (flagged in the handoff):
 *   - The plural and range forms (`§11 items 18–21`) are out of scope: the
 *     invariant is written `§N item M`, and a plural citation names several
 *     items in one token that this rule cannot attribute to one section.
 *     (No plural citation on this head is inconsistent with ADR-0300.)
 *   - `itemSections` is keyed by the item number **as written**; the two-digit
 *     keys are compared as strings, so the report quotes what the record says.
 *   - A citation inside a fenced code block or an inline code span is read like
 *     any other: the rule is textual, exactly as invariant (iv)'s is.
 */

/** The item-to-section pairs the synthetic cases cite, all true on this head. */
function adr0300Items(): Map<string, string> {
  return new Map([
    ["8", "§8"],
    ["12", "§9"],
    ["23", "§12"],
    ["28", "§11"],
  ]);
}

describe("checkItemSectionCitations — a citation of the section that holds the item", () => {
  it.each(["§8 item 8", "§9 item 12", "§11 item 28", "§12 item 23"])("accepts %s", (citation) => {
    // Arrange
    const files: SourceFileText[] = [{ path: "docs/adr/ADR-0302-a.md", text: citation }];

    // Act
    const issues = checkItemSectionCitations(files, adr0300Items());

    // Assert
    expect(issues).toEqual([]);
  });

  it("accepts a correct citation that sits beside a mismatched one", () => {
    // Arrange — the shape of ADR-0302:475 in miniature: one right, one wrong.
    const files: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0302-adr-number-guard-contract.md",
        text: "Correct: §9 item 12. Wrong: §12 item 12.",
      },
    ];

    // Act
    const issues = checkItemSectionCitations(files, adr0300Items());

    // Assert — the right citation contributes nothing, and the wrong one is not
    // excused by its neighbour.
    expect(issues).toEqual([
      {
        code: "item-section-mismatch",
        file: "docs/adr/ADR-0302-adr-number-guard-contract.md",
        line: 1,
        citedSection: "§12",
        item: "12",
        actualSection: "§9",
      },
    ]);
  });
});

describe("checkItemSectionCitations — a citation of a section that does not hold the item", () => {
  it("reports the file, the 1-based line, both sections and the item as written", () => {
    // Arrange — line 3 carries the citation, the shape ADR-0302:475 has today.
    const files: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0302-adr-number-guard-contract.md",
        text: [
          "# Guard contract",
          "",
          "**Pre-merge command — supersedes ADR-0300 §12 item 12.**",
        ].join("\n"),
      },
    ];

    // Act
    const issues = checkItemSectionCitations(files, adr0300Items());

    // Assert
    expect(issues).toEqual([
      {
        code: "item-section-mismatch",
        file: "docs/adr/ADR-0302-adr-number-guard-contract.md",
        line: 3,
        citedSection: "§12",
        item: "12",
        actualSection: "§9",
      },
    ]);
  });

  it("reports one issue per occurrence when the same mismatch repeats on two lines", () => {
    // Arrange
    const files: SourceFileText[] = [
      {
        path: "docs/CONVENTIONS.md",
        text: [
          "# Conventions",
          "because §9 item 23's rule is the one that binds", // the pre-fix shape
          "",
          "see also §9 item 23",
        ].join("\n"),
      },
    ];

    // Act
    const issues = checkItemSectionCitations(files, adr0300Items());

    // Assert — two occurrences, not one per item.
    expect(issues).toEqual([
      {
        code: "item-section-mismatch",
        file: "docs/CONVENTIONS.md",
        line: 2,
        citedSection: "§9",
        item: "23",
        actualSection: "§12",
      },
      {
        code: "item-section-mismatch",
        file: "docs/CONVENTIONS.md",
        line: 4,
        citedSection: "§9",
        item: "23",
        actualSection: "§12",
      },
    ]);
  });

  it("reports both issues when one line carries two mismatched citations, ordered by item", () => {
    // Arrange — a single line, so only the item can order the two entries.
    const files: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0302-adr-number-guard-contract.md",
        text: "The pair §12 item 12 and §9 item 23 is inverted.",
      },
    ];

    // Act
    const issues = checkItemSectionCitations(files, adr0300Items());

    // Assert
    expect(issues).toEqual([
      {
        code: "item-section-mismatch",
        file: "docs/adr/ADR-0302-adr-number-guard-contract.md",
        line: 1,
        citedSection: "§12",
        item: "12",
        actualSection: "§9",
      },
      {
        code: "item-section-mismatch",
        file: "docs/adr/ADR-0302-adr-number-guard-contract.md",
        line: 1,
        citedSection: "§9",
        item: "23",
        actualSection: "§12",
      },
    ]);
  });

  it("sorts the report by file and then by line, whatever order the files arrive in", () => {
    // Arrange — the second file is handed in first; a report must not leak the
    // collection order into CI logs.
    const files: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0892-b.md",
        text: ["# b", "", "supersedes §12 item 12"].join("\n"),
      },
      {
        path: "docs/adr/ADR-0892-a.md",
        text: ["# a", "supersedes §12 item 12"].join("\n"),
      },
    ];

    // Act
    const issues = checkItemSectionCitations(files, adr0300Items());

    // Assert — a.md's issue first even though b.md arrived first.
    expect(issues).toEqual([
      {
        code: "item-section-mismatch",
        file: "docs/adr/ADR-0892-a.md",
        line: 2,
        citedSection: "§12",
        item: "12",
        actualSection: "§9",
      },
      {
        code: "item-section-mismatch",
        file: "docs/adr/ADR-0892-b.md",
        line: 3,
        citedSection: "§12",
        item: "12",
        actualSection: "§9",
      },
    ]);
  });
});

describe("checkItemSectionCitations — what counts as an ADR-0300 item citation", () => {
  it.each([
    ["a decimal contract section", "the contract §10.2 item 12 fixes the shape"],
    ["a zero-prefixed contract section", "the contract §0.15 item 8 fixes the shape"],
  ])("ignores %s", (_shape, text) => {
    // Arrange — the character after the section digits is `.`, not whitespace.
    const files: SourceFileText[] = [{ path: "docs/adr/ADR-0302-a.md", text }];

    // Act
    const issues = checkItemSectionCitations(files, adr0300Items());

    // Assert
    expect(issues).toEqual([]);
  });

  it.each([
    ["an item ADR-0300 does not define", "supersedes §12 item 99"],
    ["a contract-document item", "the contract §1 item 4 declares the envelope"],
  ])("ignores %s", (_shape, text) => {
    // Arrange — the map is the only oracle for which items exist.
    const files: SourceFileText[] = [{ path: "docs/adr/ADR-0302-a.md", text }];

    // Act
    const issues = checkItemSectionCitations(files, adr0300Items());

    // Assert
    expect(issues).toEqual([]);
  });

  it("ignores a citation that carries no section", () => {
    // Arrange — ADR-0302:476 has exactly this shape, one line below the defect.
    const files: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0302-adr-number-guard-contract.md",
        text: "ADR-0300 item 12 pins the single-spec run.",
      },
    ];

    // Act
    const issues = checkItemSectionCitations(files, adr0300Items());

    // Assert
    expect(issues).toEqual([]);
  });
});

describe("checkRepositoryItemSectionCitations — the map and the sweep", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds the item map from the tree's own ADR-0300 record and reports the mismatch", () => {
    // Arrange — a throwaway tree: §9 holds item 12, §12 does not, and one
    // record cites each.
    const root = makeTempRepoRoot({
      "docs/adr/ADR-0300-adr-number-range-allocation-policy.md": [
        "## §9 — In-flight-aware allocation",
        "",
        "11. **In-flight-aware allocation (rule B).**",
        "12. **Pre-merge duplicate detection on the merged tree.**",
        "",
        "## §12 — The reservation is written on the card",
        "",
        "22. **The reservation.**",
        "23. **The allocation sweep.**",
      ].join("\n"),
      "docs/adr/ADR-0302-adr-number-guard-contract.md": [
        "# Guard contract",
        "",
        "Correct: supersedes ADR-0300 §9 item 12.",
        "Defect: supersedes ADR-0300 §12 item 12.",
      ].join("\n"),
    });

    // Act
    const issues = checkRepositoryItemSectionCitations(root);

    // Assert — only the second citation is reported, so the sweep is not
    // reporting every citation it sees.
    expect(issues).toEqual([
      {
        code: "item-section-mismatch",
        file: "docs/adr/ADR-0302-adr-number-guard-contract.md",
        line: 4,
        citedSection: "§12",
        item: "12",
        actualSection: "§9",
      },
    ]);
  });

  it("does not treat an item under no section heading as a section item", () => {
    // Arrange — ADR-0300's `## Decision` list items 1–7 sit before the first
    // `## §N` heading. A citation of item 4 names a contract item, not §7's.
    const root = makeTempRepoRoot({
      "docs/adr/ADR-0300-adr-number-range-allocation-policy.md": [
        "# Number allocation policy",
        "",
        "## Decision",
        "",
        "1. **The orchestrator is the allocator.**",
        "4. **Numbers allocated before this policy are frozen history.**",
        "",
        "## §9 — In-flight-aware allocation",
        "",
        "12. **Pre-merge duplicate detection on the merged tree.**",
      ].join("\n"),
      "docs/adr/ADR-0302-adr-number-guard-contract.md":
        "The lead reads contract §7 item 4, not an ADR-0300 section item.\n",
    });

    // Act
    const issues = checkRepositoryItemSectionCitations(root);

    // Assert
    expect(issues).toEqual([]);
  });

  it("sweeps docs only, never a markdown file outside docs", () => {
    // Arrange — the same defect shape, one file inside and one outside docs/.
    const root = makeTempRepoRoot({
      "docs/adr/ADR-0300-adr-number-range-allocation-policy.md": [
        "## §9 — In-flight-aware allocation",
        "",
        "12. **Pre-merge duplicate detection on the merged tree.**",
      ].join("\n"),
      "docs/adr/ADR-0302-adr-number-guard-contract.md": "§9 item 12 is correct.\n",
      "README.md": "supersedes ADR-0300 §12 item 12\n",
      "apps/web/src/notes.md": "supersedes ADR-0300 §12 item 12\n",
    });

    // Act
    const issues = checkRepositoryItemSectionCitations(root);

    // Assert
    expect(issues).toEqual([]);
  });

  it("throws an ENOENT error when the root carries no ADR-0300 record", () => {
    // Arrange — a wrong root must fail loudly, never pass vacuously.
    const root = makeTempRepoRoot({ "docs/notes.md": "supersedes ADR-0300 §12 item 12" });

    // Act + Assert
    expect(() => checkRepositoryItemSectionCitations(root)).toThrow(
      expect.objectContaining({ code: "ENOENT" })
    );
  });

  it("reports the repository's markdown tree as section-accurate", () => {
    // Act — at the pin's head this fails with exactly one issue, at
    // `docs/adr/ADR-0302-adr-number-guard-contract.md:475` (§12 item 12; item 12
    // is in §9). Repairing that citation is the GREEN card's work, and the
    // assertion is the empty report so a future record that adds a correct
    // citation can never redden this pin.
    const issues = checkRepositoryItemSectionCitations(repoRoot);

    // Assert
    expect(issues).toEqual([]);
  });
});
