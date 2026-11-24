/**
 * ADR guard, invariant (viii) — a stated count of the merge-gate conditions must
 * equal the `G1…Gk` enumeration it introduces (finding F2 of the review of
 * `t_76d10c5d`). The guard's invariants are tabulated once, in `ADR-0302`
 * (`## Decision`, the invariant table); this file owns one of them.
 *
 * **Why this exists.** The ADR-0318 ledger note in `docs/adr/README.md` read
 * "seven conditions on the exact head SHA" while enumerating only **G1–G6**, and
 * stayed that way for a day with a fully green suite: no invariant read a count
 * phrase at all (`grep -rn "conditions" apps/web/src/test/unit/adr-*.test.ts`
 * found no assertion). PR [#902](https://github.com/yahodu/openpic-webapp/pull/902)
 * (squash `d7ca197f`) repaired the text; nothing stopped the next drift. A lander
 * who counts six gates where the text promises seven skips the seventh and merges
 * with the gate unrun.
 *
 * **Contract pinned here** (RED and GREEN must not diverge):
 *
 * ```
 * interface GateConditionIssue {
 *   code: "count-disagreement" | "count-mismatch" | "sequence-gap";
 *   file: string;           // repo-relative POSIX path of the markdown
 *   line: number;           // 1-based line of the count phrase
 *   stated: string;         // the phrase as written, e.g. "seven conditions"
 *   declared: number;       // the count the phrase states
 *   highest: number;        // highest G number in the phrase's window
 *   missing: number[];      // gate numbers absent from 1..highest
 *   expected: number | null; // count-disagreement: the first phrase's count
 * }
 * interface GateConditionCheck { file, line, stated, declared, highest }
 * interface GateConditionResult { ok: boolean; issues: GateConditionIssue[]; checked: GateConditionCheck[] }
 * checkGateConditionCounts(files: SourceFileText[]): GateConditionResult
 * checkRepositoryGateConditionCounts(root: string): GateConditionResult
 * GATE_CONDITION_SOURCES: readonly string[]
 * ```
 *
 * **The rule.** A count phrase is a number word (`one`…`twelve`) **or a digit
 * run**, whitespace, the word `conditions`. Only that phrase counts: §9.1 says
 * "the eleven gating names" inside G3 and a matcher on a bare number word would
 * read eleven conditions where the text states seven. The enumeration is the
 * `G1…Gk` tokens in the phrase's **window** — its paragraph, extended through the
 * block that follows when the paragraph's last line ends with `:`, which is the
 * §9.1 shape (the count ends the sentence, the bullets below it enumerate). A
 * phrase whose window carries no `G` token introduces no enumeration: it is
 * skipped, never guessed, and appears in neither `issues` nor `checked`.
 *
 * **Defects, one issue each.** `count-mismatch` — the highest `G` token is not
 * the stated count. `sequence-gap` — a gate number in `1..highest` is missing
 * from the enumeration; the two can fire together because an enumeration can both
 * stop early and skip a number. `count-disagreement` — this phrase's count
 * differs from the run's first phrase in report order, because there is one merge
 * gate and two different counts for it cannot both be right (the F2 class: one
 * sentence said seven, another said six). The issue names one side and quotes
 * both counts in `declared` and `expected`, so the reviewer decides which side
 * drifted.
 *
 * **Ordering.** `issues` and `checked` sort by `file`, then `line`, then (for
 * issues) `code`, then the phrase as written, so the same text produces the same
 * report whatever order the files were collected in.
 *
 * **Green on arrival, load-bearing by probe.** The trunk states the count
 * correctly, so this spec passes at its head and no GREEN sibling exists. What
 * proves it is not vacuous is a throwaway probe: the ADR-0318 note reverted to
 * "seven conditions" over **G1–G6** on a scratch copy of the two documents is
 * reported as a `count-mismatch`, and the restored bytes read green again. The
 * real-tree case also pins that **both** documents are read, so a narrowed sweep
 * (one file, or a matcher that stops matching) fails even while `issues` is
 * empty.
 *
 * **Assumptions resolved in this spec** (flagged in the handoff):
 *   - "In that sentence" is read as the phrase's **window**: paragraph plus the
 *     colon-introduced block below it. §9.1 puts the count in a sentence and the
 *     `G` tokens in the bullets under it, so a literal sentence window would read
 *     nothing there and the guard would be vacuous on the very list it names.
 *   - A count phrase with no `G` token is out of scope, not a defect: the ledger
 *     intro (`README.md:122`) and the ADR-0318 index row both state "seven
 *     conditions" in prose that introduces no enumeration.
 *   - A markdown table row is its own window. The index row at `README.md:338`
 *     states the count inside the 480-row ledger table, and a paragraph-shaped
 *     window there would read another record's `G3` as this row's enumeration.
 *   - Two different counts anywhere in the run are a disagreement, including
 *     across the two documents: the ledger note and §9.1 describe one gate. The
 *     first phrase in report order is the reference, and the issue quotes both
 *     counts, because the guard cannot tell which statement is the drift.
 *   - The rule has **one subject**, the merge gate. A second gate family's own,
 *     internally consistent count is therefore a `count-disagreement` against the
 *     run's first phrase (pinned below), so a second `<n> conditions` family in
 *     either document needs its own phrase shape — recorded in `ADR-0302` §11.
 *   - `G0` is not a gate token (gate numbers start at 1), and a phrase inside a
 *     code fence or an inline code span is read like any other: the rule is
 *     textual, exactly as invariant (iv)'s is.
 */

