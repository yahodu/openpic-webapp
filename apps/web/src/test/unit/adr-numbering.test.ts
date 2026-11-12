import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkAdrDirectory,
  checkAdrNumbers,
  parseAdrNumber,
  type AdrNumberIssue,
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
 * **Scope.** Exactly two invariants:
 *   (i)  no two in-scope files share an `ADR-NNNN` number;
 *   (ii) every in-scope `ADR-*.md` file name matches
 *        `^ADR-(\d{4})-[a-z0-9]+(-[a-z0-9]+)*\.md$`.
 * Reserved-range bookkeeping is deliberately **out of scope**: it lives in the
 * prose ledger `docs/adr/README.md`, and parsing that prose is brittle.
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
 *   - `ADR-0000-x.md` and `ADR-9999-x.md` are well-formed: `parseAdrNumber`
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

function makeTempAdrDir(fileNames: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "adr-numbering-"));
  tempDirs.push(dir);
  for (const fileName of fileNames) {
    writeFileSync(join(dir, fileName), "");
  }
  return dir;
}

/**
 * A temp ADR directory that also carries a `README.md` with `readmeMarkdown`
 * (F-L1: the lane ledger the range check reads). One extra `writeFileSync` call
 * site, so the security preset's non-literal-`fs` warnings stay countable.
 */
function makeTempAdrDirWithReadme(fileNames: string[], readmeMarkdown: string): string {
  const dir = makeTempAdrDir(fileNames);
  writeFileSync(join(dir, "README.md"), readmeMarkdown);
  return dir;
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
    const result = checkAdrNumbers(["ADR-0000-x.md", "ADR-9999-y.md"]);

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
    ["ADR-0000-x.md", 0],
    ["ADR-9999-x.md", 9999],
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
    mkdirSync(join(dir, "archive"));
    writeFileSync(join(dir, "archive", "ADR-0146-a.md"), "");

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
    // ADR-0770 came to exist twice. README order is deliberately reversed, so
    // the issue's holder order pins the ascending sort.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-op126-uploads-green.md"],
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
      ["ADR-0760-a.md"],
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
      ["ADR-0760-a.md"],
      laneLedger(["| OP-126 uploads lane | `0760`–`0779` | `0771` |"])
    );

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("reports no overlap when the README table has no parseable row", () => {
    // Arrange — header and `---` separator only.
    const dir = makeTempAdrDirWithReadme(["ADR-0760-a.md"], laneLedger([]));

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("reports no overlap when the README only mentions ranges in prose", () => {
    // Arrange — an empty README and a prose-only one both carry no reservation.
    const emptyDir = makeTempAdrDirWithReadme(["ADR-0760-a.md"], "");
    const proseDir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"],
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
    const dir = makeTempAdrDir(["ADR-0760-a.md"]);

    // Act
    const result = checkAdrDirectory(dir);

    // Assert
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("reports one issue per intersecting pair when three reserved ranges overlap", () => {
    // Arrange — every pair of these three intersects, so the report carries
    // three issues, not one per row.
    const dir = makeTempAdrDirWithReadme(
      ["ADR-0760-a.md"],
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
