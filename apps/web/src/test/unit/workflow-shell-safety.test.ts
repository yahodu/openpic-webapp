import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  inspectJobEnvTransport,
  listWorkflowFiles,
  scanWorkflowFiles,
  scanWorkflowSource,
} from "../helpers/workflow-shell-safety.js";

/**
 * Unit contract — `src/test/helpers/workflow-shell-safety.ts` (OP-101 follow-up,
 * review finding F1 of OP-96 card `t_e373a255`).
 *
 * **Why this exists.** `.github/workflows/pr_checks.yml` interpolated
 * attacker-controllable PR context *directly into the script text* of a `run:`
 * step. GitHub expands `${{ … }}` before the shell runs, so the value lands
 * inside the command line and the shell re-parses it: backticks or `$( … )` in
 * a PR title or branch name execute on the runner, and a legitimate title
 * containing backticks fails validation. Observed live on PR #237, whose title
 * `` docs(adr): OP-96 record the `Next free` … `` ran `` `Next free` `` as a
 * command substitution and failed `validate-pr-title` (run `39739073402` /
 * job `119691641674`); it passed only after the backticks were removed
 * (run `39739241884`).
 *
 * **RED.** `src/test/helpers/workflow-shell-safety.ts` does not exist on the
 * baseline, so this file fails on import — the intended first state. It is red
 * for a second, independent reason even once the helper exists: the *real*
 * `.github/workflows` still interpolate the values (see the four real-workflow
 * cases at the bottom), and both invariants below are asserted against them.
 *
 * **Scope.** Exactly two invariants, each pinned twice — once on synthetic
 * fixtures (so the guard is a scanner, not a snapshot of today's files) and
 * once on the repository's real workflows:
 *   (i)  no `run:` body interpolates an untrusted `${{ … }}` context;
 *   (ii) the two `pr_checks.yml` validation jobs still read their value *from
 *        the step environment* (`"$BRANCH"` / `"$TITLE"` supplied by an
 *        `env:` mapping), so the fix cannot be "delete the check".
 *
 * **Contract pinned here** (RED and GREEN must not diverge):
 *
 * ```
 * scanWorkflowSource(file: string, source: string): UntrustedRunInterpolation[]
 * scanWorkflowFiles(workflowsDir: string): UntrustedRunInterpolation[]
 * listWorkflowFiles(workflowsDir: string): string[]
 * inspectJobEnvTransport(source: string, job: string, variable: string): JobEnvTransport
 * ```
 *
 * `UntrustedRunInterpolation = { file; line; expression; context }` — the raw
 * inner expression and the untrusted token that made it untrusted.
 * `JobEnvTransport = { job; variable; readInShell; suppliedByEnv; ok }` where
 * `ok === (readInShell && suppliedByEnv)`.
 *
 * **Deliberate scope boundary (assumption).** Only the contexts named by the
 * OP-101 card count as untrusted — `github.event.*`, `github.head_ref`,
 * `github.base_ref`, `inputs.*`. `${{ github.repository }}`, `${{ github.ref_name }}`
 * and `${{ secrets.X }}` are *not* flagged, so the unrelated `new_branch_flow.yml`
 * (`github.ref_name`) and the Discord notifier workflows (secrets/`github.repository`)
 * stay out of this change. Broadening the set is a review decision, not this pin's.
 *
 * **No ADR number is consumed.** This is a pin of an *existing* gap, not a new
 * decision record (ADR-0300 §2; `docs/adr/README.md` OP-101 range `0280`–`0299`).
 */

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

/** A step that hands the untrusted value over through `env:` — the fixed shape. */
const SAFE_ENV_WORKFLOW = [
  "name: Safe",
  "on: [pull_request]",
  "jobs:",
  "  validate-pr-title:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - name: Check PR title",
  "        env:",
  "          TITLE: ${{ github.event.pull_request.title }}",
  "        run: |",
  '          if [[ ! "$TITLE" =~ ^OP- ]]; then',
  "            exit 1",
  "          fi",
].join("\n");

