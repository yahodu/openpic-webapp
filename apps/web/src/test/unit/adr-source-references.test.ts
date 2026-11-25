import { rmSync } from "node:fs";
import { basename } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRepoRoot, repoRoot, tempDirs } from "../helpers/adr-guard-fixtures.js";
import { adrDigitsOf } from "../helpers/adr-guard-types.js";
import type { SourceFileText } from "../helpers/adr-guard-types.js";
import {
  checkMeasuredCommitCitations,
  checkRepositoryAdrReferences,
  checkRepositoryMeasuredCommitCitations,
  checkSourceAdrReferences,
  MEASURED_COMMIT_EXEMPTIONS,
} from "../helpers/adr-source-references.js";

/**
 * ADR guard, invariant (iv) — the guard's invariants are tabulated once, in
 * `ADR-0302` (`## Decision`, the invariant table). This file owns one of
 * them: every `ADR-NNNN` reference inside a source file must resolve to a
 * `docs/adr/ADR-NNNN-*.md` file.
 *
 * It also owns the family's **measured-count provenance clause** (`ADR-0302`
 * §12), which lives in the same module because it is a reference rule over the
 * records and because that module already owns the family's directory read and
 * file read: a record that quotes a suite count must name the head commit it was
 * measured at. The clause has no invariant row of its own on purpose — an
 * eleventh spec file would falsify the "ten `adr-*` guards" sentence this very
 * defect class froze into live prose (a merged record's §Evidence and its ledger
 * cell).
 */

/**
 * Unit contract — invariant (iv): an in-source `ADR-NNNN` reference must resolve
 * to a `docs/adr/ADR-NNNN-*.md` file (finding F6-b, OP-128 follow-up).
 *
 * **Why this exists.** The OP-128 round-1 renumber moved two lane records from
 * `0764`/`0765` to `0766`/`0767` (fix PR #461), but five shipped
 * production comments and three spec headers kept citing the old numbers. Those
 * numbers are *not free*: `0764` and `0765` belong to sibling lanes, so
 * the stale comments pointed readers at a different lane's unrelated decisions.
 * `checkAdrNumbers` could not see it — it reads file *names* in `docs/adr/` and
 * never the references pointing into it. This block pins the check that closes
 * that hole, in the same helper family (`src/test/helpers/adr-*.ts`) as the
 * shape and ledger checks.
 *
 * **Contract pinned here** (RED and GREEN must not diverge):
 *
 * ```
 * interface SourceFileText { path: string; text: string }
 * type SourceAdrReferenceIssue = {
 *   code: "dangling-reference";
 *   file: string;   // repo-relative POSIX path, e.g. "apps/web/src/server/x.ts"
 *   line: number;   // 1-based line of the reference
 *   number: string; // the four digits as written, leading zeros kept ("0764")
 * }
 * checkSourceAdrReferences(
 *   sources: readonly SourceFileText[],
 *   adrFileNames: readonly string[],
 * ): { ok: boolean; issues: SourceAdrReferenceIssue[];
 *      checkedReferences: number; exemptReferences: number }
 * checkRepositoryAdrReferences(root: string): typeof checkSourceAdrReferences
 * ```
 *
 * **The rule.** A reference is the literal token `ADR-` + FOUR digits, digits not
 * followed by another digit (so `ADR-12345` is not a reference to `1234`) and the
 * prefix case-sensitive (so `adr-0146` is not a reference — the same
 * case-sensitivity `checkAdrNumbers` uses). A reference resolves when
 * `adrFileNames` holds a **well-formed** `ADR-<NNNN>-<slug>.md` name with the
 * same digits; anything else is one `dangling-reference` issue per occurrence.
 * The rule is textual: a reference in a line comment, a block comment or a string
 * literal all count — the F6 defect lived in comments.
 *
 * **Fixture marker.** A line **inside the guard's own test tree**
 * (`apps/web/src/test/**`) whose text contains `adr-fixture` is exempt: those
 * specs are full of synthetic numbers that must never resolve (`ADR-000x`/
 * `ADR-999x` shape fixtures, `0764` lookalikes, lane numbers that only exist on
 * an unmerged branch). The exemption is per **line text** *and* per **path** —
 * never a line number, never a number range and never a whole file — so it
 * travels with the fixture when it moves, a new dangling reference on an
 * unmarked line still fails, and a stale pointer in `apps/web/src/server`,
 * `apps/web/src/app` or any `packages` source tree fails **even when its line
 * carries the marker** (finding F-M1). Exempt references are counted in
 * `exemptReferences`, not in `checkedReferences`.
 *
 * **`checkRepositoryAdrReferences`** scans, deterministically and sorting-free
 * (the report is sorted by file, then line, then number):
 *   - `docs/adr/*` for the resolvable numbers (a missing `docs/adr` throws, so a
 *     wrong root can never yield a vacuous pass);
 *   - every `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` file under `apps/` and
 *     `packages/` only (`scripts/` and every non-source extension is out of
 *     scope), skipping `node_modules`, `.git`, `.next`, `.worktrees`, `coverage`,
 *     `dist`, `build`, `.turbo`, `playwright-report` and `test-results` at any
 *     depth — a build output copy of a source file must not be counted twice.
 *
 * **Assumptions resolved in this spec** (flagged in the handoff):
 *   - Resolution reuses the strict file-name pattern (`adrDigitsOf`), so a
 *     malformed ADR file name does not resolve — the two guards then fail
 *     together instead of disagreeing.
 *   - `checkedReferences` counts what the rule evaluated; the two counters add up
 *     to the number of references the sweep saw.
 *   - The scan root is the repository root the spec derives from its own
 *     `import.meta.url`, so the check follows the worktree it runs in.
 */

