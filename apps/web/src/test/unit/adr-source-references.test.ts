import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRepoRoot, repoRoot, tempDirs } from "../helpers/adr-guard-fixtures.js";
import type { SourceFileText } from "../helpers/adr-guard-types.js";
import {
  checkRepositoryAdrReferences,
  checkSourceAdrReferences,
} from "../helpers/adr-source-references.js";

/**
 * ADR guard, invariant (iv) — the guard's six invariants are tabulated once, in
 * `ADR-0302` §1. This file owns one of them: every `ADR-NNNN` reference inside
 * a source file must resolve to a `docs/adr/ADR-NNNN-*.md` file.
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
    // Non-vacuity: the sweep must see the whole tree, not just the two spec files.
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
