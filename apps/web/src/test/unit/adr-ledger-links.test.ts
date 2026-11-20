/**
 * ADR guard, invariant (vi)'s **ledger half** — every markdown link target inside
 * `docs/adr/README.md` must name a file that exists, **or** a file the repository
 * carried and renamed. The invariant is tabulated once, in
 * `ADR-0302` (`## Decision`, the six-row invariant table, row (vi)); `ADR-0893`
 * records this pack.
 *
 * **Why this exists.** The review of PR #754 found the ledger pointing at a
 * `-pins` variant of 0884's record name, with **all six `adr-*` guards green at
 * `236 passed (236)`** on that head: `checkRepositoryAdrLinks` sweeps
 * `docs/adr/ADR-*.md` and deliberately never reads the ledger, so a dangling
 * link one file over is invisible to the whole guard family. That rationale is
 * sound for a name that **existed and was renamed** — the ledger's notes keep
 * those on purpose to describe the collision they record, and flagging history
 * would force every future note to lie. It does not cover a name that **never
 * existed at all**, which is the class measured here. Invariant (vi) exists
 * because three landed records "404'd permanently, in frozen records, with no
 * mechanism able to notice" — the same failure, one file over.
 *
 * **The rule** (RED and GREEN must not diverge):
 *
 * ```
 * module   apps/web/src/test/helpers/adr-ledger-links.ts
 *
 * checkAdrLedgerLinks(
 *   ledger: AdrRecordLinkFileText,               // { path: "docs/adr/README.md", text }
 *   adrFileNames: readonly string[],             // file names present in docs/adr NOW
 *   everAddedAdrFileNames: readonly string[],    // ADR file names added under docs/adr at
 *                                                // any commit reachable from the repository's
 *                                                // refs, renamed-away names included
 * ): AdrRecordLinkResult                         // the shape adr-record-links.ts returns
 *
 * checkRepositoryAdrLedgerLinks(root: string): AdrRecordLinkResult
 * ```
 *
 * A target is read from the same three inline shapes `checkAdrRecordLinks` reads
 * (a bare `](target)`, a titled `](target "title")` and an angle-bracket
 * `](<target>)`), a `#fragment` is stripped for resolution and kept in the
 * report, and a link shape inside a fenced block or an inline code span is
 * prose. Only a same-directory `ADR-*.md` file name is a target: an external
 * URL, an anchor, a `README.md` link and a path-bearing `./ADR-….md` target are
 * not record files and are never counted.
 *
 * Then, per target, in this order:
 *
 * 1. the leaf is in `adrFileNames` → it resolves, no issue;
 * 2. the leaf is **not** in `adrFileNames` but **is** in `everAddedAdrFileNames`
 *    → it was renamed away and the ledger may describe it, no issue;
 * 3. neither → one `dangling-reference` issue, with `file` the ledger's own path,
 *    the 1-based `line`, and `target` as written.
 *
 * `checkedLinks` counts the targets the rule evaluated in classes 1–3, so a
 * report that says "no issue" also says how much it read; `scannedRecords` is
 * `1`, because the ledger is one document. Together they are the non-vacuity
 * bound: a check that returns `ok: true` by sweeping nothing fails both.
 *
 * **`checkRepositoryAdrLedgerLinks` reads the real tree.** It takes the file
 * names present in `<root>/docs/adr`, the text of
 * `<root>/docs/adr/README.md`, and the history set from `root`'s own git
 * objects, so a fixture repository drives the tolerance with the commits it
 * really carries — never with a hardcoded list of the three ledger names.
 * A root with no `docs/adr/README.md` **throws** (`ENOENT`) rather than
 * reporting a vacuous pass.
 *
 * **The census, measured at the branch cut (`origin/main` `1c2d519f`).** The
 * real ledger carries **875** ADR-shaped link targets (28 external `https://`
 * links are not targets), and exactly **three** of them dangle:
 *
 * ```
 * docs/adr/README.md -> 0769-op129-anonymous-attendee-sessions-red.md
 * docs/adr/README.md -> 0770-op129-anonymous-attendee-sessions-green.md
 * docs/adr/README.md -> 0820-op132-confirm-transaction-failure-pin.md
 * ```
 *
 * Those three are the pre-rename class the ADR-0302 (vi) exclusion protects
 * (0769/0770 are the OP-129 RED/GREEN draft names, 0820 was renamed), and the
 * delivery's own typo — the fourth dangling line the review measured at
 * `2a688e25` — is repaired and merged, so the **never-existed class on the trunk
 * is empty**. The real-tree cases assert the **membership** (the three target
 * strings, and the empty report), not a count: the 875 is pinned as a floor with
 * headroom, because a prose repair that replaces a link with its record's name
 * is legitimate and lowers the count by a few (record `0860` §4: name no
 * constant a future record will move).
 *
 * **One correction to the card, measured not assumed — the history set is
 * clone-dependent, and that decides the oracle.** The card names
 * `git rev-list --objects --all -- docs/adr` as the discriminator. Measured at
 * this branch cut: the three pre-rename names are **not** reachable from
 * `origin/main` at all (`git rev-list --objects origin/main` matches none of
 * them) — they were added on lane branches and squash-merged away, so they live
 * only on the still-existing `origin` branch refs. In this checkout `--all` sees
 * 545 ADR names and all three are among them; the `ci` job checks out at the
 * default `fetch-depth: 1`, where `--all` sees one commit and the set is empty.
 * A git-only oracle therefore reports the three pre-rename names as issues in
 * CI while reporting the ledger clean locally — a guard that reds the trunk it
 * is supposed to accept. The cases below pin the **observable** the card asks
 * for (a renamed name is tolerated in a repository whose commits carry it; the
 * real ledger reports nothing), not the mechanism, so the implementation must
 * choose a source that survives a shallow checkout. A committed record of the
 * ledger's pre-rename names, unioned with the git set, satisfies both: case
 * `tolerates a target the fixture history renamed away` still rejects a pure
 * hardcoded list, because that fixture's name is synthetic.
 *
 * **The records half does not regress.** `checkRepositoryAdrLinks` keeps
 * sweeping `docs/adr/ADR-*.md` and never the ledger: a README typo is not
 * counted by it (`checkedLinks: 0` in the fixture below) while a dangling link
 * inside a record is still an issue. Both directions are pinned here as well as
 * in `adr-record-links.test.ts`, so a fix that widens the record sweep reddens
 * two files, not one.
 *
 * **Ordering.** `issues` is sorted by `file`, then `line`, then `target`, so the
 * same ledger input in any order produces one report.
 *
 * **Out of scope, stated so it is not mistaken for a gap.** The four dangling
 * lines are not repaired here (PR #754 repaired its own; the three historical
 * ones are history and must stay); reference-style links and bare autolinks stay
 * unread, exactly as in the record sweep; a `#fragment` inside a ledger target is
 * not exercised because the ledger carries none at this head; and the git
 * command, its failure modes and a missing `docs/adr` directory are the
 * implementation's choice — only a missing `docs/adr/README.md` is pinned, and it
 * throws.
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  makeTempRepoRoot,
  realAdrDir,
  repoRoot,
  tempDirs,
  writeFixtureFile,
} from "../helpers/adr-guard-fixtures.js";
import type { AdrRecordLinkFileText, AdrRecordLinkIssue } from "../helpers/adr-guard-types.js";
import { checkAdrLedgerLinks, checkRepositoryAdrLedgerLinks } from "../helpers/adr-ledger-links.js";
import { checkRepositoryAdrLinks } from "../helpers/adr-record-links.js";
import { readDirectoryEntries, readTextFile } from "../helpers/adr-source-references.js";

/**
 * Compile-time pin of the issue discriminant: the ledger sweep reports the same
 * `dangling-reference` code the record sweep and the source sweep use, so an
 * implementation that invents a second code for the same defect fails `tsc`.
 */
