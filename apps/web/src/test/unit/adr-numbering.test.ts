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
 * A *range-shaped* row that does not parse was skipped silently until F1: a row
 * whose second cell holds two backticked numbers with one non-alphanumeric
 * separator between them — inverted, em dash, minus sign, tilde, three digits —
 * is now reported as `lane-range-malformed` with `number: null` and that row's
 * holder, because that is the same silent direction that let the F-L1 collision
 * through. Rows that are not range-shaped (header, `---` separator, the
 * open-ended pool cell, a single backticked number, prose, the ADR index) stay
 * silent, and so does an indented row: the row shape requires a leading `|`.
 * Reference resolution was out of scope until F6-b: the guards pinned the ADR
 * *directory* and the ledger, never the references pointing into it, so five
 * shipped production comments kept citing `ADR-0764`/`ADR-0765` [adr-fixture] after the
 * OP-128 round-1 renumber moved those decisions to `ADR-0766`/`ADR-0767` [adr-fixture] — they
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
 *   - `ADR-0000-x.md` and `ADR-9999-x.md` [adr-fixture] are well-formed: `parseAdrNumber`
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

/**
 * Compile-time pin of the F1 follow-up's union widening: a ledger row that
 * obviously intends a reservation but does not parse is reported as
 * `lane-range-malformed`, so `AdrNumberIssue["code"]` must admit it. An
 * implementation that appends the issue without widening the union fails `tsc`
 * (`TS2322` on this line), not only a runtime assertion.
 */
const malformedCode: AdrNumberIssue["code"] = "lane-range-malformed";

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
    // ADR-0770 [adr-fixture] came to exist twice. README order is deliberately reversed, so
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