describe("checkSourceAdrReferences — resolution against docs/adr", () => {
  it("accepts an in-source reference that a docs/adr file resolves", () => {
    // Arrange
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/notifications/digest.ts",
        text: "// TTL rationale: docs/adr/ADR-0146-a.md",
      },
    ];

    // Act
    const result = checkSourceAdrReferences(sources, ["ADR-0146-a.md", "README.md"]);

    // Assert
    expect(result).toEqual({ ok: true, issues: [], checkedReferences: 1, exemptReferences: 0 });
  });

  it("reports a dangling reference naming the file, the 1-based line and the digits as written", () => {
    // Arrange — line 3 carries the reference; the number is a sibling lane's,
    // exactly the F6 shape (a comment sending readers to the wrong record).
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/media/signed-urls.ts",
        text: ['import { sign } from "./sign";', "", "// see ADR-0764 for the decision"].join("\n"), // adr-fixture: 0764 has no docs/adr file on this tree
      },
    ];

    // Act
    const result = checkSourceAdrReferences(sources, ["ADR-0766-decision.md"]); // adr-fixture: 0766 exists only on the unmerged lane

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "dangling-reference",
          file: "apps/web/src/server/media/signed-urls.ts",
          line: 3,
          number: "0764", // adr-fixture: the dangling token itself
        },
      ],
      checkedReferences: 1,
      exemptReferences: 0,
    });
  });

  it("reports one issue per file when the same dangling number appears in two files", () => {
    // Arrange
    const sources: SourceFileText[] = [
      { path: "apps/web/src/server/b.ts", text: "// ADR-0764 again" }, // adr-fixture: 0764 is not a docs/adr file here
      { path: "apps/web/src/server/a.ts", text: "// ADR-0764 first" }, // adr-fixture: 0764 is not a docs/adr file here
    ];

    // Act
    const result = checkSourceAdrReferences(sources, []);

    // Assert — sorted by file, so the input order cannot leak into the report.
    expect(result.issues).toEqual([
      { code: "dangling-reference", file: "apps/web/src/server/a.ts", line: 1, number: "0764" },
      { code: "dangling-reference", file: "apps/web/src/server/b.ts", line: 1, number: "0764" },
    ]);
    expect(result.checkedReferences).toBe(2);
  });

  it("reports one issue per occurrence when the same dangling number repeats on two lines", () => {
    // Arrange
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: [
          "// ADR-0764 once", // adr-fixture: 0764 is not a docs/adr file here
          "// ADR-0764 twice", // adr-fixture: 0764 is not a docs/adr file here
        ].join("\n"),
      },
    ];

    // Act
    const result = checkSourceAdrReferences(sources, []);

    // Assert
    expect(result.issues).toEqual([
      { code: "dangling-reference", file: "apps/web/src/server/x.ts", line: 1, number: "0764" },
      { code: "dangling-reference", file: "apps/web/src/server/x.ts", line: 2, number: "0764" },
    ]);
  });

  it("reports every reference on one line, ordered by number", () => {
    // Arrange — the F6 defect in a single comment: two sibling-lane numbers.
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// ADR-0764 and ADR-0765 were renumbered", // adr-fixture: both are sibling-lane numbers
      },
    ];

    // Act
    const result = checkSourceAdrReferences(sources, []);

    // Assert
    expect(result.issues).toEqual([
      { code: "dangling-reference", file: "apps/web/src/server/x.ts", line: 1, number: "0764" },
      { code: "dangling-reference", file: "apps/web/src/server/x.ts", line: 1, number: "0765" },
    ]);
    expect(result.checkedReferences).toBe(2);
  });

  it("does not let a malformed ADR file name resolve a reference", () => {
    // Arrange — the ADR directory's own naming rule (`^ADR-(\\d{4})-[a-z0-9-]+\\.md$`)
    // governs resolution too, so the two guards cannot disagree.
    const sources: SourceFileText[] = [
      { path: "apps/web/src/server/x.ts", text: "// ADR-0146 rationale" },
    ];

    // Act
    const result = checkSourceAdrReferences(sources, ["ADR-0146-Upper-Slug.md"]);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { code: "dangling-reference", file: "apps/web/src/server/x.ts", line: 1, number: "0146" },
    ]);
  });
});