/** The defect: the untrusted value lands inside the script text and the shell re-parses it. */
const UNSAFE_INTERPOLATION_WORKFLOW = [
  "name: Unsafe",
  "on: [pull_request]",
  "jobs:",
  "  validate-pr-title:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - name: Check PR title",
  "        run: |",
  '          TITLE="${{ github.event.pull_request.title }}"',
  '          if [[ ! "$TITLE" =~ ^OP- ]]; then',
  "            exit 1",
  "          fi",
].join("\n");

const tempDirs: string[] = [];

function makeTempWorkflowDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "workflow-shell-safety-"));
  tempDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

describe("scanWorkflowSource — synthetic fixtures", () => {
  it("reports the file, line and expression of an untrusted context interpolated into a run body", () => {
    // Act
    const findings = scanWorkflowSource("unsafe.yml", UNSAFE_INTERPOLATION_WORKFLOW);

    // Assert
    expect(findings).toEqual([
      {
        file: "unsafe.yml",
        line: 9,
        expression: "github.event.pull_request.title",
        context: "github.event",
      },
    ]);
  });

  it("reports nothing when the same value is handed over through env: instead", () => {
    // Act
    const findings = scanWorkflowSource("safe.yml", SAFE_ENV_WORKFLOW);

    // Assert
    expect(findings).toEqual([]);
  });

  it("ignores a run step that is commented out in YAML", () => {
    // Arrange — the whole step is a YAML comment, so it never runs.
    const source = [
      "# jobs:",
      "#   check:",
      "#     steps:",
      "#       - name: Check",
      "#         run: |",
      '#           T="${{ github.head_ref }}"',
    ].join("\n");

    // Act
    const findings = scanWorkflowSource("commented.yml", source);

    // Assert
    expect(findings).toEqual([]);
  });

  it("flags an untrusted context even inside a shell comment in the run body", () => {
    // Arrange — GitHub expands `${{ … }}` across the whole value before the
    // shell starts, so a shell comment is not a hiding place.
    const source = [
      "jobs:",
      "  check:",
      "    steps:",
      "      - run: |",
      "          # uses ${{ github.head_ref }}",
    ].join("\n");

    // Act
    const findings = scanWorkflowSource("shell-comment.yml", source);

    // Assert
    expect(findings).toEqual([
      {
        file: "shell-comment.yml",
        line: 5,
        expression: "github.head_ref",
        context: "github.head_ref",
      },
    ]);
  });

  it("flags an untrusted context nested inside a function call", () => {
    // Arrange
    const source = [
      "jobs:",
      "  check:",
      "    steps:",
      "      - run: |",
      '          echo "${{ toJSON(github.event.pull_request.body) }}"',
    ].join("\n");

    // Act
    const findings = scanWorkflowSource("call.yml", source);

    // Assert
    expect(findings).toEqual([
      {
        file: "call.yml",
        line: 5,
        expression: "toJSON(github.event.pull_request.body)",
        context: "github.event",
      },
    ]);
  });

  it.each<[string, string]>([
    ["github.head_ref", "github.head_ref"],
    ["github.base_ref", "github.base_ref"],
    ["inputs.ticket", "inputs"],
    ["github.event.pull_request.user.login", "github.event"],
    ["github.event.commits[0].message", "github.event"],
  ])("flags %s as the untrusted context %s", (expression, context) => {
    // Arrange
    const source = [
      "jobs:",
      "  check:",
      "    steps:",
      "      - run: |",
      '          echo "${{ ' + expression + ' }}"',
    ].join("\n");

    // Act
    const findings = scanWorkflowSource("class.yml", source);

    // Assert
    expect(findings).toEqual([{ file: "class.yml", line: 5, expression, context }]);
  });

  it.each<string>([
    "github.repository",
    "github.ref_name",
    "secrets.GITHUB_TOKEN",
    "steps.title.outputs.title",
  ])("does not flag the safe context %s used in a run body", (expression) => {
    // Arrange
    const source = [
      "jobs:",
      "  check:",
      "    steps:",
      "      - run: |",
      '          echo "${{ ' + expression + ' }}"',
    ].join("\n");

    // Act
    const findings = scanWorkflowSource("safe-context.yml", source);

    // Assert
    expect(findings).toEqual([]);
  });

  it("does not treat github.event_name as an untrusted github.event context", () => {
    // Arrange
    const source = [
      "jobs:",
      "  check:",
      "    steps:",
      "      - run: |",
      '          echo "${{ github.event_name }}"',
    ].join("\n");

    // Act
    const findings = scanWorkflowSource("event-name.yml", source);

    // Assert
    expect(findings).toEqual([]);
  });

  it("reports each untrusted expression with its own line number", () => {
    // Arrange
    const source = [
      "jobs:",
      "  check:",
      "    steps:",
      "      - run: |",
      '          A="${{ github.head_ref }}"',
      "          echo done",
      '          B="${{ inputs.ticket }}"',
    ].join("\n");

    // Act
    const findings = scanWorkflowSource("multi.yml", source);

    // Assert
    expect(findings).toEqual([
      { file: "multi.yml", line: 5, expression: "github.head_ref", context: "github.head_ref" },
      { file: "multi.yml", line: 7, expression: "inputs.ticket", context: "inputs" },
    ]);
  });
});