import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRepoRoot, repoRoot, tempDirs } from "../helpers/adr-guard-fixtures.js";
import {
  checkGateConditionCounts,
  checkRepositoryGateConditionCounts,
  GATE_CONDITION_SOURCES,
} from "../helpers/adr-gate-conditions.js";
import type { SourceFileText } from "../helpers/adr-guard-types.js";

/**
 * The ledger-note shape: one count phrase and its enumeration in one paragraph
 * on one line, exactly as `docs/adr/README.md`'s ADR-0318 note is written.
 */
function ledgerNoteText(declared: string, gates: readonly number[]): string {
  const enumeration = gates.map((gate) => `G${String(gate)} condition ${String(gate)}`).join(", ");
  return `_The note takes the number: ${declared} conditions on the exact head SHA — ${enumeration}._`;
}

/**
 * The §9.1 shape: a paragraph that ends with a colon, and the gate list below it
 * in bullets. Returns the text and the 1-based line of its count phrase.
 */
function gateSectionText(
  declared: string,
  gates: readonly number[]
): { readonly text: string; readonly countLine: number } {
  return {
    text: [
      "### 9.1 The merge gate (ADR-0318)",
      "",
      "The ruleset requires no status check. Before `gh pr merge`, evaluate these",
      `${declared} conditions against the PR's **current head SHA** and paste the`,
      "output into the PR:",
      "",
      ...gates.map((gate) => `- **G${String(gate)}** condition ${String(gate)} holds.`),
      "",
      "The decision and its rejected alternatives are recorded in the gate record.",
    ].join("\n"),
    countLine: 4,
  };
}

