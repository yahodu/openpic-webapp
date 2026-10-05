# ADR-0081 — OP-91 follow-up payload review sign-off: `scheduledAt`/`cancelUrl` verified RED→GREEN; ADR renumber drift routed

- **Status:** Accepted (review sign-off) · **Date:** 2026-10-05
- **Card:** `t_fab602c7` (reviewed) · **PR:** #183 · **Reviewed head:** `6eb8474`
  (base `origin/main` `f61a222`)
- **Verifies:** ADR-0078 (the RED pin), ADR-0079 (the GREEN implementation),
  ADR-0070/ADR-0071 (the deletion-requested emission RED/GREEN, amended)
- **Reviewer:** `openpic-webapp-reviewer`, round 1, artifact lens + execution
  verification
- **Refactor:** none — the production diff is already the smallest correct
  shape (see §Refactor)

## Context

ADR-0070/ADR-0071 wired `POST /me/deletion` to emit exactly one
`account.deletion.requested` outbox row through the identity-lifecycle seam, but
left that row's `payload` as `{}`. Contract §1.4 / notification design §4.2 need
the notification consumer to deep-link the cancel window, so the follow-up pair
pins and then carries `{ scheduledAt, cancelUrl }`. This ADR records the
independent review and merge of that lane.

## Verification performed (round 1, artifact lens + execution)

Resolved the artifact first: `git ls-remote origin` reported head
`6eb8474d02074bd7e6d2453bb289f286cddbecba`; the PR #183 head matched; reviewed in
the lane worktree `.worktrees/OP-91-deletion-payload` pinned to that exact SHA
(the PR had already merged `origin/main` `f61a222`, so `origin/main` is an
ancestor of the head — no behind-by commits).

- **RED→GREEN, reproduced independently:** reverting only the two production
  files (`route.ts`, `identity-hooks.ts`) to their `origin/main` state re-runs
  **I8** red with `AssertionError: expected 'undefined' to be 'string'`
  (`payload.scheduledAt`), proving the RED spec genuinely pins the payload and
  fails without the GREEN commit; with the GREEN commit I8 passes. The RED test
  file is byte-identical to the RED commit `85717f6` — GREEN did not touch it.
- **Focused:** `me-sessions-and-deletion.test.ts` 14/14 pass.
- **Unit:** 75 files / **1394 tests** pass.
- **Integration:** 38 files / **283 tests** pass (`TMPDIR=/root/tmp-mongo`).
- **Static gates:** `tsc` (root + `packages/contracts` + `apps/web`) clean;
  `eslint .` 0 errors / 21 pre-existing warnings; `prettier --check` clean.
- **Authoritative CI gate:** all PR checks on `6eb8474` green — `ci`, `unit_test`,
  `test_coverage`, `lint`, `env-changes`, `secret-scan`, `CodeQL`,
  `validate-branch-name`, `validate-pr-title`.
- **Payload equality:** the emitted row's `payload.scheduledAt` string-equals the
  202 body's `scheduledAt` and `cancelUntil` (same ISO instant) and
  `payload.cancelUrl === DELETION_PATH` (`/api/v1/me/deletion`); `tenantId` /
  `actorRef` / `subjectRef` stay `userRef(userId)`, the
  `eventKey:userId:instant` dedupe scheme is unchanged, and I7's exactly-one-row
  count still holds.
- **Diff surface:** `git diff origin/main...6eb8474` changes **only** the allowed
  surfaces — `identity-hooks.ts`, `me/deletion/route.ts`, the RED spec
  `me-sessions-and-deletion.test.ts`, `ADR-0071` (amended in place), the new
  ADR-0078/ADR-0079 docs and `docs/adr/README.md`. No mock, fixture or
  test-utility edit outside the RED commit; ADR-0071's `{}` note now points at
  ADR-0079.
- **Honesty scan:** clean — no debug prints, commented-out code, hardcoded
  secrets, `@ts-ignore` or fixture-shaped hardcoding. The only production change
  threads the already-computed `scheduledIso` + `DELETION_PATH` into the seam.

## Refactor

None. The GREEN diff hoists `scheduledIso` to a single binding (removing a
duplicate `scheduledAt.toISOString()` call) and extends `DeletionRequestedEvent`
with two readonly string fields that mirror the 202 body's names — the smallest
correct shape, consistent with `handleSessionsRevoked`/`sessionsRevoked`. No
structural, naming or type refactor was warranted, and the reviewer does not
rewrite the implementation.

## Findings and routing

| Sev    | Location                                      | Finding                                                                                                                                                                                                                                                                                                                                   | Routed to                                    |
| ------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Medium | `docs/adr/` (lane numbering)                  | ADR-number drift across unmerged sibling lanes: this lane holds ADR-0078/0079 while the unmerged OP-93 lane (`81c40e4`) also writes ADR-0079 (`op93-red-review-signoff`) and ADR-0080 (`op93-red-pins-followup-review-signoff`). Whichever of the two merges second must renumber — the same churn that forced this lane's RED 0076→0078. | orchestrator (ADR allocation)                |
| Low    | `POST /me/deletion` handler                   | No idempotency wrapper (contract marks idempotency "optional"); a second submit at a later instant re-emits with a new `now`-based dedupe instant. Pre-existing behaviour, unchanged by this lane.                                                                                                                                        | no card (observation, carried from ADR-0075) |
| Low    | `identity-hooks.ts` `handleDeletionRequested` | `payload.scheduledAt` is the ISO string the route computed; the handler does not re-validate it. The seam is internal and the RED pin fixes the contract, so this is acceptable.                                                                                                                                                          | no card (not a defect)                       |

## Decision

Approve and ship. The review sign-off ADR is written as **ADR-0081**, not 0080:
`origin/main` leaves 0080 free, but the unmerged OP-93 sibling lane already writes
ADR-0080 (and ADR-0079), so taking 0081 avoids a guaranteed duplicate-number
collision while reporting the shift. Squash-merged as the gated PR; the sole
GitHub identity is also the PR author, so the merge uses `--admin` (owner bypass
on the 1-approving-review ruleset).

## Alternatives considered

- **Reject for the ADR collision** — rejected: the collision is a docs/hygiene
  issue outside this lane's code, and the code contract is fully met; the drift is
  routed to the orchestrator instead of blocking a green, correct delivery.
- **Take ADR-0080** — rejected: it is already claimed on the OP-93 branch, and
  the whole point of this sign-off is to reduce renumber churn.
