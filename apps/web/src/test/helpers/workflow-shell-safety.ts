import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Mechanical guard against shell injection through GitHub Actions `run:` bodies
 * (review finding F1 of OP-96 t_e373a255, pinned by OP-101 t_4ca9d007).
 *
 * **Why this exists.** `.github/workflows/pr_checks.yml` used to interpolate
 * attacker-controllable PR context *straight into the script text*:
 *
 * ```yaml
 * run: |
 *   BRANCH="${{ github.head_ref }}"
 *   TITLE="${{ github.event.pull_request.title }}"
 * ```
 *
 * The `${{ … }}` expansion happens *before* the shell runs, so the value lands
 * inside the command line and is re-parsed by the shell. Backticks or `$( … )`
 * in a PR title or branch name therefore execute on the runner, and a perfectly
 * legitimate title that contains backticks fails validation. Observed live on
 * PR #237: the title ``docs(adr): OP-96 record the `Next free` … `` ran
 * `` `Next free` `` as a command substitution and failed `validate-pr-title`
 * (run `39739073402` / job `119691641674`); it passed only after the backticks
 * were removed (run `39739241884`).
 *
 * The remedy — and the invariant this module pins — is to hand the value over
 * through the step `env:` map and read it as a shell variable (`TITLE: ${{ … }}`
 * plus `"$TITLE"` in the script). This module reports the *defect* side of that
 * rule: every untrusted `${{ … }}` expression that appears in a `run:` body.
 *
 * **Why it lives in the test tree.** It is a scanner over repository files, not
 * production code; the guard it feeds (`apps/web/src/test/unit/workflow-shell-safety.test.ts`)
 * is a unit spec like the ADR-number guard. Nothing under `.github/` imports it.
 *
 * **Scope boundary.** Only *untrusted* contexts are flagged. A `${{ github.repository }}`,
 * `${{ github.ref_name }}` or `${{ secrets.X }}` interpolation is left alone:
 * those are not attacker-controllable strings here, and broadening the rule
 * would drag unrelated workflows into the same change. Whether *that* boundary
 * should move is a review question, not something this scanner decides — the
 * set is enumerated in {@link UNTRUSTED_CONTEXTS} so the choice is visible.
 *
 * @see .github/workflows/pr_checks.yml
 * @see apps/web/src/test/unit/workflow-shell-safety.test.ts
 */

/**
 * The untrusted contexts this guard refuses to see inside a `run:` body, each
 * with the label reported in a finding. The list is the one named by the OP-101
 * card: `github.event.*` (which covers `github.event.pull_request.*`),
 * `github.head_ref`, `github.base_ref` and workflow `inputs.*`.
 *
 * The patterns are deliberately word-bounded, so `github.event_name` (a safe
 * enum) does not match `github.event`, and `someinputs.x` does not match
 * `inputs.x`.
 */
const UNTRUSTED_CONTEXTS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bgithub\.event\b/, label: "github.event" },
  { pattern: /\bgithub\.head_ref\b/, label: "github.head_ref" },
  { pattern: /\bgithub\.base_ref\b/, label: "github.base_ref" },
  { pattern: /\binputs\s*\./, label: "inputs" },
];

/** A `run:` body line whose text interpolates an untrusted `${{ … }}` context. */
export interface UntrustedRunInterpolation {
  /** The workflow file as handed to {@link scanWorkflowSource} (or its path on disk). */
  file: string;

  /** 1-based line number of the expression inside that file. */
  line: number;

  /** The raw expression between `${{` and `}}`, trimmed, e.g. `github.head_ref`. */
  expression: string;

  /** The untrusted context that made the expression untrusted, e.g. `github.head_ref`. */
  context: string;
}

/** Whether one job hands a shell variable over through `env:` instead of interpolating it. */
export interface JobEnvTransport {
  /** The job id the scan was scoped to, e.g. `"validate-pr-title"`. */
  job: string;

  /** The shell variable the `run:` body must read, e.g. `"TITLE"`. */
  variable: string;

  /** `true` when some `run:` body inside the job reads the variable (`$TITLE` / `${TITLE}`). */
  readInShell: boolean;

  /** `true` when an `env:` mapping inside the job supplies the variable. */
  suppliedByEnv: boolean;

  /** `true` exactly when both {@link JobEnvTransport.readInShell} and {@link JobEnvTransport.suppliedByEnv} hold. */
  ok: boolean;
}

/** One source line carrying its 1-based number, so slicing keeps line numbers exact. */
interface NumberedLine {
  line: number;
  text: string;
}