describe("checkGateConditionCounts — a count that matches its enumeration", () => {
  it("accepts a word count enumerated on its own line", () => {
    // Arrange
    const files: SourceFileText[] = [
      { path: "docs/adr/README.md", text: ledgerNoteText("seven", [1, 2, 3, 4, 5, 6, 7]) },
    ];

    // Act
    const report = checkGateConditionCounts(files);

    // Assert
    expect(report).toEqual({
      ok: true,
      issues: [],
      checked: [
        {
          file: "docs/adr/README.md",
          line: 1,
          stated: "seven conditions",
          declared: 7,
          highest: 7,
        },
      ],
    });
  });

  it("accepts a digit count that matches its enumeration", () => {
    // Arrange — the digit form of the same statement.
    const files: SourceFileText[] = [
      { path: "docs/adr/README.md", text: ledgerNoteText("7", [1, 2, 3, 4, 5, 6, 7]) },
    ];

    // Act
    const report = checkGateConditionCounts(files);

    // Assert
    expect(report).toEqual({
      ok: true,
      issues: [],
      checked: [
        { file: "docs/adr/README.md", line: 1, stated: "7 conditions", declared: 7, highest: 7 },
      ],
    });
  });

  it("accepts an enumeration introduced by a colon on the lines below", () => {
    // Arrange — the §9.1 shape: the count ends a sentence ending in `:`, and the
    // gates are the bullets under it.
    const section = gateSectionText("seven", [1, 2, 3, 4, 5, 6, 7]);

    // Act
    const report = checkGateConditionCounts([{ path: "docs/CONVENTIONS.md", text: section.text }]);

    // Assert — checked proves the block below the colon was read; a
    // paragraph-only window finds no `G` token and reports nothing at all.
    expect(report).toEqual({
      ok: true,
      issues: [],
      checked: [
        {
          file: "docs/CONVENTIONS.md",
          line: section.countLine,
          stated: "seven conditions",
          declared: 7,
          highest: 7,
        },
      ],
    });
  });

  it("ignores a count phrase that introduces no enumeration", () => {
    // Arrange — `docs/adr/README.md:122` reads exactly this: prose that states the
    // count without enumerating the gates.
    const files: SourceFileText[] = [
      {
        path: "docs/adr/README.md",
        text: [
          "`0318` (ADR-0318, the merge gate is enforced by the merging agent — the seven",
          "conditions the merger runs on the exact head SHA; card `t_b38fd67e`).",
        ].join("\n"),
      },
    ];

    // Act
    const report = checkGateConditionCounts(files);

    // Assert — out of scope, and visibly so: nothing was evaluated.
    expect(report).toEqual({ ok: true, issues: [], checked: [] });
  });

  it("does not read `the eleven gating names` as eleven conditions", () => {
    // Arrange — §9.1's G3 legitimate prose (docs/CONVENTIONS.md:186), inside the
    // window of the seven-condition phrase. A matcher on a bare number word
    // declares eleven here and reports a false count-mismatch.
    const files: SourceFileText[] = [
      {
        path: "docs/CONVENTIONS.md",
        text: [
          "Before `gh pr merge`, evaluate these seven conditions against the PR's head and",
          "paste the output into the PR:",
          "",
          "- **G1** `mergeable` is `MERGEABLE`.",
          "- **G2** every check is `COMPLETED`/`SUCCESS`.",
          "- **G3** the eleven gating names are present on the head.",
          "- **G4** audit freshness.",
          "- **G5** the audited tree is clean.",
          "- **G6** a failure stops the merge.",
          "- **G7** the added number is free at every other open head.",
        ].join("\n"),
      },
    ];

    // Act
    const report = checkGateConditionCounts(files);

    // Assert
    expect(report).toEqual({
      ok: true,
      issues: [],
      checked: [
        {
          file: "docs/CONVENTIONS.md",
          line: 1,
          stated: "seven conditions",
          declared: 7,
          highest: 7,
        },
      ],
    });
  });

  it("ignores a bare number word that is not followed by `conditions`", () => {
    // Arrange
    const files: SourceFileText[] = [
      {
        path: "docs/CONVENTIONS.md",
        text: "G3 names the eleven gating names, and seven of them are required.",
      },
    ];

    // Act
    const report = checkGateConditionCounts(files);

    // Assert
    expect(report).toEqual({ ok: true, issues: [], checked: [] });
  });
});

