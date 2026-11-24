/**
 * ADR guard, invariant (viii) — a stated count of the merge-gate conditions must
 * equal the `G1…Gk` enumeration it introduces (finding F2 of the review of
 * `t_76d10c5d`). The guard's invariants are tabulated once, in `0302`
 * (`## Decision`, the invariant table), and that row is this invariant's whole
 * decision record: the rule below states it.
 *
 * The ADR-0318 ledger note in `docs/adr/README.md` read "seven conditions on the
 * exact head SHA" while enumerating only **G1–G6** for a day, and the whole
 * suite was green: no invariant read a count phrase at all, so a *number in
 * prose* and the *enumeration under it* could disagree indefinitely. PR #902
 * (squash `d7ca197f`) repaired the note; this invariant is what stops the next
 * drift. A reader who counts six gates where the text promises seven cannot
 * tell which gate is missing, and a lander who skips the seventh merges with the
 * gate unrun.
 *
 * The rule is textual, exactly as (vii)'s is: a count phrase is a **number word
 * or a digit run followed by the word `conditions`** — `seven conditions`,
 * `7 conditions`. Only that phrase is a count phrase, never a bare number word,
 * because §9.1 legitimately says "the eleven gating names" inside G3 and a loose
 * matcher would read eleven conditions where the text states seven. The
 * enumeration is read from the phrase's own **window**: its paragraph, extended
 * through the block that follows when the paragraph ends with a colon (§9.1
 * states the count and introduces the bullet list below it). A count phrase whose
 * window carries no `G` token introduces no enumeration and is skipped, never
 * guessed — the report's `checked` list is what proves the silence was not a
 * narrow read. See {@link checkGateConditionCounts} and
 * {@link checkRepositoryGateConditionCounts}.
 */

import { join } from "node:path";

import type { SourceFileText } from "./adr-guard-types.js";
import { compareStrings } from "./adr-guard-types.js";
import { readTextFile } from "./adr-source-references.js";

/**
 * One gate-condition defect.
 *
 * `count-mismatch` — the highest `G` token in the window is not the stated
 * count; `sequence-gap` — a gate number in `1..highest` is missing from the
 * enumeration; `count-disagreement` — this phrase states a different count than
 * the run's first phrase in report order, so two statements of the one gate
 * disagree and `expected` quotes the count this one is measured against (the
 * report names one side and quotes both, so the reviewer decides which is the
 * drift). The phrase is carried **as written** so the failure message can be
 * pasted into a search, and `line` is 1-based so it matches an editor's gutter.
 */
export interface GateConditionIssue {
  /** The defect family; the discriminant for this issue family. */
  code: "count-disagreement" | "count-mismatch" | "sequence-gap";

  /** Repo-relative POSIX path of the markdown that states the count. */
  file: string;

  /** 1-based line number of the count phrase. */
  line: number;

  /** The phrase as written, e.g. `"seven conditions"`. */
  stated: string;

  /** The count the phrase states: `"seven"` → 7. */
  declared: number;

  /** The highest `G` number enumerated in the phrase's window. */
  highest: number;

  /** Gate numbers absent from `1..highest`; `[]` for the two count-* families. */
  missing: number[];

  /** For `count-disagreement`, the first phrase's count; `null` otherwise. */
  expected: number | null;
}

/**
 * One count phrase the rule evaluated: the window carried at least one `G`
 * token, so the phrase introduced an enumeration and was checked. A phrase that
 * introduced none is not listed.
 */
export interface GateConditionCheck {
  /** Repo-relative POSIX path of the markdown that states the count. */
  file: string;

  /** 1-based line number of the count phrase. */
  line: number;

  /** The phrase as written, e.g. `"seven conditions"`. */
  stated: string;

  /** The count the phrase states. */
  declared: number;

  /** The highest `G` number enumerated in the phrase's window. */
  highest: number;
}

/** The report shape returned by both entry points. */
export interface GateConditionResult {
  /** `true` exactly when {@link GateConditionResult.issues} is empty. */
  ok: boolean;

  /**
   * The defects found, deterministically ordered: file, then line, then code,
   * then the phrase as written — so the same text yields the same report
   * whatever order the files were collected in.
   */
  issues: GateConditionIssue[];