describe("checkSourceAdrReferences — what counts as a reference", () => {
  it.each<[string, string]>([
    ["a five-digit number", "// ADR-12345 is not four digits"], // adr-fixture: shape fixture, must never resolve
    ["a two-digit number", "// ADR-96 keeps the short form"], // adr-fixture: shape fixture, must never resolve
    ["a lowercase prefix", "// adr-0146 is not an ADR reference"],
  ])("counts no reference for %s", (_shape, text) => {
    // Act
    const result = checkSourceAdrReferences([{ path: "apps/web/src/server/x.ts", text }], []);

    // Assert
    expect(result).toEqual({ ok: true, issues: [], checkedReferences: 0, exemptReferences: 0 });
  });

  it("reports references inside a block comment, a line comment and a string literal alike", () => {
    // Arrange — the F6 defect was in comments, so comments are explicitly in scope.
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: [
          "/**",
          " * @see ADR-0001 for the rationale", // adr-fixture: shape fixture, no docs/adr file
          " */",
          "// ADR-0002 likewise", // adr-fixture: shape fixture, no docs/adr file
          'const label = "ADR-0003";', // adr-fixture: shape fixture, no docs/adr file
        ].join("\n"),
      },
    ];

    // Act
    const result = checkSourceAdrReferences(sources, []);

    // Assert
    expect(result.issues.map((issue) => [issue.line, issue.number])).toEqual([
      [2, "0001"],
      [4, "0002"],
      [5, "0003"],
    ]);
    expect(result.checkedReferences).toBe(3);
  });
});