describe("checkAdrDirectory — range-shaped rows that do not parse (review finding F1)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an inverted range as one lane-range-malformed issue naming its holder", () => {
    // Arrange — `0780`-`0760` obviously intends a reservation, but it is
    // inverted, so today it parses as { start: 780, end: 760 } and the span the
    // lane meant is invisible: the ledger is reported clean. A row that does not
    // parse must be named, not dropped, or a typo silently disables the guard.
    // One issue per row, carrying that row's holder once — not the two holders
    // an overlap issue carries.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger([
        "| OP-201 alpha lane | `0780`-`0760` | `0781` |",
        "| OP-202 beta lane  | `0760`–`0779` | `0761` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [{ code: malformedCode, number: null, files: ["OP-201 alpha lane"] }],
    });
  });

  it("still parses the valid rows of a ledger that carries one malformed row", () => {
    // Arrange — a malformed row must not poison the rows around it: the two
    // valid rows still overlap, so the report carries both the malformed row and
    // the intersection the guard exists to catch.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger([
        "| OP-201 alpha lane | `0780`-`0760` | `0781` |",
        "| OP-202 beta lane  | `0760`–`0779` | `0761` |",
        "| OP-203 gamma lane | `0770`–`0785` | `0776` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert — both issues carry `number: null`, so the shared
    // (number, code, files[0]) ordering key puts `lane-range-malformed` first.
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: malformedCode, number: null, files: ["OP-201 alpha lane"] },
        { code: overlapCode, number: null, files: ["OP-202 beta lane", "OP-203 gamma lane"] },
      ],
    });
  });

  it.each<[string, string]>([
    ["the em dash (U+2014)", "\u2014"],
    ["the minus sign (U+2212)", "\u2212"],
    ["a tilde", "~"],
  ])("reports a row whose range separator is %s", (_label, separator) => {
    // Arrange — "two backticked numbers with one non-alphanumeric separator
    // between them" is what makes a row range-shaped, whatever the separator
    // is. Only `–` (U+2013) and `-` are accepted, so every other separator is a
    // reservation the parser cannot see.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger([`| OP-201 alpha lane | \`0760\`${separator}\`0779\` | \`0761\` |`])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [{ code: malformedCode, number: null, files: ["OP-201 alpha lane"] }],
    });
  });

  it("reports a three-digit pair as lane-range-malformed", () => {
    // Arrange — the ledger's numbers are zero-padded to four digits, so
    // `760`-`779` is a typo that reserves nothing today.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger([
        "| OP-201 alpha lane | `760`-`779` | `761` |",
        "| OP-202 beta lane  | `0780`-`0799` | `0781` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert — the valid row is untouched, so exactly one issue is reported.
    expect(result).toEqual({
      ok: false,
      issues: [{ code: malformedCode, number: null, files: ["OP-201 alpha lane"] }],
    });
  });

  it("reports one issue per offending row, ordered by holder", () => {
    // Arrange — README order is deliberately reversed: the two rows tie on
    // (number, code), so the report must order them by `files[0]`.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger([
        "| OP-203 gamma lane | `0780`-`0760` | `0781` |",
        "| OP-201 alpha lane | `760`-`779` | `761` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: malformedCode, number: null, files: ["OP-201 alpha lane"] },
        { code: malformedCode, number: null, files: ["OP-203 gamma lane"] },
      ],
    });
  });

  it("reports no malformed row for a ledger whose rows all use the accepted form", () => {
    // Arrange — no false positives: en dash, plain hyphen and a spaced en dash
    // are all accepted, and none of them is reported.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger([
        "| OP-201 alpha lane | `0760`–`0779` | `0761` |",
        "| OP-202 beta lane  | `0780`-`0799` | `0781` |",
        "| OP-203 gamma lane | `0800` – `0819` | `0801` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("reports no malformed row for the repository's real ledger", () => {
    // Act — the zero-false-positive proof on the board's most-edited table: any
    // row of `docs/adr/README.md` misread as range-shaped would show up here.
    const result = checkAdrDirectory(realAdrDir);

    // Assert (the same report is pinned by the plain `checkAdrDirectory` block
    // above; this case names the malformed-row code so a false positive is
    // diagnosable from the failing case alone).
    expect(result.issues.filter((issue) => issue.code === malformedCode)).toEqual([]);
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("reports a duplicate number and a malformed range from the same directory", () => {
    // Arrange — the two invariants are independent: neither may swallow the
    // other. `duplicate` sorts first (it carries a number; both null-number
    // issues come last).
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0146-a.md", "ADR-0146-b.md"],
      laneLedger(["| OP-201 alpha lane | `0780`-`0760` | `0781` |"])
    );

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
        { code: malformedCode, number: null, files: ["OP-201 alpha lane"] },
      ],
    });
  });

  it("reports nothing for rows that are not range-shaped", () => {
    // Arrange — the non-vacuity control for the whole rule: the header row, the
    // `---` separator row, the open-ended pool cell, a cell holding a single
    // backticked number, a prose mention and the ADR index rows all stay silent.
    // Only two backticked numbers with a non-alphanumeric separator between them
    // make a row range-shaped.
    const markdown = [
      laneLedger([
        "| unallocated (future lanes) | `0700`+ (20 per lane, in order) | `0700` |",
        "| OP-201 alpha lane          | `0780`                          | `0781` |",
      ]),
      "",
      "The OP-129 lane holds `0769`-`0788`; the uploads lane holds `0760`-`0779`.",
      "",
      "| ADR                                                                    | Title                    | Status   |",
      "| ---------------------------------------------------------------------- | ------------------------ | -------- |",
      "| [0001](ADR-0001-ports-and-adapters.md)                                 | Ports and adapters       | Accepted |",
    ].join("\n");
    const dir = makeTempAdrDirWithReadme(["ADR-0760-a.md"], markdown); // adr-fixture

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("keeps an ADR index row whose title quotes two numbers with a slash silent", () => {
    // Arrange — measured on the real ledger: the ADR-0341 index row's title cell
    // reads "the `402`/`403` denial split". Read purely literally ("two
    // backticked number tokens with a non-alphanumeric separator between them")
    // that row is range-shaped, so reporting it would make the real ledger fail
    // the clean-report pin above. A slash is not range notation, and an index
    // row is not a reservation: it must stay silent.
    const markdown = [
      "| ADR                                          | Title                                                                  | Status   |",
      "| -------------------------------------------- | ---------------------------------------------------------------------- | -------- |",
      "| [0341](ADR-0341-op103-entitlements-green.md) | OP-103 GREEN: the `402`/`403` denial split and the registry extensions | Accepted |", // adr-fixture
    ].join("\n");
    const dir = makeTempAdrDirWithReadme(["ADR-0760-a.md"], markdown); // adr-fixture

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });
});

/**
 * Unit contract — invariant (iv): an in-source `ADR-NNNN` reference must resolve
 * to a `docs/adr/ADR-NNNN-*.md` file (finding F6-b, OP-128 follow-up).
 *
 * **Why this exists.** The OP-128 round-1 renumber moved two lane records from
 * `ADR-0764`/`ADR-0765` to `ADR-0766`/`ADR-0767` [adr-fixture] (fix PR #461), but five shipped
 * production comments and three spec headers kept citing the old numbers. Those
 * numbers are *not free*: `ADR-0764` and `ADR-0765` [adr-fixture] belong to sibling lanes, so
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
 * **Fixture marker.** A line whose text contains `adr-fixture` is exempt: the
 * guard's own specs are full of synthetic numbers that must never resolve
 * (`ADR-0000`/`ADR-9999` [adr-fixture] shape fixtures, `ADR-0764` [adr-fixture] lookalikes, lane numbers that
 * only exist on an unmerged branch). The exemption is per **line text**, never a
 * line number and never a number range, so it travels with the fixture when it
 * moves and a new dangling reference on an unmarked line still fails. Exempt
 * references are counted in `exemptReferences`, not in `checkedReferences`.
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
