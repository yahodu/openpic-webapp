import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  CI_EVIDENCE_GUARD_WORKFLOW,
  inspectCiEvidenceGuard,
  loadCiEvidenceGuardSource,
} from "../helpers/ci-evidence-guard.js";

/**
 * Unit contract — `src/test/helpers/ci-evidence-guard.ts` (OP-101 card
 * `t_fe3b946f`, the RED half of the `t_fe3b946f`/`t_22f95e1f` TDD pair).
 *
 * **Why this exists.** GitHub creates **no `pull_request` workflow run while a
 * PR has a merge conflict**. `CI` and `PR Checks` both trigger on
 * `pull_request`, so a lane head whose PR conflicts with `main` gets **no run at
 * all**; the only checks left are CodeQL *default setup* runs
 * (`event=dynamic`, push-triggered, not conflict-suppressed) — three green
 * checks, so the head **reads green** although the suite never ran. The eight
 * closed draft branches each hit this: every one conflicted on
 * `docs/adr/README.md`, and `main` has no required status checks to catch it.
 *
 * The remedy is a new workflow, `.github/workflows/ci_evidence_guard.yml`,
 * triggered by **`on: push`** — the one trigger proved not to be
 * conflict-suppressed — that reads the GitHub API and fails the pushed head when
 * its open PR is conflicting, or when no `CI`/`PR Checks` run exists for that
 * head SHA. This spec pins the *shape* of that workflow; the GREEN sibling card
 * `t_22f95e1f` writes it.
 *
 * **RED.** `.github/workflows/ci_evidence_guard.yml` does not exist on the
 * baseline, so the first assertion in the real-repo block fails naming the
 * missing file, and every structural case below is asserted against the empty
 * source. That is the intended first state.
 *
 * **Scope.** Exactly six invariants, each asserted **twice** — once on a
 * synthetic fixture (so the scanner is a scanner, not a snapshot of today's
 * file) and once on the repository's real workflow:
 *   1. triggered by `on: push` with `branches-ignore: [main]` (and *not* by
 *      `pull_request` / `pull_request_target`);
 *   2. minimal permissions — `contents: read`, `pull-requests: read`,
 *      `checks: read` — with **no** `write` scope;
 *   3. **no `actions/checkout`** step (the job only reads the API);
 *   4. a **conflict assertion**: a `run:` body references the commits→pulls
 *      endpoint and `mergeable`, and emits `::error::`;
 *   5. the **belt-and-braces absence check**: a `run:` body names both `CI` and
 *      `PR Checks` and references `head_sha`;
 *   6. **no `${{ … }}` in any `run:` body** — `github.sha` /
 *      `github.repository` / the token are transported through the step `env:`
 *      map. The *untrusted* half reuses `scanWorkflowSource` from
 *      `apps/web/src/test/helpers/workflow-shell-safety.ts`.
 *
 * **Contract pinned here** (RED and GREEN must not diverge):
 *
 * ```
 * const CI_EVIDENCE_GUARD_WORKFLOW = "ci_evidence_guard.yml"
 * loadCiEvidenceGuardSource(workflowsDir: string): string | null
 * inspectCiEvidenceGuard(file: string, source: string): CiEvidenceGuardReport
 * ```
 *
 * `loadCiEvidenceGuardSource` reads `join(workflowsDir,
 * CI_EVIDENCE_GUARD_WORKFLOW)` and returns `null` (never throws) when the file
 * is absent, so a spec can assert existence with a message naming the file.
 * `inspectCiEvidenceGuard` is pure.
 *
 * ```
 * CiEvidenceGuardReport = {
 *   ok: boolean;
 *   pushTrigger: { push; pullRequest; pullRequestTarget; branchesIgnore: string[] };
 *   permissions: { entries: { key; value }[]; writeKeys: string[]; minimal: boolean };
 *   checkoutUses: { line: number; uses: string }[];
 *   conflictAssertion: { commitsPullsEndpoint; mergeable; errorAnnotation };
 *   absenceCheck: { ciWorkflow; prChecksWorkflow; headSha };
 *   runBodyInterpolations: { file; line; expression }[];
 *   untrustedInterpolations: UntrustedRunInterpolation[];
 * }
 * ```
 *
 * - `permissions.entries` is sorted ascending by `key`; `minimal` is `true`
 *   exactly when the entries are the three read scopes above.
 * - `ok` is the roll-up: `true` only when all six invariants hold.
 * - `runBodyInterpolations` reports **every** `${{ … }}` in a `run:` body
 *   (whatever its context), pinning the `env:`-transport rule;
 *   `untrustedInterpolations` is `scanWorkflowSource(file, source)`.
 *
 * **Trigger boundary (deliberate).** `pull_request_target` was considered as a
 * trigger and **rejected**: its check attachment to the PR head rollup is
 * unproven here, whereas push-triggered checks are proved to attach to the head
 * SHA (the CodeQL runs). The guard is therefore push-only — both
 * `pushTrigger.pullRequest` and `pushTrigger.pullRequestTarget` must be `false`.
 *
 * **No ADR number is consumed.** This is a pin of a new gap; the enforcement
 * contract is recorded separately (the GREEN card names ADR-0305), and this card
 * deliberately touches no ADR file.
 */

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