describe("checkGateConditionCounts — a count that does not match its enumeration", () => {
  it("reports a count-mismatch when seven conditions enumerate only G1–G6", () => {
    // Arrange — the F2 regression shape: the note the review of `t_76d10c5d` found
    // for a day, with a fully green suite.
    const files: SourceFileText[] = [
      { path: "docs/adr/README.md", text: ledgerNoteText("seven", [1, 2, 3, 4, 5, 6]) },
    ];

    // Act
    const report = checkGateConditionCounts(files);

    // Assert
    expect(report).toEqual({
      ok: false,
      issues: [
        {
          code: "count-mismatch",
          file: "docs/adr/README.md",
          line: 1,
          stated: "seven conditions",
          declared: 7,
          highest: 6,
          missing: [],
          expected: null,
        },
      ],
      checked: [
        {
          file: "docs/adr/README.md",
          line: 1,
          stated: "seven conditions",
          declared: 7,
          highest: 6,
        },
      ],
    });
  });

  it("reports a count-mismatch when a digit count is lower than the enumeration", () => {
    // Arrange — six stated, seven enumerated: the same defect in the digit form.
    const files: SourceFileText[] = [
      { path: "docs/adr/README.md", text: ledgerNoteText("6", [1, 2, 3, 4, 5, 6, 7]) },
    ];

    // Act
    const report = checkGateConditionCounts(files);

    // Assert
    expect(report.issues).toEqual([
      {
        code: "count-mismatch",
        file: "docs/adr/README.md",
        line: 1,
        stated: "6 conditions",
        declared: 6,
        highest: 7,
        missing: [],
        expected: null,
      },
    ]);
  });

  it("reports a sequence-gap naming the missing gate when G4 is skipped", () => {
    // Arrange — the count is right (seven, highest G7) but one gate in the middle
    // is absent, so a lander counting the bullets sees six.
    const files: SourceFileText[] = [
      { path: "docs/adr/README.md", text: ledgerNoteText("seven", [1, 2, 3, 5, 6, 7]) },
    ];

    // Act
    const report = checkGateConditionCounts(files);

    // Assert — the gap is named, and the correct count is not reported twice.
    expect(report.issues).toEqual([
      {
        code: "sequence-gap",
        file: "docs/adr/README.md",
        line: 1,
        stated: "seven conditions",
        declared: 7,
        highest: 7,
        missing: [4],
        expected: null,
      },
    ]);
  });

  it("reports both defects when the enumeration stops early and skips a number", () => {
    // Arrange — seven stated, G1–G3 then G5–G6: highest 6, and 4 missing.
    const files: SourceFileText[] = [
      { path: "docs/adr/README.md", text: ledgerNoteText("seven", [1, 2, 3, 5, 6]) },
    ];

    // Act
    const report = checkGateConditionCounts(files);

    // Assert — ordered by code within the line: count-mismatch, then sequence-gap.
    expect(report.issues).toEqual([
      {
        code: "count-mismatch",
        file: "docs/adr/README.md",
        line: 1,
        stated: "seven conditions",
        declared: 7,
        highest: 6,
        missing: [4],
        expected: null,
      },
      {
        code: "sequence-gap",
        file: "docs/adr/README.md",
        line: 1,
        stated: "seven conditions",
        declared: 7,
        highest: 6,
        missing: [4],
        expected: null,
      },
    ]);
  });

  it("reads the §9.1 bullets and reports a count-mismatch there", () => {
    // Arrange — the list shape with the enumeration cut at G6.
    const section = gateSectionText("seven", [1, 2, 3, 4, 5, 6]);

    // Act
    const report = checkGateConditionCounts([{ path: "docs/CONVENTIONS.md", text: section.text }]);

    // Assert
    expect(report.issues).toEqual([
      {
        code: "count-mismatch",
        file: "docs/CONVENTIONS.md",
        line: section.countLine,
        stated: "seven conditions",
        declared: 7,
        highest: 6,
        missing: [],
        expected: null,
      },
    ]);
  });
});

