import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  makeTempRepoRoot,
  repoRoot,
  tempDirs,
  writeFixtureFile,
} from "../helpers/adr-guard-fixtures.js";
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
 * measured at, and that head must resolve to a git `commit` object — the pure
 * check takes an injected batch resolver, and the repository sweep supplies one
 * `git cat-file --batch-check` pass, so a blob, a tree or an unknown token is not
 * provenance. The clause has no invariant row of its own on purpose — an
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

  it("reports the first head-shaped token that is a commit, not the first head-shaped token", () => {
    // Arrange — the OP-132 liveness selfie record's shape: a random 32-hex nonce
    // is quoted above the head the counts were measured at. Both tokens are
    // head-shaped; only the second is an object in any repository.
    const records: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0791-a.md", // adr-fixture: synthetic record name
        text: [
          "```",
          '"nonce": "3f2c1d8899aa55bb66cc77dd88ee99ff",',
          "```",
          "",
          "Tests  13 passed (13) at `3eb7c7d`.",
        ].join("\n"),
      },
    ];
    const seen: string[][] = [];

    // Act — the resolver knows the head and not the nonce.
    const report = checkMeasuredCommitCitations(records, (tokens) => {
      seen.push([...tokens]);
      return new Set(tokens.filter((token) => token === "3eb7c7d"));
    });

    // Assert — the nonce is skipped, so the record reports its real head.
    expect(report).toEqual({
      ok: true,
      issues: [],
      checked: [
        {
          file: "docs/adr/ADR-0791-a.md", // adr-fixture: synthetic record name
          line: 5,
          quoted: "13 passed",
          head: "3eb7c7d",
        },
      ],
      scannedRecords: 1,
    });
    // The resolver is a **batch** over the record's candidates, in document order:
    // one call for the record, not one call per token, so the sweep costs one
    // `git cat-file --batch-check` pass over the corpus.
    expect(seen).toEqual([["3f2c1d8899aa55bb66cc77dd88ee99ff", "3eb7c7d"]]);
  });

  it("rejects a record whose only head-shaped tokens are not commit objects", () => {
    // Arrange — a file digest and a tree, both head-shaped, neither a commit: the
    // drift record's shape twice over in one record.
    const records: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0302-h.md",
        text: [
          "Tests  15 passed (15)",
          "",
          "The route blob is `c6a0cd45` and the tree above it `83a1c8ce`.",
        ].join("\n"),
      },
    ];

    // Act — the resolver reports no commit for either token.
    const report = checkMeasuredCommitCitations(records, () => new Set<string>());

    // Assert — one issue for the record, naming its first quote, and no head.
    expect(report).toEqual({
      ok: false,
      issues: [
        {
          code: "missing-head-commit",
          file: "docs/adr/ADR-0302-h.md",
          line: 1,
          quoted: "15 passed",
        },
      ],
      checked: [{ file: "docs/adr/ADR-0302-h.md", line: 1, quoted: "15 passed", head: null }],
      scannedRecords: 1,
    });
  });

  it("keeps the one-argument default shape-only, so the pure call is not the enforcing one", () => {
    // Arrange — a token the clause rejects once a resolver answers: a file's
    // digest. With no resolver there is no repository to ask.
    const records: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0302-i.md",
        text: ["Tests  15 passed (15)", "", "blob sha256 c6a0cd45… unchanged."].join("\n"),
      },
    ];

    // Act — one argument only.
    const report = checkMeasuredCommitCitations(records);

    // Assert — the permissive default accepts every head-shaped token. The
    // enforcing path is `checkRepositoryMeasuredCommitCitations`; a default that
    // quietly grew a resolver would make every injected-resolver case above pass
    // for the wrong reason.
    expect(report).toEqual({
      ok: true,
      issues: [],
      checked: [{ file: "docs/adr/ADR-0302-i.md", line: 1, quoted: "15 passed", head: "c6a0cd45" }],
      scannedRecords: 1,
    });
  });
});