describe("checkSourceAdrReferences — the fixture marker", () => {
  it("exempts every reference on a line that carries the marker and counts them", () => {
    // Arrange — a synthetic number on a line that also carries `adr-fixture`.
    const sources: SourceFileText[] = [
      { path: "apps/web/src/test/unit/x.test.ts", text: "// ADR-0764 synthetic adr-fixture" }, // adr-fixture: the line under test is itself a fixture
    ];

    // Act
    const result = checkSourceAdrReferences(sources, []);

    // Assert
    expect(result).toEqual({ ok: true, issues: [], checkedReferences: 0, exemptReferences: 1 });
  });

  it("counts every reference on a marked line as exempt", () => {
    // Arrange
    const sources: SourceFileText[] = [
      { path: "apps/web/src/test/unit/x.test.ts", text: "// ADR-0764 and ADR-0765 adr-fixture" }, // adr-fixture: the line under test is itself a fixture
    ];

    // Act
    const result = checkSourceAdrReferences(sources, []);

    // Assert
    expect(result).toEqual({ ok: true, issues: [], checkedReferences: 0, exemptReferences: 2 });
  });

  it("still reports a dangling reference on an unmarked line of a marked file", () => {
    // Arrange — narrowness: the exemption is per line, not per file.
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/test/unit/x.test.ts",
        text: ["// ADR-0764 synthetic adr-fixture", "// ADR-0764 unmarked"].join("\n"),
      },
    ];

    // Act
    const result = checkSourceAdrReferences(sources, []);

    // Assert
    expect(result.issues).toEqual([
      {
        code: "dangling-reference",
        file: "apps/web/src/test/unit/x.test.ts",
        line: 2,
        number: "0764",
      },
    ]);
    expect(result.checkedReferences).toBe(1);
    expect(result.exemptReferences).toBe(1);
  });

  it("does not exempt a marked dangling reference in the application source", () => {
    // Arrange — the F-M1 hole: a real stale pointer in shipped source with the
    // exemption word appended. The pre-scope helper swallowed it silently.
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/media/signed-urls.ts",
        text: "// see ADR-0764 for the decision adr-fixture", // adr-fixture: the line under test is itself a fixture
      },
    ];

    // Act
    const result = checkSourceAdrReferences(sources, ["ADR-0766-decision.md"]);

    // Assert — the marker buys nothing outside the guard's own test tree.
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "dangling-reference",
          file: "apps/web/src/server/media/signed-urls.ts",
          line: 1,
          number: "0764",
        },
      ],
      checkedReferences: 1,
      exemptReferences: 0,
    });
  });

  it.each<[string, string]>([
    ["the app router tree", "apps/web/src/app/(public)/events/page.tsx"],
    ["a package source tree", "packages/contracts/src/index.ts"],
    ["a sibling directory whose name starts with `test`", "apps/web/src/test-tools/server.ts"],
    ["a path that leaves the test tree", "apps/web/src/test/../server/x.ts"],
  ])("does not exempt a marked dangling reference in %s", (_where, path) => {
    // Arrange — every path here sits outside `apps/web/src/test/**`, so the
    // marker must not be load-bearing. The last two rows pin an explicit
    // directory boundary and a normalized path, not a raw prefix test.
    const sources: SourceFileText[] = [
      { path, text: "// ADR-0764 adr-fixture" }, // adr-fixture: the line under test is itself a fixture
    ];

    // Act
    const result = checkSourceAdrReferences(sources, []);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [{ code: "dangling-reference", file: path, line: 1, number: "0764" }],
      checkedReferences: 1,
      exemptReferences: 0,
    });
  });

  it("exempts a marked line anywhere under the guard's own test tree", () => {
    // Arrange — the fixture half of the scope: helpers, unit and integration
    // specs all live under `apps/web/src/test/**`.
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/test/integration/media-signed-urls.test.ts",
        text: "// ADR-0764 synthetic adr-fixture", // adr-fixture: the line under test is itself a fixture
      },
    ];

    // Act
    const result = checkSourceAdrReferences(sources, []);

    // Assert
    expect(result).toEqual({ ok: true, issues: [], checkedReferences: 0, exemptReferences: 1 });
  });
});

describe("checkRepositoryAdrReferences — the repository sweep", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the repository's real source tree as reference-clean", () => {
    // Act — the characterization half of this card: every in-source reference at
    // this head resolves to a docs/adr file (the uploads lane may not be on this
    // tree yet, so the count is measured here, not copied from the card).
    const result = checkRepositoryAdrReferences(repoRoot);

    // Assert
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    // Non-vacuity: the sweep must see the whole tree, not just this spec file's references.
    expect(result.checkedReferences).toBeGreaterThanOrEqual(1000);
  });

  it("resolves references across apps/ and packages/ and reports the dangling ones in a stable order", () => {
    // Arrange — a throwaway repository: one resolving reference plus four that
    // have no ADR file, spread over apps/ and packages/ and over three extensions.
    const root = makeTempRepoRoot({
      "docs/adr/ADR-0146-alpha.md": "# alpha",
      "docs/adr/README.md": "ledger",
      "apps/web/src/resolved.ts": "// TTL rationale: ADR-0146-alpha.md",
      "apps/web/src/both.mjs": "// ADR-0001 and ADR-0002", // adr-fixture: shape fixtures, no docs/adr file
      "apps/web/src/dangling.ts": "const a = 1;\n// see ADR-0764 now", // adr-fixture: 0764 has no docs/adr file
      "packages/contracts/src/x.tsx": "// ADR-0007", // adr-fixture: shape fixture, no docs/adr file
    });

    // Act
    const result = checkRepositoryAdrReferences(root);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: "dangling-reference", file: "apps/web/src/both.mjs", line: 1, number: "0001" },
        { code: "dangling-reference", file: "apps/web/src/both.mjs", line: 1, number: "0002" },
        { code: "dangling-reference", file: "apps/web/src/dangling.ts", line: 2, number: "0764" },
        {
          code: "dangling-reference",
          file: "packages/contracts/src/x.tsx",
          line: 1,
          number: "0007",
        },
      ],
      checkedReferences: 5,
      exemptReferences: 0,
    });
  });

  it("ignores dependencies, build output, non-source files and the root scripts/ directory", () => {
    // Arrange — every reference here is outside the sweep's scope.
    const root = makeTempRepoRoot({
      "docs/adr/ADR-0146-alpha.md": "# alpha",
      "apps/web/src/notes.md": "ADR-0003", // adr-fixture: not a source extension
      "apps/web/src/data.json": '{ "note": "ADR-0004" }', // adr-fixture: not a source extension
      "apps/web/node_modules/pkg/index.ts": "// ADR-0005", // adr-fixture: dependency, never swept
      "apps/web/.next/server/page.ts": "// ADR-0006", // adr-fixture: build output, never swept
      "packages/contracts/src/empty.ts": "export const nothing = 0;",
      "scripts/tool.ts": "// ADR-0008", // adr-fixture: root scripts/ is out of scope
    });

    // Act
    const result = checkRepositoryAdrReferences(root);

    // Assert
    expect(result).toEqual({ ok: true, issues: [], checkedReferences: 0, exemptReferences: 0 });
  });

  it("throws an ENOENT error when the root has no docs/adr directory", () => {
    // Arrange — a wrong root must fail loudly, never pass vacuously.
    const root = makeTempRepoRoot({ "apps/web/src/x.ts": "// no references here" });

    // Act + Assert
    expect(() => checkRepositoryAdrReferences(root)).toThrow(
      expect.objectContaining({ code: "ENOENT" })
    );
  });
});