describe("checkGateConditionCounts — two statements of the one gate", () => {
  it("reports a count-disagreement when one file states six where it first states seven", () => {
    // Arrange — the F2 class within one document: the first sentence promises
    // seven and enumerates seven, the second promises six and enumerates six.
    const files: SourceFileText[] = [
      {
        path: "docs/adr/README.md",
        text: [
          ledgerNoteText("seven", [1, 2, 3, 4, 5, 6, 7]),
          "",
          ledgerNoteText("six", [1, 2, 3, 4, 5, 6]),
        ].join("\n"),
      },
    ];

    // Act
    const report = checkGateConditionCounts(files);

    // Assert — the first statement is canonical, so only the second is reported.
    expect(report.issues).toEqual([
      {
        code: "count-disagreement",
        file: "docs/adr/README.md",
        line: 3,
        stated: "six conditions",
        declared: 6,
        highest: 6,
        missing: [],
        expected: 7,
      },
    ]);
  });

  it("reports a count-disagreement across the ledger note and the §9.1 gate list", () => {
    // Arrange — the two documents must agree; each is internally consistent here.
    const section = gateSectionText("six", [1, 2, 3, 4, 5, 6]);
    const files: SourceFileText[] = [
      { path: "docs/adr/README.md", text: ledgerNoteText("seven", [1, 2, 3, 4, 5, 6, 7]) },
      { path: "docs/CONVENTIONS.md", text: section.text },
    ];

    // Act
    const report = checkGateConditionCounts(files);

    // Assert — CONVENTIONS sorts first, so it is the reference and the ledger
    // note is reported against it; the issue quotes both counts (7 in `declared`,
    // 6 in `expected`) so either side can be the drift a reviewer must chase.
    expect(report.issues).toEqual([
      {
        code: "count-disagreement",
        file: "docs/adr/README.md",
        line: 1,
        stated: "seven conditions",
        declared: 7,
        highest: 7,
        missing: [],
        expected: 6,
      },
    ]);
    expect(report.checked).toEqual([
      {
        file: "docs/CONVENTIONS.md",
        line: section.countLine,
        stated: "six conditions",
        declared: 6,
        highest: 6,
      },
      { file: "docs/adr/README.md", line: 1, stated: "seven conditions", declared: 7, highest: 7 },
    ]);
  });

  it("reports a second gate family's own count against the run's first phrase", () => {
    // Arrange — a future §9.2 gate stated beside the merge gate's own count, each
    // internally consistent: seven conditions over G1–G7, then two over G1–G2.
    // The rule has one subject (the merge gate), so the second family is not
    // recognised as a family at all — its count is compared with the first
    // phrase's and reported. Characterization pin: this is the behaviour a second
    // gate would have to design around (ADR-0302 §11).
    const files: SourceFileText[] = [
      {
        path: "docs/adr/README.md",
        text: [
          ledgerNoteText("seven", [1, 2, 3, 4, 5, 6, 7]),
          "",
          "The audit gate runs two conditions: G1 fresh, G2 complete.",
        ].join("\n"),
      },
    ];

    // Act
    const report = checkGateConditionCounts(files);

    // Assert — the second family's correct count is the reported defect, and the
    // run's first phrase is the reference, exactly as for a genuine drift.
    expect(report.issues).toEqual([
      {
        code: "count-disagreement",
        file: "docs/adr/README.md",
        line: 3,
        stated: "two conditions",
        declared: 2,
        highest: 2,
        missing: [],
        expected: 7,
      },
    ]);
    expect(report.checked).toEqual([
      { file: "docs/adr/README.md", line: 1, stated: "seven conditions", declared: 7, highest: 7 },
      { file: "docs/adr/README.md", line: 3, stated: "two conditions", declared: 2, highest: 2 },
    ]);
  });

  it("reads a markdown table row as its own window, never the table below it", () => {
    // Arrange — `docs/adr/README.md:338` states the count inside the 480-row
    // ledger table, and the next rows of that table carry other records' gate
    // tokens. A paragraph-shaped window reads `G3` as this row's enumeration.
    const files: SourceFileText[] = [
      {
        path: "docs/adr/README.md",
        text: [
          "| [0318](ADR-0318-a.md) | The merge gate: seven conditions on the exact head SHA | Accepted |",
          "| [0319](ADR-0319-b.md) | G3 of another record's gate note is quoted here | Accepted |",
        ].join("\n"),
      },
    ];

    // Act
    const report = checkGateConditionCounts(files);

    // Assert
    expect(report).toEqual({ ok: true, issues: [], checked: [] });
  });

  it("sorts the report by file and then by line, whatever order the files arrive in", () => {
    // Arrange — the ledger is handed in first, so only an explicit sort puts the
    // conventions defect first.
    const section = gateSectionText("seven", [1, 2, 3, 4, 5, 6]);
    const files: SourceFileText[] = [
      {
        path: "docs/adr/README.md",
        text: ["# ledger", "", ledgerNoteText("seven", [1, 2, 3, 4, 5, 6])].join("\n"),
      },
      { path: "docs/CONVENTIONS.md", text: section.text },
    ];

    // Act
    const report = checkGateConditionCounts(files);

    // Assert
    expect(report.issues.map((issue) => [issue.file, issue.line])).toEqual([
      ["docs/CONVENTIONS.md", section.countLine],
      ["docs/adr/README.md", 3],
    ]);
    expect(report.checked.map((check) => check.file)).toEqual([
      "docs/CONVENTIONS.md",
      "docs/adr/README.md",
    ]);
  });
});