/**
 * The fixture commit's own timeline, in seconds since the epoch
 * (2023-11-14T22:13:29Z), pinned into {@link fixtureGitEnv}.
 *
 * `git commit` otherwise stamps the committer date with the wall clock, which
 * makes the fixture's commit hash — and the 8 characters a record quotes — a
 * different value on every run. That was this file's flake: the clause's
 * head-shape gate (`HEAD_COMMIT_PATTERN`, at least one `a`–`f` letter in a 7–40
 * character hexadecimal run) rejects a letter-free run on purpose — four trunk
 * records match a looser `\b[0-9a-f]{7,40}\b` on an epoch, a byte count, a magic
 * number and a placeholder — so a letter-free prefix is not a head-shaped token
 * at all: the record it was pasted into yields no token, and the sweep reports
 * `head: null` / `missing-head-commit` on a tree that is correct. Measured on a
 * 200-distinct-hash sample: **5 letter-free heads (2.5%)** against
 * `(10/16)^8 = 2.33%` predicted. CI reded that way twice on 2026-11-25
 * (`84170438`, no letter — `unit` run `45576932454` on PR #961 head `8f5ad417`
 * and run `45575920259` on `main` `50d98aba`). A pinned date makes the hash a
 * constant, so the case is deterministic instead of 1-in-43.
 *
 * The value is also chosen so the **raw** commit answers a letter-free head
 * (`96654021`): with the fixture's repair below, every build therefore takes the
 * amend-until-shaped path, instead of a path only one case would ever reach.
 */
const FIXTURE_COMMIT_EPOCH = 1_700_000_069;

/**
 * The environment every fixture git command runs with: the parent's, **minus
 * every inherited `GIT_*` variable**, plus the pinned author and committer dates.
 *
 * `git -C <root>` is authoritative only while the child carries no `GIT_DIR`,
 * `GIT_OBJECT_DIRECTORY`, `GIT_INDEX_FILE` or `GIT_WORK_TREE`: any of those
 * redirects the very commands that are supposed to write and read `<root>`'s own
 * object database, and a redirected read is indistinguishable from a foreign
 * hash — it answers `missing` for a commit that exists, which is the same report
 * a record citing a hash from elsewhere earns. Stripping the whole prefix makes
 * the fixture hermetic; the pinned dates make the resulting hash a constant.
 */
function fixtureGitEnv(): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))
  ) as unknown as NodeJS.ProcessEnv;
  const stamp = `@${String(FIXTURE_COMMIT_EPOCH)} +0000`;
  return { ...inherited, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp };
}

/** `git -C <root> …` on the fixture's own environment, as text. */
function gitIn(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: fixtureGitEnv(),
  });
}

/**
 * Whether the rule's **own** head-shape gate accepts `token`, asked through the
 * public check rather than a copy of the pattern: a record quoting the token is
 * scanned with the shape-only default resolver, and the token is head-shaped
 * exactly when the report names it as that record's `head`.
 *
 * A copy of `/\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/` here would let the fixture
 * and the rule drift apart — the fixture would keep minting tokens the rule had
 * stopped accepting, or the reverse.
 */
function headIsHeadShaped(token: string): boolean {
  const report = checkMeasuredCommitCitations([
    { path: "docs/adr/ADR-0302-shape-probe.md", text: `Tests  15 passed (15)\n\nAt \`${token}\`.` },
  ]);
  return report.checked.at(0)?.head === token;
}

/**
 * How many times {@link makeTempGitRoot} may amend its own commit before it gives
 * up. Each attempt re-draws the hash from a different message, so the tail is
 * `(10/16)^(8 × 32)`: the bound exists to fail loudly, never to fail in practice.
 */
const FIXTURE_HEAD_ATTEMPTS = 32;

/**
 * Attempts, and the pause between them, {@link makeTempGitRoot} spends waiting
 * for its own commit object to answer a read.
 *
 * 50 × 20 ms is a ceiling on a slow filesystem's writeback, never a tolerance on
 * an assertion: when the object is still invisible the factory **throws**, so a
 * missing commit cannot reach the sweep as a `missing-head-commit` report about a
 * tree that is correct.
 */