/**
 * Measured-count provenance — a record that quotes a suite count must name the
 * head commit it was measured at (`ADR-0302` §12; finding F3 of the review of
 * `t_e3a344af`, PR #910).
 *
 * **Why this exists.** A merged record (finding F3 of the review of `t_e3a344af`,
 * PR #910) quoted `unit` as `199 files / 3378 passed` and "the nine `adr-*`
 * guards" for a head that measured `200 / 3398` and ten: the figures were true of
 * an earlier head and nothing tied them to the head the record described, so the
 * whole suite stayed green while the record drifted.
 * Census at this branch's base `f0422e2e`: 486 records, 315 quote a suite count,
 * 297 name a head, 18 name none. At `03a5fbd5`, the head the card states, the same
 * census read 485 / 314 / 296 / 18 — `#911` minted one more record since.
 *
 * **What the rule reads.**
 *
 * - A **suite-count quote** is a digit run, whitespace, `passed`, whitespace, `(`
 *   — vitest's `Tests  15 passed (15)`, its `1 failed | 14 passed (15)` arm, and
 *   a quote whose parenthesis wrapped to the next line. The parenthesis is
 *   required, so prose like "the 3 passed cases" is not a quote. `quoted` is the
 *   phrase **without** the parenthesis, whitespace collapsed, so a failure
 *   message is pasteable back into the record.
 * - A **head commit reference** is a lowercase hexadecimal run of 7 to 40
 *   characters that contains at least one `a`–`f` letter. A bare digit run is not
 *   a commit — four trunk records pass the looser `[0-9a-f]{7,40}` test on an
 *   epoch, a byte count, a magic number and a placeholder — a six-character
 *   prefix is too short to pin a commit, a 64-character blob hash is not a commit
 *   at all, and uppercase is not read because this repository writes SHAs
 *   lowercase. The **first** such token in document order is what `checked.head`
 *   reports.
 * - Only `docs/adr/ADR-*.md` records are read; `docs/adr/README.md` is out,
 *   because its ledger notes quote other heads' counts on purpose.
 * - A fenced code block and an inline code span **are** read, unlike invariant
 *   (vi): a record's measured counts and its head live in fences and backticks.
 *
 * **Assumptions resolved in this spec** (flagged in the handoff):
 *
 *   - The rule is **record-level**, not §Evidence-only. At `03a5fbd5`, 148 of the
 *     314 quoting records carry a `## Evidence` section at all and 37 cite their
 *     head only outside it, so a §Evidence-scoped rule would red about 200
 *     records — a docs programme, not a guard.
 *   - The 18 records that already quote counts and name no head at `f0422e2e` are
 *     an explicit, **shrink-only** allowlist ({@link MEASURED_COMMIT_EXEMPTIONS})
 *     of bare four-digit record numbers, not a "greater than the highest number"
 *     cut-off: a cut-off is vacuous until the next record is minted, while the
 *     allowlist enforces the rule over the other 297 records today. Numbers and
 *     not file names, because naming the eighteen files from source makes the
 *     helper their declared consumer — invariant (v) reported three
 *     `consumer-mismatch` issues when it did — and a number identifies exactly one
 *     record (invariant (i)).
 *   - An allowlisted record is **skipped**, never checked-and-passed: it appears
 *     in neither `checked` nor `issues`, so repairing one cannot look like a pass.
 *   - One issue per record, not per quote: a record has one measured head.
 */
