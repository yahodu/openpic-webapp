# ADR-0077 — OP-92 GREEN review sign-off and the Novu HTTP-plumbing refactor

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-reviewer`
- **Card:** `t_8930fc35` (OP-92 MessageTransport port, Novu adapter and workflow drift guard, GREEN) · **Deliverable:** branch `OP-92-task-message-transport-novu-drift`, PR #182
- **Contract under review:** `docs/adr/ADR-0076-op92-message-transport-and-novu-drift-guard-green.md`
- **Implements (review stage):** ADR-0072 (RED) · ADR-0073 (RED sign-off) · ADR-0074 (RED pins)

## Verdict

**APPROVED WITH FINDINGS** (round 1, artifact lens + execution). The GREEN
implementation turns every RED pin green for the right reason, adds no
production code the pins do not drive, modifies no test, and regresses nothing.
One behaviour-preserving refactor was made (below); the findings are coverage
gaps and two documented deviations, routed to a Test Author + GREEN follow-up
pair so they are fixed rather than merely flagged.

## Evidence (reproduced independently by the reviewer)

- Unit: `vitest run --project unit` → **75 files / 1394 tests passed**.
- Integration: `TMPDIR=/root/tmp-mongo vitest run --project integration` →
  **38 files / 281 tests passed**.
- Coverage: **92.96 % lines / 83.47 % branches** (≥ 80 threshold).
- `tsc -p apps/web/tsconfig.json --noEmit` clean; `eslint .` → **0 errors**
  (21 pre-existing security warnings); `prettier --check .` clean.
- `git diff --name-only 645dbbb..HEAD` (the GREEN-only commit range) touches
  **no test, factory, fixture or spec file** — the RED pins from
  `t_fd03ff87`/`t_97f1df44` ship unchanged inside this PR.
- No `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `console.*`, `TODO` or
  `FIXME` in the GREEN diff. No fixture-shaped hardcoding or test-environment
  conditional found.
- PR #182 CI: branch-name, pr-title, lint, env-changes, unit_test,
  test_coverage, ci, secret-scan, CodeQL — all passing.

## Refactor (behaviour-preserving, suite-verified)

**Extracted `apps/web/src/server/adapters/novu/novu-http.ts`.** The drift guard
and the workflow-upsert engine each re-implemented the identical "GET
`/v1/workflows` with `ApiKey` auth, parse with `novuWorkflowListSchema`, log +
return 1 on failure" block, and the transport adapter repeated the same auth
scheme. The new module owns `novuAuthHeaders(apiKey)` and
`readNovuWorkflowList(connection) -> { ok, workflows } | { ok, status? }`; the
three call sites now share it.

- The log event names, log messages, exit codes, HTTP verbs, headers, request
  bodies and return shapes are byte-for-byte unchanged — the drift check and
  the upsert engine branch on `read.status === undefined` to reproduce exactly
  the prior "request failed" vs "did not match the contract" messages.
- Verified after the change: unit 1394 / integration 281 pass, coverage above
  threshold, typecheck/lint/format clean.

## Findings

### Medium — the drift guard does not flag an inactive step (coverage gap)

`checkTransportWorkflows` normalizes `TransportWorkflowStep.active` (and
`transportWorkflowStepSchema` requires it) but never reads it, so a workflow
whose single step is **disabled** passes the guard even though such a workflow
delivers nothing. The CLI doc-string and ADR-0076 promise "one **active**
step". Location: `apps/web/src/server/adapters/novu/workflow-drift.ts:56-72`.
Routing: **Test Author** — pin an inactive-step fixture (RED), then a GREEN card
adds the check. This is the one finding with real operational weight.

### Low — a duplicate workflow id collapses and is not reported (coverage gap)

`checkTransportWorkflows` stores workflows in a `Map` keyed by `workflowId`, so
two entries with the same id overwrite one another and the "exactly three
workflows" invariant is not enforced for a duplicate. Location:
`workflow-drift.ts:39-47`. Routing: **Test Author** (bundle with the Medium).

### Low — a non-JSON 2xx body is not classified as a `TransportError`

In `novuTransport.send`, only `fetch` is wrapped by the classifier; a 200 with a
body that is not JSON makes `response.json()` throw a raw `SyntaxError` that
escapes as a non-transport error. Every other failure path is a classified
`TransportError` (retryable/non-retryable). Location:
`novu-transport.ts:151`. Routing: **Test Author** (bundle) — the GREEN fix wraps
the parse in `classifyTransportFailure` as a non-retryable/retryable contract
failure.

### Low — the adapter timeout default degrades silently (documented deviation)

`configuredTimeoutMs()` catches `getConfig()` and falls back to `10_000` ms
(ADR-0076 §1), so a mis-configured process would not fail fast. Behaviour is
identical to the pins' expectation when configured. Informational only — no
change requested; recorded so a future GREEN can decide whether to fail fast in
production builds.

### Low — `getNovuRuntimeConfig()` is an unpinned surface (documented deviation)

The admin-CLI accessor reads `NOVU_BASE_URL`/`NOVU_API_KEY` outside the frozen
`AppConfig` (ADR-0076 §2). It exists only to make the card-mandated CLIs
runnable and is not asserted by a spec. Informational.

### Low — the drift guard has no CI job (documented deviation)

AC2's behaviour is pinned by I5b and `pnpm novu:assert-no-drift` exists, but no
GitHub Actions job invokes it (ADR-0076 §3): wiring one needs the `NOVU_API_KEY`
secret and would block PRs until production Novu holds the three workflows.
Ops follow-up, not a code defect.

## Consequences

- The reviewed code stands; PR #182 is squash-merged to `main` and the local
  `main` is synced (local == remote).
- The Medium and two Low coverage gaps are routed to a Test Author RED-pins card
  and a dependent GREEN card on the same worktree, so they are fixed rather than
  left as prose.
- The reviewer edited no test file. The only production change at review time is
  the `novu-http.ts` extraction; this ADR and its README row are the only doc
  changes.

## Alternatives

- **Leave the duplication.** Rejected: three copies of the Novu auth scheme and
  two copies of the workflow-list read invite drift in exactly the vendor
  boundary this card exists to isolate.
- **Request changes / block on the coverage gaps.** Rejected: the card's own
  acceptance criteria are met (extra steps/workflows are covered); the gaps are
  additive hardening the Test Author must pin first under AGENTS.md §2.1.
