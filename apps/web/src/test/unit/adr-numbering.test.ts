import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkAdrDirectory,
  checkAdrNumbers,
  checkAdrRecordLinks,
  checkRepositoryAdrConsumers,
  checkRepositoryAdrLinks,
  checkRepositoryAdrReferences,
  checkSourceAdrConsumers,
  checkSourceAdrReferences,
  parseAdrNumber,
  type AdrNumberIssue,
  type AdrRecordLinkFileText,
  type AdrRecordLinkIssue,
  type AdrRecordText,
  type SourceAdrConsumerIssue,
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
 *        `docs/adr/ADR-NNNN-*.md` file (`dangling-reference`, finding F6-b);
 *   (v)  every reference that resolves to a record declaring a `Consumers:`
 *        field is made by a file that record names (`consumer-mismatch`,
 *        finding F-N1);
 *   (vi) every **markdown link target** inside a `docs/adr/ADR-*.md` record
 *        names a file that exists (`dangling-reference`, finding F3) — the
 *        records' own navigation, which (iv) never read.
 *
 * F-N1's own accuracy gaps are pinned with it: a citation is verified by a bare
 * file name only when that name is unique across the swept population (finding
 * F1, 85 `route.ts` files), and a `Consumers`-shaped line that is not the
 * canonical field is a `consumers-malformed` failure instead of a silent
 * non-declaration (finding F2, the adoption programme writes the field by hand).
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
 * shipped production comments kept citing `0764`/`0765` after the
 * OP-128 round-1 renumber moved those decisions to `0766`/`0767` — they
 * sent readers to a sibling lane's unrelated records and nothing failed. The
 * `checkSourceAdrReferences` / `checkRepositoryAdrReferences` contract is
 * documented in the block comment below.
 * What it still cannot see: a *file* whose number sits inside another lane's
 * reserved range — the guard has no file→lane map, so range membership stays a
 * review-time obligation (ADR-0302 §4).
 * Reference *accuracy* — does the cited record decide what the comment claims? —
 * was unreachable mechanically until F-N1 (the land review of PR #465). Nine
 * OP-129 spec headers cited the never-minted `0768`, and once a record with that
 * number was minted for the OP-128 lane those nine became "valid" references to
 * a record about a different feature: the guard proved *existence*, never
 * *accuracy*. Invariant (v) closes the half of that gap that is decidable from
 * the tree: a record that declares a `Consumers:` field makes a claim about who
 * consumes it, and a citing file the record never names is a
 * `consumer-mismatch`. A citation of a record that declares no `Consumers:`
 * field is `unlisted-consumer` — reported and counted, not failed; the contract
 * block for the two functions (near the end of this file) states the exact
 * matching rule and why the unlisted half is not a hard failure yet.
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

  it("reports only the malformed row when the inverted span would intersect a real lane", () => {
    // Arrange — the discriminating fixture for the rule "a malformed row never
    // feeds the overlap predicate": the inverted row is paired with a lane that
    // its *inverted* span would intersect. `0780`-`0760` read as
    // { start: 780, end: 760 } against 0760-0799 answers
    // `780 <= 799 && 760 <= 760` — an overlap no lane reserved. The `0799` end is
    // load-bearing: against 0760-0779 the predicate answers false for both rows,
    // so the case would stay green under an implementation that feeds malformed
    // rows to the predicate. Expected: the malformed row alone, no overlap.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger([
        "| OP-201 alpha lane | `0780`-`0760` | `0781` |",
        "| OP-204 delta lane | `0760`-`0799` | `0781` |",
      ])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert — exactly one issue, carrying the malformed row's holder once; a
    // `lane-range-overlap` here would be a phantom the ledger never reserved.
    expect(result).toEqual({
      ok: false,
      issues: [{ code: malformedCode, number: null, files: ["OP-201 alpha lane"] }],
    });
  });

  it("stays silent for an indented row: the row shape requires a leading pipe", () => {
    // Arrange — a row pushed in by two spaces is not a pipe-table row, so it is
    // neither a reservation nor a malformed one: Markdown does not read it as a
    // table row either. Silence is the contract, and a false positive here would
    // make every indented snippet in the ledger's notes fail the guard.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"], // adr-fixture
      laneLedger(["  | OP-201 alpha lane | `0780`-`0760` | `0781` |"])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
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

/* ------------------------------------------------------------------------- *
 * Invariant (v) — citation accuracy (finding F-N1)
 * ------------------------------------------------------------------------- */

/**
 * Unit contract — invariant (v): a citation must be *accurate*, not merely
 * resolvable (finding F-N1, the land review of PR #465, card `t_03a786bd`).
 *
 * **Why this exists.** Invariant (iv) proves that the record a comment cites
 * *exists*. That is half the question. On the OP-129 tree nine spec headers
 * cited the never-minted `0768`; then a record with that number was minted for
 * the OP-128 lane, and overnight all nine became "valid" references to a record
 * about a different feature — the media signer's account-status gate. The
 * existence guard's real-tree case would go green on that tree, and that is how
 * the defect it was written for survives a renumber. This block pins the half of
 * "is this citation right?" that is decidable from the tree: **a record that
 * declares a `Consumers:` field states who consumes it, and a citing file the
 * record never names is a `consumer-mismatch`.**
 *
 * **Contract pinned here** (RED and GREEN must not diverge):
 *
 * ```
 * interface AdrRecordText { fileName: string; text: string }
 * type SourceAdrConsumerIssue = {
 *   code: "consumer-mismatch" | "unlisted-consumer" | "consumers-malformed";
 *   file: string;   // repo-relative POSIX path of the citing file; for
 *                   // consumers-malformed, the record's file name
 *   line: number;   // 1-based line of the reference; for consumers-malformed,
 *                   // the offending line inside the record
 *   number: string; // the four digits as written, leading zeros kept ("0768")
 *   record: string; // the cited record's file name, e.g. "ADR-0768-….md" (adr-fixture: shape only)
 * }
 * checkSourceAdrConsumers(
 *   sources: readonly SourceFileText[],
 *   records: readonly AdrRecordText[],
 * ): { ok: boolean; issues: SourceAdrConsumerIssue[]; unlisted: SourceAdrConsumerIssue[];
 *      checkedReferences: number; exemptReferences: number; danglingReferences: number;
 *      verifiedReferences: number; declaredRecords: string[] }
 * checkRepositoryAdrConsumers(root: string): typeof checkSourceAdrConsumers
 * ```
 *
 * **Participation is declared, never inferred.** A record participates when its
 * text carries a canonical `Consumers:` field — `- **Consumers:**` at column 0,
 * anywhere in the record, header or body — **or** a `Consumers`-shaped line that
 * is not canonical. A `Consumes:` field is *not* a consumer declaration (records
 * use it for what the decision consumes, e.g. an upstream record); neither is
 * prose that happens to contain the word. A record with no `Consumers:` field
 * yields `unlisted-consumer` for each of its citations — reported and counted,
 * not failed (see the decision below).
 *
 * **A non-canonical shape fails the report, and still declares (finding F2).**
 * Only the canonical field used to declare; every other plausible shape —
 * indented, colon outside the bold, no list dash, a `## Consumers` heading, a
 * plain unbolded field — fell into `unlisted-consumer` with `ok: true`, so one
 * punctuation slip in a hand-written record silently switched enforcement off
 * for it and nothing said so. Pinned here: such a line is reported as
 * `consumers-malformed` **in `issues`**, which makes `ok` `false` — it *fails*,
 * it is not merely counted — with `file` and `record` set to the record's file
 * name, `line` to the offending line inside that record (1-based) and `number`
 * to the record's own four digits. The record still declares, so its citations
 * stay hard-checked: a slip must not disable enforcement as a side effect of
 * being reported. Reporting is per record, not per citation: a malformed field
 * in a record nobody cites is still a failure (that is the shape the 175-record
 * adoption programme will produce). A malformed entry joins the same `issues`
 * array and the same `file`/`line`/`number` ordering as a citation issue, so the
 * citation census identity below holds for a malformed-free record set.
 *
 * **The identification rule** — what makes a citation *verified*. A declaring
 * record identifies a citing file when its **whole text** carries one of:
 *   1. the file's repo-relative path (`apps/…`, `packages/…`) as a path token;
 *   2. the file's **bare name** (`attendee-sessions.test.ts`), but only when that
 *      bare name is **unique across the swept population** — the `sources`
 *      argument here, the whole swept tree in `checkRepositoryAdrConsumers`.
 *      A shared bare name identifies nothing: this head holds 85 `route.ts`
 *      files, so a record naming one of them by path used to verify all 85, and
 *      an unrelated route handler citing ADR-0786 (adr-fixture) left the spec green
 *      (finding F1, the reviewer's probe at `1384ac3`);
 *   3. a `@/…` module specifier that resolves to it — `apps/web/src/` + the
 *      specifier for a module, `apps/web/src/app/` + the specifier for an App
 *      Router route (`@/api/v1/p/attendee-sessions` names the route), optionally
 *      followed by a swept source extension, or a directory containing the file;
 *      a trailing `[...]` annotation group is stripped first
 *      (`@/api/v1/p/attendee-sessions[/current]` names both routes);
 *   4. **in backticks, an identifier the citing file exports** — `export
 *      const|let|var|function|class|interface|type|enum <Name>` or an
 *      `export { <Name> }` alias — with `Name` at least **6** characters.
 *
 * Reading the whole record, not only its `Consumers:` block, is deliberate and
 * measured at this head: 11 of the 32 citations of declaring records are named
 * only in the record's prose (§Decision names the implementation file, the
 * field names the pinning spec), so a block-only reading would fail 11
 * legitimate citations on the pristine tree. The backticked-export channel is
 * what covers the last one — a `packages/contracts` source whose exported
 * `AUTH_ERROR_CODES` the record discusses without naming the file. The 6-char
 * floor keeps short generic names (`GET`, `rate`) from verifying arbitrary
 * files. Leniency is intentional in one direction only: a citation the record
 * *does* talk about must never be reported, because a false failure would be
 * silenced by the next worker with a wider exemption.
 *
 * **Decisions recorded here (measured at this head, not asserted as literals):**
 *   - 4 records declare `Consumers:` (the OP-129 lane), 32 of the 1238 checked
 *     references target them, and all 32 are verified — so the hard rule is
 *     green on the pristine tree, exactly as the card requires. The floor in the
 *     real-tree case is `>= 4`: an accepted ADR is never un-declared, so the
 *     declaring population may only grow, and the floor catches a declaration
 *     being quietly dropped.
 *   - `unlisted-consumer` is counted, not failed. 1206 of the 1238 checked
 *     references at this head cite a record written before the `Consumers:`
 *     convention existed (175 distinct records). Failing them would make the
 *     guard permanently red and demand a 175-record docs programme that this
 *     card's scope lock (test files only, no `docs/adr/` byte) forbids. The code
 *     exists so the debt is visible and a follow-up can drive adoption;
 *     enforcement is **per record**, not per file or directory — the moment a
 *     record adds a `Consumers:` field, every citation of it is hard-checked,
 *     and nothing is exempt.
 *   - A reference whose record does not exist is counted in
 *     `danglingReferences` and not evaluated: invariant (iv) owns it, and the
 *     two counters are reconciled against `checkRepositoryAdrReferences` below.
 *   - A duplicate ADR number does not make this guard throw or go vacuous: a
 *     citation is declared when *any* record with that number declares, and
 *     verified when any of them identifies the citing file. Duplicate reporting
 *     stays `checkAdrNumbers`' job.
 *   - The bare-name channel is gated on population uniqueness (finding F1).
 *     Measured at `1384ac3`: of the 32 verified citations, 20 are named by path,
 *     8 by `@/` specifier and 2 by an exported symbol — **0** by bare name. The
 *     gate therefore costs nothing on the real tree, whose accuracy case also
 *     asserts `issues` empty, so it stays green.
 *   - A non-canonical `Consumers` shape fails the report (finding F2). Measured
 *     over the 289 records at `1384ac3`: 6 canonical field lines, **0**
 *     non-canonical ones and 9 prose mentions that are not field shapes, so the
 *     real-tree case stays green and the rule costs nothing until a hand-written
 *     slip appears.
 *
 * **Marker and population parity.** The accuracy sweep reads exactly the
 * reference population invariant (iv) reads, with the same per-line
 * `adr-fixture` exemption and the same `apps/web/src/test/**` path scope: an
 * exempt reference is counted in `exemptReferences` and never classified, and
 * a marked line in shipped source is still checked (finding F-M1).
 *
 * **Ordering.** `issues` and `unlisted` are sorted by `file`, then `line`, then
 * `number`, so the same sources in any order produce the same report.
 */

/**
 * The record names the fixtures point at. Synthetic on this tree: 0768 and 0786
 * are real records elsewhere, which is the point — the defect this pins is a
 * citation of an existing record that has nothing to do with the citing file.
 */ // adr-fixture: the record names below are fixture targets, not references
const fixtureRecord0768 = "ADR-0768-op128-account-status-gate-pins.md"; // adr-fixture: fixture record name
const fixtureRecord0786 = "ADR-0786-op129-attendee-session-rate-limit-green.md"; // adr-fixture: fixture record name
const fixtureRecord0781 = "ADR-0781-op129-anonymous-attendee-sessions-green.md"; // adr-fixture: fixture record name
const fixtureRecord0780 = "ADR-0780-op129-anonymous-attendee-sessions-red.md"; // adr-fixture: fixture record name
const fixtureRecord0025 = "ADR-0025-auth-guard-table.md"; // adr-fixture: fixture record name

/**
 * Compile-time pins of the accuracy union: an implementation that reports either
 * case without widening `SourceAdrConsumerIssue["code"]` fails `tsc`, not only a
 * runtime assertion.
 */
const consumerMismatchCode: SourceAdrConsumerIssue["code"] = "consumer-mismatch";
const unlistedConsumerCode: SourceAdrConsumerIssue["code"] = "unlisted-consumer";

/**
 * The third code of that union (finding F2), pinned at runtime only and typed
 * `string` on purpose: this RED branch must keep `tsc` at exit 0, and naming a
 * union member that does not exist yet would fail the typecheck before the GREEN
 * widens `SourceAdrConsumerIssue["code"]`. Widening the union to carry this value
 * is what lets the implementation type the issue it must report.
 */
const consumersMalformedCode = "consumers-malformed";

/** A record no file of this tree carries: the F2 shape fixtures point at it. */
const fixtureRecord0901 = "ADR-0901-consumers-shape-fixture.md"; // adr-fixture: fixture record name

/**
 * The shape-matrix fixtures (review finding F-A): a record no file of this tree
 * carries, plus two records that deliberately share `0903` for the
 * duplicate-number case — duplicate reporting stays `checkAdrNumbers`' job.
 */
const fixtureRecord0902 = "ADR-0902-consumers-shape-matrix.md"; // adr-fixture: fixture record name
const fixtureRecord0903Alpha = "ADR-0903-consumers-dup-alpha.md"; // adr-fixture: fixture record name
const fixtureRecord0903Beta = "ADR-0903-consumers-dup-beta.md"; // adr-fixture: fixture record name

/** One `docs/adr` record as the accuracy sweep reads it: bare name + whole text. */
function adrRecord(fileName: string, text: string): AdrRecordText {
  return { fileName, text };
}

describe("checkSourceAdrConsumers — a declared consumer is verified", () => {
  it("accepts a citation of a record that names the citing file by repo-relative path", () => {
    // Arrange
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0786,
        [
          "- **Status:** Accepted",
          "- **Consumers:** `apps/web/src/server/rate-limit/classes.test.ts`",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/rate-limit/classes.test.ts",
        text: "// the class table this spec pins ADR-0786", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result).toEqual({
      ok: true,
      issues: [],
      unlisted: [],
      checkedReferences: 1,
      exemptReferences: 0,
      danglingReferences: 0,
      verifiedReferences: 1,
      declaredRecords: ["0786"],
    });
  });

  it("accepts a citation of a record that names the citing file by module specifier", () => {
    // Arrange — `[...]` is an annotation group, not part of the path: the
    // specifier names the collection route and its `current` child.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0781,
        [
          "- **Status:** Accepted",
          "- **Consumers:** `@/api/v1/p/attendee-sessions[/current]`",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/app/api/v1/p/attendee-sessions/current/route.ts",
        text: "// D2 answers this handler ADR-0781", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues).toEqual([]);
    expect(result.verifiedReferences).toBe(1);
    expect(result.checkedReferences).toBe(1);
  });

  it("accepts a citation of a record that names only the citing file's bare name", () => {
    // Arrange
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0780,
        [
          "- **Consumers:** the OP-129 RED specs, starting with",
          "  `attendee-sessions.test.ts` (I1–I5)",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/test/integration/attendee-sessions.test.ts",
        text: "// the I1-I5 pins live here ADR-0780", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues).toEqual([]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("accepts a citation of a record that names an identifier the citing file exports", () => {
    // Arrange — the record names the stage helper's API without naming the file.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0786,
        [
          "- **Status:** Accepted",
          "- **Consumers:** the rate-limit stage helper",
          "",
          "The gate runs inside `evaluateRateLimit` before the route handler.",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/rate-limit/stage.ts",
        text: "export function evaluateRateLimit() {\n  // stage gate ADR-0786\n}", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues).toEqual([]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("accepts a citation when the record names the citing file's directory", () => {
    // Arrange
    const records: AdrRecordText[] = [
      adrRecord(fixtureRecord0786, "- **Consumers:** `apps/web/src/server/rate-limit`"),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/rate-limit/stage.ts",
        text: "// stage gate ADR-0786", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues).toEqual([]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("verifies a citation when any record carrying that number names the citing file", () => {
    // Arrange — a duplicate number is `checkAdrNumbers`' issue; this guard must
    // not throw on it, and must not ignore the record that does name the file.
    const records: AdrRecordText[] = [
      adrRecord("ADR-0786-duplicate-a.md", ["# a record that declares nothing"].join("\n")), // adr-fixture: duplicate-number fixture
      adrRecord(
        fixtureRecord0786,
        ["- **Consumers:** `apps/web/src/server/rate-limit/classes.test.ts`"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/rate-limit/classes.test.ts",
        text: "// the class table ADR-0786", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues).toEqual([]);
    expect(result.verifiedReferences).toBe(1);
    expect(result.declaredRecords).toEqual(["0786"]);
  });

  it("finds a Consumers: field declared in the record body, not only in its header", () => {
    // Arrange — records add a §Post-review section with its own consumers.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0781,
        [
          "- **Status:** Accepted",
          "- **Lane:** OP-129",
          "",
          "## Post-review status",
          "",
          "- **Consumers:** `apps/web/src/server/db/indexes.ts`",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/db/indexes.ts",
        text: "// the slug index entry ADR-0781", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues).toEqual([]);
    expect(result.verifiedReferences).toBe(1);
    expect(result.declaredRecords).toEqual(["0781"]);
  });
});

describe("checkSourceAdrConsumers — a citation the record does not claim", () => {
  it("reports a citation of a record that declares a different consumer and says nothing about this file", () => {
    // Arrange — the F-N1 shape precisely: the target record EXISTS (invariant
    // (iv) is green) but it is another lane's decision.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0768,
        [
          "- **Status:** Accepted",
          "- **Consumers:** `apps/web/src/test/integration/media-signed-urls.test.ts`",
          "",
          "## Decision",
          "",
          "The gate runs on the media signer's principal resolution.",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/test/integration/attendee-sessions.test.ts",
        text: "// I3 pins the cookie contract ADR-0768", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: consumerMismatchCode,
          file: "apps/web/src/test/integration/attendee-sessions.test.ts",
          line: 1,
          number: "0768",
          record: fixtureRecord0768,
        },
      ],
      unlisted: [],
      checkedReferences: 1,
      exemptReferences: 0,
      danglingReferences: 0,
      verifiedReferences: 0,
      declaredRecords: ["0768"],
    });
  });

  it("does not accept a record that names only an exported identifier shorter than six characters", () => {
    // Arrange — the noise floor: a short generic export must not verify a file.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0786,
        ["- **Consumers:** the stage helper", "", "The `rate` value is capped per class."].join(
          "\n"
        )
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/rate-limit/rate.ts",
        text: "export const rate = 1;\n// cap ADR-0786\n", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: "apps/web/src/server/rate-limit/rate.ts",
        line: 2,
        number: "0786",
        record: fixtureRecord0786,
      },
    ]);
  });

  it("reports one issue per occurrence and orders the report by file, then line", () => {
    // Arrange — input order is b, a; the report must be a, b.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0786,
        ["- **Consumers:** `apps/web/src/server/rate-limit/classes.test.ts`"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/b.ts",
        text: ["// first ADR-0786", "// second ADR-0786"].join("\n"), // adr-fixture: fixture citation targets
      },
      {
        path: "apps/web/src/server/a.ts",
        text: "// once ADR-0786", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues.map((issue) => [issue.file, issue.line])).toEqual([
      ["apps/web/src/server/a.ts", 1],
      ["apps/web/src/server/b.ts", 1],
      ["apps/web/src/server/b.ts", 2],
    ]);
    expect(result.checkedReferences).toBe(3);
    expect(result.verifiedReferences).toBe(0);
  });
});

describe("checkSourceAdrConsumers — records that declare nothing", () => {
  it("reports unlisted-consumer, and does not fail, when the cited record declares no consumers", () => {
    // Arrange
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0025,
        ["# The auth guard table", "", "## Decision", "", "One label table."].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/auth/guards.ts",
        text: "// the label table ADR-0025", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — reported in its own channel, counted, and never a failure.
    expect(result).toEqual({
      ok: true,
      issues: [],
      unlisted: [
        {
          code: unlistedConsumerCode,
          file: "apps/web/src/server/auth/guards.ts",
          line: 1,
          number: "0025",
          record: fixtureRecord0025,
        },
      ],
      checkedReferences: 1,
      exemptReferences: 0,
      danglingReferences: 0,
      verifiedReferences: 0,
      declaredRecords: [],
    });
  });

  it("does not treat a Consumes: field as a consumer declaration", () => {
    // Arrange — `Consumes:` is what the decision consumes, not who consumes it.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0768,
        ["- **Status:** Accepted", "- **Consumes:** ADR-0025 (the auth guard table)"].join("\n") // adr-fixture: fixture citation target
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/auth/guards.ts",
        text: "// the account-status gate ADR-0768", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.unlisted).toEqual([
      {
        code: unlistedConsumerCode,
        file: "apps/web/src/server/auth/guards.ts",
        line: 1,
        number: "0768",
        record: fixtureRecord0768,
      },
    ]);
    expect(result.declaredRecords).toEqual([]);
  });

  it("does not evaluate a reference whose record does not exist", () => {
    // Arrange — invariant (iv) owns the dangling case; this guard must not
    // double-report it, and must still account for it in its counters.
    const records: AdrRecordText[] = [
      adrRecord(fixtureRecord0786, "- **Consumers:** `apps/web/src/server/rate-limit`"),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// a record no file carries ADR-0999", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result).toEqual({
      ok: true,
      issues: [],
      unlisted: [],
      checkedReferences: 0,
      exemptReferences: 0,
      danglingReferences: 1,
      verifiedReferences: 0,
      declaredRecords: ["0786"],
    });
  });
});

/**
 * Finding F1 (the land review of PR #488): the bare-name channel judged a
 * citation by the file's bare name alone, so a record naming *any* `…/route.ts`
 * verified **every** swept file whose bare name is `route.ts` — this head holds
 * 85 of them. The reviewer's probe added a citation of ADR-0786 (adr-fixture) to an
 * unrelated route handler and the whole spec stayed green, although that record names
 * `apps/web/src/app/api/v1/p/attendee-sessions/route.ts`. adr-fixture: the
 * number is a fixture target, not a citation.
 *
 * The rule pinned here: a bare-name mention identifies a file only when that bare
 * name is **unique across the swept population** (the `sources` argument in the
 * pure function, the whole swept tree in `checkRepositoryAdrConsumers`). A shared
 * bare name identifies nothing; the path and `@/` specifier channels keep
 * covering the real citations.
 */
describe("checkSourceAdrConsumers — the bare-name channel needs a unique name (finding F1)", () => {
  it("does not verify a citation from another file that shares the named file's bare name", () => {
    // Arrange — the record names one of the tree's 85 `route.ts` files by full
    // path; the second source shares only the bare name.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0786,
        [
          "- **Status:** Accepted",
          "- **Consumers:** `apps/web/src/app/api/v1/p/attendee-sessions/route.ts`",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/app/api/v1/p/attendee-sessions/route.ts",
        text: "// the session rate-limit gate ADR-0786", // adr-fixture: fixture citation target
      },
      {
        path: "apps/web/src/app/api/v1/addons/route.ts",
        text: "// a route the record never names ADR-0786", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — only the path the record names is verified; the shared bare name
    // is not a claim about every file that carries it.
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: "apps/web/src/app/api/v1/addons/route.ts",
        line: 1,
        number: "0786",
        record: fixtureRecord0786,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.checkedReferences).toBe(2);
    expect(result.verifiedReferences).toBe(1);
  });

  it("keeps the bare-name channel for a name that is unique across the swept population", () => {
    // Arrange — the gate must not delete the channel: a bare name no other swept
    // file carries still identifies its file.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0780,
        [
          "- **Consumers:** the OP-129 RED specs, starting with",
          "  `attendee-sessions.test.ts` (I1–I5)",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/test/integration/attendee-sessions.test.ts",
        text: "// the I1-I5 pins live here ADR-0780", // adr-fixture: fixture citation target
      },
      {
        path: "apps/web/src/test/integration/media-signed-urls.test.ts",
        text: "export const nothingToSee = 0;",
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checkedReferences).toBe(1);
    expect(result.verifiedReferences).toBe(1);
  });
});

/**
 * Finding F2 (the land review of PR #488): only `- **Consumers:**` at column 0
 * with the colon inside the bold declared. Every other plausible shape fell into
 * `unlisted-consumer` with `ok: true`, so one punctuation slip in a hand-written
 * record silently switched enforcement off for it — and the `Consumers:`
 * adoption programme writes the field into 175 records by hand.
 *
 * The contract pinned here:
 *   - a `Consumers`-shaped line that is not the canonical field is reported as
 *     `consumers-malformed` **in `issues`**, so `ok` is `false`: it fails, it is
 *     not merely counted. `file` and `record` carry the record's file name,
 *     `line` the offending line inside that record, `number` the record's digits;
 *   - the record still declares, so a slip cannot switch enforcement off as a
 *     side effect of being reported;
 *   - reporting is per record: a malformed field in a record nobody cites fails
 *     too;
 *   - the canonical shapes keep declaring — the header field and a column-0 field
 *     in a later section are pinned in the blocks above;
 *   - `Consumes:` is another field and prose is not a field shape; both stay
 *     silent (pinned above).
 */
describe("checkSourceAdrConsumers — a malformed Consumers field (finding F2)", () => {
  it.each<[string, string[], number]>([
    [
      "an indented field",
      ["- **Status:** Accepted", "  - **Consumers:** `apps/web/src/server/x.ts`"],
      2,
    ],
    [
      "the colon outside the bold",
      ["- **Status:** Accepted", "- **Consumers**: `apps/web/src/server/x.ts`"],
      2,
    ],
    ["no list dash", ["- **Status:** Accepted", "**Consumers:** `apps/web/src/server/x.ts`"], 2],
    [
      "a section heading",
      ["- **Status:** Accepted", "## Consumers", "", "- `apps/web/src/server/x.ts`"],
      2,
    ],
    [
      "a plain, unbolded field",
      ["- **Status:** Accepted", "- Consumers: `apps/web/src/server/x.ts`"],
      2,
    ],
  ])(
    "reports consumers-malformed, and fails the report, for %s",
    (_shape, recordLines, expectedLine) => {
      // Arrange
      const records: AdrRecordText[] = [adrRecord(fixtureRecord0901, recordLines.join("\n"))];
      const sources: SourceFileText[] = [
        {
          path: "apps/web/src/server/x.ts",
          text: "// the helper the field names ADR-0901", // adr-fixture: fixture citation target
        },
      ];

      // Act
      const result = checkSourceAdrConsumers(sources, records);

      // Assert — the slip fails the report and does not switch enforcement off:
      // the record still declares, so the citation it does name is verified.
      expect(result.issues).toEqual([
        {
          code: consumersMalformedCode,
          file: fixtureRecord0901,
          line: expectedLine,
          number: "0901",
          record: fixtureRecord0901,
        },
      ]);
      expect(result.ok).toBe(false);
      expect(result.unlisted).toEqual([]);
      expect(result.declaredRecords).toEqual(["0901"]);
      expect(result.verifiedReferences).toBe(1);
    }
  );

  it("still hard-checks a malformed record's citations against a file it does not name", () => {
    // Arrange — the record's field has the colon outside the bold and names
    // `x.ts`; the citing file is `y.ts`.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0901,
        ["- **Status:** Accepted", "- **Consumers**: `apps/web/src/server/x.ts`"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/y.ts",
        text: "// a file that field does not name ADR-0901", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — a malformed entry and a citation entry share one sorted `issues`
    // array (by `file`, so "ADR-…" sorts before "apps/…" in code-unit order).
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0901,
        line: 2,
        number: "0901",
        record: fixtureRecord0901,
      },
      {
        code: consumerMismatchCode,
        file: "apps/web/src/server/y.ts",
        line: 1,
        number: "0901",
        record: fixtureRecord0901,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual([]);
  });

  it("reports a malformed field in a record that no source cites", () => {
    // Arrange — the adoption programme will write the field into records nobody
    // cites yet; a slip there must not be silent either.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0901,
        ["- **Status:** Accepted", "## Consumers", "", "- `apps/web/src/server/x.ts`"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      { path: "apps/web/src/server/x.ts", text: "// no record is cited here" },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0901,
        line: 2,
        number: "0901",
        record: fixtureRecord0901,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.checkedReferences).toBe(0);
    expect(result.unlisted).toEqual([]);
  });
});

/**
 * The `Consumers` shape matrix (review finding F-A, the follow-up to F2's
 * `consumers-malformed`). F2 pins the five slipping shapes the land review
 * enumerated; every other shape measured at `11ec3d9` was unpinned, so a
 * refactor of the classifier could change it silently. This block pins them.
 *
 * **Canonical-adjacent shapes still declare and stay silent.** The `\s+` after
 * the bullet in the field pattern is load-bearing: several spaces after the
 * dash and a tab after the dash are canonical, and trailing whitespace on the
 * line changes nothing. A tightening to one literal space would only be noticed
 * by the real tree, which carries 0 such lines, so it is pinned here instead.
 *
 * **A space before the colon is a slip, not a silence.** `- **Consumers :**`
 * declares *and* reports `consumers-malformed` at that line: the record keeps
 * hard-checking its citations while the slip fails the report.
 *
 * **Reporting is positional and per offending line.** A malformed entry carries
 * the offending line's 1-based number inside the record — not the canonical
 * field's line, and not a citation's line — one entry per offending line, and
 * with a duplicate number the entry carries that record's own `file` and
 * `record`. Duplicate numbering stays `checkAdrNumbers`' job.
 *
 * **Fences are not parsed** (review finding F-B). The classifier reads physical
 * lines, so a column-0 canonical field inside a fenced sample declares, exactly
 * as it did before F2 existed, while an indented field inside the fence is
 * reported as `consumers-malformed`. No record in this tree carries either
 * shape, so neither costs anything today.
 */
describe("checkSourceAdrConsumers — the Consumers shape matrix (review finding F-A)", () => {
  it.each<[string, string[]]>([
    [
      "several spaces after the bullet",
      ["- **Status:** Accepted", "-   **Consumers:** `apps/web/src/server/x.ts`"],
    ],
    [
      "a tab after the bullet",
      ["- **Status:** Accepted", "-\t**Consumers:** `apps/web/src/server/x.ts`"],
    ],
    [
      "trailing spaces on the line",
      ["- **Status:** Accepted", "- **Consumers:** `apps/web/src/server/x.ts`   "],
    ],
  ])("declares, reports nothing and verifies the citation for %s", (_shape, recordLines) => {
    // Arrange — the `\s+` after the bullet is what these three rows protect.
    const records: AdrRecordText[] = [adrRecord(fixtureRecord0902, recordLines.join("\n"))];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result).toEqual({
      ok: true,
      issues: [],
      unlisted: [],
      checkedReferences: 1,
      exemptReferences: 0,
      danglingReferences: 0,
      verifiedReferences: 1,
      declaredRecords: ["0902"],
    });
  });

  it("reports a space before the colon, and keeps the record declaring", () => {
    // Arrange — the colon is inside the bold but not glued to the label.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0902,
        ["- **Status:** Accepted", "- **Consumers :** `apps/web/src/server/x.ts`"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — a slip reports, and does not switch enforcement off.
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0902,
        line: 2,
        number: "0902",
        record: fixtureRecord0902,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual([]);
    expect(result.declaredRecords).toEqual(["0902"]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("reports the offending line, not the canonical field's line, when both are in the record", () => {
    // Arrange — the canonical field sits on line 4 and the heading on line 256;
    // the report must name 256 (1-based inside the record), not 4. The filler
    // keeps that arithmetic visible instead of hidden in a loop.
    const recordLines = [
      "- **Status:** Accepted", // 1
      "", // 2
      "", // 3
      "- **Consumers:** `apps/web/src/server/x.ts`", // 4
      ...Array.from({ length: 251 }, () => ""), // 5-255
      "## Consumers", // 256
      "- `apps/web/src/server/x.ts`", // 257
    ];
    const records: AdrRecordText[] = [adrRecord(fixtureRecord0902, recordLines.join("\n"))];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — one entry, at the offending line, and the record still declares.
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0902,
        line: 256,
        number: "0902",
        record: fixtureRecord0902,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual([]);
    expect(result.declaredRecords).toEqual(["0902"]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("reports one entry per offending line when a record carries two", () => {
    // Arrange — an indented field and a dashless field, on lines 2 and 3.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0902,
        [
          "- **Status:** Accepted",
          "  - **Consumers:** `apps/web/src/server/x.ts`",
          "**Consumers:** `apps/web/src/server/x.ts`",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — both lines, in line order, and one record's worth of declaration.
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0902,
        line: 2,
        number: "0902",
        record: fixtureRecord0902,
      },
      {
        code: consumersMalformedCode,
        file: fixtureRecord0902,
        line: 3,
        number: "0902",
        record: fixtureRecord0902,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.declaredRecords).toEqual(["0902"]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("reports a malformed record by its own file and record when the number is duplicated", () => {
    // Arrange — both records carry `0903`; only the first is canonical, and only
    // the second is malformed. Duplicate numbering is not this guard's report.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0903Alpha,
        ["- **Status:** Accepted", "- **Consumers:** `apps/web/src/server/x.ts`"].join("\n")
      ),
      adrRecord(
        fixtureRecord0903Beta,
        ["- **Status:** Accepted", "## Consumers", "", "- `apps/web/src/server/x.ts`"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0903", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — the entry points at the offending record, not at its twin.
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0903Beta,
        line: 2,
        number: "0903",
        record: fixtureRecord0903Beta,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.declaredRecords).toEqual(["0903"]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("declares a canonical field inside a fenced code sample and reports nothing", () => {
    // Arrange — pre-existing behaviour: fences are not parsed, so a column-0
    // field inside a sample declares like any other.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0902,
        ["```md", "- **Consumers:** `apps/web/src/server/x.ts`", "```"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result).toEqual({
      ok: true,
      issues: [],
      unlisted: [],
      checkedReferences: 1,
      exemptReferences: 0,
      danglingReferences: 0,
      verifiedReferences: 1,
      declaredRecords: ["0902"],
    });
  });

  it("reports an indented field inside a fenced code sample (review finding F-B)", () => {
    // Arrange — the same sample, indented: a slip is a slip inside a fence too.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0902,
        ["```md", "  - **Consumers:** `apps/web/src/server/x.ts`", "```"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0902,
        line: 2,
        number: "0902",
        record: fixtureRecord0902,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.declaredRecords).toEqual(["0902"]);
    expect(result.verifiedReferences).toBe(1);
  });
});

/**
 * Residual `Consumers` shapes of the F2 class (review finding F-A) — measured at
 * `11ec3d9` and each one silently unenforced (`declares: false`, `issues: []`,
 * `ok: true`, `unlisted: 1`).
 *
 * **The decision: report them, and keep the record declaring.** The
 * `Consumers:` adoption programme writes the field into 175 records by hand, and
 * the point of F2 is that a punctuation slip must not switch enforcement off
 * without a signal. So the GREEN widens *recognition* — never *canonicality*:
 *
 *   - a leading `>` blockquote marker is stripped per level, with the spaces
 *     that follow it, before the rest of the line is classified;
 *   - `__…__` bold around the label is the same field vocabulary as `**…**`;
 *   - a `\d+[.)]` ordered-list marker stands where the canonical shape has its
 *     `-` bullet.
 *
 * A widened match is **always** `consumers-malformed`: only `-` + `\s+` +
 * `**Consumers:**` at column 0 is canonical, so a shape that merely normalizes
 * to it (a blockquote bullet, an underscore-bold label) still fails the report
 * and still declares — the F2 rule, applied to the wider vocabulary.
 *
 * The widened matcher must not reach prose: the label needs its colon, not just
 * the word, or the real tree's nine prose mentions of `Consumers` would redden
 * the citation sweep.
 */
describe("checkSourceAdrConsumers — residual Consumers shapes report instead of going silent (review finding F-A)", () => {
  it.each<[string, string[]]>([
    ["a blockquote bullet", ["> - **Consumers:** `apps/web/src/server/x.ts`"]],
    ["a blockquote with an indented bullet", [">   - **Consumers:** `apps/web/src/server/x.ts`"]],
    ["a nested blockquote bullet", ["> > - **Consumers:** `apps/web/src/server/x.ts`"]],
    ["an underscore-bold label", ["- __Consumers:__ `apps/web/src/server/x.ts`"]],
    ["an ordered-list label", ["1. **Consumers:** `apps/web/src/server/x.ts`"]],
    ["an indented ordered-list label", ["  1. **Consumers:** `apps/web/src/server/x.ts`"]],
  ])("reports consumers-malformed, and still declares, for %s", (_shape, fieldLines) => {
    // Arrange — the field is on line 2 of the record, after the status line.
    const records: AdrRecordText[] = [
      adrRecord(fixtureRecord0902, ["- **Status:** Accepted", ...fieldLines].join("\n")),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — the slip fails the report, and the record keeps hard-checking.
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0902,
        line: 2,
        number: "0902",
        record: fixtureRecord0902,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual([]);
    expect(result.declaredRecords).toEqual(["0902"]);
    expect(result.verifiedReferences).toBe(1);
  });

  /**
   * The rows above are six **literal** shapes, and an alternation of exactly
   * those six literals satisfies them while leaving every *composition* of the
   * three recognition axes (blockquote level × list marker × bold-marker style)
   * silently enforced-off — the F-A defect this block exists to close, one level
   * up. The rows below therefore **sample** the compositions, one per axis
   * pairing.
   *
   * What the sample encodes is the contract: the axis vocabulary is recognized
   * by peeling the blockquote levels, then the list marker, then the bold
   * markers — in sequence — because every composition of the three axes is the
   * same field. What the sample does **not** prove is that the classifier cannot
   * *enumerate* instead: an alternation of the pinned literals alone was
   * measured green on this file, so the blocks below widen the sample rather than
   * treating it as that proof.
   */
  it.each<[string, string[]]>([
    ["blockquote × ordered marker", ["> 1. **Consumers:** `apps/web/src/server/x.ts`"]],
    ["blockquote × underscore bold", ["> - __Consumers:__ `apps/web/src/server/x.ts`"]],
    [
      "blockquote × asterisk bullet × underscore bold",
      ["> * __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    ["ordered marker × underscore bold", ["1. __Consumers:__ `apps/web/src/server/x.ts`"]],
    [
      "blockquote × ordered marker × underscore bold",
      ["> 1. __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    [
      "nested blockquote × ordered marker × underscore bold",
      ["> > 1. __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    ["parenthesized marker × underscore bold", ["1) __Consumers:__ `apps/web/src/server/x.ts`"]],
    [
      "blockquote × plus bullet × underscore bold",
      ["> + __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
  ])(
    "reports consumers-malformed, and still declares, for the shape cross-product %s",
    (_shape, fieldLines) => {
      // Arrange — the field is on line 2 of the record, after the status line.
      const records: AdrRecordText[] = [
        adrRecord(fixtureRecord0902, ["- **Status:** Accepted", ...fieldLines].join("\n")),
      ];
      const sources: SourceFileText[] = [
        {
          path: "apps/web/src/server/x.ts",
          text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
        },
      ];

      // Act
      const result = checkSourceAdrConsumers(sources, records);

      // Assert — the composition is reported once, and the record keeps
      // hard-checking, exactly like its single-axis siblings.
      expect(result.issues).toEqual([
        {
          code: consumersMalformedCode,
          file: fixtureRecord0902,
          line: 2,
          number: "0902",
          record: fixtureRecord0902,
        },
      ]);
      expect(result.ok).toBe(false);
      expect(result.unlisted).toEqual([]);
      expect(result.declaredRecords).toEqual(["0902"]);
      expect(result.verifiedReferences).toBe(1);
    }
  );

  /**
   * Eight further samples of the same three axes, composed the other way round —
   * the residue the F2 finding recorded (plus the triple-underscore bold style
   * whose coverage gap card t_53ef51f6 recorded): nested quotes, a column-0 `*`
   * bullet, a `+` bullet, an indented `1)` marker, and the triple-underscore
   * label. Every one of them is the same field vocabulary, so every one must
   * report and keep the record declaring; a classifier that recognizes only the
   * pairings sampled above goes silent on these, which is the F-A defect one
   * composition further out.
   */
  it.each<[string, string[]]>([
    [
      "nested blockquote × ordered marker × double-star bold",
      ["> > 1. **Consumers:** `apps/web/src/server/x.ts`"],
    ],
    [
      "blockquote × asterisk bullet × double-star bold",
      ["> * **Consumers:** `apps/web/src/server/x.ts`"],
    ],
    [
      "nested blockquote × bullet × underscore bold",
      ["> > - __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    ["column-0 asterisk bullet × underscore bold", ["* __Consumers:__ `apps/web/src/server/x.ts`"]],
    [
      "blockquote × plus bullet × double-star bold",
      ["> + **Consumers:** `apps/web/src/server/x.ts`"],
    ],
    [
      "indented parenthesised ordered marker × underscore bold",
      ["  1) __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    ["triple-underscore bold", ["- ___Consumers:___ `apps/web/src/server/x.ts`"]],
    [
      "blockquote × ordered marker × triple-underscore bold",
      ["> 1. ___Consumers:___ `apps/web/src/server/x.ts`"],
    ],
  ])(
    "reports consumers-malformed, and still declares, for the residual shape %s",
    (_shape, fieldLines) => {
      // Arrange — the field is on line 2 of the record, after the status line.
      const records: AdrRecordText[] = [
        adrRecord(fixtureRecord0902, ["- **Status:** Accepted", ...fieldLines].join("\n")),
      ];
      const sources: SourceFileText[] = [
        {
          path: "apps/web/src/server/x.ts",
          text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
        },
      ];

      // Act
      const result = checkSourceAdrConsumers(sources, records);

      // Assert — the residual composition is reported once, and the record keeps
      // hard-checking, exactly like its single-axis siblings.
      expect(result.issues).toEqual([
        {
          code: consumersMalformedCode,
          file: fixtureRecord0902,
          line: 2,
          number: "0902",
          record: fixtureRecord0902,
        },
      ]);
      expect(result.ok).toBe(false);
      expect(result.unlisted).toEqual([]);
      expect(result.declaredRecords).toEqual(["0902"]);
      expect(result.verifiedReferences).toBe(1);
    }
  );

  /**
   * A heading is a fourth way to write the field, and it is classified on the
   * **raw** line — before the blockquote peel — so a heading inside a blockquote
   * is silently unenforced (measured at `319532d`: `issues: []`, `ok: true`,
   * `unlisted: 1`). That is the exact F2/F-A failure mode: a punctuation slip
   * must not switch enforcement off without a signal. The column-0 controls
   * (`## **Consumers:** …` and `## Consumers: …`) already report and are pinned
   * elsewhere in this file.
   *
   * These two rows are **RED by design**: they pin the intended contract, and the
   * GREEN (card t_ba4928fb) peels the blockquote levels, *then* runs the heading
   * test, then the list-marker/bold peel. Do not weaken them — a blockquoted
   * heading declares exactly like the column-0 one.
   */
  it.each<[string, string[]]>([
    ["a double-star bold heading", ["> ## **Consumers:** `apps/web/src/server/x.ts`"]],
    ["a plain heading", ["> ## Consumers: `apps/web/src/server/x.ts`"]],
  ])(
    "reports consumers-malformed, and still declares, for %s inside a blockquote",
    (_shape, fieldLines) => {
      // Arrange — the field is on line 2 of the record, after the status line.
      const records: AdrRecordText[] = [
        adrRecord(fixtureRecord0902, ["- **Status:** Accepted", ...fieldLines].join("\n")),
      ];
      const sources: SourceFileText[] = [
        {
          path: "apps/web/src/server/x.ts",
          text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
        },
      ];

      // Act
      const result = checkSourceAdrConsumers(sources, records);

      // Assert — a blockquoted heading is not a licence to go silent: it reports,
      // and the record keeps hard-checking.
      expect(result.issues).toEqual([
        {
          code: consumersMalformedCode,
          file: fixtureRecord0902,
          line: 2,
          number: "0902",
          record: fixtureRecord0902,
        },
      ]);
      expect(result.ok).toBe(false);
      expect(result.unlisted).toEqual([]);
      expect(result.declaredRecords).toEqual(["0902"]);
      expect(result.verifiedReferences).toBe(1);
    }
  );

  it("reports the citation mismatch too when a blockquote field does not name the citing file", () => {
    // Arrange — the field names `x.ts`; `y.ts` cites the record.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0902,
        ["- **Status:** Accepted", "> - **Consumers:** `apps/web/src/server/x.ts`"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/y.ts",
        text: "// a file the field does not name ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — one malformed entry and one mismatch in the same sorted array
    // (by `file`, so the record name sorts before the citing path).
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0902,
        line: 2,
        number: "0902",
        record: fixtureRecord0902,
      },
      {
        code: consumerMismatchCode,
        file: "apps/web/src/server/y.ts",
        line: 1,
        number: "0902",
        record: fixtureRecord0902,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual([]);
    expect(result.verifiedReferences).toBe(0);
  });

  it("keeps prose that starts with the word Consumers silent", () => {
    // Arrange — a widened classifier must not read an English sentence as a
    // field: the label needs its colon, not just the word.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0902,
        [
          "- **Status:** Accepted",
          "Consumers of this record are the OP-129 specs listed below.",
          "- **Consumers:** `apps/web/src/server/x.ts`",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — the canonical field on line 3 declares; line 2 is prose.
    expect(result).toEqual({
      ok: true,
      issues: [],
      unlisted: [],
      checkedReferences: 1,
      exemptReferences: 0,
      danglingReferences: 0,
      verifiedReferences: 1,
      declaredRecords: ["0902"],
    });
  });
});

describe("checkSourceAdrConsumers — the fixture marker", () => {
  it("exempts a marked fixture line from the accuracy rule", () => {
    // Arrange — the marker's scope is the guard's own test tree, same as (iv).
    const records: AdrRecordText[] = [
      adrRecord(fixtureRecord0786, "- **Consumers:** `apps/web/src/test/unit/other.test.ts`"),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/test/unit/x.test.ts",
        text: "// a synthetic citation ADR-0786 adr-fixture", // adr-fixture: the line under test is itself a fixture
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result).toEqual({
      ok: true,
      issues: [],
      unlisted: [],
      checkedReferences: 0,
      exemptReferences: 1,
      danglingReferences: 0,
      verifiedReferences: 0,
      declaredRecords: ["0786"],
    });
  });

  it("does not exempt a marked line outside the guard's test tree", () => {
    // Arrange — finding F-M1's shape: the marker appended to a real pointer.
    const records: AdrRecordText[] = [
      adrRecord(fixtureRecord0786, "- **Consumers:** `apps/web/src/test/integration/x.test.ts`"),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/media/signed-urls.ts",
        text: "// a real pointer adr-fixture ADR-0786", // adr-fixture: the line under test is itself a fixture
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.exemptReferences).toBe(0);
    expect(result.checkedReferences).toBe(1);
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: "apps/web/src/server/media/signed-urls.ts",
        line: 1,
        number: "0786",
        record: fixtureRecord0786,
      },
    ]);
  });
});

describe("checkRepositoryAdrConsumers — the repository sweep", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the repository's real source tree as citation-accurate", () => {
    // Act — every citation of a declaring record at this head is made by a file
    // that record names: the OP-129 lane declares its consumers, and the
    // pristine tree is clean under the rule.
    const report = checkRepositoryAdrConsumers(repoRoot);

    // Assert
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    // Non-vacuity: a green report must come from the tree's declaring records,
    // not from an empty population. An accepted ADR is never un-declared, so the
    // floor may only rise.
    expect(report.declaredRecords.length).toBeGreaterThanOrEqual(4);
    expect(report.verifiedReferences).toBeGreaterThan(0);
    // Every evaluated reference is classified exactly once.
    expect(report.verifiedReferences + report.issues.length + report.unlisted.length).toBe(
      report.checkedReferences
    );
  });

  it("sweeps exactly the reference population the existence guard sweeps", () => {
    // Act
    const existence = checkRepositoryAdrReferences(repoRoot);
    const accuracy = checkRepositoryAdrConsumers(repoRoot);

    // Assert — the two guards cannot drift apart: same fixtures exempted, same
    // references seen, the dangling ones credited to invariant (iv).
    expect(accuracy.exemptReferences).toBe(existence.exemptReferences);
    expect(accuracy.checkedReferences + accuracy.danglingReferences).toBe(
      existence.checkedReferences
    );
  });

  it("reports a wrong-but-existing target in a throwaway repository", () => {
    // Arrange — the record exists, the citation resolves, and the record is
    // about another lane's file: the case invariant (iv) cannot see.
    const root = makeTempRepoRoot({
      "docs/adr/ADR-0768-op128-account-status-gate-pins.md": [
        // adr-fixture: fixture record name
        "- **Status:** Accepted",
        "- **Consumers:** `apps/web/src/test/integration/media-signed-urls.test.ts`",
      ].join("\n"), // adr-fixture: fixture record name
      "apps/web/src/test/integration/attendee-sessions.test.ts": "// I3 ADR-0768\n", // adr-fixture: fixture citation target
      "packages/contracts/src/empty.ts": "export const nothing = 0;",
    });

    // Act
    const report = checkRepositoryAdrConsumers(root);

    // Assert
    expect(report).toEqual({
      ok: false,
      issues: [
        {
          code: consumerMismatchCode,
          file: "apps/web/src/test/integration/attendee-sessions.test.ts",
          line: 1,
          number: "0768",
          record: fixtureRecord0768,
        },
      ],
      unlisted: [],
      checkedReferences: 1,
      exemptReferences: 0,
      danglingReferences: 0,
      verifiedReferences: 0,
      declaredRecords: ["0768"],
    });
  });

  it("reports the undeclared-record citation in the unlisted channel instead of failing it", () => {
    // Arrange
    const root = makeTempRepoRoot({
      "docs/adr/ADR-0025-auth-guard-table.md": "# The auth guard table", // adr-fixture: fixture record name
      "apps/web/src/server/auth/guards.ts": "// the label table ADR-0025", // adr-fixture: fixture citation target
      "packages/contracts/src/empty.ts": "export const nothing = 0;",
    });

    // Act
    const report = checkRepositoryAdrConsumers(root);

    // Assert
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.unlisted).toEqual([
      {
        code: unlistedConsumerCode,
        file: "apps/web/src/server/auth/guards.ts",
        line: 1,
        number: "0025",
        record: fixtureRecord0025,
      },
    ]);
    expect(report.declaredRecords).toEqual([]);
  });

  it("throws an ENOENT error when the root has no docs/adr directory", () => {
    // Arrange — a wrong root must fail loudly, never pass vacuously.
    const root = makeTempRepoRoot({ "apps/web/src/x.ts": "// no references here" });

    // Act + Assert
    expect(() => checkRepositoryAdrConsumers(root)).toThrow(
      expect.objectContaining({ code: "ENOENT" })
    );
  });
});

/* ------------------------------------------------------------------------- *
 * Invariant (vi) — markdown link targets inside the records (finding F3)
 * ------------------------------------------------------------------------- */

/**
 * Unit contract — invariant (vi): a `docs/adr` record's markdown link target
 * must name a file that exists (finding F3, the OP-129 ledger verification
 * `t_7d87f91b`, card `t_e042ab22`).
 *
 * **Why this exists.** Invariant (iv) proves that a *source comment's* citation
 * of a record resolves, and it sweeps `apps/` and `packages/` only — so a
 * record's own navigation was never read by anything. On the OP-129 tree three
 * landed records linked pre-rename files (0769's RED draft, 0770's GREEN draft,
 * and a never-minted 0782 rate-limit name) while every guard stayed green: the
 * links 404'd permanently, in frozen records, with no mechanism able to notice.
 * This block pins that mechanism.
 *
 * **The rule** (RED and GREEN must not diverge):
 *
 * ```
 * interface AdrRecordLinkFileText { path: string; text: string }
 * type AdrRecordLinkIssue = {
 *   code: "dangling-reference";
 *   file: string;   // repo-relative POSIX path of the record, e.g. docs/adr/ADR-…md
 *   line: number;   // 1-based line of the link
 *   target: string; // the link target AS WRITTEN, fragment kept
 * }
 * checkAdrRecordLinks(
 *   records: readonly AdrRecordLinkFileText[],
 *   adrFileNames: readonly string[],   // the file names present in docs/adr
 * ): { ok: boolean; issues: AdrRecordLinkIssue[];
 *      checkedLinks: number; scannedRecords: number }
 * checkRepositoryAdrLinks(root: string): typeof checkAdrRecordLinks
 * ```
 *
 * **Scope — the records, never the ledger.** Only `docs/adr/ADR-*.md` is swept;
 * `checkRepositoryAdrLinks` applies the same in-scope name predicate the
 * numbering guard uses. `docs/adr/README.md` is deliberately out of scope: its
 * ledger notes keep pre-rename names on purpose (0819 and 0821 at this head) to
 * describe the collision they record, and flagging history would force every
 * future note to lie. Pinned in both directions: a broken link in a record is
 * an issue, the same bytes in `README.md` are not swept.
 *
 * **Prose is not a link.** A fenced code block and an inline code span are
 * prose: a `](…)` shape inside backticks documents a shape, it does not
 * navigate. Both directions are pinned, because the record that documents this
 * very rule will quote the shape in backticks.
 *
 * **A target is a same-directory ADR file name, matched exactly.** The link
 * syntax read is a markdown inline `](target)`; the target must carry no path
 * separator, start `ADR-` and end `.md`, after stripping a `#fragment`. It
 * resolves only against a file name **equal** to the leaf — never a prefix,
 * never a number-only match. Number keying accepted two real defects in silence
 * until they were repaired: `0029-domain-event-outbox.md` (the record is the
 * plural `…-domain-events-outbox.md`) and `0306-red-branch-pipeline.md` (0306 is
 * now `0306-op101-stale-branch-deletion.md`, a different decision). The pinned
 * fixture is the same shape: `0781-something-else.md` while 0781's real record
 * exists.
 *
 * **Trunk expectation — `ok: true`.** The sweep landed as a ratchet over the
 * **32 dangling occurrences of 16 distinct targets** it found in other lanes'
 * records, and the repair that retargeted every one of them retired the list in
 * the same change (the F2 coupling: a ratchet fails on a repair as well as on an
 * add). The real-tree case therefore asserts the empty report, with the
 * non-vacuity bounds below keeping a silently narrowed sweep from passing.
 *
 * **Ordering.** `issues` is sorted by `file`, then `line`, then `target`, so the
 * same records in any input order produce one report.
 */

/**
 * Compile-time pin of the issue discriminant: the docs sweep reuses the
 * numbering guard's `dangling-reference` code, so an implementation that invents
 * a second code for the same defect fails `tsc`.
 */
const danglingLinkCode: AdrRecordLinkIssue["code"] = "dangling-reference";

// Fixture record names, named once so each line stays readable. Synthetic on
// this tree: the numbers below are real records' numbers, which is the point —
// the rule keys on the whole file name, not on the digits.
const fixture0780Red = "ADR-0780-op129-anonymous-attendee-sessions-red.md"; // adr-fixture: fixture record name
const fixture0781Green = "ADR-0781-op129-anonymous-attendee-sessions-green.md"; // adr-fixture: fixture record name
const fixture0782Edge = "ADR-0782-op129-attendee-session-edge-pins.md"; // adr-fixture: fixture record name
const fixture0787Rate = "ADR-0787-op129-attendee-session-rate-limit-pin.md"; // adr-fixture: fixture record name
const fixture0300Alpha = "ADR-0300-alpha.md"; // adr-fixture: fixture record name
const fixture0301Alpha = "ADR-0301-alpha.md"; // adr-fixture: fixture record name
const fixture0302Guard = "ADR-0302-adr-number-guard-contract.md"; // adr-fixture: fixture record name
const fixture0304Omega = "ADR-0304-omega.md"; // adr-fixture: fixture record name
const fixture0780Sessions = "ADR-0780-op129-attendee-sessions.md"; // adr-fixture: fixture record name
const fixture0783Resolver = "ADR-0783-op129-attendee-resolver-default.md"; // adr-fixture: fixture record name

/**
 * One record as the docs sweep reads it. The fixture factory owns the
 * `docs/adr/` prefix so every case writes only the file name and the text.
 */
function adrRecordFile(fileName: string, lines: string[]): AdrRecordLinkFileText {
  return { path: `docs/adr/${fileName}`, text: lines.join("\n") };
}

describe("checkAdrRecordLinks — a link target must resolve to a record file", () => {
  it("reports a link to a record that does not exist, naming the record and the line", () => {
    // Arrange — one resolving link and one dangling link on the same line.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0782Edge, [
        "# Attendee session edge pins",
        "",
        "- **Amends:** [ADR-0780](ADR-0780-op129-anonymous-attendee-sessions-red.md) and [ADR-0769](ADR-0769-op129-anonymous-attendee-sessions-red.md)", // adr-fixture: the 0769 draft has no docs/adr file
      ]),
    ];

    // Act — only 0780's record exists in this fixture directory.
    const result = checkAdrRecordLinks(records, [fixture0780Red]);

    // Assert — the report names the record and the line and keeps the target as
    // written, so the reader can open the record and fix that link.
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: danglingLinkCode,
          file: `docs/adr/${fixture0782Edge}`,
          line: 3,
          target: "ADR-0769-op129-anonymous-attendee-sessions-red.md", // adr-fixture: fixture link target
        },
      ],
      checkedLinks: 2,
      scannedRecords: 1,
    });
  });

  it("accepts a link whose exact record file exists and counts what it checked", () => {
    // Arrange — the repaired shape the OP-129 records carry at this head.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0780Red, [
        "- **Relates to:** [ADR-0781](ADR-0781-op129-anonymous-attendee-sessions-green.md)", // adr-fixture: fixture record name
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0780Red, fixture0781Green]);

    // Assert
    expect(result).toEqual({ ok: true, issues: [], checkedLinks: 1, scannedRecords: 1 });
  });

  it("reports a target that only shares its number with an existing record", () => {
    // Arrange — the false-accept shape: a rule keyed on the four digits (or on a
    // name prefix) accepts this target because 0781's real record exists.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0787Rate, [
        "- **Numbering:** the first draft was [ADR-0781](ADR-0781-something-else.md) before the renumber.", // adr-fixture: the exact leaf does not exist
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0781Green]);

    // Assert — the leaf must be equal to a file name, never a prefix or a number.
    expect(result.issues).toEqual([
      {
        code: danglingLinkCode,
        file: `docs/adr/${fixture0787Rate}`,
        line: 1,
        target: "ADR-0781-something-else.md", // adr-fixture: fixture link target
      },
    ]);
    expect(result.checkedLinks).toBe(1);
  });

  it("does not read a target that is not a same-directory ADR file name", () => {
    // Arrange — an external URL, the ledger, a section anchor, a path-bearing
    // relative link: none of them is a record file name.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        "- **PR:** [review](https://github.com/yahodu/openpic-webapp/pull/448)",
        "- **Ledger:** [the ledger](README.md), [a section](#numbering), [notes](../notes.md)",
        "- **Relative:** [the draft](./ADR-0001-ports-and-adapters.md)", // adr-fixture: the "./" prefix puts it out of scope
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard]);

    // Assert
    expect(result).toEqual({ ok: true, issues: [], checkedLinks: 0, scannedRecords: 1 });
  });

  it("treats a link shape inside an inline code span as prose, never as a link", () => {
    // Arrange — the shape a record uses to *document* a link, not to navigate.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        "- **Rule:** a record writes a live link as `[ADR-0001](ADR-9999-missing.md)` and names a retired one as plain text.", // adr-fixture: the code-span shape must not be read
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard]);

    // Assert — nothing was even evaluated: the span is prose.
    expect(result).toEqual({ ok: true, issues: [], checkedLinks: 0, scannedRecords: 1 });
  });

  it("treats a link inside a fenced code block as prose, never as a link", () => {
    // Arrange — an example block followed by one real link it must not hide.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        "- **Example:**",
        "",
        "```markdown",
        "[the draft](ADR-9999-missing.md)", // adr-fixture: inside a fence, prose not a link
        "```",
        "",
        "- **The record:** [ADR-0302](ADR-0302-adr-number-guard-contract.md)", // adr-fixture: fixture record name
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard]);

    // Assert — only the live link is counted, and it resolves.
    expect(result).toEqual({ ok: true, issues: [], checkedLinks: 1, scannedRecords: 1 });
  });

  it("reports every occurrence, sorted by record path, then line, then target", () => {
    // Arrange — two records in reverse path order, four dangling targets, two of
    // them on one line.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0304Omega, [
        "- **A:** [x](ADR-0302-missing.md)", // adr-fixture: no such docs/adr file
        "",
        "- **B:** [y](ADR-0304-gone.md)", // adr-fixture: no such docs/adr file
      ]),
      adrRecordFile(fixture0300Alpha, [
        "- **C:** [z](ADR-0302-zeta.md) and [w](ADR-0302-alpha.md)", // adr-fixture: no such docs/adr files
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, []);

    // Assert — one issue per occurrence, ordered by file, line, then target.
    expect(
      result.issues.map(({ file, line, target }) => `${file}:${String(line)}:${target}`)
    ).toEqual([
      "docs/adr/ADR-0300-alpha.md:1:ADR-0302-alpha.md", // adr-fixture: fixture expectation
      "docs/adr/ADR-0300-alpha.md:1:ADR-0302-zeta.md", // adr-fixture: fixture expectation
      "docs/adr/ADR-0304-omega.md:1:ADR-0302-missing.md", // adr-fixture: fixture expectation
      "docs/adr/ADR-0304-omega.md:3:ADR-0304-gone.md", // adr-fixture: fixture expectation
    ]);
    expect(result.checkedLinks).toBe(4);
    expect(result.scannedRecords).toBe(2);
    expect(result.ok).toBe(false);
  });

  it("reports a dangling target that carries a fragment, as written", () => {
    // Arrange — a link into a section of a record that does not exist is still a
    // link to that record.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0301Alpha, [
        "- **See:** [the decision](ADR-0769-op129-attendee-sessions-red.md#decision)", // adr-fixture: the 0769 draft has no docs/adr file
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, []);

    // Assert — the fragment is stripped for resolution and kept in the report.
    expect(result.issues).toEqual([
      {
        code: danglingLinkCode,
        file: `docs/adr/${fixture0301Alpha}`,
        line: 1,
        target: "ADR-0769-op129-attendee-sessions-red.md#decision", // adr-fixture: fixture link target
      },
    ]);
    expect(result.checkedLinks).toBe(1);
  });
});

describe("checkRepositoryAdrLinks — the repository sweep", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sweeps docs/adr/ADR-*.md records and never docs/adr/README.md", () => {
    // Arrange — the ledger keeps pre-rename names on purpose, so its dangling
    // links must stay unflagged while the record's own dangling link fails.
    const root = makeTempRepoRoot({
      "docs/adr/README.md": [
        "- the 0769 draft [ADR-0769](ADR-0769-op129-gone.md) was renumbered", // adr-fixture: the ledger note keeps the old name
        "- the 0770 draft [ADR-0770](ADR-0770-op129-gone.md) was renumbered", // adr-fixture: the ledger note keeps the old name
      ].join("\n"),
      [`docs/adr/${fixture0780Sessions}`]: [
        "- **Ledger:** [README](README.md)",
        "- **Self:** [this record](ADR-0780-op129-attendee-sessions.md)", // adr-fixture: fixture record name
        "- **Draft:** [the draft](ADR-0783-op129-attendee-resolver-something-else.md)", // adr-fixture: exact leaf does not exist
      ].join("\n"),
      [`docs/adr/${fixture0783Resolver}`]: "# resolver default", // adr-fixture: fixture record name
    });

    // Act
    const result = checkRepositoryAdrLinks(root);

    // Assert — one issue, from the record, and the ledger's two links unwatched.
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: danglingLinkCode,
          file: `docs/adr/${fixture0780Sessions}`,
          line: 3,
          target: "ADR-0783-op129-attendee-resolver-something-else.md", // adr-fixture: fixture link target
        },
      ],
      checkedLinks: 2,
      scannedRecords: 2,
    });
  });

  it("reports the repository tree's known dangling targets, as a ratchet", () => {
    // Act
    const result = checkRepositoryAdrLinks(repoRoot);

    // Assert — non-vacuity first: the sweep must see the whole record population,
    // not a narrow slice of it.
    expect(result.scannedRecords).toBeGreaterThanOrEqual(250);
    expect(result.checkedLinks).toBeGreaterThanOrEqual(800);

    // The inherited debt — 32 occurrences of 16 distinct targets — was repaired
    // record by record, so the honest end state is the empty report. The ratchet
    // is retired, not re-pinned: a new dangling link fails here, and the two
    // bounds above keep a silently narrowed sweep from passing vacuously.
    expect(result).toEqual({ ok: true, issues: [], checkedLinks: 881, scannedRecords: 292 });
  });

  it("throws an ENOENT error when the root has no docs/adr directory", () => {
    // Arrange — a wrong root must fail loudly, never pass vacuously.
    const root = makeTempRepoRoot({ "apps/web/src/x.ts": "// no references here" });

    // Act + Assert
    expect(() => checkRepositoryAdrLinks(root)).toThrow(
      expect.objectContaining({ code: "ENOENT" })
    );
  });
});