describe("checkMeasuredCommitCitations — a record that quotes a count names its head", () => {
  it("accepts a record whose count names the head it was measured at", () => {
    // Arrange — the F3 shape: a fenced vitest summary plus the head.
    const records: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0302-a.md",
        text: [
          "## Evidence",
          "",
          "```",
          "Tests  15 passed (15)",
          "```",
          "",
          "Counts at `e91cfed7`: the focused spec `15 passed (15)`.",
        ].join("\n"),
      },
    ];

    // Act
    const report = checkMeasuredCommitCitations(records);

    // Assert
    expect(report).toEqual({
      ok: true,
      issues: [],
      checked: [{ file: "docs/adr/ADR-0302-a.md", line: 4, quoted: "15 passed", head: "e91cfed7" }],
      scannedRecords: 1,
    });
  });

  it("reports a record that quotes a suite count and names no head commit", () => {
    // Arrange — the defect F3 shipped: counts with nothing tying them to a head.
    const records: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0323-a.md",
        text: ["## Evidence", "", "Tests  13 failed | 2 passed (15)", ""].join("\n"),
      },
    ];

    // Act
    const report = checkMeasuredCommitCitations(records);

    // Assert
    expect(report).toEqual({
      ok: false,
      issues: [
        {
          code: "missing-head-commit",
          file: "docs/adr/ADR-0323-a.md",
          line: 3,
          quoted: "2 passed",
        },
      ],
      checked: [{ file: "docs/adr/ADR-0323-a.md", line: 3, quoted: "2 passed", head: null }],
      scannedRecords: 1,
    });
  });

  it("ignores a record that quotes no suite count", () => {
    // Arrange — a design record with no measurement is out of scope entirely.
    const records: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0302-b.md",
        text: ["## Decision", "", "The rule is textual, and 3 cases hold.", ""].join("\n"),
      },
    ];

    // Act
    const report = checkMeasuredCommitCitations(records);

    // Assert — `checked` stays empty, so the silence names what was skipped.
    expect(report).toEqual({ ok: true, issues: [], checked: [], scannedRecords: 1 });
  });

  it("reports the record's first quote, whichever count it is", () => {
    // Arrange — two quotes, the first one already at line 1.
    const records: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0002-a.md",
        text: [
          "Tests  320 passed (320)",
          "",
          "```",
          "Tests  3398 passed | 3 skipped (3401)",
          "```",
        ].join("\n"),
      },
    ];

    // Act
    const report = checkMeasuredCommitCitations(records);

    // Assert
    expect(report.issues).toEqual([
      {
        code: "missing-head-commit",
        file: "docs/adr/ADR-0002-a.md",
        line: 1,
        quoted: "320 passed",
      },
    ]);
  });

  it.each<[string, string]>([
    ["a bare digit run", "1792924295000"],
    ["a six-character hex prefix", "e91cfe"],
    ["a forty-one-character hex run", "e".repeat(41)],
    ["an uppercase hex token", "E91CFED7"],
    [
      "a 64-character blob hash",
      "e66bcc7fc3fbbf82f97d2c3032ad802b969ae5de001c7149b654be889b3a8e09",
    ],
    ["a hex run glued to non-hex letters", "e91cfed7z"],
  ])("does not read %s as a head commit", (_label, token) => {
    // Arrange — each token is head-shaped at a glance and names no commit.
    const records: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0001-a.md",
        text: ["Tests  15 passed (15)", "", `Measured at \`${token}\`.`].join("\n"),
      },
    ];

    // Act
    const report = checkMeasuredCommitCitations(records);

    // Assert
    expect(report.issues).toEqual([
      { code: "missing-head-commit", file: "docs/adr/ADR-0001-a.md", line: 1, quoted: "15 passed" },
    ]);
    expect(report.checked[0]?.head).toBeNull();
  });

  it("reads a count whose parenthesis wrapped, and a head inside a fenced block", () => {
    // Arrange — the measured shape: `1781 passed  (` then the timing on the next
    // line; the head is a `git rev-parse` line inside the same fence.
    const records: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0003-a.md",
        text: [
          "```",
          "$ git rev-parse HEAD",
          "e91cfed7",
          "",
          "--project integration (full)   165 files / 1781 passed",
          "  (334 s wall, 0 failed)",
          "```",
          "",
          "Measured earlier at `4a8fe73`.",
        ].join("\n"),
      },
    ];

    // Act
    const report = checkMeasuredCommitCitations(records);

    // Assert — the count was read at its own line, the first head is the one named.
    expect(report).toEqual({
      ok: true,
      issues: [],
      checked: [
        { file: "docs/adr/ADR-0003-a.md", line: 5, quoted: "1781 passed", head: "e91cfed7" },
      ],
      scannedRecords: 1,
    });
  });

  it("sorts the report by file, whatever order the records arrive in", () => {
    // Arrange — the later path is handed in first. Both numbers carry a real
    // record on the trunk, so the source sweep reads these fixture names as
    // resolvable references rather than as new dangling ones.
    const records: SourceFileText[] = [
      { path: "docs/adr/ADR-0200-b.md", text: "Tests  1 passed (1)" }, // adr-fixture: synthetic record name
      { path: "docs/adr/ADR-0001-b.md", text: "Tests  1 passed (1)" }, // adr-fixture: synthetic record name
    ];

    // Act
    const report = checkMeasuredCommitCitations(records);

    // Assert
    expect(report.issues.map((issue) => issue.file)).toEqual([
      "docs/adr/ADR-0001-b.md",
      "docs/adr/ADR-0200-b.md",
    ]);
    expect(report.checked.map((check) => check.file)).toEqual([
      "docs/adr/ADR-0001-b.md",
      "docs/adr/ADR-0200-b.md",
    ]);
  });
});