/**
 * Match a `run:` mapping key and capture its content indentation — the leading
 * spaces plus an optional YAML sequence dash (`- run: |` inside a `steps:`
 * list), so a block body must be indented past the dash — plus its inline value.
 * A single character class keeps the pattern free of nested quantifiers.
 */
const RUN_KEY_PATTERN = /^([ -]*)run:(.*)$/;

/** The YAML block-scalar indicators a `run:` value may carry (`|`, `>`, `|-`, `>-`, `|2`, …). */
const BLOCK_SCALAR_INDICATOR = /^[|>][+-]?[0-9]*$/;

/** Match an `env:` mapping key and capture its indentation and inline value. */
const ENV_KEY_PATTERN = /^([ ]*)env:(.*)$/;

/** Match an `env:` mapping *entry* key (`TITLE: …`) inside a block mapping. */
const ENV_ENTRY_PATTERN = /^[ ]*([A-Za-z_][A-Za-z0-9_]*):/;

/** Number of leading spaces in a line (YAML forbids tabs for indentation). */
function leadingSpaces(text: string): number {
  const match = /^[ ]*/.exec(text);
  return match === null ? 0 : match[0].length;
}

/** Split a source into numbered lines; line numbers are 1-based to match editors and CI logs. */
function toNumberedLines(source: string): NumberedLine[] {
  return source.split("\n").map((text, index) => ({ line: index + 1, text }));
}

/**
 * Yield the body of every `run:` step in a line list — the inline value for a
 * `run: cmd` key, or every deeper-indented line for a `run: |` block scalar.
 * Blank lines inside a block are yielded too (they cannot contain an
 * expression, so they are harmless, and skipping them would mis-number the
 * rest).
 *
 * A YAML comment line can never look like a `run:` key (the `#` precedes the
 * key), so a commented-out step is not a step.
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

    // Block scalar: the body runs until the first non-blank line at or above
    // the `run:` key's indentation (the next key, step or job).
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

/**
 * Collect the keys of every block `env:` mapping in a line list. An `env:`
 * value on the same line (`env: {A: b}`) is ignored: the workflows in this
 * repository use block mappings, and flow mappings would need a real parser.
 */
function collectEnvKeys(lines: readonly NumberedLine[]): Set<string> {
  const keys = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    if (current === undefined) {
      continue;
    }

    const match = ENV_KEY_PATTERN.exec(current.text);
    if (match === null || (match[2] ?? "").trim() !== "") {
      continue;
    }

    const envIndent = leadingSpaces(match[1] ?? "");
    let keyIndex = index + 1;
    while (keyIndex < lines.length) {
      const keyLine = lines[keyIndex];
      if (keyLine === undefined) {
        break;
      }
      if (keyLine.text.trim() === "") {
        keyIndex += 1;
        continue;
      }
      if (leadingSpaces(keyLine.text) <= envIndent) {
        break;
      }
      const entry = ENV_ENTRY_PATTERN.exec(keyLine.text);
      if (entry?.[1] !== undefined) {
        keys.add(entry[1]);
      }
      keyIndex += 1;
    }
    index = keyIndex - 1;
  }

  return keys;
}

/** Does a shell verbatim read `${VAR}` or a bare `$VAR`? No `new RegExp` — the variable is user input. */
function readsShellVariable(text: string, variable: string): boolean {
  return text.includes(`$${variable}`) || text.includes("${" + variable + "}");
}

/** The untrusted context an expression refers to, or `null` when the expression is in scope-safe territory. */
function untrustedContextOf(expression: string): string | null {
  for (const candidate of UNTRUSTED_CONTEXTS) {
    if (candidate.pattern.test(expression)) {
      return candidate.label;
    }
  }
  return null;
}

/**
 * The slice of a workflow that belongs to one job: everything after the
 * `  <job>:` line up to the next non-blank line indented two spaces or less.
 * Returns `[]` when the job does not exist, so a deleted job reports as "does
 * not read the variable" rather than throwing.
 */
function jobBlock(lines: readonly NumberedLine[], job: string): NumberedLine[] {
  const expectedKey = `${job}:`;
  let start = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    if (current === undefined || leadingSpaces(current.text) !== 2) {
      continue;
    }
    if (current.text.slice(2).trimEnd() === expectedKey) {
      start = index;
      break;
    }
  }

  if (start === -1) {
    return [];
  }

  const block: NumberedLine[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const current = lines[index];
    if (current === undefined) {
      break;
    }
    if (current.text.trim() !== "" && leadingSpaces(current.text) <= 2) {
      break;
    }
    block.push(current);
  }
  return block;
}

