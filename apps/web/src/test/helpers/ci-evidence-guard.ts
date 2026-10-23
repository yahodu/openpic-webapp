import { readFileSync } from "node:fs";
import { join } from "node:path";

import { scanWorkflowSource } from "./workflow-shell-safety.js";
import type { UntrustedRunInterpolation } from "./workflow-shell-safety.js";

/**
 * CI-evidence guard scanner (OP-101 card `t_fe3b946f`, the RED half of the
 * `t_fe3b946f`/`t_22f95e1f` TDD pair).
 *
 * **Why this exists.** GitHub creates **no `pull_request` workflow run while a
 * PR has a merge conflict**. `CI` and `PR Checks` both trigger on
 * `pull_request`, so a lane head whose PR conflicts with `main` gets **no run at
 * all**; the only checks that remain are CodeQL *default setup* runs
 * (`event=dynamic`, push-triggered, not conflict-suppressed), so the head shows
 * three green checks and **reads green** although the suite never ran. The eight
 * closed draft branches each demonstrated this: every one conflicted on
 * `docs/adr/README.md`, and `main` has no required status checks to catch it.
 *
 * The remedy is a new workflow, `.github/workflows/ci_evidence_guard.yml`,
 * triggered by **`on: push`** (the one trigger proved not to be
 * conflict-suppressed) that reads the GitHub API and fails the pushed head when
 * its open PR is conflicting, or — belt and braces — when no `CI`/`PR Checks`
 * run exists for that head SHA. This module is the **scanner** over that
 * workflow's source; it is test-only tooling (nothing under `.github/` imports
 * it), the same idiom as `apps/web/src/test/helpers/workflow-shell-safety.ts`
 * and `apps/web/src/test/helpers/adr-numbering.ts`.
 *
 * **RED.** `.github/workflows/ci_evidence_guard.yml` does not exist on the
 * baseline, so the spec that reads it through {@link loadCiEvidenceGuardSource}
 * fails naming the missing file. This helper is the RED-side contract only; no
 * workflow file is written by this card.
 *
 * **Scope boundary.** The scanner is line-based and understands the two YAML
 * shapes the guard is written in: block mappings and block sequences, plus an
 * inline flow sequence for `branches-ignore` (`[main]`). It is deliberately not
 * a YAML parser (same choice as the shell-safety scanner) — a real parser is a
 * new dependency, and the structural questions here are line-shaped.
 *
 * @see apps/web/src/test/unit/ci-evidence-guard.test.ts
 * @see apps/web/src/test/helpers/workflow-shell-safety.ts
 * @see docs/adr/ADR-0303-workflow-shell-safety-guard.md
 */

/** The workflow file the CI-evidence guard must live at, relative to `.github/workflows`. */
export const CI_EVIDENCE_GUARD_WORKFLOW = "ci_evidence_guard.yml";

/** One `uses:` action reference found in a workflow. */
export interface WorkflowUse {
  /** 1-based line number of the `uses:` key. */
  line: number;

  /** The action reference as written, e.g. `actions/checkout@v4`. */
  uses: string;
}

/** One `${{ … }}` expression found inside a `run:` body, whatever its context. */
export interface RunBodyInterpolation {
  /** The workflow file label the source was scanned under. */
  file: string;

  /** 1-based line number of the expression inside that file. */
  line: number;

  /** The raw expression between `${{` and `}}`, trimmed, e.g. `github.sha`. */
  expression: string;
}

/**
 * The `on:` trigger half of the guard. The load-bearing field is
 * {@link PushTriggerReport.push}: push-triggered runs are the only trigger
 * proved not to be conflict-suppressed. {@link PushTriggerReport.pullRequest}
 * and {@link PushTriggerReport.pullRequestTarget} must both be `false` — the
 * guard is push-only (`pull_request_target` was considered and rejected as a
 * primary trigger: its check attachment to the PR head rollup is unproven here,
 * whereas the push path is proved).
 */
export interface PushTriggerReport {
  /** `true` when `on:` carries a `push` key. */
  push: boolean;

  /** `true` when `on:` carries a `pull_request` key (must not — it is conflict-suppressed). */
  pullRequest: boolean;

  /** `true` when `on:` carries a `pull_request_target` key (rejected primary trigger). */
  pullRequestTarget: boolean;

  /** The entries under `push.branches-ignore`, in file order, without surrounding quotes. */
  branchesIgnore: string[];
}

/** One `key: value` entry of the top-level `permissions:` block. */
export interface PermissionEntry {
  /** The permission name as written, e.g. `pull-requests`. */
  key: string;

  /** The access level as written, e.g. `read` or `write`. */
  value: string;
}