const FIXTURE_VISIBILITY_ATTEMPTS = 50;
const FIXTURE_VISIBILITY_DELAY_MS = 20;

/**
 * Block until `<root>`'s own object database answers for `head` — the read the
 * resolver performs microseconds later — and throw when it does not.
 *
 * This is the opening card's first hypothesis, kept as a guard rather than as the
 * diagnosis: the observed CI failure was a **letter-free** head (a token the rule
 * never accepts), not an invisible one, and no case can induce a visibility lag
 * deterministically. The guard costs one `cat-file` when the object is already
 * there, and it converts the pathological case into an error that names the root
 * and the head instead of a report that reads exactly like a record citing a
 * foreign hash.
 */
function waitForCommitObject(root: string, head: string): void {
  for (let attempt = 1; attempt <= FIXTURE_VISIBILITY_ATTEMPTS; attempt += 1) {
    try {
      gitIn(root, "cat-file", "-e", `${head}^{commit}`);
      return;
    } catch {
      // A synchronous pause: this factory runs inside a test body, and a timer the
      // suite could fake would not pace a subprocess anyway.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, FIXTURE_VISIBILITY_DELAY_MS);
    }
  }
  throw new Error(
    `makeTempGitRoot's own commit ${head} was still invisible to git cat-file after ` +
      `${String(FIXTURE_VISIBILITY_ATTEMPTS)} attempts in ${root}`
  );
}

/**
 * A throwaway repository root that is a **real git repository with one commit**,
 * so the sweep's commit-object resolver has an object database to read: the
 * returned `head` is the 8-character prefix of `HEAD`, which
 * `git cat-file -t <head>` answers `commit` for.
 *
 * A bare temp directory is not enough any more. `git -C <root> cat-file` exits
 * 128 outside a repository, so a root with no `.git` cannot tell a commit from a
 * blob, a tree or a typo — and a resolver that answered "every token is a commit"
 * when git could not run would be the shape-only rule again under a new name.
 * The cases below therefore build a repository, exactly as CI checks one out
 * (`fetch-depth: 0`).
 *
 * Two properties are built in, and both are here because the factory used to hand
 * the sweep a token it could not read:
 *
 * - **the commit's timeline is pinned** ({@link FIXTURE_COMMIT_EPOCH}), so the
 *   hash — and the token pasted into the record — is a constant instead of a
 *   fresh draw from the wall clock;
 * - **the token is head-shaped** even when the raw hash is not: the commit is
 *   amended with a different message until the 8-character prefix carries an
 *   `a`–`f` letter, which is the clause's own shape requirement. Amending
 *   replaces the commit, so the repository stays at exactly one commit and the
 *   abbreviated token can never become ambiguous.
 *
 * **Why the factory and not the rule.** The alternative repair — relax
 * `HEAD_COMMIT_PATTERN` to accept a letter-free digit run — would put four trunk
 * records back into the corpus on an epoch (`1792924295000`), a byte count
 * (`53687091200`), a magic number and a placeholder (`0123456789`), none of which
 * pins a commit: the false heads the letter requirement exists to reject. The
 * rule is right; a fixture that pasted a random hexadecimal value into a record
 * and then required the rule to see it was the defective half.
 */
