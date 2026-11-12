import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkAdrDirectory,
  checkAdrNumbers,
  checkRepositoryAdrReferences,
  checkSourceAdrReferences,
  parseAdrNumber,
  type AdrNumberIssue,
  type SourceFileText,
} from "../helpers/adr-numbering.js";

/**
 * Unit contract — `src/test/helpers/adr-numbering.ts` (review finding R-1, OP-96).
 *
 * **Why this exists.** ADR numbers used to be allocated by "take the lowest free
 * number at commit time", which no tool can enforce. On 2026-10-20 it burned a
 * day: four renumbers in a single day and a genuine collision on `0144` between
 * the OP-101 review sign-off (PR #224) and the OP-96 quiet-release lane, which
 * left PR #225 CONFLICTING. `ADR-0300`
 * (`docs/adr/ADR-0300-adr-number-range-allocation-policy.md`) replaces the rule
 * with per-lane reserved ranges; this spec pins the one *mechanical* half of
 * that policy, so the mistake is caught by CI instead of by a reviewer: no two
 * ADRs may share a number, and every ADR file name must be well-formed.
 *
 * **RED.** `src/test/helpers/adr-numbering.ts` does not exist yet, so this file
 * fails on import. That is the intended first state — the guard ships with the
 * implementation that satisfies these assertions.
 *
 * **Scope.** Four invariants:
 *   (i)  no two in-scope files share an `ADR-NNNN` number;
 *   (ii) every in-scope `ADR-*.md` file name matches
 *        `^ADR-(\d{4})-[a-z0-9]+(-[a-z0-9]+)*\.md$`;
 *   (iii) no two rows of the reserved-range ledger in `<dir>/README.md` reserve
 *        intersecting **closed** ranges (`lane-range-overlap`);
 *   (iv) every `ADR-NNNN` reference **inside a source file** resolves to a
 *        `docs/adr/ADR-NNNN-*.md` file (`dangling-reference`, finding F6-b).
 * Range bookkeeping was out of scope until F-L1: the guard now parses the
 * ledger's closed `` `NNNN`–`NNNN` `` rows (see `adr-lane-ranges.test.ts`).
 * Reference resolution was out of scope until F6-b: the guards pinned the ADR
 * *directory* and the ledger, never the references pointing into it, so five
 * shipped production comments kept citing `0764`/`0765` after the
 * OP-128 round-1 renumber moved those decisions to `0766`/`0767` — they
 * sent readers to a sibling lane's unrelated records and nothing failed. The
 * `checkSourceAdrReferences` / `checkRepositoryAdrReferences` contract is
 * documented in the block comment below.
 * What it still cannot see: a *file* whose number sits inside another lane's
 * reserved range — the guard has no file→lane map, so range membership stays a
 * review-time obligation (ADR-0302 §4). Reference *accuracy* (does the cited
 * ADR decide what the comment claims?) is likewise unreachable mechanically.
 *
 * **Contract pinned here** (RED and GREEN must not diverge):
 *
 * ```
 * parseAdrNumber(fileName: string): number | null
 * ```
 * The number of a *well-formed* ADR file name, leading zeros dropped
 * (`ADR-0146-a.md` -> `146`); `null` for everything else — a wrong-length number
 * (`ADR-96-x.md`, `ADR-12345-x.md`), a non-lowercase slug (`ADR-0146-X.md`), a
 * non-`.md` file, or a non-ADR name (`README.md`, `adr-0146-x.md` — the prefix
 * match is case-sensitive, so `adr-` is not an ADR reference).
 *
 * ```
 * checkAdrNumbers(fileNames: string[]): { ok: boolean; issues: AdrNumberIssue[] }
 * ```
 * In scope: a name matching `/^ADR-.*\.md$/` (case-sensitive). Everything else is
 * ignored silently (`README.md`, `adr-numbering-notes.md`, `adr-0146-x.md`).
 *   - well-formed in-scope names group by number: two or more sharing a number
 *     produce ONE `{ code: "duplicate", number: "0146", files: [...] }` issue;
 *   - each in-scope name that is *not* well-formed produces ONE
 *     `{ code: "malformed", number: null, files: [thatName] }` issue (malformed
 *     names never join a duplicate group);
 *   - `ok === (issues.length === 0)`.
 *
 * ```
 * checkAdrDirectory(dir: string): { ok: boolean; issues: AdrNumberIssue[] }
 * ```
 * `node:fs` sync read of exactly one directory — no recursion into
 * subdirectories — filtered to in-scope names, then the same rules.
 *
 * ```
 * type AdrNumberIssue = {
 *   code: "duplicate" | "malformed";
 *   number: string | null;
 *   files: string[];
 * }
 * ```
 *
 * **Determinism.** CI logs must be stable and `fs.readdir` order is not
 * guaranteed, so: `files` within an issue is sorted ascending, and `issues` is
 * sorted by numeric ADR number ascending with malformed issues (`number === null`)
 * last — the same input in any order yields the same report.
 *
 * **Edge cases pinned by characterization** (OP-96 follow-up to the R-1 review;
 * the helper is frozen contract, so these pin what it does today rather than
 * asking for a change):
 *   - the same file name passed twice is two group members, so the lone
 *     `duplicate` issue repeats the name (`["ADR-0146-a.md", "ADR-0146-a.md"]`);
 *   - `ADR-000x.md` and `ADR-999x.md`-shaped names are well-formed: `parseAdrNumber`
 *     yields `0` / `9999`, and both are accepted when unique;
 *   - `checkAdrDirectory` on a missing directory throws (the TSDoc `@throws`
 *     branch), propagating the `node:fs` error with `code === "ENOENT"`;
 *   - `readdirSync(dir, { withFileTypes: true })` + `entry.isFile()` is
 *     lstat-based, so a **symlinked** ADR file is silently skipped — the one way
 *     the guard can under-report. A symlink never contributes to a duplicate.
 */

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const realAdrDir = join(repoRoot, "docs/adr");