/** The top-level `permissions:` block, reduced to what the guard must and must not declare. */
export interface PermissionsReport {
  /**
   * Every entry of the top-level `permissions:` block, sorted ascending by
   * `key` so the report is independent of file order.
   */
  entries: PermissionEntry[];

  /** The keys whose value is `write` (the guard must declare none). */
  writeKeys: string[];

  /** `true` exactly when {@link PermissionsReport.entries} is exactly the three read scopes. */
  minimal: boolean;
}

/**
 * The conflict assertion: the guard's `run:` body must query the pushed head's
 * open PRs, read their mergeability, and fail with an `::error::` annotation
 * when the PR is conflicting.
 */
export interface ConflictAssertionReport {
  /** `true` when a `run:` body references the commits→pulls endpoint (`…/commits/<sha>/pulls`). */
  commitsPullsEndpoint: boolean;

  /** `true` when a `run:` body reads the `mergeable` field. */
  mergeable: boolean;

  /** `true` when a `run:` body emits a GitHub `::error::` annotation. */
  errorAnnotation: boolean;
}

/**
 * The belt-and-braces absence check: when the PR is mergeable, the guard must
 * fail if neither the `CI` nor the `PR Checks` workflow has a run whose
 * `head_sha` equals the pushed SHA.
 */
export interface AbsenceCheckReport {
  /** `true` when a `run:` body names the `CI` workflow. */
  ciWorkflow: boolean;

  /** `true` when a `run:` body names the `PR Checks` workflow. */
  prChecksWorkflow: boolean;

  /** `true` when a `run:` body references the `head_sha` field. */
  headSha: boolean;
}

/** The full structural report for one guard-workflow source. */
export interface CiEvidenceGuardReport {
  /** `true` exactly when every invariant below holds for this source. */
  ok: boolean;

  /** The `on:` trigger half. */
  pushTrigger: PushTriggerReport;

  /** The top-level `permissions:` half. */
  permissions: PermissionsReport;

  /** Every `actions/checkout` `uses:` entry (the guard must declare none). */
  checkoutUses: WorkflowUse[];

  /** The conflict assertion. */
  conflictAssertion: ConflictAssertionReport;

  /** The absence check. */
  absenceCheck: AbsenceCheckReport;

  /**
   * Every `${{ … }}` expression appearing in a `run:` body, whatever its
   * context. Must be empty: `github.sha` / `github.repository` / the token are
   * transported through the step `env:` map, never interpolated into the script
   * text.
   */
  runBodyInterpolations: RunBodyInterpolation[];

  /**
   * The *untrusted* `run:`-body interpolations, computed by the existing
   * `scanWorkflowSource` (review finding F1 of OP-96 `t_e373a255`) so the guard
   * reuses one definition of "untrusted". Must be empty.
   */
  untrustedInterpolations: UntrustedRunInterpolation[];
}

/** One source line carrying its 1-based number, so slicing keeps line numbers exact. */
interface NumberedLine {
  line: number;
  text: string;
}

/** Match a `run:` mapping key and capture its indentation and inline value. */
const RUN_KEY_PATTERN = /^([ -]*)run:(.*)$/;

/** The YAML block-scalar indicators a `run:` value may carry (`|`, `>`, `|-`, `>-`, `|2`, …). */
const BLOCK_SCALAR_INDICATOR = /^[|>][+-]?[0-9]*$/;

/** Match a `key: value` line (block mapping entry) and capture key and value. */
const KEY_VALUE_PATTERN = /^([ ]*)([A-Za-z0-9_-]+):(.*)$/;

/** Match a `uses:` line, with or without the leading sequence dash. */
const USES_PATTERN = /^[ ]*-?[ ]*uses:(.*)$/;

/** Number of leading spaces in a line (YAML forbids tabs for indentation). */
function leadingSpaces(text: string): number {
  const match = /^[ ]*/.exec(text);
  return match === null ? 0 : match[0].length;
}

/** Split a source into numbered lines; line numbers are 1-based to match editors and CI logs. */
function toNumberedLines(source: string): NumberedLine[] {
  return source.split("\n").map((text, index) => ({ line: index + 1, text }));
}

/** Strip one pair of matching surrounding single or double quotes. */
function unquote(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/**
 * Index of the first line that is exactly `<indent spaces><key>:` followed by
 * end-of-line or a space — i.e. the key sits at that indentation. Returns `-1`
 * when the key is absent at that indentation.
 */
function findKeyLine(lines: readonly NumberedLine[], key: string, indent: number): number {
  const prefix = `${" ".repeat(indent)}${key}:`;
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    if (current === undefined) {
      continue;
    }
    if (current.text.startsWith(prefix)) {
      const after = current.text.slice(prefix.length);
      if (after === "" || after.startsWith(" ")) {
        return index;
      }
    }
  }
  return -1;
}

