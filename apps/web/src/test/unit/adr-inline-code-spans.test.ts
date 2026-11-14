import { rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRepoRoot, repoRoot, tempDirs } from "../helpers/adr-guard-fixtures.js";
import {
  checkMarkdownInlineCodeDelimiters,
  checkRepositoryInlineCodeDelimiters,
  type MarkdownFileText,
} from "../helpers/adr-inline-code-spans.js";

/**
 * Guard — no markdown file in this repository may carry an **escaped inner
 * backtick**, i.e. the byte pair backslash + `` ` `` used as an inline-code
 * delimiter. This spec is the durable home of the rationale: **no ADR number is
 * minted for it** (a doc-only sweep would have needed one in flight, and this
 * guard family keeps its per-invariant rationale in the spec that pins it).
 *
 * **Why a textual guard exists — the prettier trap.** `prettier@3.9.9` reads
 * `` \` `` inside a single-backtick inline code span as a *closing* delimiter,
 * so while that construct is present in a paragraph it **drops the spaces
 * adjacent to every inline code span in that paragraph**: word and code blur
 * into `profile`/`answered`/`""`/`"/e//gallery"` wherever the prose had a space
 * at a span boundary. Measured on the record that carries `0822` §Context: with
 * the intended spaces restored and the pre-`585` escaped delimiters in place,
 * `prettier` re-glues four boundaries; switch that one span to
 * **double-backtick** delimiters and the same paragraph comes back
 * byte-unchanged.
 *
 * **The fixpoint trap — why `--check` cannot catch it.** The glued text is a
 * *stable prettier fixpoint*: running `prettier` on the already-damaged file
 * changes nothing, and `node node_modules/prettier/bin/prettier.cjs --check`
 * reports it clean. That is how the defect shipped, and why every formatter
 * gate in this repository is blind to it. Only a byte-level scan can see it, so
 * the construct is banned outright and an author who needs a literal backtick
 * inside a code span must widen the delimiters (`` ``…`…`` ``) or use a fence.
 *
 * **Contract pinned here** (RED and GREEN must not diverge):
 *
 * ```
 * interface MarkdownFileText { path: string; text: string }
 * interface EscapedBacktickIssue {
 *   code: "escaped-backtick";
 *   file: string;   // repo-relative POSIX path, e.g. "docs/adr/README.md"
 *   line: number;   // 1-based line of the backslash
 *   column: number; // 1-based column of the backslash, in characters
 * }
 * checkMarkdownInlineCodeDelimiters(files: readonly MarkdownFileText[])
 *   : { ok: boolean; issues: EscapedBacktickIssue[]; occurrences: number;
 *       fencedOccurrences: number; scannedFiles: number; checkedLines: number }
 * checkRepositoryInlineCodeDelimiters(root: string): same report
 * ```
 *
 * **The rule.** One issue per **occurrence** of the byte pair backslash +
 * `` ` `` on a prose line, sorted file → line → column, so the report is
 * input-order independent and a line carrying three escaped delimiters reports
 * three places to fix. `occurrences` counts *every* pair the sweep saw,
 * including the ones inside a fenced block; `fencedOccurrences` is that subset,
 * so `issues.length + fencedOccurrences === occurrences` always holds and
 * "`occurrences` went up but nothing was reported" is legible instead of
 * mysterious.
 *
 * **Fences are code, not inline spans** — the decision this card left open, and
 * it is pinned both ways below. A **matched** fenced block (``` or `~~~`, either
 * delimiter, at any indentation — a fence nested in a list item is indented by
 * the container's width — closed by a run of the same character at least as long
 * as the opening run) is *not* prose, so an escaped backtick inside it is never
 * an issue: that is the CommonMark reading, and it is where a shell snippet
 * legitimately needs `` \` `` to suppress command substitution. A backtick run
 * shorter than the opening run inside it is content rather than a close.
 *
 * An **unmatched** opening fence is not a fence at all: its lines stay prose, so
 * one dropped closing delimiter cannot silence the rest of a file. CommonMark
 * would run such a block to the end of the document, but a guard that copied
 * that rule could be defeated by a single missing fence line — the defect
 * class this pin exists for — so the guard fails loud instead. Only **fenced**
 * blocks are recognised: an indented (four-space) code block is read as prose,
 * which is a deliberate limitation — this repository's records use fences.
 *
 * **Sweep scope.** `checkRepositoryInlineCodeDelimiters` walks every `*.md` file
 * under the root — `docs/**` (records, ledger and the four design documents),
 * root-level files such as `AGENTS.md`, `.github/`, `scripts/`, `apps/**` and
 * `packages/**` — because `.prettierrc` plus `lint-staged` format **every**
 * staged `*.md` in the repository, so every one of them is exposed to the same
 * trap. The skipped directory names mirror `.prettierignore` (`node_modules`,
 * `.next`, `dist`, `coverage`, `playwright-report`, `test-results`) plus the
 * repository's own `.git`, `.worktrees`, `.turbo` and `build`, so a build
 * artifact or a dependency's README can never be counted and the result does
 * not depend on whether a build ran.
 *
 * **Assumptions resolved in this spec** (flagged in the handoff):
 *   - An escaped backtick *outside* a fence is banned in prose **and** inside an
 *     inline span, whatever the author meant. Inside a single-backtick span it
 *     is the prettier trap; outside a span it renders a literal backtick, which
 *     is the CommonMark way to write one; inside a double-backtick span it can
 *     be literal shell text (`echo \`id\``). So the two sanctioned alternatives
 *     are a **fenced block**, or **dropping the escape** where the meaning
 *     allows (`` ``…`…`` ``). An earlier revision of this bullet claimed the
 *     pair was "always wrong … nothing legitimate needs it in prose", which was
 *     too strong: the two characterization rows at the end of the rule block pin
 *     the shapes that are reported although prettier leaves them byte-stable.
 *   - `column` is the 1-based character offset of the **backslash** — the first
 *     byte of the pair — so a report can be pasted into an editor's gutter.
 *   - The sweep root is the repository root the spec derives from its own
 *     `import.meta.url`, so the pin follows the worktree it runs in.
 *   - The real-tree arm asserts the occurrence count **and** the empty issue
 *     list **and** two non-vacuity floors (`scannedFiles`, `checkedLines`), so a
 *     walk that reads nothing can never pass as "clean". Should a future record
 *     legitimately need `` \` `` inside a fence, `fencedOccurrences` moves and
 *     the rule stays intact — that is the re-baseline path, and it is visible
 *     in the report rather than hidden behind a loosened assertion.
 *   - Fixture record paths carry the bare number (`0662-invitation-links.md`)
 *     rather than an `ADR-NNNN-` name: this spec's own source is swept by the
 *     citation guards for `ADR-`-prefixed tokens, so a fixture that spelled one
 *     would have to cite a real record. This spec cites no record, by design.
 *
 * **Open design question, not answered here.** Should a double-backtick span's
 * content be exempt from the ban — which needs span parsing — or stay banned, as
 * it is today under a cheap byte scan? This card pins the behaviour that exists,
 * so the answer belongs to an orchestrator decision, not to an edit here.
 */