/**
 * Report the names of every `*.yml` / `*.yaml` workflow in a directory, sorted
 * so a report is stable across filesystems.
 *
 * @param workflowsDir - Absolute or relative path to a `.github/workflows` directory.
 * @returns Full paths built with {@link join}, ascending by name.
 * @throws If `workflowsDir` cannot be read (missing directory, permission denied).
 */
export function listWorkflowFiles(workflowsDir: string): string[] {
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => join(workflowsDir, name));
}

/**
 * Scan one workflow source for `run:` bodies that interpolate an untrusted
 * `${{ … }}` context. Pure — it never touches the filesystem.
 *
 * A `${{ … }}` under an `env:` key is not a `run:` body and is therefore
 * clean; an expansion anywhere inside a `run:` body — including inside a shell
 * comment, because GitHub expands expressions in the whole value before the
 * shell ever sees it — is reported at its own line. An expression that carries
 * an untrusted context inside a function call (`${{ toJSON(github.event.x) }}`)
 * is reported too.
 *
 * @param file - The label reported back in each finding, e.g. `"pr_checks.yml"`.
 * @param source - The raw workflow YAML.
 * @returns One entry per untrusted expression, in file order.
 * @example
 * ```ts
 * scanWorkflowSource("a.yml", 'run: |\n  TITLE="${{ github.head_ref }}"\n');
 * // [{ file: "a.yml", line: 2, expression: "github.head_ref", context: "github.head_ref" }]
 * ```
 */
export function scanWorkflowSource(file: string, source: string): UntrustedRunInterpolation[] {
  const findings: UntrustedRunInterpolation[] = [];

  for (const body of runBodies(toNumberedLines(source))) {
    for (const match of body.text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
      const expression = (match[1] ?? "").trim();
      const context = untrustedContextOf(expression);
      if (context !== null) {
        findings.push({ file, line: body.line, expression, context });
      }
    }
  }

  return findings;
}

/**
 * Read every workflow in a directory and report the untrusted `run:`-body
 * interpolations across all of them.
 *
 * @param workflowsDir - Absolute or relative path to a `.github/workflows` directory.
 * @returns Findings in ascending file-name, then line, order.
 * @throws If the directory or any workflow file cannot be read.
 */
export function scanWorkflowFiles(workflowsDir: string): UntrustedRunInterpolation[] {
  const findings: UntrustedRunInterpolation[] = [];
  for (const path of listWorkflowFiles(workflowsDir)) {
    findings.push(...scanWorkflowSource(path, readFileSync(path, "utf8")));
  }
  return findings;
}

/**
 * Inspect one job to see whether it hands a shell variable over through `env:`
 * (the fix) rather than interpolating an untrusted context into the script (the
 * defect) — the "the fix must not be to delete the check" half of the guard.
 *
 * The scan is scoped to the job: a `TITLE: …` mapping in a *different* job does
 * not count, nor does a `$TITLE` reference outside this job. `readInShell` is
 * satisfied by `"$TITLE"` or `"${TITLE}"` in any `run:` body of the job;
 * `suppliedByEnv` is satisfied by a block `env:` mapping with a `TITLE` key.
 * The value of that entry is deliberately not asserted here — that it is a
 * `${{ … }}` expression is pinned where it is set, not by this scanner.
 *
 * @param source - The raw workflow YAML.
 * @param job - The job id, e.g. `"validate-pr-title"` (a two-space-indented key under `jobs:`).
 * @param variable - The shell variable name, e.g. `"TITLE"`.
 * @returns The per-job transport report; {@link JobEnvTransport.ok} is the assertion target.
 * @example
 * ```ts
 * inspectJobEnvTransport(source, "validate-pr-title", "TITLE").ok; // true once the fix lands
 * ```
 */
export function inspectJobEnvTransport(
  source: string,
  job: string,
  variable: string
): JobEnvTransport {
  const lines = toNumberedLines(source);
  const block = jobBlock(lines, job);
  const readInShell = Array.from(runBodies(block)).some((body) =>
    readsShellVariable(body.text, variable)
  );
  const suppliedByEnv = collectEnvKeys(block).has(variable);

  return {
    job,
    variable,
    readInShell,
    suppliedByEnv,
    ok: readInShell && suppliedByEnv,
  };
}