const danglingLinkCode: AdrRecordLinkIssue["code"] = "dangling-reference";

// Fixture record names, named once so each line stays readable. The numbers are
// real records' numbers on purpose: the rule keys on the whole file name, never
// on the digits.
const fixture0300Alpha = "ADR-0300-alpha.md"; // adr-fixture: fixture record name
const fixture0300Renamed = "ADR-0300-alpha-renamed.md"; // adr-fixture: fixture record name
const fixture0301Missing = "ADR-0301-missing.md"; // adr-fixture: no such docs/adr file
const fixture0877Record = "ADR-0877-op137-delivery-receipts-green.md"; // adr-fixture: fixture record name
const fixture0884Record = "ADR-0884-op137-receipt-hygiene.md"; // adr-fixture: fixture record name

/** The delivery's own typo: no file of this name ever existed on any surface. */
const fixture0884Typo = "ADR-0884-op137-receipt-hygiene-pins.md"; // adr-fixture: the never-existed target

/**
 * The ledger's three pre-rename targets at this head — the class the ADR-0302
 * (vi) exclusion protects. Each was added under that name and renamed later, so
 * an empty history set reports them and the real history set does not.
 */
const ledgerPreRenameTargets = [
  "ADR-0769-op129-anonymous-attendee-sessions-red.md", // adr-fixture: pre-rename ledger target
  "ADR-0770-op129-anonymous-attendee-sessions-green.md", // adr-fixture: pre-rename ledger target
  "ADR-0820-op132-confirm-transaction-failure-pin.md", // adr-fixture: pre-rename ledger target
];

