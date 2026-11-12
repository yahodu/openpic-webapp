import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRepoRoot, repoRoot, tempDirs } from "../helpers/adr-guard-fixtures.js";
import type { AdrRecordLinkFileText, AdrRecordLinkIssue } from "../helpers/adr-guard-types.js";
import { checkAdrRecordLinks, checkRepositoryAdrLinks } from "../helpers/adr-record-links.js";

/**
 * ADR guard, invariant (vi) — the guard's six invariants are tabulated once, in
 * `ADR-0302` §1. This file owns one of them: every markdown link target inside
 * a `docs/adr/ADR-*.md` record must name a file that exists.
 */
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
 * **Trunk expectation — `ok: true`, with the census as a floor.** The sweep
 * landed as a ratchet over the **32 dangling occurrences of 16 distinct
 * targets** it found in other lanes' records, and the repair that retargeted
 * every one of them retired the list in the same change (the F2 coupling: a
 * ratchet fails on a repair as well as on an add). The real-tree case therefore
 * asserts the empty report, and pins the census as a **floor**, never an
 * equality: a minted record with a `Relates to` line raises `checkedLinks` by
 * design, so an equality pin would couple every ADR to this file — the same
 * friction, one direction over. The floor plus the non-vacuity bounds below are
 * what keep a silently narrowed sweep from passing.
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

/* ------------------------------------------------------------------------- *
 * Invariant (vi) — the link-target shape matrix (review finding F1)
 * ------------------------------------------------------------------------- */

/**
 * Unit contract — invariant (vi), the link-target **shape matrix**: for every
 * markdown link-target shape a record can carry, is the target read, and what
 * does the report say? (Review finding F1 of card `t_e042ab22`.)
 *
 * **Why this exists.** The delivered rule read one shape only. Its pattern was
 * `\]\(([^)\s]+)\)`, which needs `)` immediately after a non-space run, so
 * `](ADR-0700-missing.md "the record")` matched **nothing** — while the same
 * pattern's TSDoc claimed a title "stops before the space". The rule was blind
 * to a whole false-negative class and its documentation said the opposite. The
 * trunk carried no such shape at review time, so closing the gap is cheap now
 * and unbounded later.
 *
 * **IN scope (RED on this branch).** Two shapes must be read, resolve on the
 * exact leaf, and report a dangling target:
 *
 * - a **titled** target — `](ADR-….md "title")` — reported with `target` as
 *   written *minus the title*, so the report still quotes a greppable string;
 * - an **angle-bracket** target — `](<ADR-….md>)` — reported with the brackets
 *   **stripped**, never as `<ADR-….md>`;
 * - a titled target that also carries a `#fragment` keeps the fragment and
 *   loses only the title.
 *
 * Both shapes must also *resolve* when the exact leaf exists, and must be
 * **counted** in `checkedLinks`: `ok: true` alone passes on a rule that
 * silently skips the shape, which is exactly the defect these pins close.
 *
 * **All three markdown title styles are peeled, and pinned.** `linkTarget`
 * strips the angle brackets and then takes the first whitespace-separated
 * token, so a `"title"`, a `'title'` and a `(title)` all leave the leaf behind.
 * The five title-style rows below lock that for every style, bare and
 * angle-bracketed, plus the combined shape `](<ADR-….md> "title")` that crosses
 * both axes. Those rows are **characterisation**: they pass on the trunk today,
 * and they exist so a future "tighten the peel" refactor (e.g. an explicit
 * `/\s+["'(].*$/` strip) cannot silently drop a style with nothing going red.
 *
 * A title's own `)` closes the capture — `](x.md (title))` is read as
 * `x.md (title` — which is why the parenthesised-title rows still report the
 * leaf. That is **not** the out-of-scope case of a *target* containing `(` or
 * `)`: the leaf predicate still rejects such a target, and nothing here widens
 * it.
 *
 * The helper's `MARKDOWN_LINK_TEXT_PATTERN` TSDoc still claims
 * `shortcut: only a double-quoted title is peeled; widen if a record ever uses
 * 'title' or (title)`, which these rows contradict. That comment is helper
 * code, so its correction is a separate behaviour-free card, not a test change.
 *
 * **OUT of scope — stated here, and pinned as out of scope, never left
 * unstated.**
 *
 * - `./ADR-….md` and every other path-bearing target: the leaf predicate
 *   rejects a leaf carrying a path separator, and that stays as delivered. Its
 *   pin lives in the sibling block
 *   `describe("checkAdrRecordLinks — a link target must resolve to a record
 *   file")`, case "does not read a target that is not a same-directory ADR file
 *   name", so this matrix does not re-pin it.
 * - reference-style links — `[label][ref]` plus a `[ref]: ADR-….md` definition —
 *   are not inline `](…)` targets and are not read. Pinned below.
 * - bare autolinks — `<ADR-….md>` — are not inline `](…)` targets and are not
 *   read. Pinned below.
 *
 * **Everything else stays exactly as delivered,** and the remaining rows
 * characterise it rather than change it: `docs/adr/ADR-*.md` records only (never
 * `README.md`), fenced blocks and inline code spans are prose, a target without
 * the `.md` suffix or with a lowercase `adr-` prefix is not a record name, an
 * image link `![alt](ADR-….md)` *is* a target (it navigates), one issue per
 * occurrence sorted by file/line/target, and `#fragment` is stripped for
 * resolution and kept in the report.
 *
 * **Posture.** The titled and angle-bracket rows were RED-by-design on the
 * branch that carried them, and the GREEN card `t_b9d8a27f` turned them green.
 * The title-style and combined-shape rows were added afterwards as
 * **characterisation** of the shipped peel, so they are green on arrival and
 * need no GREEN of their own. Every other row is green in both states, so a fix
 * that reads the shapes by loosening the leaf predicate (case, suffix, path
 * separator) reddens one of them.
 */