  /**
   * Every count phrase the rule evaluated, ordered like the issues. Empty means
   * no phrase in the input introduced an enumeration; a caller that expects a
   * gate statement pins this list so silence can never be a vacuous pass.
   */
  checked: GateConditionCheck[];
}

/** The number words a count phrase may use, `one` through `twelve`. */
const NUMBER_WORDS: ReadonlyMap<string, number> = new Map([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
]);

/**
 * A count phrase: a number word or a digit run, whitespace, the word
 * `conditions`. Anchored on both sides and on the word `conditions`, so `the
 * eleven gating names` (no `conditions`), `conditions` alone and `seven
 * conditional` are not count phrases.
 */
const COUNT_PHRASE_PATTERN =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\s+conditions\b/gi;

/** A gate token: `G` and a gate number, which starts at 1. */
const GATE_TOKEN_PATTERN = /\bG([1-9]\d*)\b/g;

/**
 * The count a phrase's captured token states.
 *
 * @param token - The captured word or digit run, e.g. `"seven"` or `"7"`.
 * @returns The count, or `null` when the token is neither a known number word
 * nor a digit run (out of scope, never guessed).
 */
function declaredCountOf(token: string): number | null {
  const word = NUMBER_WORDS.get(token.toLowerCase());
  if (word !== undefined) {
    return word;
  }
  return /^\d+$/.test(token) ? Number(token) : null;
}

/**
 * The paragraph that starts at the front of `lines`: contiguous non-blank lines,
 * stopping at the first blank one.
 */
function paragraphLinesOf(lines: readonly string[]): string[] {
  const paragraph: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      break;
    }
    paragraph.push(line);
  }
  return paragraph;
}

/**
 * The block that follows the paragraph: the first contiguous non-blank run after
 * any blank lines, stopping at the next blank one. Continuation lines of a list
 * item are inside the run, so a bullet that wraps is read whole.
 */
function blockLinesOf(lines: readonly string[]): string[] {
  const block: string[] = [];
  let inside = false;
  for (const line of lines) {
    const blank = line.trim() === "";
    if (!inside) {
      if (blank) {
        continue;
      }
      inside = true;
    }
    if (blank) {
      break;
    }
    block.push(line);
  }
  return block;
}

/**
 * A markdown table row: its `|` cells hold one row, not a paragraph, so a count
 * phrase inside a table cell reads only its own row. Without this, the ADR-0318
 * index row (`docs/adr/README.md:338`) would take the whole 480-row ledger table
 * as its window and read another record's `G3` as its own enumeration.
 */
function isTableRow(line: string): boolean {
  return line.trimStart().startsWith("|");
}

/**
 * The enumeration window of a count phrase: its paragraph, extended through the
 * block that follows when the paragraph's last line ends with a colon. §9.1
 * states the count at the end of a sentence ending in `:` and enumerates `G1…G7`
 * in the bullets below it, so the colon is the one signal that the enumeration
 * is not in the paragraph itself. A table row is its own window.
 */
function enumerationWindowOf(lines: readonly string[], startLine: number): string[] {
  const remainder = lines.slice(startLine);
  const [firstLine] = remainder;
  if (firstLine !== undefined && isTableRow(firstLine)) {
    return [firstLine];
  }
  const paragraph = paragraphLinesOf(remainder);
  const last = paragraph[paragraph.length - 1] ?? "";
  if (!last.trimEnd().endsWith(":")) {
    return paragraph;
  }
  return [...paragraph, ...blockLinesOf(remainder.slice(paragraph.length))];
}

/** Order count phrases: file, then line, then the phrase as written. */
function compareChecks(left: GateConditionCheck, right: GateConditionCheck): number {
  const byFile = compareStrings(left.file, right.file);
  if (byFile !== 0) {
    return byFile;
  }
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return compareStrings(left.stated, right.stated);
}

/** Order issues: file, then line, then code, then the phrase as written. */
function compareIssues(left: GateConditionIssue, right: GateConditionIssue): number {
  const byCheck = compareChecks(left, right);
  if (byCheck !== 0) {
    return byCheck;
  }
  return compareStrings(left.code, right.code);
}