/** The ledger as the sweep reads it: its repo-relative path, never a bare name. */
const ledgerPath = "docs/adr/README.md";

/** One ledger document built from its lines. */
function ledgerFile(lines: string[]): AdrRecordLinkFileText {
  return { path: ledgerPath, text: lines.join("\n") };
}

/** The real ledger's text, read from this checkout. */
function realLedgerFile(): AdrRecordLinkFileText {
  return { path: ledgerPath, text: readTextFile(join(realAdrDir, "README.md")) };
}

/** The file names a `docs/adr` directory carries, in any order. */
function adrFileNamesIn(dir: string): string[] {
  return readDirectoryEntries(dir)
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

/**
 * Run one git command in a fixture repository with a fixed identity and no
 * signing, so a developer's global config cannot change what the fixture
 * history is.
 */
function git(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ADR ledger fixture",
      GIT_AUTHOR_EMAIL: "adr-ledger-fixture@example.invalid",
      GIT_COMMITTER_NAME: "ADR ledger fixture",
      GIT_COMMITTER_EMAIL: "adr-ledger-fixture@example.invalid",
    },
  });
}

/**
 * A throwaway repository with **one real commit** carrying `files`. Later cases
 * add their own commits (`git mv`, a second `git add` + `git commit`), which is
 * what makes the tolerance history-driven rather than a literal list.
 */
function makeTempGitRepoRoot(files: Record<string, string>): string {
  const root = makeTempRepoRoot(files);
  git(root, ["init", "--quiet"]);
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "-m", "fixture: the base tree"]);
  return root;
}

/* ------------------------------------------------------------------------- *
 * The rule, at the pure seam
 * ------------------------------------------------------------------------- */

describe("checkAdrLedgerLinks — a ledger link resolves, or was renamed", () => {
  it("reports a ledger link to a file that never existed, naming the ledger and the line", () => {
    // Arrange — the delivery's own shape: the record exists, the target differs
    // from it by one suffix, so exact-leaf resolution must reject it.
    const ledger = ledgerFile([
      "# ADR ledger",
      "",
      `- [0877](${fixture0877Record}) — accepted.`, // adr-fixture: fixture record name
      `- [0884](${fixture0884Typo}) — accepted.`, // adr-fixture: the never-existed target
    ]);

    // Act
    const result = checkAdrLedgerLinks(
      ledger,
      [fixture0877Record, fixture0884Record],
      [fixture0884Record]
    );

    // Assert — one issue, on the ledger, quoting the target as written.
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: danglingLinkCode,
          file: ledgerPath,
          line: 4,
          target: fixture0884Typo,
        },
      ],
      checkedLinks: 2,
      scannedRecords: 1,
    });
  });

  it("does not report a target that was renamed away, and counts it as read", () => {
    // Arrange — the 0769/0770/0820 shape: absent now, once added.
    const ledger = ledgerFile([
      `- the 0300 draft [ADR-0300](${fixture0300Alpha}) was renamed.`, // adr-fixture: a renamed-away name
    ]);

    // Act
    const result = checkAdrLedgerLinks(
      ledger,
      [fixture0300Renamed],
      [fixture0300Alpha, fixture0300Renamed]
    );

    // Assert — `checkedLinks: 1` is the load-bearing half: a check that skipped
    // the target would also report no issue.
    expect(result).toEqual({ ok: true, issues: [], checkedLinks: 1, scannedRecords: 1 });
  });

  it("does not report a target whose exact file exists", () => {
    // Arrange — the positive control.
    const ledger = ledgerFile([
      `- [0300](${fixture0300Alpha}) — accepted.`, // adr-fixture: fixture record name
    ]);

    // Act
    const result = checkAdrLedgerLinks(ledger, [fixture0300Alpha], []);

    // Assert
    expect(result).toEqual({ ok: true, issues: [], checkedLinks: 1, scannedRecords: 1 });
  });

  it("does not read a target that is not a same-directory ADR file name", () => {
    // Arrange — an external URL, the ledger itself, a section anchor and a
    // path-bearing relative link: none of them is a record file name.
    const ledger = ledgerFile([
      "- **PR:** [review](https://github.com/yahodu/openpic-webapp/pull/754)",
      "- **Ledger:** [this ledger](README.md), [a section](#ranges), [notes](../notes.md)",
      `- **Draft:** [the draft](./${fixture0300Alpha})`, // adr-fixture: the "./" prefix puts it out of scope
    ]);

    // Act
    const result = checkAdrLedgerLinks(ledger, [fixture0300Alpha], []);

    // Assert — nothing was even counted, so a narrow leaf predicate cannot be
    // mistaken for a clean ledger.
    expect(result).toEqual({ ok: true, issues: [], checkedLinks: 0, scannedRecords: 1 });
  });
});