/** A minimal guard workflow that satisfies all six invariants — the positive fixture. */
const SAFE_GUARD_WORKFLOW = [
  "name: CI Evidence Guard",
  "",
  "on:",
  "  push:",
  "    branches-ignore:",
  "      - main",
  "",
  "permissions:",
  "  contents: read",
  "  pull-requests: read",
  "  checks: read",
  "",
  "jobs:",
  "  ci-evidence:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - name: Assert CI evidence for the pushed head",
  "        env:",
  "          REPO: ${{ github.repository }}",
  "          SHA: ${{ github.sha }}",
  "          TOKEN: ${{ secrets.GITHUB_TOKEN }}",
  "        run: |",
  '          PRS=$(curl -sS -H "Authorization: Bearer $TOKEN" \\',
  '            "https://api.github.com/repos/$REPO/commits/$SHA/pulls")',
  "          MERGEABLE=$(echo \"$PRS\" | jq -r '.[0].mergeable')",
  '          if [ "$MERGEABLE" = "false" ]; then',
  '            echo "::error::head PR is conflicting with main"',
  "            exit 1",
  "          fi",
  '          RUNS=$(curl -sS -H "Authorization: Bearer $TOKEN" \\',
  '            "https://api.github.com/repos/$REPO/actions/runs?head_sha=$SHA")',
  '          for WF in "CI" "PR Checks"; do',
  '            if ! echo "$RUNS" | jq -e --arg wf "$WF" \'.workflow_runs[] | select(.name == $wf)\' >/dev/null; then',
  '              echo "::error::no $WF run for $SHA"',
  "              exit 1",
  "            fi",
  "          done",
].join("\n");

/** The report the positive fixture must produce — freezes the exported shape. */
const SAFE_GUARD_REPORT = {
  ok: true,
  pushTrigger: {
    push: true,
    pullRequest: false,
    pullRequestTarget: false,
    branchesIgnore: ["main"],
  },
  permissions: {
    entries: [
      { key: "checks", value: "read" },
      { key: "contents", value: "read" },
      { key: "pull-requests", value: "read" },
    ],
    writeKeys: [],
    minimal: true,
  },
  checkoutUses: [],
  conflictAssertion: { commitsPullsEndpoint: true, mergeable: true, errorAnnotation: true },
  absenceCheck: { ciWorkflow: true, prChecksWorkflow: true, headSha: true },
  runBodyInterpolations: [],
  untrustedInterpolations: [],
};

/**
 * Replace `from` with `to` without interpreting `$` sequences in `to` (a plain
 * `String.replace` would mangle a `${{ … }}` replacement string).
 */
function withReplacement(base: string, from: string, to: string): string {
  return base.split(from).join(to);
}

const tempDirs: string[] = [];

function makeWorkflowDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-evidence-guard-"));
  tempDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