/**
 * Check that every count phrase in `files` states the count of the `G1…Gk`
 * enumeration it introduces. Pure — it never touches the filesystem, so the rule
 * is testable without fixtures on disk.
 *
 * Three defects are reported per evaluated phrase: `count-mismatch` when the
 * highest `G` token is not the stated count, `sequence-gap` when a gate number
 * in `1..highest` is missing from the enumeration (a gap can fire beside a
 * `count-mismatch`: the enumeration can both stop early and skip a number), and
 * `count-disagreement` when the phrase's count differs from the run's first
 * evaluated phrase, because there is one merge gate and two different counts for
 * it cannot both be right. A phrase whose window carries no `G` token introduces
 * no enumeration: it is skipped, never reported, and never appears in `checked`.
 *
 * @param files - The markdown files to read, in any order.
 * @returns The report; `ok` is true when `issues` is empty.
 * @example
 * ```ts
 * checkGateConditionCounts([
 *   { path: "docs/adr/README.md", text: "seven conditions — G1 one, G2 two … G6 six." },
 * ]);
 * // { ok: false, issues: [{ code: "count-mismatch", file: "docs/adr/README.md",
 * //   line: 1, stated: "seven conditions", declared: 7, highest: 6, missing: [],
 * //   expected: null }], checked: [{ … }] }
 * ```
 */
export function checkGateConditionCounts(files: SourceFileText[]): GateConditionResult {
  const checks: GateConditionCheck[] = [];
  const issues: GateConditionIssue[] = [];

  for (const file of files) {
    const lines = file.text.split("\n");

    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(COUNT_PHRASE_PATTERN)) {
        const [stated, token = ""] = match;
        const declared = declaredCountOf(token);
        if (declared === null) {
          continue;
        }

        const window = enumerationWindowOf(lines, index).join("\n");
        const gateNumbers = new Set<number>();
        for (const gate of window.matchAll(GATE_TOKEN_PATTERN)) {
          const [, digits = ""] = gate;
          gateNumbers.add(Number(digits));
        }
        if (gateNumbers.size === 0) {
          continue;
        }

        const highest = [...gateNumbers].reduce((max, gate) => Math.max(max, gate), 0);
        const missing: number[] = [];
        for (let gate = 1; gate <= highest; gate += 1) {
          if (!gateNumbers.has(gate)) {
            missing.push(gate);
          }
        }

        const check: GateConditionCheck = {
          file: file.path,
          line: index + 1,
          stated,
          declared,
          highest,
        };
        checks.push(check);

        if (highest !== declared) {
          issues.push({ ...check, code: "count-mismatch", missing, expected: null });
        }
        if (missing.length > 0) {
          issues.push({ ...check, code: "sequence-gap", missing, expected: null });
        }
      }
    }
  }

  checks.sort(compareChecks);

  const canonical = checks[0];
  if (canonical !== undefined) {
    for (const check of checks) {
      if (check.declared !== canonical.declared) {
        issues.push({
          ...check,
          code: "count-disagreement",
          missing: [],
          expected: canonical.declared,
        });
      }
    }
  }

  issues.sort(compareIssues);

  return { ok: issues.length === 0, issues, checked: checks };
}

/**
 * The two documents that state the merge gate's condition count: the ADR-0318
 * ledger note in the ledger and the §9.1 gate list. Both are read whole — every
 * count phrase in them is evaluated — and no other file is read at all.
 */
export const GATE_CONDITION_SOURCES: readonly string[] = [
  "docs/adr/README.md",
  "docs/CONVENTIONS.md",
];

/**
 * Apply {@link checkGateConditionCounts} to a real working tree: read the two
 * documents that state the gate's condition count.
 *
 * No third file is read and no directory is walked, so the report cannot be
 * widened or slowed by the tree's size. Nothing is hardcoded about the counts,
 * so the pin follows the tree it runs in.
 *
 * @param root - Absolute path to the repository root.
 * @returns The same report as {@link checkGateConditionCounts}.
 * @throws If either document is missing: a wrong root must fail loudly instead
 * of reading one document and reporting a vacuous pass.
 */
export function checkRepositoryGateConditionCounts(root: string): GateConditionResult {
  const files: SourceFileText[] = GATE_CONDITION_SOURCES.map((path) => ({
    path,
    text: readTextFile(join(root, path)),
  }));

  return checkGateConditionCounts(files);
}
