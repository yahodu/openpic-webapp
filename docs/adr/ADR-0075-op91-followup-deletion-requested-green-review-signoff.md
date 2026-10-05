# ADR-0075 — OP-91 follow-up GREEN review sign-off: the `account.deletion.requested` emission verified, one Medium payload finding routed

- **Status:** Accepted (review sign-off) · **Date:** 2026-10-05
- **Card:** `t_3ca3db85` (reviewed) · **PR:** #181 · **Reviewed head:** `051d2b9`
  (base `origin/main` `819cdf1`)
- **Verifies:** ADR-0070 (the RED pin), ADR-0071 (the GREEN implementation),
  ADR-0067/0068 (the OP-91 contract and its GREEN)
- **Reviewer:** `openpic-webapp-reviewer`, round 1, artifact lens + execution
  verification
- **Refactor:** none — the delivery is already minimal and idiomatic (see §Refactor)

## Context

`t_3ca3db85` turned the parent RED spec (I7, ADR-0070) green by emitting the
`account.deletion.requested` domain event required by contract §1.4. The
implementer added `handleDeletionRequested` to `identity-hooks.ts`, exposed it on
`IdentityLifecycleSeams` as `deletionRequested`, and called it once from
`POST /me/deletion` after the `userProfiles` write. The reviewer independently
reproduced the suite and audited the delivery before merging.

## Verification performed (round 1, artifact lens + execution)

Independently reproduced in the task worktree `.worktrees/t_19486cb2` on
`051d2b9`:

- **Focused RED→GREEN:** `me-sessions-and-deletion.test.ts` 13/13 pass; I7
  (`account.deletion.requested` exact-count === 1) now green; the emitted row
  logs `subjectRef.kind: "user"`.
- **Unit:** 71 files / 1357 tests pass.
- **Integration:** 36 files / 263 tests pass (`TMPDIR=/root/tmp-mongo`).
- **Playwright:** `--project api` 14 passed (includes `me-deletion.spec.ts`).
- **Static gates:** `tsc` (root + `apps/web`) clean; `eslint` 0 errors;
  `prettier --check` clean on all changed files.
- **Authoritative CI gate** (`ci.yml`: typecheck/lint/unit/integration/coverage/
  build/e2e/audit) green on `051d2b9`; branch-name/PR-title/secret-scan/codeql
  green.
- **Behaviour:** `POST /me/deletion` with a matching `confirmEmail` returns
  `202`, flips the profile to `deletion_pending` and emits **exactly one** row
  through the identity-lifecycle seam — the route never writes the event
  directly and no `userProfiles` database hook exists, so there is no
  double-emit. The revoked-count assertion (I3) is `countDocuments === 1`.
- **Security:** `requireAuth("user")`; `confirmEmail` exact-match (else `422`);
  no injection surface, no secrets, no over-return of fields.
- **Honesty scan:** clean — the GREEN commits touch only the three production
  files plus docs; no fixture-shaped hardcoding, test-env conditionals,
  `@ts-ignore`, dead code or console noise. The test edits in the PR belong to
  the parent RED commit `a8b66ca`, not to the GREEN implementer.

## Refactor

None. The production change is the smallest correct shape and mirrors
`handleSessionsRevoked`/`sessionsRevoked` exactly (same `safeEmit`, same
`userRef`, same `eventKey:userId:instant` dedupe scheme, same `safeRun`
wrapper), which is what the RED spec explicitly required. No structural,
naming or type refactor was warranted, and the reviewer does not edit the
implementation.

## Findings and routing

| Sev    | Location                                      | Finding                                                                                                                                                                                                                                                                                                                                                                         | Routed to                                 |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Medium | `identity-hooks.ts` `handleDeletionRequested` | `payload: {}` — notification design §4.2 says the `account.deletion.requested` notification "includes cancel-window link", but the outbox row carries no `scheduledAt`/`cancelUrl`, so a future template render has nothing to hydrate. No consumer reads the payload today and the card explicitly scoped payload shape out (§4.2 owns it), so this is not a blocker for #181. | new follow-up card (notification payload) |
| Low    | `POST /me/deletion` handler                   | No idempotency wrapper (contract marks idempotency "optional"); a second submit at a later instant re-emits and recomputes `deletionScheduledAt` (pushes the window). Acceptable per contract; noted so the behaviour is intentional.                                                                                                                                           | no card (observation)                     |
| Low    | `DELETE /me/deletion` handler                 | The cancel path emits no domain event. Contract §1.4 does not require one (only `account.deletion.requested` on POST, `account.deletion.completed` at purge), so this is not a defect.                                                                                                                                                                                          | no card (not a defect)                    |

## Decision

Approve and ship. Every acceptance criterion of the card is met — I7 is green
for the right reason, the emission flows through the identity-lifecycle seam
exactly once, the parent's test commit is preserved, and all gates are green.
Squash-merged as the gated GREEN PR; the sole GitHub identity is also the PR
author, so the merge uses `--admin` (owner bypass on the 1-approving-review
ruleset). The single Medium finding is routed as a follow-up card so the §4.2
payload shape is not lost.

## Alternatives considered

- **Reject for the empty payload** — rejected: the card body and ADR-0070/0071
  explicitly place payload shape (§4.2) out of scope; the emission and its
  subject are the pinned requirement and they are satisfied.
- **Emit the row from the route directly** — rejected by the card and consistent
  with ADR-0043 §3; the seam is the house pattern.