const tempDirs: string[] = [];

/**
 * The one `mkdirSync` + `writeFileSync` call site in this spec. Every fixture
 * write goes through it, so the security preset's non-literal-`fs` warnings
 * stay countable and no new one appears per fixture factory.
 */
function writeFixtureFile(filePath: string, text: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, text);
}

function makeTempAdrDir(fileNames: string[]): string {
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
function makeTempAdrDirWithReadme(fileNames: string[], readmeMarkdown: string): string {
  const dir = makeTempAdrDir(fileNames);
  writeFixtureFile(join(dir, "README.md"), readmeMarkdown);
  return dir;
}

/**
 * A throwaway repository root for the source-reference sweep: `files` maps a
 * repo-relative POSIX path to its text, and every parent directory is created.
 */
function makeTempRepoRoot(files: Record<string, string>): string {
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
function laneLedger(rows: string[]): string {
  return [
    "### Reserved ranges (effective 2026-10-20)",
    "",
    "| Holder (lane)                       | Reserved range | Next free |",
    "| ----------------------------------- | -------------- | --------- |",
    ...rows,
  ].join("\n");
}

/**
 * Compile-time pin of the widened issue union: `AdrNumberIssue["code"]` must
 * admit `"lane-range-overlap"`, so an implementation that appends an overlap
 * issue without widening the type fails `tsc`, not just a runtime assertion.
 */
const overlapCode: AdrNumberIssue["code"] = "lane-range-overlap";

describe("checkAdrNumbers — clean input", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts uniquely numbered ADR files and ignores a non-ADR README", () => {
    // Act
    const result = checkAdrNumbers(["ADR-0146-a.md", "ADR-0147-b.md", "README.md"]);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("ignores every name that is not an ADR reference", () => {
    // Act
    const result = checkAdrNumbers(["README.md", "adr-numbering-notes.md", "adr-0146-x.md"]);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("accepts the boundary numbers 0000 and 9999 when they are unique", () => {
    // Act — the strict four-digit pattern admits both extremes of the range.
    const result = checkAdrNumbers(["ADR-0000-x.md", "ADR-9999-y.md"]); // adr-fixture

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });
});

describe("checkAdrNumbers — duplicate numbers", () => {
  it("reports one duplicate issue listing both files, sorted, for a repeated number", () => {
    // Act — input deliberately out of order, to pin a deterministic report.
    const result = checkAdrNumbers(["ADR-0146-b.md", "ADR-0146-a.md"]);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "duplicate",
          number: "0146",
          files: ["ADR-0146-a.md", "ADR-0146-b.md"],
        },
      ],
    });
  });

  it("groups a three-way duplicate into a single issue", () => {
    // Act
    const result = checkAdrNumbers(["ADR-0300-c.md", "ADR-0300-a.md", "ADR-0300-b.md"]);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "duplicate",
          number: "0300",
          files: ["ADR-0300-a.md", "ADR-0300-b.md", "ADR-0300-c.md"],
        },
      ],
    });
  });

  it("reports one duplicate issue repeating the name when the same file is passed twice", () => {
    // Act — the same name twice is two group members, so the issue lists it twice.
    const result = checkAdrNumbers(["ADR-0146-a.md", "ADR-0146-a.md"]);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "duplicate",
          number: "0146",
          files: ["ADR-0146-a.md", "ADR-0146-a.md"],
        },
      ],
    });
  });

  it("reports one issue per duplicated number", () => {
    // Act
    const result = checkAdrNumbers([
      "ADR-0300-b.md",
      "ADR-0146-a.md",
      "ADR-0300-a.md",
      "ADR-0146-b.md",
    ]);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "duplicate",
          number: "0146",
          files: ["ADR-0146-a.md", "ADR-0146-b.md"],
        },
        {
          code: "duplicate",
          number: "0300",
          files: ["ADR-0300-a.md", "ADR-0300-b.md"],
        },
      ],
    });
  });
});