describe("scanWorkflowFiles / listWorkflowFiles — directory fixtures", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports findings from every *.yml and *.yaml workflow in a directory", () => {
    // Arrange
    const dir = makeTempWorkflowDir({
      "safe.yml": SAFE_ENV_WORKFLOW,
      "unsafe.yaml": UNSAFE_INTERPOLATION_WORKFLOW,
      "notes.txt": 'BRANCH="${{ github.head_ref }}"',
    });

    // Act
    const findings = scanWorkflowFiles(dir);

    // Assert
    expect(findings).toEqual([
      {
        file: join(dir, "unsafe.yaml"),
        line: 9,
        expression: "github.event.pull_request.title",
        context: "github.event",
      },
    ]);
  });

  it("lists workflow files ascending by name and ignores other extensions", () => {
    // Arrange
    const dir = makeTempWorkflowDir({
      "b.yaml": "",
      "a.yml": "",
      "notes.txt": "",
      "readme.md": "",
    });

    // Act
    const files = listWorkflowFiles(dir).map((path) => basename(path));

    // Assert
    expect(files).toEqual(["a.yml", "b.yaml"]);
  });
});

describe("inspectJobEnvTransport — synthetic fixtures", () => {
  it('accepts a job that supplies the variable through env: and reads "$TITLE" from the shell', () => {
    // Act
    const report = inspectJobEnvTransport(SAFE_ENV_WORKFLOW, "validate-pr-title", "TITLE");

    // Assert
    expect(report).toEqual({
      job: "validate-pr-title",
      variable: "TITLE",
      readInShell: true,
      suppliedByEnv: true,
      ok: true,
    });
  });

  it("accepts the ${TITLE} brace form as a shell read", () => {
    // Arrange
    const source = [
      "jobs:",
      "  check:",
      "    steps:",
      "      - name: Check",
      "        env:",
      "          TITLE: ${{ github.event.pull_request.title }}",
      "        run: |",
      '          if [[ ! "${TITLE}" =~ ^OP- ]]; then',
      "            exit 1",
      "          fi",
    ].join("\n");

    // Act
    const report = inspectJobEnvTransport(source, "check", "TITLE");

    // Assert
    expect(report.ok).toBe(true);
  });

  it("rejects a job that still interpolates the value into the script", () => {
    // Act
    const report = inspectJobEnvTransport(
      UNSAFE_INTERPOLATION_WORKFLOW,
      "validate-pr-title",
      "TITLE"
    );

    // Assert
    expect(report).toEqual({
      job: "validate-pr-title",
      variable: "TITLE",
      readInShell: true,
      suppliedByEnv: false,
      ok: false,
    });
  });

  it("rejects a job that no longer reads the variable at all (the check was deleted)", () => {
    // Arrange — the env mapping survives but nothing in the job uses it.
    const source = [
      "jobs:",
      "  validate-pr-title:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Check PR title",
      "        env:",
      "          TITLE: ${{ github.event.pull_request.title }}",
      "        run: |",
      '          echo "nothing to validate"',
    ].join("\n");

    // Act
    const report = inspectJobEnvTransport(source, "validate-pr-title", "TITLE");

    // Assert
    expect(report).toEqual({
      job: "validate-pr-title",
      variable: "TITLE",
      readInShell: false,
      suppliedByEnv: true,
      ok: false,
    });
  });

  it("does not count an env: mapping that belongs to a different job", () => {
    // Arrange — the reading job has no env: mapping of its own.
    const source = [
      "jobs:",
      "  other:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Other",
      "        env:",
      "          TITLE: ${{ github.event.pull_request.title }}",
      "        run: |",
      '          echo "$TITLE"',
      "  check:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Check",
      "        run: |",
      '          echo "$TITLE"',
    ].join("\n");

    // Act
    const report = inspectJobEnvTransport(source, "check", "TITLE");

    // Assert
    expect(report).toEqual({
      job: "check",
      variable: "TITLE",
      readInShell: true,
      suppliedByEnv: false,
      ok: false,
    });
  });

  it("does not count a plain shell assignment as an env: mapping", () => {
    // Arrange
    const source = [
      "jobs:",
      "  check:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Check",
      "        run: |",
      '          TITLE="op-1 thing"',
      '          echo "$TITLE"',
    ].join("\n");

    // Act
    const report = inspectJobEnvTransport(source, "check", "TITLE");

    // Assert
    expect(report).toEqual({
      job: "check",
      variable: "TITLE",
      readInShell: true,
      suppliedByEnv: false,
      ok: false,
    });
  });

  it("reports ok:false for a job that does not exist", () => {
    // Act
    const report = inspectJobEnvTransport(SAFE_ENV_WORKFLOW, "no-such-job", "TITLE");

    // Assert
    expect(report).toEqual({
      job: "no-such-job",
      variable: "TITLE",
      readInShell: false,
      suppliedByEnv: false,
      ok: false,
    });
  });
});