describe("checkRepositoryMeasuredCommitCitations — the docs/adr sweep", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads every in-scope record and reports the one that names no head", () => {
    // Arrange — the keep-set: a record with a head, a record with no count, a
    // ledger that quotes counts for other heads, and a file outside docs/adr.
    const root = makeTempRepoRoot({
      "docs/adr/ADR-0001-quoted-with-head.md": "Tests  15 passed (15)\n\nAt `e91cfed7`.",
      "docs/adr/ADR-0002-quoted-no-head.md": "Tests  15 passed (15)",
      "docs/adr/ADR-0003-design.md": "## Decision\n\nNo measurement here.",
      "docs/adr/README.md": "| [0002](ADR-0002-quoted-no-head.md) | Tests 320 passed (320) |",
      "apps/web/notes.md": "Tests  99 passed (99)", // adr-fixture: outside docs/adr
    });

    // Act
    const report = checkRepositoryMeasuredCommitCitations(root, []);

    // Assert — three records scanned, README and apps/ never read.
    expect(report).toEqual({
      ok: false,
      issues: [
        {
          code: "missing-head-commit",
          file: "docs/adr/ADR-0002-quoted-no-head.md",
          line: 1,
          quoted: "15 passed",
        },
      ],
      checked: [
        {
          file: "docs/adr/ADR-0001-quoted-with-head.md",
          line: 1,
          quoted: "15 passed",
          head: "e91cfed7",
        },
        {
          file: "docs/adr/ADR-0002-quoted-no-head.md",
          line: 1,
          quoted: "15 passed",
          head: null,
        },
      ],
      scannedRecords: 3,
    });
  });

  it("skips an allowlisted record instead of passing it", () => {
    // Arrange — a record whose number is on the allowlist, in a throwaway tree.
    const root = makeTempRepoRoot({
      "docs/adr/ADR-0046-synthetic.md": "Tests  15 passed (15)", // adr-fixture: synthetic record name
    });

    // Act
    const report = checkRepositoryMeasuredCommitCitations(root);

    // Assert — neither checked nor reported: the skip is visible in `checked`.
    expect(report).toEqual({ ok: true, issues: [], checked: [], scannedRecords: 1 });
  });

  it("throws an ENOENT error when the root has no docs/adr directory", () => {
    // Arrange — a wrong root must fail loudly, never pass vacuously.
    const root = makeTempRepoRoot({ "docs/CONVENTIONS.md": "Tests  15 passed (15)" });

    // Act + Assert
    expect(() => checkRepositoryMeasuredCommitCitations(root)).toThrow(
      expect.objectContaining({ code: "ENOENT" })
    );
  });

  it("reports the trunk as provenance-complete for every record off the allowlist", () => {
    // Act — the enforced census at `c28cc394` is 298 records checked.
    const report = checkRepositoryMeasuredCommitCitations(repoRoot);

    // Assert — floors two below that census, never an equality: a mint raises the
    // pair and a retirement lowers it, so re-measure both with
    // `checkRepositoryMeasuredCommitCitations(repoRoot, [])` (298 checked / 487
    // scanned at `c28cc394`) before the next edit. Two records of slack is the
    // point: the previous `>= 280` / `>= 480` pair left a `.slice(0, -17)`
    // narrowing of the enforced corpus and the four-record quote-pattern
    // narrowing green, and the `checked` list is what keeps silence non-vacuous.
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checked.length).toBeGreaterThanOrEqual(296);
    expect(report.scannedRecords).toBeGreaterThanOrEqual(485);
  });

  it("keeps the allowlist equal to the trunk's actual offenders, so it can only shrink", () => {
    // Arrange — the same tree, with the allowlist switched off.
    const offenders = checkRepositoryMeasuredCommitCitations(repoRoot, [])
      .issues.map((issue) => adrDigitsOf(basename(issue.file)))
      .sort();

    // Assert — an equality on the allowlist's own contents, not on the census:
    // repairing a record reds here until its number leaves the allowlist, and a
    // new offender reds here beside the rule's own case.
    expect(offenders).toEqual([...MEASURED_COMMIT_EXEMPTIONS]);
  });
});