describe("checkAdrNumbers — malformed names", () => {
  it("reports one malformed issue per in-scope file name that breaks the naming pattern", () => {
    // Act
    const result = checkAdrNumbers(["ADR-96-x.md", "ADR-12345-x.md", "ADR-0146-X.md"]);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(3);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { code: "malformed", number: null, files: ["ADR-96-x.md"] },
        { code: "malformed", number: null, files: ["ADR-12345-x.md"] },
        { code: "malformed", number: null, files: ["ADR-0146-X.md"] },
      ])
    );
  });

  it("does not let a malformed name collide with a well-formed one carrying the same digits", () => {
    // Act
    const result = checkAdrNumbers(["ADR-0096-a.md", "ADR-96-b.md"]);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [{ code: "malformed", number: null, files: ["ADR-96-b.md"] }],
    });
  });
});

describe("checkAdrNumbers — deterministic ordering", () => {
  const mixed: string[] = [
    "ADR-0300-b.md",
    "ADR-96-x.md",
    "ADR-0146-a.md",
    "ADR-0146-b.md",
    "ADR-0300-a.md",
  ];

  it("sorts issues by ascending ADR number with malformed names last", () => {
    // Act
    const result = checkAdrNumbers(mixed);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "duplicate",
          number: "0146",
          files: ["ADR-0146-a.md", "ADR-0146-b.md"],
        },
        {
          code: "duplicate",
          number: "0300",
          files: ["ADR-0300-a.md", "ADR-0300-b.md"],
        },
        { code: "malformed", number: null, files: ["ADR-96-x.md"] },
      ],
    });
  });

  it("reports the same issues for the same files in any input order", () => {
    // Act
    const forward = checkAdrNumbers(mixed);
    const reversed = checkAdrNumbers([...mixed].reverse());

    // Assert
    expect(reversed).toEqual(forward);
  });
});