/**
 * The lines of the block that belongs to the key at `index` (indentation
 * `indent`): every following line that is blank or indented deeper, up to the
 * first non-blank line at or above `indent`.
 */
function blockAfter(lines: readonly NumberedLine[], index: number, indent: number): NumberedLine[] {
  const block: NumberedLine[] = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const current = lines[cursor];
    if (current === undefined) {
      break;
    }
    if (current.text.trim() !== "" && leadingSpaces(current.text) <= indent) {
      break;
    }
    block.push(current);
  }
  return block;
}

/**
 * Read a YAML string sequence under a key: an inline flow sequence
 * (`branches-ignore: [main]`), or a block sequence (`branches-ignore:` followed
 * by `- main` lines). Values are unquoted; blank lines are skipped.
 */
function stringListUnderKey(
  lines: readonly NumberedLine[],
  keyIndex: number,
  key: string,
  indent: number
): string[] {
  const keyLine = lines[keyIndex];
  if (keyLine === undefined) {
    return [];
  }

  const inline = keyLine.text.slice(indent + key.length + 1).trim();
  if (inline.startsWith("[")) {
    const inner = inline.replace(/^\[/, "").replace(/\]$/, "").trim();
    if (inner === "") {
      return [];
    }
    return inner
      .split(",")
      .map((part) => unquote(part.trim()))
      .filter((part) => part !== "");
  }

  const values: string[] = [];
  for (const line of blockAfter(lines, keyIndex, indent)) {
    const text = line.text.trim();
    if (text.startsWith("- ")) {
      const value = unquote(text.slice(2).trim());
      if (value !== "") {
        values.push(value);
      }
    }
  }
  return values;
}

/**
 * Yield every `run:` body in a line list — the inline value of `run: cmd`, or
 * every deeper-indented line of a `run: |` block scalar. A YAML comment can
 * never look like a `run:` key, so a commented-out step is not a step.
 */
function* runBodies(lines: readonly NumberedLine[]): Generator<NumberedLine> {
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    if (current === undefined) {
      continue;
    }

    const match = RUN_KEY_PATTERN.exec(current.text);
    if (match === null) {
      continue;
    }

    const runIndent = (match[1] ?? "").length;
    const inlineValue = (match[2] ?? "").trim();

    if (inlineValue !== "" && !BLOCK_SCALAR_INDICATOR.test(inlineValue)) {
      yield { line: current.line, text: inlineValue };
      continue;
    }

    let bodyIndex = index + 1;
    while (bodyIndex < lines.length) {
      const bodyLine = lines[bodyIndex];
      if (bodyLine === undefined) {
        break;
      }
      if (bodyLine.text.trim() !== "" && leadingSpaces(bodyLine.text) <= runIndent) {
        break;
      }
      yield bodyLine;
      bodyIndex += 1;
    }
    index = bodyIndex - 1;
  }
}

/** The `on:` trigger half of the report. */
function readPushTrigger(lines: readonly NumberedLine[]): PushTriggerReport {
  const onIndex = findKeyLine(lines, "on", 0);
  if (onIndex === -1) {
    return { push: false, pullRequest: false, pullRequestTarget: false, branchesIgnore: [] };
  }

  const onBlock = blockAfter(lines, onIndex, 0);
  const pushIndex = findKeyLine(onBlock, "push", 2);
  const branchesIgnoreIndex =
    pushIndex === -1 ? -1 : findKeyLine(blockAfter(onBlock, pushIndex, 2), "branches-ignore", 4);
  const pushBlock = pushIndex === -1 ? [] : blockAfter(onBlock, pushIndex, 2);

  return {
    push: pushIndex !== -1,
    pullRequest: findKeyLine(onBlock, "pull_request", 2) !== -1,
    pullRequestTarget: findKeyLine(onBlock, "pull_request_target", 2) !== -1,
    branchesIgnore:
      branchesIgnoreIndex === -1
        ? []
        : stringListUnderKey(pushBlock, branchesIgnoreIndex, "branches-ignore", 4),
  };
}

/** Compare two strings without locale dependence, so a report is stable. */
function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** The three read scopes the guard must declare, sorted. */
const MINIMAL_PERMISSION_KEYS = ["checks", "contents", "pull-requests"];