/**
 * Characterization — what the head pattern proves, and what it does not.
 *
 * `HEAD_COMMIT_PATTERN` accepts any lowercase 7–40-character hexadecimal token
 * that carries a letter, anywhere in the record, so the clause proves only that a
 * quoting record names a token **shaped** like a head commit. Three shapes are
 * pinned here so the limit is executable instead of prose only (`ADR-0302` §12):
 *
 * - another record's head is reported as this record's `head` — the clause never
 *   compares the token with the commit the counts were measured at;
 * - a truncated blob digest — seven hexadecimal characters of a file's sha256,
 *   the shape the drift record cited for a file — is accepted as a head;
 * - a `0x`-prefixed hex literal is rejected, because its run is glued to the
 *   non-hex `x` and so has no word boundary.
 *
 * These rows are characterization, not a contract to widen. A stricter form — the
 * head inside `## Evidence`, or adjacent to the first quote — is a design change
 * for the orchestrator, and a pattern change that flips one of these rows must red
 * here first.
 */
describe("checkMeasuredCommitCitations — head-shaped is not the measured head", () => {
  it("accepts another record's head as this record's head", () => {
    // Arrange — the token is a real head, of a different record.
    const records: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0302-c.md",
        text: ["Tests  15 passed (15)", "", "Landed ADR-0980 at e91cfed7."].join("\n"), // adr-fixture: verbatim record text, not a pointer
      },
    ];

    // Act
    const report = checkMeasuredCommitCitations(records);

    // Assert — a foreign head satisfies the clause exactly like an own one.
    expect(report).toEqual({
      ok: true,
      issues: [],
      checked: [{ file: "docs/adr/ADR-0302-c.md", line: 1, quoted: "15 passed", head: "e91cfed7" }],
      scannedRecords: 1,
    });
  });

  it("accepts a truncated blob digest as a head commit", () => {
    // Arrange — a file's sha256 prefix, not a commit.
    const records: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0302-d.md",
        text: ["Tests  15 passed (15)", "", "blob sha256 c6a0cd45… unchanged."].join("\n"),
      },
    ];

    // Act
    const report = checkMeasuredCommitCitations(records);

    // Assert — seven hexadecimal characters carrying a letter are head-shaped.
    expect(report).toEqual({
      ok: true,
      issues: [],
      checked: [{ file: "docs/adr/ADR-0302-d.md", line: 1, quoted: "15 passed", head: "c6a0cd45" }],
      scannedRecords: 1,
    });
  });

  it("rejects a 0x-prefixed hex literal, because the run has no word boundary", () => {
    // Arrange — a seven-character hexadecimal run inside a `0x` literal.
    const records: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0302-e.md",
        text: ["Tests  15 passed (15)", "", "flag is 0x1234567a here."].join("\n"),
      },
    ];

    // Act
    const report = checkMeasuredCommitCitations(records);

    // Assert — the run is preceded by `x`, so it is not a head-shaped token.
    expect(report).toEqual({
      ok: false,
      issues: [
        {
          code: "missing-head-commit",
          file: "docs/adr/ADR-0302-e.md",
          line: 1,
          quoted: "15 passed",
        },
      ],
      checked: [{ file: "docs/adr/ADR-0302-e.md", line: 1, quoted: "15 passed", head: null }],
      scannedRecords: 1,
    });
  });
});