describe("parseAdrNumber", () => {
  it.each<[string, number]>([
    ["ADR-0146-a.md", 146],
    ["ADR-0300-adr-number-range-allocation-policy.md", 300],
  ])("parses %s as %s", (fileName, expected) => {
    // Act + Assert
    expect(parseAdrNumber(fileName)).toBe(expected);
  });

  it.each<string>([
    "README.md",
    "adr-numbering-notes.md",
    "adr-0146-x.md",
    "ADR-96-x.md",
    "ADR-12345-x.md",
    "ADR-0146-X.md",
    "ADR-0146-a.txt",
  ])("returns null for %s", (fileName) => {
    // Act + Assert
    expect(parseAdrNumber(fileName)).toBeNull();
  });

  it.each<[string, number]>([
    ["ADR-0000-x.md", 0], // adr-fixture
    ["ADR-9999-x.md", 9999], // adr-fixture
  ])("parses the boundary number %s as %s", (fileName, expected) => {
    // Act + Assert
    expect(parseAdrNumber(fileName)).toBe(expected);
  });
});

describe("checkAdrDirectory", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the repository's real docs/adr directory as duplicate-free and well-formed", () => {
    // Act
    const result = checkAdrDirectory(realAdrDir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("applies the numbering rules to a directory and ignores its non-ADR files", () => {
    // Arrange
    const dir = makeTempAdrDir(["ADR-0146-a.md", "ADR-0146-b.md", "README.md"]);

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "duplicate",
          number: "0146",
          files: ["ADR-0146-a.md", "ADR-0146-b.md"],
        },
      ],
    });
  });

  it("reads only the given directory and never recurses into subdirectories", () => {
    // Arrange
    const dir = makeTempAdrDir(["ADR-0146-a.md"]);
    writeFixtureFile(join(dir, "archive", "ADR-0146-a.md"), "");

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("throws when the directory cannot be read", () => {
    // Arrange
    const dir = makeTempAdrDir([]);
    const missing = join(dir, "does-not-exist");

    // Act + Assert — the TSDoc `@throws` branch, unpinned until now.
    expect(() => checkAdrDirectory(missing)).toThrow();
  });

  it("throws an ENOENT error when the directory does not exist", () => {
    // Arrange
    const dir = makeTempAdrDir([]);
    const missing = join(dir, "does-not-exist");

    // Act + Assert — `node:fs` propagates the raw error code to the caller.
    expect(() => checkAdrDirectory(missing)).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  it("silently skips a symlinked ADR file", () => {
    // Arrange — `readdirSync(dir, { withFileTypes: true })` + `entry.isFile()`
    // is lstat-based, so a symlink is neither a regular file nor a directory and
    // is dropped before `checkAdrNumbers` ever sees it. This skip is the one way
    // the guard can under-report, so it is pinned instead of left implicit.
    const targetDir = makeTempAdrDir(["ADR-0146-a.md"]);
    const dir = makeTempAdrDir([]);
    symlinkSync(join(targetDir, "ADR-0146-a.md"), join(dir, "ADR-0146-a.md"));

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("does not count a symlinked ADR file toward a duplicate number", () => {
    // Arrange — number 0146 appears on a real file and on a differently-named
    // symlink; because the symlink is skipped, 0146 stays unique and no
    // duplicate is reported.
    const targetDir = makeTempAdrDir(["ADR-0146-b.md"]);
    const dir = makeTempAdrDir(["ADR-0146-a.md"]);
    symlinkSync(join(targetDir, "ADR-0146-b.md"), join(dir, "ADR-0146-b.md"));

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });
});

describe("checkAdrDirectory — lane-range overlaps (ledger finding F-L1)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports one overlap issue for the live OP-126 / OP-129 intersection", () => {
    // Arrange — the measured in-flight state: the uploads lane reserved
    // 0760-0779 and the attendee-identity lane reserved 0769-0788, which is how
    // 0770 came to exist twice. README order is deliberately reversed, so
    // the issue's holder order pins the ascending sort.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-op126-uploads-green.md"], // adr-fixture
      laneLedger([
        "| OP-129 attendee identity lane | `0769`–`0788` | `0770` |",
        "| OP-126 uploads lane           | `0760`–`0779` | `0771` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: overlapCode,
          number: null,
          files: ["OP-126 uploads lane", "OP-129 attendee identity lane"],
        },
      ],
    });
  });

  it("reports no overlap for ranges that touch without intersecting", () => {
    // Arrange — 0760-0779 and 0780-0798 are adjacent, so they are disjoint
    // (this is the boundary the F-L1 repair relies on).
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger([
        "| OP-126 uploads lane           | `0760`–`0779` | `0771` |",
        "| OP-129 attendee identity lane | `0780`–`0798` | `0782` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("reports no overlap for a single reserved range", () => {
    // Arrange
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger(["| OP-126 uploads lane | `0760`–`0779` | `0771` |"])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("reports no overlap when the README table has no parseable row", () => {
    // Arrange — header and `---` separator only.
    const dir = makeTempAdrDirWithReadme(["ADR-0760-a.md"], laneLedger([])); // adr-fixture

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("reports no overlap when the README only mentions ranges in prose", () => {
    // Arrange — an empty README and a prose-only one both carry no reservation.
    const emptyDir = makeTempAdrDirWithReadme(["ADR-0760-a.md"], ""); // adr-fixture
    const proseDir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      "The OP-129 lane holds `0769`-`0788`; the uploads lane holds `0760`-`0779`."
    );

    // Act
    const emptyResult = checkAdrDirectory(emptyDir);
    const proseResult = checkAdrDirectory(proseDir);

    // Assert
    expect(emptyResult).toEqual({ ok: true, issues: [] });
    expect(proseResult).toEqual({ ok: true, issues: [] });
  });

  it("reports no overlap for a directory that has no README at all", () => {
    // Arrange — a bare ADR directory must not throw on the missing ledger.
    const dir = makeTempAdrDir(["ADR-0760-a.md"]); // adr-fixture

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("reports one issue per intersecting pair when three reserved ranges overlap", () => {
    // Arrange — every pair of these three intersects, so the report carries
    // three issues, not one per row.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger([
        "| OP-201 alpha lane | `0760`–`0779` | `0761` |",
        "| OP-202 beta lane  | `0769`–`0788` | `0770` |",
        "| OP-203 gamma lane | `0775`–`0795` | `0776` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(3);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        {
          code: overlapCode,
          number: null,
          files: ["OP-201 alpha lane", "OP-202 beta lane"],
        },
        {
          code: overlapCode,
          number: null,
          files: ["OP-201 alpha lane", "OP-203 gamma lane"],
        },
        {
          code: overlapCode,
          number: null,
          files: ["OP-202 beta lane", "OP-203 gamma lane"],
        },
      ])
    );
  });

  it("reports a duplicate number and a lane-range overlap from the same directory", () => {
    // Arrange — the two invariants are independent: a directory can break both,
    // and the range check must not swallow the numbering report (or vice versa).
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0146-a.md", "ADR-0146-b.md"],
      laneLedger([
        "| OP-126 uploads lane           | `0760`–`0779` | `0771` |",
        "| OP-129 attendee identity lane | `0769`–`0788` | `0770` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        {
          code: "duplicate",
          number: "0146",
          files: ["ADR-0146-a.md", "ADR-0146-b.md"],
        },
        {
          code: overlapCode,
          number: null,
          files: ["OP-126 uploads lane", "OP-129 attendee identity lane"],
        },
      ])
    );
  });
});

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
 * that hole, in the same helper (`src/test/helpers/adr-numbering.ts`) as the
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