function makeTempGitRoot(): { root: string; head: string } {
  const root = makeTempRepoRoot({ "README.md": "fixture\n" });
  const commit = (...flags: readonly string[]): void => {
    gitIn(
      root,
      "-c",
      "user.name=adr-guard",
      "-c",
      "user.email=adr-guard@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      ...flags
    );
  };
  // `--short=8` is a floor, not a fixed width: git lengthens the abbreviation if
  // it is ambiguous, so a future second commit in the same repository still
  // yields a token that names exactly one object.
  const head = (): string => gitIn(root, "rev-parse", "--short=8", "HEAD").trim();

  gitIn(root, "init", "--quiet", "--initial-branch=main");
  gitIn(root, "add", "--all");
  commit("-m", "fixture");

  let abbreviated = head();
  for (
    let attempt = 1;
    attempt <= FIXTURE_HEAD_ATTEMPTS && !headIsHeadShaped(abbreviated);
    attempt += 1
  ) {
    commit("--amend", "-m", `fixture-${String(attempt)}`);
    abbreviated = head();
  }
  if (!headIsHeadShaped(abbreviated)) {
    throw new Error(
      `makeTempGitRoot could not reach a head-shaped commit in ` +
        `${String(FIXTURE_HEAD_ATTEMPTS)} attempts (last head ${abbreviated} in ${root})`
    );
  }

  waitForCommitObject(root, abbreviated);
  return { root, head: abbreviated };
}

/**
 * The git object type of each token, as `token -> type`, in **one**
 * `git cat-file --batch-check` pass; `"missing"` when the object database cannot
 * read a token, which is the answer git itself gives a bad revision.
 *
 * One process for the whole corpus is the shape the resolver uses, and the reason
 * this helper exists: 305 separate `cat-file -t` spawns measure 2.8 s against the
 * unit project's 5 000 ms case budget, which is a timeout flake on a contended
 * runner rather than a stronger assertion.
 */