describe("checkMarkdownInlineCodeDelimiters — the escaped-delimiter rule", () => {
  it("accepts a record with no escaped backtick", () => {
    // Arrange — plain prose, a single-backtick span and a double-backtick span:
    // the three shapes a compliant record uses.
    const files: MarkdownFileText[] = [
      {
        path: "docs/adr/ledger.md",
        text: [
          "# Record",
          "",
          "The field `epochSeconds` is a number.",
          "",
          '``item.slug === "" ? "" : `/e/${item.slug}/gallery` ``',
        ].join("\n"),
      },
    ];

    // Act
    const result = checkMarkdownInlineCodeDelimiters(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      issues: [],
      occurrences: 0,
      fencedOccurrences: 0,
      scannedFiles: 1,
      checkedLines: 5,
    });
  });

  it("reports the invitations-link shape with its file, 1-based line and column", () => {
    // Arrange — the shape that shipped in `0662`: an escaped backtick used as
    // both the opening and the closing delimiter of a span whose content itself
    // holds backticks. Four occurrences on one line, so the report must name
    // four columns rather than swallow the line.
    const files: MarkdownFileText[] = [
      {
        path: "docs/adr/0662-invitation-links.md",
        text: ["# Record", "", "add \\`link: \\`${baseUrl}/invitations/${token}\\`\\`"].join("\n"),
      },
    ];

    // Act
    const result = checkMarkdownInlineCodeDelimiters(files);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "escaped-backtick",
          file: "docs/adr/0662-invitation-links.md",
          line: 3,
          column: 5,
        },
        {
          code: "escaped-backtick",
          file: "docs/adr/0662-invitation-links.md",
          line: 3,
          column: 13,
        },
        {
          code: "escaped-backtick",
          file: "docs/adr/0662-invitation-links.md",
          line: 3,
          column: 46,
        },
        {
          code: "escaped-backtick",
          file: "docs/adr/0662-invitation-links.md",
          line: 3,
          column: 48,
        },
      ],
      occurrences: 4,
      fencedOccurrences: 0,
      scannedFiles: 1,
      checkedLines: 3,
    });
  });

  it("reports one issue per occurrence across files, ordered file then line then column", () => {
    // Arrange — two files in reverse order, each with two or more offenders, so
    // both the per-occurrence count and the ordering are load-bearing.
    const files: MarkdownFileText[] = [
      {
        path: "docs/b.md",
        text: ["# B", "A \\`x\\` and \\`y\\`"].join("\n"),
      },
      {
        path: "apps/web/x.md",
        text: "a \\`b\\`",
      },
    ];

    // Act
    const result = checkMarkdownInlineCodeDelimiters(files);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: "escaped-backtick", file: "apps/web/x.md", line: 1, column: 3 },
        { code: "escaped-backtick", file: "apps/web/x.md", line: 1, column: 6 },
        { code: "escaped-backtick", file: "docs/b.md", line: 2, column: 3 },
        { code: "escaped-backtick", file: "docs/b.md", line: 2, column: 6 },
        { code: "escaped-backtick", file: "docs/b.md", line: 2, column: 13 },
        { code: "escaped-backtick", file: "docs/b.md", line: 2, column: 16 },
      ],
      occurrences: 6,
      fencedOccurrences: 0,
      scannedFiles: 2,
      checkedLines: 3,
    });
  });

  it("stays silent on a double-backtick span that holds single backticks", () => {
    // Arrange — the sanctioned way to put a backtick inside a code span: two
    // delimiters each side, which prettier leaves byte-stable.
    const files: MarkdownFileText[] = [
      {
        path: "docs/adr/0822-record.md",
        text: '``item.slug === "" ? "" : `/e/${item.slug}/gallery` ``',
      },
    ];

    // Act
    const result = checkMarkdownInlineCodeDelimiters(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      issues: [],
      occurrences: 0,
      fencedOccurrences: 0,
      scannedFiles: 1,
      checkedLines: 1,
    });
  });

  it("stays silent on a plain single-backtick span", () => {
    // Arrange
    const files: MarkdownFileText[] = [{ path: "docs/a.md", text: "The `epochSeconds` field." }];

    // Act
    const result = checkMarkdownInlineCodeDelimiters(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      issues: [],
      occurrences: 0,
      fencedOccurrences: 0,
      scannedFiles: 1,
      checkedLines: 1,
    });
  });

  it("does not report an escaped backtick inside a fenced block, and counts it as fenced", () => {
    // Arrange — the decision this card left open, pinned: fences are code, so
    // the pair is silent there, and `occurrences` still counts it so the skip is
    // visible instead of invisible.
    const files: MarkdownFileText[] = [
      {
        path: "docs/adr/0662-invitation-links.md",
        text: [
          "# Record",
          "",
          "Run this:",
          "",
          "```sh",
          'curl -H "X-Note: \\`not a span\\`" "$URL"',
          "```",
          "",
          "The end.",
        ].join("\n"),
      },
    ];

    // Act
    const result = checkMarkdownInlineCodeDelimiters(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      issues: [],
      occurrences: 2,
      fencedOccurrences: 2,
      scannedFiles: 1,
      checkedLines: 6,
    });
  });

  it.each<[string, string, string]>([
    ["a tilde fence", "~~~", "~~~"],
    ["a four-backtick fence", "````", "````"],
    ["a backtick fence with an info string", "```sh", "```"],
  ])("does not report an escaped backtick inside %s", (_shape, openingFence, closingFence) => {
    // Arrange — the fence delimiter is not pinned to three backticks: a `~~~`
    // block and a longer backtick run are fences too, and the info string does
    // not stop the opening line being a fence.
    const files: MarkdownFileText[] = [
      {
        path: "docs/a.md",
        text: [openingFence, "inside \\`x\\`", closingFence, "after \\`y\\`"].join("\n"),
      },
    ];

    // Act
    const result = checkMarkdownInlineCodeDelimiters(files);

    // Assert — the fenced pair is silent, and the prose pair after the closing
    // fence is reported, so the fence does not latch the scan off.
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: "escaped-backtick", file: "docs/a.md", line: 4, column: 7 },
        { code: "escaped-backtick", file: "docs/a.md", line: 4, column: 10 },
      ],
      occurrences: 4,
      fencedOccurrences: 2,
      scannedFiles: 1,
      checkedLines: 1,
    });
  });

  it("keeps a shorter backtick run inside a longer fence as content", () => {
    // Arrange — a four-backtick fence whose body holds a three-backtick line:
    // the shorter run cannot close the block, so the escaped backtick after it
    // is still fenced, not prose.
    const files: MarkdownFileText[] = [
      {
        path: "docs/a.md",
        text: ["````md", "```", "still fenced \\`x\\`", "````", "prose \\`y\\`"].join("\n"),
      },
    ];

    // Act
    const result = checkMarkdownInlineCodeDelimiters(files);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: "escaped-backtick", file: "docs/a.md", line: 5, column: 7 },
        { code: "escaped-backtick", file: "docs/a.md", line: 5, column: 10 },
      ],
      occurrences: 4,
      fencedOccurrences: 2,
      scannedFiles: 1,
      checkedLines: 1,
    });
  });

  it("does not report an escaped backtick inside a fence indented in a list item", () => {
    // Arrange — a fence nested in a list item is indented by the container's
    // width (`0300` carries one at four spaces), so indentation must not stop a
    // fence being a fence.
    const files: MarkdownFileText[] = [
      {
        path: "docs/a.md",
        text: ["- step:", "", "    ```sh", "    x \\`y\\`", "    ```"].join("\n"),
      },
    ];

    // Act
    const result = checkMarkdownInlineCodeDelimiters(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      issues: [],
      occurrences: 2,
      fencedOccurrences: 2,
      scannedFiles: 1,
      checkedLines: 2,
    });
  });

  it("does not exempt the lines below an opening fence that is never closed", () => {
    // Arrange — an unmatched fence is not a fence: CommonMark would run it to the
    // end of the file, which would let one dropped closing delimiter silence the
    // rest of a record. The pair below it must still be reported.
    const files: MarkdownFileText[] = [
      {
        path: "docs/a.md",
        text: ["```sh", "prose \\`x\\`"].join("\n"),
      },
    ];

    // Act
    const result = checkMarkdownInlineCodeDelimiters(files);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: "escaped-backtick", file: "docs/a.md", line: 2, column: 7 },
        { code: "escaped-backtick", file: "docs/a.md", line: 2, column: 10 },
      ],
      occurrences: 2,
      fencedOccurrences: 0,
      scannedFiles: 1,
      checkedLines: 2,
    });
  });

  it("reports an escaped backtick inside an indented code block (pins current behaviour)", () => {
    // Arrange — a four-space indented code block is read as prose: only fenced
    // blocks are recognised, which the docblock calls a deliberate limitation.
    // The shape is reported although `prettier@3.9.9` leaves it byte-unchanged.
    const files: MarkdownFileText[] = [
      {
        path: "docs/a.md",
        text: ["# Record", "", "    grep -F '\\`' notes.txt", "", "Prose after the block."].join(
          "\n"
        ),
      },
    ];

    // Act
    const result = checkMarkdownInlineCodeDelimiters(files);

    // Assert — one issue at the backslash, and the indent did not silence it.
    expect(result).toEqual({
      ok: false,
      issues: [{ code: "escaped-backtick", file: "docs/a.md", line: 3, column: 14 }],
      occurrences: 1,
      fencedOccurrences: 0,
      scannedFiles: 1,
      checkedLines: 5,
    });
  });

  it("reports an escaped backtick inside a double-backtick span (pins current behaviour)", () => {
    // Arrange — the literal shell form inside a double-backtick span. Widening
    // the delimiters is the sanctioned way to carry a *bare* backtick in a span,
    // but the pair inside the span is still a byte match, so it is reported
    // although `prettier@3.9.9` leaves this line byte-unchanged.
    const files: MarkdownFileText[] = [
      { path: "docs/a.md", text: "Run ``echo \\`id\\` `` to test." },
    ];

    // Act
    const result = checkMarkdownInlineCodeDelimiters(files);

    // Assert — both pairs on the line, inside the span, at the backslashes.
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: "escaped-backtick", file: "docs/a.md", line: 1, column: 12 },
        { code: "escaped-backtick", file: "docs/a.md", line: 1, column: 16 },
      ],
      occurrences: 2,
      fencedOccurrences: 0,
      scannedFiles: 1,
      checkedLines: 1,
    });
  });
});