describe("checkRepositoryGateConditionCounts — the two documents and nothing else", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the ledger note and the §9.1 gate list and reports a defect in either", () => {
    // Arrange — the ledger carries the F2 regression, the conventions are green.
    const section = gateSectionText("seven", [1, 2, 3, 4, 5, 6, 7]);
    const root = makeTempRepoRoot({
      "docs/adr/README.md": ledgerNoteText("seven", [1, 2, 3, 4, 5, 6]),
      "docs/CONVENTIONS.md": section.text,
    });

    // Act
    const report = checkRepositoryGateConditionCounts(root);

    // Assert — both documents were read, and only the ledger is defective.
    expect(report.issues).toEqual([
      {
        code: "count-mismatch",
        file: "docs/adr/README.md",
        line: 1,
        stated: "seven conditions",
        declared: 7,
        highest: 6,
        missing: [],
        expected: null,
      },
    ]);
    expect(report.checked).toEqual([
      {
        file: "docs/CONVENTIONS.md",
        line: section.countLine,
        stated: "seven conditions",
        declared: 7,
        highest: 7,
      },
      { file: "docs/adr/README.md", line: 1, stated: "seven conditions", declared: 7, highest: 6 },
    ]);
  });

  it("reads no document beyond the two that state the gate", () => {
    // Arrange — a drifted record beside the two green statements.
    const section = gateSectionText("seven", [1, 2, 3, 4, 5, 6, 7]);
    const root = makeTempRepoRoot({
      "docs/adr/README.md": ledgerNoteText("seven", [1, 2, 3, 4, 5, 6, 7]),
      "docs/CONVENTIONS.md": section.text,
      "docs/adr/ADR-0999-drifted-record.md": ledgerNoteText("seven", [1, 2, 3, 4, 5, 6]), // adr-fixture: a synthetic record on a temp tree, never in docs/adr
    });

    // Act
    const report = checkRepositoryGateConditionCounts(root);

    // Assert — no directory walk: the drifted record is not read at all.
    expect(GATE_CONDITION_SOURCES).toEqual(["docs/adr/README.md", "docs/CONVENTIONS.md"]);
    expect(report).toEqual({
      ok: true,
      issues: [],
      checked: [
        {
          file: "docs/CONVENTIONS.md",
          line: section.countLine,
          stated: "seven conditions",
          declared: 7,
          highest: 7,
        },
        {
          file: "docs/adr/README.md",
          line: 1,
          stated: "seven conditions",
          declared: 7,
          highest: 7,
        },
      ],
    });
  });

  it.each(["docs/adr/README.md", "docs/CONVENTIONS.md"])(
    "throws an ENOENT error when the tree carries no %s",
    (missingPath) => {
      // Arrange — a wrong root must fail loudly, never pass vacuously on the one
      // document it did find.
      const section = gateSectionText("seven", [1, 2, 3, 4, 5, 6, 7]);
      const present: Record<string, string> = {
        "docs/adr/README.md": ledgerNoteText("seven", [1, 2, 3, 4, 5, 6, 7]),
        "docs/CONVENTIONS.md": section.text,
      };
      const root = makeTempRepoRoot(
        Object.fromEntries(Object.entries(present).filter(([path]) => path !== missingPath))
      );

      // Act + Assert
      expect(() => checkRepositoryGateConditionCounts(root)).toThrow(
        expect.objectContaining({ code: "ENOENT" })
      );
    }
  );

  it("reports the trunk's two gate statements as consistent", () => {
    // Act — green on arrival, and the `checked` pair is what makes the silence
    // mean something: a sweep that read one document, or a matcher that stopped
    // matching either count phrase, loses the entry and fails here.
    const report = checkRepositoryGateConditionCounts(repoRoot);

    // Assert
    expect(report.issues).toEqual([]);
    expect(report.checked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "docs/adr/README.md",
          stated: "seven conditions",
          declared: 7,
          highest: 7,
        }),
        expect.objectContaining({
          file: "docs/CONVENTIONS.md",
          stated: "seven conditions",
          declared: 7,
          highest: 7,
        }),
      ])
    );
  });
});