/** A leaf no `docs/adr` file carries: a read target must report as dangling. */
const fixtureMissingLeaf = "ADR-0700-missing.md"; // adr-fixture: no such docs/adr file

describe("checkAdrRecordLinks — link-target shapes", () => {
  it("reads the canonical shape and reports the target as written", () => {
    // Arrange — the row every other row is compared against.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        "- **Amends:** [the decision](ADR-0700-missing.md)", // adr-fixture: no such docs/adr file
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard]);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: danglingLinkCode,
          file: `docs/adr/${fixture0302Guard}`,
          line: 1,
          target: fixtureMissingLeaf,
        },
      ],
      checkedLinks: 1,
      scannedRecords: 1,
    });
  });

  it("reads a fragment target, stripping the fragment for resolution and keeping it in the report", () => {
    // Arrange
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        "- **See:** [the decision](ADR-0700-missing.md#decision)", // adr-fixture: no such docs/adr file
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard]);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: danglingLinkCode,
          file: `docs/adr/${fixture0302Guard}`,
          line: 1,
          target: `${fixtureMissingLeaf}#decision`,
        },
      ],
      checkedLinks: 1,
      scannedRecords: 1,
    });
  });

  it("reads an image link, because an image target navigates like a text link", () => {
    // Arrange
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        "- **Diagram:** ![the decision](ADR-0700-missing.md)", // adr-fixture: no such docs/adr file
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard]);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: danglingLinkCode,
          file: `docs/adr/${fixture0302Guard}`,
          line: 1,
          target: fixtureMissingLeaf,
        },
      ],
      checkedLinks: 1,
      scannedRecords: 1,
    });
  });

  it("reads a titled target and reports it with the title removed", () => {
    // Arrange — F1: the delivered pattern needs `)` right after a non-space run,
    // so this line matched nothing and the dangling target stayed invisible.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        '- **Amends:** [the decision](ADR-0700-missing.md "the record")', // adr-fixture: no such docs/adr file
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard]);

    // Assert — read, and reported as written minus the title.
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: danglingLinkCode,
          file: `docs/adr/${fixture0302Guard}`,
          line: 1,
          target: fixtureMissingLeaf,
        },
      ],
      checkedLinks: 1,
      scannedRecords: 1,
    });
  });

  it("reads an angle-bracket target and reports it with the brackets stripped", () => {
    // Arrange — F1: the brackets put the leaf off the `ADR-` prefix, so the
    // delivered rule dropped the line before it could look at the leaf.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        "- **Amends:** [the decision](<ADR-0700-missing.md>)", // adr-fixture: no such docs/adr file
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard]);

    // Assert — the reported target is the leaf, never `<ADR-0700-missing.md>`.
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: danglingLinkCode,
          file: `docs/adr/${fixture0302Guard}`,
          line: 1,
          target: fixtureMissingLeaf,
        },
      ],
      checkedLinks: 1,
      scannedRecords: 1,
    });
  });

  it("reads a titled target that carries a fragment, dropping the title and keeping the fragment", () => {
    // Arrange — both axes at once, so removing the title cannot eat the fragment.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        '- **See:** [the decision](ADR-0700-missing.md#decision "the record")', // adr-fixture: no such docs/adr file
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard]);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: danglingLinkCode,
          file: `docs/adr/${fixture0302Guard}`,
          line: 1,
          target: `${fixtureMissingLeaf}#decision`,
        },
      ],
      checkedLinks: 1,
      scannedRecords: 1,
    });
  });

  it("reads a single-quoted title and reports the target with the title removed", () => {
    // Arrange — the peel takes the first whitespace-separated token, so every
    // markdown title style leaves the leaf; this row locks the single-quoted one.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        "- **Amends:** [the decision](ADR-0700-missing.md 'the record')", // adr-fixture: no such docs/adr file
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard]);

    // Assert — read, and reported as written minus the title.
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: danglingLinkCode,
          file: `docs/adr/${fixture0302Guard}`,
          line: 1,
          target: fixtureMissingLeaf,
        },
      ],
      checkedLinks: 1,
      scannedRecords: 1,
    });
  });

  it("reads a parenthesised title and reports the target with the title removed", () => {
    // Arrange — the title's own `)` closes the capture, so the reported target
    // is still the leaf and the stray `(` never reaches it.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        "- **Amends:** [the decision](ADR-0700-missing.md (the record))", // adr-fixture: no such docs/adr file
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard]);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: danglingLinkCode,
          file: `docs/adr/${fixture0302Guard}`,
          line: 1,
          target: fixtureMissingLeaf,
        },
      ],
      checkedLinks: 1,
      scannedRecords: 1,
    });
  });

  it("reads the combined angle-bracket and double-quoted title shape and reports the leaf", () => {
    // Arrange — both in-scope axes at once: bracketed target plus a title.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        '- **Amends:** [the decision](<ADR-0700-missing.md> "the record")', // adr-fixture: no such docs/adr file
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard]);

    // Assert — neither the brackets nor the title reaches the report.
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: danglingLinkCode,
          file: `docs/adr/${fixture0302Guard}`,
          line: 1,
          target: fixtureMissingLeaf,
        },
      ],
      checkedLinks: 1,
      scannedRecords: 1,
    });
  });

  it("reads an angle-bracket target with a single-quoted title and reports the leaf", () => {
    // Arrange — the bracket peel must not depend on which quote the title uses.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        "- **Amends:** [the decision](<ADR-0700-missing.md> 'the record')", // adr-fixture: no such docs/adr file
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard]);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: danglingLinkCode,
          file: `docs/adr/${fixture0302Guard}`,
          line: 1,
          target: fixtureMissingLeaf,
        },
      ],
      checkedLinks: 1,
      scannedRecords: 1,
    });
  });

  it("reads an angle-bracket target with a parenthesised title and reports the leaf", () => {
    // Arrange
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        "- **Amends:** [the decision](<ADR-0700-missing.md> (the record))", // adr-fixture: no such docs/adr file
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard]);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: danglingLinkCode,
          file: `docs/adr/${fixture0302Guard}`,
          line: 1,
          target: fixtureMissingLeaf,
        },
      ],
      checkedLinks: 1,
      scannedRecords: 1,
    });
  });

  it("accepts and counts a titled target whose exact record file exists", () => {
    // Arrange — the over-reporter guard: reading the new shape must not turn a
    // resolving link into an issue, and `checkedLinks` proves it was read.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        `- **Amends:** [ADR-0781](${fixture0781Green} "the green record")`, // adr-fixture: fixture record name
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard, fixture0781Green]);

    // Assert
    expect(result).toEqual({ ok: true, issues: [], checkedLinks: 1, scannedRecords: 1 });
  });

  it("accepts and counts an angle-bracket target whose exact record file exists", () => {
    // Arrange — the same over-reporter guard for the bracket shape.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        `- **Amends:** [ADR-0781](<${fixture0781Green}>)`, // adr-fixture: fixture record name
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard, fixture0781Green]);

    // Assert
    expect(result).toEqual({ ok: true, issues: [], checkedLinks: 1, scannedRecords: 1 });
  });

  it("does not read a reference-style link or its definition", () => {
    // Arrange — out of scope, stated in this block's docblock: only inline
    // `](…)` targets are read.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        "- **Amends:** [the decision][the-record]", // adr-fixture: reference-style, out of scope
        "",
        `[the-record]: ${fixtureMissingLeaf}`, // adr-fixture: reference definition, out of scope
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard]);

    // Assert — nothing was evaluated, so nothing is reported.
    expect(result).toEqual({ ok: true, issues: [], checkedLinks: 0, scannedRecords: 1 });
  });

  it("does not read a bare autolink", () => {
    // Arrange — out of scope, stated in this block's docblock.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        "- **Amends:** <ADR-0700-missing.md>", // adr-fixture: bare autolink, out of scope
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard]);

    // Assert
    expect(result).toEqual({ ok: true, issues: [], checkedLinks: 0, scannedRecords: 1 });
  });

  it("does not read a target whose `ADR-` prefix is lowercase", () => {
    // Arrange — the leaf predicate is case-sensitive, and that stays as
    // delivered: a fix that reads the new shapes must not widen it.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        "- **Amends:** [the decision](adr-0700-missing.md)", // adr-fixture: lowercase prefix, not a record name
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard]);

    // Assert
    expect(result).toEqual({ ok: true, issues: [], checkedLinks: 0, scannedRecords: 1 });
  });

  it("does not read a target without the `.md` suffix", () => {
    // Arrange — a `.md`-less target is not a record file name, and that stays
    // as delivered.
    const records: AdrRecordLinkFileText[] = [
      adrRecordFile(fixture0302Guard, [
        "- **Amends:** [the decision](ADR-0700-missing)", // adr-fixture: no .md suffix, not a record name
      ]),
    ];

    // Act
    const result = checkAdrRecordLinks(records, [fixture0302Guard]);

    // Assert
    expect(result).toEqual({ ok: true, issues: [], checkedLinks: 0, scannedRecords: 1 });
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

  it("reports the whole repository tree clean and pins the census as a floor, never an equality", () => {
    // Act
    const result = checkRepositoryAdrLinks(repoRoot);

    // Assert — non-vacuity first: the sweep must see the whole record population,
    // not a narrow slice of it.
    expect(result.scannedRecords).toBeGreaterThanOrEqual(250);
    expect(result.checkedLinks).toBeGreaterThanOrEqual(800);

    // The inherited debt — 32 occurrences of 16 distinct targets — was repaired
    // record by record, so the honest end state is the empty report. The ratchet
    // is retired, not re-pinned: a new dangling link fails here, and the bounds
    // above keep a silently narrowed sweep from passing vacuously.
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);

    // Anti-shrink floor — the drift-free replacement for the retired
    // `checkedLinks: 881` equality. 881 is the census at the retirement; minting
    // a record raises it and a record with no link leaves it unchanged, so an
    // added ADR no longer reddens this case. It fails only if the sweep reads
    // less than it read then — a narrowed sweep, or records deleted in bulk.
    expect(result.checkedLinks).toBeGreaterThanOrEqual(881);
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
