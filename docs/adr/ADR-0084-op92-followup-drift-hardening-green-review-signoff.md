# ADR-0084 — OP-92 follow-up GREEN review sign-off: inactive-step, duplicate-id and non-JSON 2xx hardening

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-reviewer`
- **Card:** `t_3f26ec7d` (dependent GREEN of the RED-pins card `t_c38934da`) · **Deliverable:** branch `OP-92-task-followup-drift-hardening-green`, PR #186
- **Contract under review:** `docs/adr/ADR-0083-op92-followup-drift-hardening-green.md`
- **Implements (review stage):** ADR-0076/0077 (OP-92 GREEN + sign-off) · ADR-0082 (follow-up RED pins)

## Verdict

**APPROVED** (round 1, artifact lens + execution). The three RED pins
(`workflow-drift.test.ts` inactive step + duplicate id; `novu-workflow-drift.test.ts`
I5c; `novu-transport.test.ts` I19) are turned green for the right reason by the
minimum production change, no test/factory/fixture/MSW file was modified, and the
drift guard, transport adapter and vendor boundary regress nothing. No refactor
was warranted — the diff is already minimal and idiomatic. No changes requested
and no required follow-up at this level.

## Evidence (reproduced independently by the reviewer)

- Unit: `vitest run --project unit` → **75 files / 1396 tests passed**.
- Focused unit: `vitest run --project unit workflow-drift` → **1 file / 7 passed**.
- Integration: `TMPDIR=/root/tmp-mongo vitest run --project integration` →
  **38 files / 284 tests passed**; focused `novu-transport novu-workflow-drift` →
  **2 files / 21 passed**.
- Coverage: **93 % lines / 83.51 % branches / 95.73 % functions / 92.87 % statements**
  (matches the handoff exactly; ≥ 80 threshold).
- `tsc -b` clean; `eslint .` → **0 errors**, 21 pre-existing security warnings;
  `prettier --check` clean; `next build` clean (13 routes).
- `git diff 7767751..b9413a5` (the GREEN-only commit) touches **two production
  modules + ADR-0083 + `docs/adr/README.md` only** — no test, factory, fixture or
  MSW handler.
- No `@ts-ignore`/`@ts-expect-error`, `eslint-disable`, `console.*`, `TODO`/`FIXME`,
  fixture-shaped hardcoding or test-environment conditional in the GREEN diff.
- PR #186 CI (head `b9413a5`): validate-branch-name, validate-pr-title, env-changes,
  secret-scan, lint, unit_test, test_coverage, ci, CodeQL — **all passing**.

## Pin fidelity (why each pin is green for the right reason)

- **Inactive step** — `!step.active` is read after the "exactly one step" and
  channel checks. The fixture (`makeCanonicalTransportWorkflows` with only
  `transport-email` disabled) can fail _only_ on the new check, so `ok === false`
  is attributable to it, not to an incidental problem.
- **Duplicate id** — the additive `Set` catches a byte-identical duplicate that
  the `Map` used to collapse. The fixture is three canonical workflows plus one
  identical `transport-email`, so duplicate detection is the _only_ possible cause
  of `ok === false`; the assertion is therefore not weaker than it looks.
- **Non-JSON 2xx** — `response.json()` rejection is caught, logged on
  `transport.upstream_contract_violation` at `error` and rethrown as
  `UpstreamContractError` (`retryable: false`). The I19 pin asserts the classified
  `TransportError` instance and `{ retryable:false, code:"upstream_contract_violation" }`.
  The success path (schema parse + `transport.sent`) is untouched.

## Findings

### Low — duplicate ids are reported but the per-id checks still run against the last entry (informational)

`checkTransportWorkflows` keeps the `Map` for the step/channel lookups, so when
two entries share an id the later one wins for those checks. The outcome
(`ok === false`) is stable regardless of order because the duplicate is always
reported, so this is not a defect; only the _set of problem strings_ can vary
with the order of the duplicates. Location: `workflow-drift.ts:44-57`.
No change requested — recorded so a future refactor can pick "first occurrence
wins" deterministically if problem-string stability ever matters.

### Low — the drift guard is still not invoked from CI (ops follow-up, pre-existing)

AC2's behaviour is pinned by I5c/I5b and `pnpm novu:assert-no-drift` exists, but no
GitHub Actions job runs it (already flagged in ADR-0077). Wiring one needs the
`NOVU_API_KEY` secret and would block PRs until production Novu holds the three
workflows. Out of this card's scope; carried forward from ADR-0077.

## Consequences

- PR #186 is squash-merged to `main`; local `main` synced to `origin/main`.
- The three hardening behaviours are now covered by specs that predate the
  implementation, so future refactors of the guard or the adapter stay safe.
- The superseded draft RED PR #184 is routed to a cleanup card (it is an ancestor
  of this merge and its diff is a strict subset).
- The reviewer edited no implementation and no test file; this ADR and its README
  row are the only changes made at review time.

## Alternatives

- **Request changes.** Rejected: the implementation is minimal, correct and
  behaviour-preserving; the two Low items are informational and no pin is
  under-asserted.
- **Extract the duplicate scan into a helper.** Rejected: a five-line additive
  `Set` guard is clearer inline than a named indirection, and extraction would
  churn a hot, well-tested function for no readability gain.
- **Leave a review sign-off ADR unwritten.** Rejected: `docs/adr/README.md` reserved
  a sign-off number for this lane and every prior GREEN review lane records one
  (0065/0069/0075/0077); writing it keeps the reservation from going stale. (At
  integration the lane renumbered `0078/0079/0080 → 0082/0083/0084` because the
  OP-91 follow-up payload lane claimed `0078`-`0079`/`0081` on `origin/main` first.)