/* ------------------------------------------------------------------------- *
 * The census on the real ledger
 * ------------------------------------------------------------------------- */

describe("checkAdrLedgerLinks — the real ledger census", () => {
  it("reports no never-existed target on the real ledger, and counts what it read", () => {
    // Arrange — the real bytes, and the three pre-rename names supplied as
    // history (the class the exclusion protects).
    const adrFileNames = adrFileNamesIn(realAdrDir);

    // Act
    const result = checkAdrLedgerLinks(realLedgerFile(), adrFileNames, [
      ...adrFileNames,
      ...ledgerPreRenameTargets,
    ]);

    // Assert — the never-existed class is empty on the trunk (the delivery's own
    // typo is repaired and merged), and the census is a floor with headroom: 875
    // ADR-shaped links measured at `origin/main` `1c2d519f`, a prose repair may
    // lower it by a few.
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.scannedRecords).toBe(1);
    expect(result.checkedLinks).toBeGreaterThanOrEqual(850);
  });

  it("reports exactly the pre-rename names when history is empty, so the tolerance is what keeps them quiet", () => {
    // Arrange — the same real bytes twice: once with the history the ledger
    // describes, once with no history at all.
    const adrFileNames = adrFileNamesIn(realAdrDir);
    const ledger = realLedgerFile();

    // Act
    const withHistory = checkAdrLedgerLinks(ledger, adrFileNames, [
      ...adrFileNames,
      ...ledgerPreRenameTargets,
    ]);
    const withoutHistory = checkAdrLedgerLinks(ledger, adrFileNames, []);

    // Assert — the sweep is identical; only the verdict moves. That is what makes
    // the trunk's clean report a fact about history and not about a narrower
    // read.
    expect(withoutHistory.scannedRecords).toBe(withHistory.scannedRecords);
    expect(withoutHistory.checkedLinks).toBe(withHistory.checkedLinks);
    expect(withHistory.issues).toEqual([]);

    // The ledger really does carry dangling targets ...
    expect(withoutHistory.ok).toBe(false);
    // ... and they are the pre-rename names, asserted as membership because a
    // future ledger note may add a fourth historical name.
    expect(withoutHistory.issues.map(({ target }) => target)).toEqual(
      expect.arrayContaining([...ledgerPreRenameTargets])
    );
    // ... and every one of them is the ledger, never a record.
    expect(new Set(withoutHistory.issues.map(({ file }) => file))).toEqual(new Set([ledgerPath]));
  });
});

/* ------------------------------------------------------------------------- *
 * The rule, at the repository seam — real commits, no literal allowlist
 * ------------------------------------------------------------------------- */

