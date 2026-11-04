import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Unit contract — `.github/workflows/ci.yml`, the `audit-dev` job
 * (OP-117 follow-up card `t_f5588c70`, pin for PR #389 / squash `7fc7abf`).
 *
 * **Why this exists.** ADR-0301 split the dependency audit into a blocking
 * `audit` job (`pnpm audit --prod`) and a **non-blocking** `audit-dev` job
 * (`pnpm audit --dev`). The non-blocking half was implemented with **job-level**
 * `continue-on-error: true` only — which quiets the `CI` *workflow run* but
 * still publishes the job's **check-run** with `conclusion: failure`. Every
 * commit therefore carried a red `audit-dev` check-run (the `undici`
 * `GHSA-xjj6-f33q-929c` advisories reachable only through the `semantic-release`
 * dev toolchain), and a check-run consumer — the board's PR-acceptance gate —
 * refused `kanban_complete` for unrelated, fully-landed cards repo-wide.
 *
 * ADR-0313 fixed it by making the audit step itself exit `0`
 * (`run: pnpm audit --dev --audit-level=moderate || true`), so the step, the job
 * and the check-run conclude `success` while `pnpm`'s advisory report — printed
 * before the non-zero exit — stays in the job log. That fix shipped **without a
 * test**; this file is the missing pin, in the same idiom as the repo's other
 * two workflow guards (`workflow-shell-safety.test.ts`, `ci-evidence-guard.test.ts`):
 * every invariant is asserted on the **real** workflow *and* on synthetic
 * fixtures, so the assertion is a guard rather than a snapshot of today's file.
 *
 * **Characterisation pin, not a RED.** The behaviour is correct on the trunk
 * (`origin/main` `b683c3c`), so this file is expected to be **green on arrival**
 * and owes no GREEN sibling. If it ever fails, the workflow regressed; do not
 * weaken the pin.
 *
 * **Invariants pinned (the property, not the text of the fix):**
 *   1. the `audit-dev` job exists and declares **no `needs:`** — it reports
 *      independently;
 *   2. no step of `audit-dev` that runs `pnpm audit` can make the job fail: its
 *      `run:` ends in a form that exits `0` on a non-zero audit (`|| true`,
 *      `|| :`, `|| exit 0`, `|| echo …`) **or** the step itself carries
 *      `continue-on-error: true`. Either shape is accepted; the literal
 *      `|| true` string is *not* pinned;
 *   3. the job still runs `pnpm audit --dev`, so "delete the job" (or downgrade
 *      it to the blocking prod audit) cannot satisfy invariant 2 vacuously;
 *   4. **job-level** `continue-on-error: true` alone does **not** satisfy
 *      invariant 2 — that is exactly the pre-ADR-0313 defect;
 *   5. the blocking `audit` job still exists as its own job, so the
 *      blocking/non-blocking split is still in place.
 *
 * The scanner below is line-based on purpose (the same choice as the two
 * existing guards): it understands the two YAML shapes `ci.yml` is written in —
 * block mappings, block sequences and a block scalar `run:` body — and needs no
 * new parser dependency.
 */

/** The `audit-dev` job this pin guards. */
const AUDIT_DEV_JOB = "audit-dev";

/** The blocking sibling job — asserted to still exist, never asserted on further. */
const BLOCKING_AUDIT_JOB = "audit";

/** A `run:` body that invokes the dependency audit at all. */
const AUDIT_COMMAND = /\bpnpm\s+audit\b/;

/** A `run:` body that audits the *dev/test* toolchain (ADR-0301's non-blocking half). */
const DEV_AUDIT_COMMAND = /\bpnpm\s+audit\b[^\n]*\s--dev(\s|$)/;

/**
 * A trailing shell form whose exit status is `0` whatever the left-hand command
 * exited with: `|| true`, `|| :`, `|| exit 0`, `|| echo "…"`. This is the shape
 * that makes the step — and therefore the job check-run — conclude `success`.
 */
const EXIT_ZERO_SUFFIX = /\|\|\s*(?:true|:|exit\s+0|echo\b[^\n]*)$/;

/** Markers that turn a `run:` value into a multi-line block scalar. */
const BLOCK_SCALAR_MARKERS = new Set(["|", "|-", "|+", ">", ">-", ">+"]);

/** One line of the workflow, trimmed, with its indentation depth. */
interface SourceLine {
  readonly indent: number;
  readonly text: string;
}

/** One step of a job whose `run:` invokes `pnpm audit`, reduced to the pinned facts. */
interface AuditStepScan {
  /** The step's `name:`, when it has one. */
  readonly name: string | null;

  /** The full `run:` body, lines joined with `\n` (multi-line bodies keep their text). */
  readonly run: string;

  /** `true` when the step itself declares `continue-on-error: true` (step level, not job level). */
  readonly stepContinueOnError: boolean;

  /** `true` when the last command of the body carries an {@link EXIT_ZERO_SUFFIX}. */
  readonly exitsZeroOnAuditFailure: boolean;

  /** `exitsZeroOnAuditFailure || stepContinueOnError` — the two accepted shapes. */
  readonly nonGating: boolean;
}

/** The `audit-dev` job, reduced to what the non-gating contract consists of. */
interface AuditDevJobReport {
  /** `true` when `jobs:` declares an `audit-dev` key. */
  readonly exists: boolean;

  /** The job's `needs:` entries, or `null` when it declares no `needs:` at all. */
  readonly needs: string[] | null;

  /** `true` when the **job** declares `continue-on-error: true` (necessary, not sufficient). */
  readonly jobContinueOnError: boolean;

  /** Every step whose `run:` invokes `pnpm audit`, in file order. */
  readonly auditSteps: AuditStepScan[];

  /** `true` when some audit step invokes `pnpm audit --dev`. */
  readonly runsDevAudit: boolean;

  /**
   * The roll-up the pin asserts: the job exists, runs at least one `pnpm audit`
   * step, and **every** such step is non-gating.
   */
  readonly nonGating: boolean;
}

function toSourceLines(source: string): SourceLine[] {
  return source.split("\n").map((raw) => ({
    indent: raw.length - raw.trimStart().length,
    text: raw.trim(),
  }));
}

/** A line that carries structure — not blank, not a comment-only line. */
function isStructural(line: SourceLine): boolean {
  return line.text !== "" && !line.text.startsWith("#");
}

/**
 * Split the `jobs:` block into one line block per job. Consecutive job headings
 * are the `indent === 2`, `name:`-terminated keys of `jobs:`; a job block runs
 * until the next job heading (or the next top-level key). Comments inside a
 * stand-alone line are dropped — a `#` inside a `run:` body is a shell comment
 * and never carries structure this pin reads.
 */
function parseJobs(source: string): Map<string, SourceLine[]> {
  const jobs = new Map<string, SourceLine[]>();
  let inJobs = false;
  let current: SourceLine[] | null = null;

  for (const line of toSourceLines(source)) {
    if (!isStructural(line)) continue;

    if (line.indent === 0) {
      inJobs = line.text === "jobs:";
      current = null;
      continue;
    }

    if (!inJobs) continue;

    if (line.indent === 2 && line.text.endsWith(":") && !line.text.startsWith("-")) {
      current = [];
      jobs.set(line.text.slice(0, -1).trim(), current);
      continue;
    }

    current?.push(line);
  }

  return jobs;
}

/** `value` when `text` starts with `prefix` (`"needs:"` -> `"ci"`), else `null`. */
function valueAfterPrefix(text: string, prefix: string): string | null {
  return text.startsWith(prefix) ? text.slice(prefix.length).trim() : null;
}

/** Normalise a YAML scalar to a boolean: only an unquoted/quoted `true` is `true`. */
function isTrueLiteral(value: string): boolean {
  return value.replaceAll('"', "").replaceAll("'", "") === "true";
}

/** One `key: value` boolean of a job block (indent 4) — job level. */
function jobBoolean(block: readonly SourceLine[], key: string): boolean {
  for (const line of block) {
    if (line.indent !== 4) continue;
    const value = valueAfterPrefix(line.text, `${key}:`);
    if (value !== null) return isTrueLiteral(value);
  }
  return false;
}

/** One `key: value` boolean of a step (indent 8) — step level. */
function stepBoolean(step: readonly SourceLine[], key: string): boolean {
  for (const line of step) {
    if (line.indent !== 8) continue;
    const value = valueAfterPrefix(line.text, `${key}:`);
    if (value !== null) return isTrueLiteral(value);
  }
  return false;
}

/** One `key: value` scalar of a step (indent 8). */
function stepValue(step: readonly SourceLine[], key: string): string | null {
  for (const line of step) {
    if (line.indent !== 8) continue;
    const value = valueAfterPrefix(line.text, `${key}:`);
    if (value !== null) return value;
  }
  return null;
}

/** Split a job block into its step blocks (`- ` items at indent 6 of the job block). */
function parseSteps(block: readonly SourceLine[]): SourceLine[][] {
  const start = block.findIndex((line) => line.indent === 4 && line.text === "steps:");
  if (start < 0) return [];

  const steps: SourceLine[][] = [];
  let current: SourceLine[] | null = null;

  for (const line of block.slice(start + 1)) {
    if (line.indent <= 4) break;

    if (line.indent === 6 && line.text.startsWith("-")) {
      current = [];
      steps.push(current);
      const rest = line.text.slice(1).trim();
      if (rest !== "") current.push({ indent: 8, text: rest });
      continue;
    }

    current?.push(line);
  }

  return steps;
}

/** The step's full `run:` body — the inline scalar, or the block scalar's lines. */
function stepRun(step: readonly SourceLine[]): string | null {
  const start = step.findIndex((line) => line.indent === 8 && line.text.startsWith("run:"));
  if (start < 0) return null;

  const head = step.at(start);
  if (head === undefined) return null;

  const inline = head.text.slice("run:".length).trim();
  if (inline !== "" && !BLOCK_SCALAR_MARKERS.has(inline)) return inline;

  const body: string[] = [];
  for (const line of step.slice(start + 1)) {
    if (line.indent <= 8) break;
    body.push(line.text);
  }
  return body.join("\n");
}

/** `true` when the body's last command carries an {@link EXIT_ZERO_SUFFIX}. */
function exitsZeroOnAuditFailure(run: string): boolean {
  const commands = run
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const last = commands.at(-1);
  return last !== undefined && EXIT_ZERO_SUFFIX.test(last);
}

/** The `needs:` entries of a job block; `null` when the job declares none. */
function parseNeeds(block: readonly SourceLine[]): string[] | null {
  const start = block.findIndex((line) => line.indent === 4 && line.text.startsWith("needs:"));
  if (start < 0) return null;

  const head = block.at(start);
  if (head === undefined) return null;

  const inline = head.text.slice("needs:".length).trim();
  if (inline !== "") {
    return inline
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
  }

  const names: string[] = [];
  for (const line of block.slice(start + 1)) {
    if (line.indent <= 4) break;
    const item = valueAfterPrefix(line.text, "-");
    if (item !== null && item !== "") names.push(item);
  }
  return names;
}

/** Reduce `.github/workflows/ci.yml`'s `audit-dev` job to the non-gating contract. */
function inspectAuditDevJob(source: string): AuditDevJobReport {
  const block = parseJobs(source).get(AUDIT_DEV_JOB);
  if (block === undefined) {
    return {
      exists: false,
      needs: null,
      jobContinueOnError: false,
      auditSteps: [],
      runsDevAudit: false,
      nonGating: false,
    };
  }

  const auditSteps: AuditStepScan[] = [];
  for (const step of parseSteps(block)) {
    const run = stepRun(step);
    if (run === null || !AUDIT_COMMAND.test(run)) continue;

    const toleratesFailure = exitsZeroOnAuditFailure(run);
    const stepContinueOnError = stepBoolean(step, "continue-on-error");

    auditSteps.push({
      name: stepValue(step, "name"),
      run,
      stepContinueOnError,
      exitsZeroOnAuditFailure: toleratesFailure,
      nonGating: toleratesFailure || stepContinueOnError,
    });
  }

  return {
    exists: true,
    needs: parseNeeds(block),
    jobContinueOnError: jobBoolean(block, "continue-on-error"),
    auditSteps,
    runsDevAudit: auditSteps.some((step) => DEV_AUDIT_COMMAND.test(step.run)),
    nonGating: auditSteps.length > 0 && auditSteps.every((step) => step.nonGating),
  };
}

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

/**
 * One `readFileSync` call site: the security preset flags every non-literal `fs`
 * argument (`security/detect-non-literal-fs-filename`), so reading through this
 * helper keeps the file's warning count at its trunk value.
 */
function readCiWorkflow(): string {
  return readFileSync(join(repoRoot, ".github/workflows", "ci.yml"), "utf8");
}

/** The real workflow the pin guards. */
const REAL_CI_YML = readCiWorkflow();

/**
 * The pre-ADR-0313 shape: the same file with the exit-0 tolerance stripped from
 * every line, so the dev-audit step is bare `pnpm audit --dev …` again while the
 * job keeps its job-level `continue-on-error: true`.
 */
const PRE_FIX_CI_YML = REAL_CI_YML.split("\n")
  .map((line) => line.replace(EXIT_ZERO_SUFFIX, ""))
  .join("\n");

/** The accepted *alternative* shape: no tolerance suffix, but the step itself is `continue-on-error`. */
function withStepContinueOnError(source: string): string {
  const lines = source.split("\n");
  const index = lines.findIndex((line) =>
    /^\s*run:\s*pnpm\s+audit\b[^\n]*\s--dev(\s|$)/.test(line)
  );
  const target = lines.at(index);
  if (target === undefined) {
    throw new Error(
      "ci.yml has no `run: pnpm audit --dev …` line — update this fixture builder with the workflow"
    );
  }

  const indent = target.slice(0, target.length - target.trimStart().length);
  lines.splice(index, 0, `${indent}continue-on-error: true`);
  return lines.join("\n");
}

/** The same file with `needs: [ci]` added to `audit-dev` — the shape invariant 1 forbids. */
function withNeedsOnAuditDev(source: string): string {
  const lines = source.split("\n");
  const index = lines.findIndex((line) => line === `  ${AUDIT_DEV_JOB}:`);
  if (index < 0) {
    throw new Error(
      `ci.yml has no \`  ${AUDIT_DEV_JOB}:\` job heading — update this fixture builder`
    );
  }

  lines.splice(index + 1, 0, "    needs: [ci]");
  return lines.join("\n");
}

/** The same file with the dev-audit command downgraded to a bare `pnpm audit`. */
function withoutDevFlag(source: string): string {
  return source.split(" pnpm audit --dev").join(" pnpm audit");
}

describe("inspectAuditDevJob — synthetic fixtures (the guard is a guard)", () => {
  it("accepts a step-level `continue-on-error: true` as the second non-gating shape", () => {
    // Arrange — no exit-0 suffix at all; only the step-level flag makes it non-gating.
    const source = withStepContinueOnError(PRE_FIX_CI_YML);

    // Act
    const report = inspectAuditDevJob(source);

    // Assert
    expect(report.auditSteps.map((step) => step.exitsZeroOnAuditFailure)).toEqual([false]);
    expect(report.auditSteps.map((step) => step.stepContinueOnError)).toEqual([true]);
    expect(report.nonGating).toBe(true);
  });

  it("fails the non-gating assertion when the exit-0 tolerance is removed and no step is continue-on-error", () => {
    // Arrange — the pre-ADR-0313 defect: job-level `continue-on-error` only.
    const report = inspectAuditDevJob(PRE_FIX_CI_YML);

    // Assert
    expect(report.auditSteps.map((step) => step.exitsZeroOnAuditFailure)).toEqual([false]);
    expect(report.auditSteps.map((step) => step.stepContinueOnError)).toEqual([false]);
    expect(report.jobContinueOnError).toBe(true);
    expect(report.nonGating).toBe(false);
  });

  it("reports a `needs:` the job declares, so invariant 1 cannot pass silently", () => {
    // Arrange
    const source = withNeedsOnAuditDev(REAL_CI_YML);

    // Act
    const report = inspectAuditDevJob(source);

    // Assert
    expect(report.needs).toEqual(["ci"]);
    expect(report.nonGating).toBe(true);
  });

  it("reports a job that no longer audits the dev toolchain", () => {
    // Arrange — a bare `pnpm audit` is the blocking prod scope's business, not the dev one.
    const source = withoutDevFlag(REAL_CI_YML);

    // Act
    const report = inspectAuditDevJob(source);

    // Assert
    expect(report.runsDevAudit).toBe(false);
    expect(report.auditSteps.map((step) => step.exitsZeroOnAuditFailure)).toEqual([true]);
  });

  it("reports the job as absent when it is renamed or deleted, never as non-gating", () => {
    // Arrange
    const source = REAL_CI_YML.replace(`  ${AUDIT_DEV_JOB}:`, `  ${AUDIT_DEV_JOB}-disabled:`);

    // Act
    const report = inspectAuditDevJob(source);

    // Assert
    expect(report.exists).toBe(false);
    expect(report.auditSteps).toEqual([]);
    expect(report.nonGating).toBe(false);
  });
});

describe("the repository's real .github/workflows/ci.yml", () => {
  it("declares the audit-dev job with at least one step that runs `pnpm audit`", () => {
    // Act
    const report = inspectAuditDevJob(REAL_CI_YML);

    // Assert
    expect(report.exists).toBe(true);
    expect(report.auditSteps.length).toBeGreaterThan(0);
  });

  it("declares no `needs:` on audit-dev, so it reports independently", () => {
    // Act
    const report = inspectAuditDevJob(REAL_CI_YML);

    // Assert
    expect(report.needs).toBeNull();
  });

  it("cannot fail the job: its dev-audit step exits 0 on a non-zero audit (or is continue-on-error)", () => {
    // Act
    const report = inspectAuditDevJob(REAL_CI_YML);

    // Assert — every `pnpm audit` step in the job, not just the last one written.
    expect(report.auditSteps.map((step) => step.nonGating)).toEqual(
      report.auditSteps.map(() => true)
    );
    expect(report.nonGating).toBe(true);
  });

  it("still audits the dev toolchain with `pnpm audit --dev`", () => {
    // Act
    const report = inspectAuditDevJob(REAL_CI_YML);

    // Assert
    expect(report.runsDevAudit).toBe(true);
  });

  it("keeps the blocking `audit` job as its own job, so the split still lives on", () => {
    // Act
    const jobs = parseJobs(REAL_CI_YML);

    // Assert
    expect(jobs.has(BLOCKING_AUDIT_JOB)).toBe(true);
    expect(jobs.has(AUDIT_DEV_JOB)).toBe(true);
  });
});