describe("the repository's real .github/workflows", () => {
  const workflowsDir = join(repoRoot, ".github/workflows");
  const prChecks = readFileSync(join(workflowsDir, "pr_checks.yml"), "utf8");

  it("interpolates no untrusted PR context into a run: body anywhere under .github/workflows", () => {
    // Act — report bare file names so the failure names the offending workflow.
    const flagged = scanWorkflowFiles(workflowsDir).map((finding) => ({
      ...finding,
      file: basename(finding.file),
    }));

    // Assert
    expect(flagged).toEqual([]);
  });

  it("keeps validate-branch-name reading BRANCH from the step environment", () => {
    // Act
    const report = inspectJobEnvTransport(prChecks, "validate-branch-name", "BRANCH");

    // Assert
    expect(report).toEqual({
      job: "validate-branch-name",
      variable: "BRANCH",
      readInShell: true,
      suppliedByEnv: true,
      ok: true,
    });
  });

  it("keeps validate-pr-title reading TITLE from the step environment", () => {
    // Act
    const report = inspectJobEnvTransport(prChecks, "validate-pr-title", "TITLE");

    // Assert
    expect(report).toEqual({
      job: "validate-pr-title",
      variable: "TITLE",
      readInShell: true,
      suppliedByEnv: true,
      ok: true,
    });
  });
});