describe("checkRepositoryInlineCodeDelimiters — the repository sweep", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the repository's markdown as free of escaped backticks", () => {
    // Act — the characterization half of this guard: the tree at this head
    // carries the byte pair nowhere (the seven swept records included).
    const result = checkRepositoryInlineCodeDelimiters(repoRoot);

    // Assert — the count, the empty list, and two non-vacuity floors, so a walk
    // that reads nothing cannot pass as "clean".
    expect(result.issues).toEqual([]);
    expect(result.occurrences).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.scannedFiles).toBeGreaterThanOrEqual(340);
    expect(result.checkedLines).toBeGreaterThanOrEqual(60000);
  });

  it("sweeps markdown at the repository root and in nested trees", () => {
    // Arrange — a root-level README plus a nested docs file.
    const root = makeTempRepoRoot({
      "README.md": "a \\`b\\`",
      "docs/nested/deep.md": "clean prose",
    });

    // Act
    const result = checkRepositoryInlineCodeDelimiters(root);

    // Assert — repo-relative POSIX paths, root-level file included.
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: "escaped-backtick", file: "README.md", line: 1, column: 3 },
        { code: "escaped-backtick", file: "README.md", line: 1, column: 6 },
      ],
      occurrences: 2,
      fencedOccurrences: 0,
      scannedFiles: 2,
      checkedLines: 2,
    });
  });

  it("ignores the trees .prettierignore and the build skip, and non-markdown files", () => {
    // Arrange — every escaped backtick here is outside the sweep's scope.
    const root = makeTempRepoRoot({
      "docs/keep.md": "clean prose",
      "node_modules/pkg/README.md": "a \\`b\\`",
      ".next/cache/page.md": "a \\`b\\`",
      "dist/out.md": "a \\`b\\`",
      "coverage/report.md": "a \\`b\\`",
      "playwright-report/index.md": "a \\`b\\`",
      "test-results/run.md": "a \\`b\\`",
      ".git/NOTES.md": "a \\`b\\`",
      "docs/notes.txt": "a \\`b\\`",
    });

    // Act
    const result = checkRepositoryInlineCodeDelimiters(root);

    // Assert
    expect(result).toEqual({
      ok: true,
      issues: [],
      occurrences: 0,
      fencedOccurrences: 0,
      scannedFiles: 1,
      checkedLines: 1,
    });
  });

  it("throws an ENOENT error when the root does not exist", () => {
    // Arrange — a wrong root must fail loudly, never pass vacuously.
    const root = makeTempRepoRoot({ "docs/a.md": "clean prose" });

    // Act + Assert
    expect(() => checkRepositoryInlineCodeDelimiters(join(root, "missing"))).toThrow(
      expect.objectContaining({ code: "ENOENT" })
    );
  });
});