function gitObjectTypes(root: string, tokens: readonly string[]): Map<string, string> {
  const types = new Map<string, string>();
  if (tokens.length === 0) {
    return types;
  }

  let output: string;
  try {
    output = execFileSync("git", ["-C", root, "cat-file", "--batch-check"], {
      input: tokens.map((token) => `${token}\n`).join(""),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    for (const token of tokens) {
      types.set(token, "missing");
    }
    return types;
  }

  // `--batch-check` answers one line per input line, in input order: `<token>
  // <type> <size>`, or `<token> missing` when the object database cannot read it.
  const pending = tokens[Symbol.iterator]();
  for (const line of output.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const token = pending.next();
    if (token.done === true) {
      break;
    }
    const [, type] = line.split(" ");
    types.set(token.value, type ?? "missing");
  }
  return types;
}

describe("checkRepositoryMeasuredCommitCitations — the docs/adr sweep", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads every in-scope record and reports the one that names no head", () => {
    // Arrange — the keep-set: a record naming a real commit object, a record with
    // no count, a ledger that quotes counts for other heads, and a file outside
    // docs/adr. The root is a git repository, so the head is a commit object the
    // resolver can find; `docs/adr` is written after the commit on purpose, so the
    // head exists even though the records are uncommitted.
    const { root, head } = makeTempGitRoot();
    writeFixtureFile(
      join(root, "docs/adr/ADR-0001-quoted-with-head.md"),
      `Tests  15 passed (15)\n\nAt \`${head}\`.`
    );
    writeFixtureFile(join(root, "docs/adr/ADR-0002-quoted-no-head.md"), "Tests  15 passed (15)");
    writeFixtureFile(
      join(root, "docs/adr/ADR-0003-design.md"),
      "## Decision\n\nNo measurement here."
    );
    writeFixtureFile(
      join(root, "docs/adr/README.md"),
      "| [0002](ADR-0002-quoted-no-head.md) | Tests 320 passed (320) |"
    );
    writeFixtureFile(join(root, "apps/web/notes.md"), "Tests  99 passed (99)"); // adr-fixture: outside docs/adr

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
          head,
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

  it("pins its own commit, so the head it hands the sweep cannot vary with the wall clock", () => {
    // Arrange — the fixture's head is pasted into a record as that record's
    // provenance, so the fixture owns one property the sweep itself cannot check:
    // that the 8 characters it names are the same on every run. A `git commit`
    // that stamps the wall clock makes them a fresh random draw, and about one
    // draw in 43 carries no `a`–`f` letter — which the clause's head-shape gate
    // rejects, so the record yields no token and reports `head: null` on a tree
    // that is correct. Pinning the commit's dates makes the draw a constant.
    const { root, head } = makeTempGitRoot();

    // Act
    const authored = Number(gitIn(root, "show", "-s", "--format=%at", "HEAD").trim());
    const committed = Number(gitIn(root, "show", "-s", "--format=%ct", "HEAD").trim());
    const commits = gitIn(root, "rev-list", "--count", "HEAD").trim();

    // Assert — the commit carries the fixture's own timeline, so the hash (and
    // the token) is fixed; the repository still holds exactly one commit, because
    // the fixture's repair amends its commit instead of adding a second one; and
    // the token the fixture hands out is the shape the rule accepts, naming a
    // commit object.
    expect(authored).toBe(FIXTURE_COMMIT_EPOCH);
    expect(committed).toBe(FIXTURE_COMMIT_EPOCH);
    expect(commits).toBe("1");
    expect(headIsHeadShaped(head)).toBe(true);
    expect(gitIn(root, "cat-file", "-t", head).trim()).toBe("commit");
  });

  it("ignores an inherited GIT_* variable, so a stray GIT_DIR cannot redirect the fixture or the resolver", () => {
    // Arrange — a runner that exported GIT_DIR, GIT_OBJECT_DIRECTORY or
    // GIT_INDEX_FILE points every `git -C <root>` somewhere else: the fixture
    // would commit into the wrong object database and the sweep's resolver would
    // read the wrong one, answering `missing` for a commit that exists — the same
    // report a record citing a foreign hash earns, on a record naming its own.
    const stray = join(tmpdir(), "adr-source-refs-not-a-repository");
    vi.stubEnv("GIT_DIR", join(stray, "git-dir"));
    vi.stubEnv("GIT_OBJECT_DIRECTORY", join(stray, "objects"));
    vi.stubEnv("GIT_INDEX_FILE", join(stray, "index"));

    const { root, head } = makeTempGitRoot();
    writeFixtureFile(
      join(root, "docs/adr/ADR-0001-quoted-with-head.md"),
      `Tests  15 passed (15)\n\nAt \`${head}\`.`
    );

    // Act
    const report = checkRepositoryMeasuredCommitCitations(root, []);

    // Assert — the record is read, and its head is the commit the fixture made in
    // `<root>`: no inherited variable may redirect either child process.
    expect(report).toEqual({
      ok: true,
      issues: [],
      checked: [
        { file: "docs/adr/ADR-0001-quoted-with-head.md", line: 1, quoted: "15 passed", head },
      ],
      scannedRecords: 1,
    });
  });

  it("skips an allowlisted record instead of passing it", () => {
    // Arrange — a record whose number is on the allowlist, in a throwaway
    // repository: the root is git-backed so the sweep's resolver runs against a
    // real object database even though this record names no head at all.
    const { root } = makeTempGitRoot();
    writeFixtureFile(join(root, "docs/adr/ADR-0046-synthetic.md"), "Tests  15 passed (15)"); // adr-fixture: synthetic record name

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

  it("reports only commit objects as heads at the trunk", () => {
    // Act — the tree this spec runs in, with the default allowlist. Measured at
    // `0ccc18f4`: 305 records checked, 494 scanned, and 1,456 distinct head-shaped
    // tokens of which 1,109 are commits, 125 blobs, 56 trees and 166 resolve to
    // nothing — the rule skips the 347 that are not commits.
    const report = checkRepositoryMeasuredCommitCitations(repoRoot);

    // Assert — a non-empty corpus first, so the property below cannot hold
    // vacuously. The floor is the neighbouring case's, two below the census: this
    // case adds object types, not a second census.
    expect(report.checked.length).toBeGreaterThanOrEqual(296);

    // One `git cat-file --batch-check` pass for the corpus, the shape the resolver
    // uses, then the property per entry. `execFileSync` per head is the same
    // answer for 50x the process count — see `gitObjectTypes`.
    const types = gitObjectTypes(
      repoRoot,
      report.checked.flatMap((entry) => (entry.head === null ? [] : [entry.head]))
    );
    const notCommits = report.checked
      .map((entry) => ({
        file: entry.file,
        head: entry.head,
        type: entry.head === null ? "none" : (types.get(entry.head) ?? "missing"),
      }))
      .filter((entry) => entry.type !== "commit");

    // A head that is a blob, a tree, or a token no object database knows is not
    // provenance: it names no commit, so the clause must report the record instead.
    expect(notCommits).toEqual([]);
  });
});

/**
 * The clause's limit — what commit-object provenance proves, and what it does
 * not (`ADR-0302` §12).
 *
 * The reported head must be **the first head-shaped token in document order that
 * resolves to a git `commit` object**. A token that resolves to a blob, a tree,
 * nothing (`missing`) or ambiguously is skipped; a record with no such token
 * reports `missing-head-commit`. Three cases are pinned here:
 *
 * - another record's head is still reported as this record's `head`: a commit
 *   object that exists is all a static clause can check, and it never compares
 *   the token with the head *this* record's counts were measured at. That is the
 *   hole the rule leaves open on purpose — documented, never closed by a
 *   pattern, because no static check can see which head a merge measured;
 * - a truncated blob digest is **rejected**, because a blob is not a commit
 *   object — the drift shape that named a file's digest as a head;
 * - a `0x`-prefixed hex literal is rejected, because its run is glued to the
 *   non-hex `x` and so has no word boundary. That token never reaches the
 *   resolver: it was never head-shaped.
 *
 * These rows are characterization of what a head-shaped token can and cannot
 * prove. The measurements behind the rule — every positional form reds 138–301
 * of the 302 enforced records at `08c778bc`, an ancestor-of-`origin/main` form
 * reds 113, commit-object provenance reds none and corrects one report — are
 * recorded in the decision that chose it, not restated here.
 */
describe("checkMeasuredCommitCitations — the reported head must be a commit object", () => {
  it("still accepts another record's head, because a real commit object is out of reach of a static clause", () => {
    // Arrange — the token is a real commit object, of a different record.
    const records: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0302-c.md",
        text: ["Tests  15 passed (15)", "", "Landed ADR-0980 at e91cfed7."].join("\n"), // adr-fixture: verbatim record text, not a pointer
      },
    ];

    // Act — the resolver reports the token as a commit.
    const report = checkMeasuredCommitCitations(
      records,
      (tokens) => new Set(tokens.filter((token) => token === "e91cfed7"))
    );

    // Assert — a foreign head satisfies the clause exactly like an own one: the
    // object exists, and no static rule can tell whose counts it measured.
    expect(report).toEqual({
      ok: true,
      issues: [],
      checked: [{ file: "docs/adr/ADR-0302-c.md", line: 1, quoted: "15 passed", head: "e91cfed7" }],
      scannedRecords: 1,
    });
  });

  it("rejects a truncated blob digest, because a blob is not a commit object", () => {
    // Arrange — a file's digest, not a commit. The trunk carries the real
    // instance of this shape: `51de695c` names a route blob at
    // `docs/adr/ADR-0980-op101-downgrade-scheduled-event-green.md:143` (adr-fixture: verbatim trunk path, not a pointer),
    // and `git cat-file -t 51de695c` answers `blob`.
    const records: SourceFileText[] = [
      {
        path: "docs/adr/ADR-0302-d.md",
        text: ["Tests  15 passed (15)", "", "blob sha256 c6a0cd45… unchanged."].join("\n"),
      },
    ];

    // Act — the resolver reports no commit for the token.
    const report = checkMeasuredCommitCitations(records, () => new Set<string>());

    // Assert — head-shaped is not enough: the object must be a commit, so the
    // record reports its first quote and no head.
    expect(report).toEqual({
      ok: false,
      issues: [
        {
          code: "missing-head-commit",
          file: "docs/adr/ADR-0302-d.md",
          line: 1,
          quoted: "15 passed",
        },
      ],
      checked: [{ file: "docs/adr/ADR-0302-d.md", line: 1, quoted: "15 passed", head: null }],
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