describe("checkRepositoryAdrLedgerLinks — driven by the repository's own commits", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a target the fixture history renamed away, because a commit really added it", () => {
    // Arrange — a synthetic record added under its old name, then renamed by a
    // second commit. A check that answers from a hardcoded list of the three
    // ledger names cannot tolerate this one.
    const root = makeTempGitRepoRoot({
      "docs/adr/README.md": `- **0300:** [the record](${fixture0300Alpha}) is accepted.`, // adr-fixture: a name the fixture renames
      [`docs/adr/${fixture0300Alpha}`]: "# alpha", // adr-fixture: fixture record name
    });
    git(root, ["mv", `docs/adr/${fixture0300Alpha}`, `docs/adr/${fixture0300Renamed}`]); // adr-fixture: the rename commit
    git(root, ["commit", "--quiet", "-m", "fixture: rename 0300"]);

    // Act
    const result = checkRepositoryAdrLedgerLinks(root);

    // Assert — the old name is really gone from the tree, so the tolerance can
    // only come from history ...
    expect(adrFileNamesIn(join(root, "docs/adr")).sort()).toEqual(
      [fixture0300Renamed, "README.md"].sort()
    );
    // ... and the ledger's link to it is neither reported nor skipped.
    expect(result).toEqual({ ok: true, issues: [], checkedLinks: 1, scannedRecords: 1 });
  });

  it("reports a ledger link that no commit ever added, even when the typo has its own commit", () => {
    // Arrange — the record is added by the base commit; the ledger's typo'd link
    // to a `-pins` name arrives in a second commit. Being committed is not the
    // tolerance: the *target* was never a file.
    const root = makeTempGitRepoRoot({
      "docs/adr/README.md": `| [0884](${fixture0884Record}) | the record |`, // adr-fixture: fixture record name
      [`docs/adr/${fixture0884Record}`]: "# receipt hygiene", // adr-fixture: fixture record name
    });
    writeFixtureFile(
      join(root, "docs/adr/README.md"),
      [
        `| [0884](${fixture0884Record}) | the record |`, // adr-fixture: fixture record name
        "",
        `- _The lane's [0884](${fixture0884Typo}) carries the pins._`, // adr-fixture: the never-existed target
      ].join("\n")
    );
    git(root, ["add", "--all"]);
    git(root, ["commit", "--quiet", "-m", "fixture: the typo lands"]);

    // Act
    const result = checkRepositoryAdrLedgerLinks(root);

    // Assert — the repaired link resolves, the typo is reported on its line.
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: danglingLinkCode,
          file: ledgerPath,
          line: 3,
          target: fixture0884Typo,
        },
      ],
      checkedLinks: 2,
      scannedRecords: 1,
    });
  });

  it("throws an ENOENT error when the repository has no docs/adr/README.md", () => {
    // Arrange — a wrong root must fail loudly, never pass vacuously.
    const root = makeTempGitRepoRoot({
      [`docs/adr/${fixture0300Alpha}`]: "# alpha", // adr-fixture: fixture record name
    });

    // Act + Assert
    expect(() => checkRepositoryAdrLedgerLinks(root)).toThrow(
      expect.objectContaining({ code: "ENOENT" })
    );
  });

  it("reports the real repository's ledger clean", () => {
    // Arrange + Act — the whole tree, the whole history this checkout carries.
    const result = checkRepositoryAdrLedgerLinks(repoRoot);

    // Assert — the never-existed class is empty and the census is non-vacuous.
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.scannedRecords).toBe(1);
    expect(result.checkedLinks).toBeGreaterThanOrEqual(850);
  });
});

/* ------------------------------------------------------------------------- *
 * The records half stays exactly as delivered
 * ------------------------------------------------------------------------- */

describe("checkRepositoryAdrLinks — the record sweep is unchanged", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not count or report the ledger's links", () => {
    // Arrange — the ledger carries the typo; the one record carries no link.
    const root = makeTempGitRepoRoot({
      "docs/adr/README.md": `- _The lane's [0884](${fixture0884Typo}) carries the pins._`, // adr-fixture: the never-existed target
      [`docs/adr/${fixture0884Record}`]: "# receipt hygiene", // adr-fixture: fixture record name
    });

    // Act
    const result = checkRepositoryAdrLinks(root);

    // Assert — `checkedLinks: 0` is the sharp half: the record sweep must not
    // even count the ledger's targets.
    expect(result).toEqual({ ok: true, issues: [], checkedLinks: 0, scannedRecords: 1 });
  });

  it("still reports a dangling link inside a record", () => {
    // Arrange — the half that is green today and must stay green.
    const root = makeTempGitRepoRoot({
      [`docs/adr/${fixture0300Alpha}`]: `- **See:** [the record](${fixture0301Missing})`, // adr-fixture: no such docs/adr file
    });

    // Act
    const result = checkRepositoryAdrLinks(root);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: danglingLinkCode,
          file: `docs/adr/${fixture0300Alpha}`,
          line: 1,
          target: fixture0301Missing,
        },
      ],
      checkedLinks: 1,
      scannedRecords: 1,
    });
  });
});