describe("inspectCiEvidenceGuard — synthetic fixtures", () => {
  it("reduces a conforming guard workflow to the frozen report shape", () => {
    // Act
    const report = inspectCiEvidenceGuard(CI_EVIDENCE_GUARD_WORKFLOW, SAFE_GUARD_WORKFLOW);

    // Assert
    expect(report).toEqual(SAFE_GUARD_REPORT);
  });

  it("flags a pull_request_target trigger as not-push-only", () => {
    // Arrange
    const source = withReplacement(
      SAFE_GUARD_WORKFLOW,
      "on:\n",
      "on:\n  pull_request_target: {}\n"
    );

    // Act
    const report = inspectCiEvidenceGuard(CI_EVIDENCE_GUARD_WORKFLOW, source);

    // Assert
    expect(report.pushTrigger.pullRequestTarget).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("flags a pull_request trigger as conflict-suppressed and therefore forbidden", () => {
    // Arrange
    const source = withReplacement(SAFE_GUARD_WORKFLOW, "on:\n", "on:\n  pull_request: {}\n");

    // Act
    const report = inspectCiEvidenceGuard(CI_EVIDENCE_GUARD_WORKFLOW, source);

    // Assert
    expect(report.pushTrigger.pullRequest).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("reads a flow-sequence branches-ignore ([main]) as well as the block form", () => {
    // Arrange
    const source = withReplacement(
      SAFE_GUARD_WORKFLOW,
      "    branches-ignore:\n      - main",
      "    branches-ignore: [main]"
    );

    // Act
    const report = inspectCiEvidenceGuard(CI_EVIDENCE_GUARD_WORKFLOW, source);

    // Assert
    expect(report.pushTrigger.branchesIgnore).toEqual(["main"]);
    expect(report.ok).toBe(true);
  });

  it("reports push:false when the on: block carries no push trigger", () => {
    // Arrange
    const source = withReplacement(
      SAFE_GUARD_WORKFLOW,
      "  push:\n    branches-ignore:\n      - main",
      "  pull_request:"
    );

    // Act
    const report = inspectCiEvidenceGuard(CI_EVIDENCE_GUARD_WORKFLOW, source);

    // Assert
    expect(report.pushTrigger.push).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("reports a write permission scope and drops minimal", () => {
    // Arrange
    const source = withReplacement(SAFE_GUARD_WORKFLOW, "contents: read", "contents: write");

    // Act
    const report = inspectCiEvidenceGuard(CI_EVIDENCE_GUARD_WORKFLOW, source);

    // Assert
    expect(report.permissions.writeKeys).toEqual(["contents"]);
    expect(report.permissions.minimal).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("reports an actions/checkout step (the job must only read the API)", () => {
    // Arrange
    const source = withReplacement(
      SAFE_GUARD_WORKFLOW,
      "      - name: Assert CI evidence for the pushed head",
      "      - uses: actions/checkout@v4\n      - name: Assert CI evidence for the pushed head"
    );

    // Act
    const report = inspectCiEvidenceGuard(CI_EVIDENCE_GUARD_WORKFLOW, source);

    // Assert
    expect(report.checkoutUses).toEqual([{ line: 17, uses: "actions/checkout@v4" }]);
    expect(report.ok).toBe(false);
  });

  it("flags a run body that never reads mergeable", () => {
    // Arrange
    const source = withReplacement(
      SAFE_GUARD_WORKFLOW,
      "MERGEABLE=$(echo \"$PRS\" | jq -r '.[0].mergeable')",
      "MERGEABLE=$(echo \"$PRS\" | jq -r '.[0].state')"
    );

    // Act
    const report = inspectCiEvidenceGuard(CI_EVIDENCE_GUARD_WORKFLOW, source);

    // Assert
    expect(report.conflictAssertion.mergeable).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("flags a run body that never queries the commits→pulls endpoint", () => {
    // Arrange
    const source = withReplacement(SAFE_GUARD_WORKFLOW, "commits/$SHA/pulls", "pulls");

    // Act
    const report = inspectCiEvidenceGuard(CI_EVIDENCE_GUARD_WORKFLOW, source);

    // Assert
    expect(report.conflictAssertion.commitsPullsEndpoint).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("flags a run body that emits no ::error:: annotation", () => {
    // Arrange
    const source = withReplacement(SAFE_GUARD_WORKFLOW, "::error::", "ERROR:");

    // Act
    const report = inspectCiEvidenceGuard(CI_EVIDENCE_GUARD_WORKFLOW, source);

    // Assert
    expect(report.conflictAssertion.errorAnnotation).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("flags a run body that never references head_sha", () => {
    // Arrange
    const source = withReplacement(SAFE_GUARD_WORKFLOW, "?head_sha=$SHA", "?per_page=100");

    // Act
    const report = inspectCiEvidenceGuard(CI_EVIDENCE_GUARD_WORKFLOW, source);

    // Assert
    expect(report.absenceCheck.headSha).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("flags a run body that omits the PR Checks workflow", () => {
    // Arrange
    const source = withReplacement(SAFE_GUARD_WORKFLOW, '"CI" "PR Checks"', '"CI" "Unit"');

    // Act
    const report = inspectCiEvidenceGuard(CI_EVIDENCE_GUARD_WORKFLOW, source);

    // Assert
    expect(report.absenceCheck.prChecksWorkflow).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("flags a run body that omits the CI workflow", () => {
    // Arrange
    const source = withReplacement(SAFE_GUARD_WORKFLOW, '"CI" "PR Checks"', '"Build" "PR Checks"');

    // Act
    const report = inspectCiEvidenceGuard(CI_EVIDENCE_GUARD_WORKFLOW, source);

    // Assert
    expect(report.absenceCheck.ciWorkflow).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("flags github.sha interpolated into a run body instead of transported through env:", () => {
    // Arrange — `github.sha` is not an *untrusted* context, so only the
    // all-expressions half notices.
    const source = withReplacement(
      SAFE_GUARD_WORKFLOW,
      "          MERGEABLE=",
      '          echo "${{ github.sha }}"\n          MERGEABLE='
    );

    // Act
    const report = inspectCiEvidenceGuard(CI_EVIDENCE_GUARD_WORKFLOW, source);

    // Assert
    expect(report.runBodyInterpolations).toEqual([
      { file: CI_EVIDENCE_GUARD_WORKFLOW, line: 25, expression: "github.sha" },
    ]);
    expect(report.untrustedInterpolations).toEqual([]);
    expect(report.ok).toBe(false);
  });

  it("flags an untrusted context interpolated into a run body via scanWorkflowSource", () => {
    // Arrange
    const source = withReplacement(
      SAFE_GUARD_WORKFLOW,
      "          MERGEABLE=",
      '          echo "${{ github.head_ref }}"\n          MERGEABLE='
    );

    // Act
    const report = inspectCiEvidenceGuard(CI_EVIDENCE_GUARD_WORKFLOW, source);

    // Assert
    expect(report.untrustedInterpolations).toEqual([
      {
        file: CI_EVIDENCE_GUARD_WORKFLOW,
        line: 25,
        expression: "github.head_ref",
        context: "github.head_ref",
      },
    ]);
    expect(report.ok).toBe(false);
  });
});

describe("loadCiEvidenceGuardSource — directory fixtures", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the guard workflow when the file is present", () => {
    // Arrange
    const dir = makeWorkflowDir({ [CI_EVIDENCE_GUARD_WORKFLOW]: SAFE_GUARD_WORKFLOW });

    // Act
    const source = loadCiEvidenceGuardSource(dir);

    // Assert
    expect(source).toBe(SAFE_GUARD_WORKFLOW);
  });

  it("returns null, rather than throwing, when the guard workflow is absent", () => {
    // Arrange — a workflows directory with no `ci_evidence_guard.yml`.
    const dir = makeWorkflowDir({ "ci.yml": "name: CI\n" });

    // Act
    const source = loadCiEvidenceGuardSource(dir);

    // Assert
    expect(source).toBeNull();
  });
});

describe("the repository's real .github/workflows/ci_evidence_guard.yml", () => {
  const workflowsDir = join(repoRoot, ".github/workflows");
  const source = loadCiEvidenceGuardSource(workflowsDir);
  const report = inspectCiEvidenceGuard(CI_EVIDENCE_GUARD_WORKFLOW, source ?? "");

  it("ships the guard workflow at .github/workflows/ci_evidence_guard.yml", () => {
    // Assert
    expect(
      loadCiEvidenceGuardSource(workflowsDir),
      ".github/workflows/ci_evidence_guard.yml does not exist — the CI-evidence guard has not been written yet"
    ).not.toBeNull();
  });

  it("triggers on push with branches-ignore: [main], and is not pull_request / pull_request_target triggered", () => {
    // Assert
    expect(report.pushTrigger).toEqual({
      push: true,
      pullRequest: false,
      pullRequestTarget: false,
      branchesIgnore: ["main"],
    });
  });

  it("declares only the three read permissions and no write scope", () => {
    // Assert
    expect(report.permissions).toEqual({
      entries: [
        { key: "checks", value: "read" },
        { key: "contents", value: "read" },
        { key: "pull-requests", value: "read" },
      ],
      writeKeys: [],
      minimal: true,
    });
  });

  it("checks out no repository code (the job only reads the GitHub API)", () => {
    // Assert
    expect(report.checkoutUses).toEqual([]);
  });

  it("asserts the conflict through the commits→pulls endpoint, mergeable and an ::error:: annotation", () => {
    // Assert
    expect(report.conflictAssertion).toEqual({
      commitsPullsEndpoint: true,
      mergeable: true,
      errorAnnotation: true,
    });
  });

  it("asserts the absence of a CI and a PR Checks run for the pushed head_sha", () => {
    // Assert
    expect(report.absenceCheck).toEqual({
      ciWorkflow: true,
      prChecksWorkflow: true,
      headSha: true,
    });
  });

  it("interpolates no ${{ … }} expression into a run body", () => {
    // Assert
    expect(report.runBodyInterpolations).toEqual([]);
  });

  it("interpolates no untrusted context into a run body", () => {
    // Assert
    expect(report.untrustedInterpolations).toEqual([]);
  });

  it("satisfies every invariant at once (ok)", () => {
    // Assert
    expect(report.ok).toBe(true);
  });
});