/** The top-level `permissions:` half of the report. */
function readPermissions(lines: readonly NumberedLine[]): PermissionsReport {
  const permissionsIndex = findKeyLine(lines, "permissions", 0);
  const entries: PermissionEntry[] = [];

  if (permissionsIndex !== -1) {
    for (const line of blockAfter(lines, permissionsIndex, 0)) {
      const match = KEY_VALUE_PATTERN.exec(line.text);
      if (match === null) {
        continue;
      }
      const key = match[2];
      const value = unquote((match[3] ?? "").trim());
      if (key === undefined) {
        continue;
      }
      entries.push({ key, value });
    }
  }

  entries.sort((left, right) => compareStrings(left.key, right.key));
  const writeKeys = entries
    .filter((entry) => entry.value === "write")
    .map((entry) => entry.key)
    .sort(compareStrings);
  const minimal =
    entries.length === MINIMAL_PERMISSION_KEYS.length &&
    entries.every(
      (entry, index) => entry.key === MINIMAL_PERMISSION_KEYS[index] && entry.value === "read"
    );

  return { entries, writeKeys, minimal };
}

/** Every `uses:` action reference in the source. */
function readUses(lines: readonly NumberedLine[]): WorkflowUse[] {
  const uses: WorkflowUse[] = [];
  for (const line of lines) {
    const match = USES_PATTERN.exec(line.text);
    if (match === null) {
      continue;
    }
    uses.push({ line: line.line, uses: unquote((match[1] ?? "").trim()) });
  }
  return uses;
}

/**
 * Scan one guard-workflow source and reduce it to the structural facts the
 * spec pins. Pure — it never touches the filesystem.
 *
 * @param file - The label reported back in findings, e.g. `"ci_evidence_guard.yml"`.
 * @param source - The raw workflow YAML.
 * @returns The structural report; {@link CiEvidenceGuardReport.ok} is the roll-up assertion target.
 * @example
 * ```ts
 * inspectCiEvidenceGuard("ci_evidence_guard.yml", source).ok; // true once the guard lands
 * ```
 */
export function inspectCiEvidenceGuard(file: string, source: string): CiEvidenceGuardReport {
  const lines = toNumberedLines(source);
  const bodies = [...runBodies(lines)];
  const runText = bodies.map((body) => body.text).join("\n");

  const pushTrigger = readPushTrigger(lines);
  const permissions = readPermissions(lines);
  const checkoutUses = readUses(lines).filter((use) => use.uses.startsWith("actions/checkout"));

  const conflictAssertion: ConflictAssertionReport = {
    commitsPullsEndpoint: /commits\/[^\s"'`]*\/pulls/.test(runText),
    mergeable: /\bmergeable\b/.test(runText),
    errorAnnotation: runText.includes("::error::"),
  };

  const absenceCheck: AbsenceCheckReport = {
    ciWorkflow: /\bCI\b/.test(runText),
    prChecksWorkflow: runText.includes("PR Checks"),
    headSha: runText.includes("head_sha"),
  };

  const runBodyInterpolations: RunBodyInterpolation[] = [];
  for (const body of bodies) {
    for (const match of body.text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
      runBodyInterpolations.push({
        file,
        line: body.line,
        expression: (match[1] ?? "").trim(),
      });
    }
  }

  const untrustedInterpolations = scanWorkflowSource(file, source);

  const ok =
    pushTrigger.push &&
    pushTrigger.branchesIgnore.length > 0 &&
    !pushTrigger.pullRequest &&
    !pushTrigger.pullRequestTarget &&
    permissions.minimal &&
    permissions.writeKeys.length === 0 &&
    checkoutUses.length === 0 &&
    conflictAssertion.commitsPullsEndpoint &&
    conflictAssertion.mergeable &&
    conflictAssertion.errorAnnotation &&
    absenceCheck.ciWorkflow &&
    absenceCheck.prChecksWorkflow &&
    absenceCheck.headSha &&
    runBodyInterpolations.length === 0 &&
    untrustedInterpolations.length === 0;

  return {
    ok,
    pushTrigger,
    permissions,
    checkoutUses,
    conflictAssertion,
    absenceCheck,
    runBodyInterpolations,
    untrustedInterpolations,
  };
}

/**
 * Read the guard workflow's source from a `.github/workflows` directory.
 *
 * Returns `null` when the file does not exist (or cannot be read), so a spec can
 * assert existence with a message that names the missing file instead of a raw
 * `ENOENT` from module load.
 *
 * @param workflowsDir - Absolute or relative path to a `.github/workflows` directory.
 * @returns The workflow YAML, or `null` when `ci_evidence_guard.yml` is absent.
 * @throws Never — an unreadable file is reported as `null`.
 * @example
 * ```ts
 * loadCiEvidenceGuardSource("path/.github/workflows"); // null on the RED baseline
 * ```
 */
export function loadCiEvidenceGuardSource(workflowsDir: string): string | null {
  const path = join(workflowsDir, CI_EVIDENCE_GUARD_WORKFLOW);
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
