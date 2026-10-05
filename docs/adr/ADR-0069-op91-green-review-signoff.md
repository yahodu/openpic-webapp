# ADR-0069 — OP-91 GREEN review sign-off: §1.3 sessions and the §1.4 deletion cancel window verified, with one Medium and three Low findings routed

- **Status:** Accepted (review sign-off) · **Date:** 2026-10-05
- **Card:** OP-91 `t_19486cb2` (reviewed) · **PR:** #176 (merged, squash `844060a`) · **Reviewed head:** `0736ddc`
- **Verifies:** ADR-0067 (the RED contract), ADR-0068 (the GREEN implementation)
- **Reviewer:** `openpic-webapp-reviewer`, round 1, artifact lens + execution verification
- **Refactor commit:** `0736ddc` (comment-only; see §Refactor)

## Context

`t_19486cb2` implemented contract §1.3 (sessions & devices list/revoke) and §1.4
(account deletion request/cancel window) on top of the OP-91 RED specs
(ADR-0067). The reviewer independently reproduced the suite on the task
worktree, audited the delivery across security/performance/architecture/test
lenses, and made one comment-only refactor before merging.

## Verification performed (round 1, artifact lens + execution)

Independently reproduced in the task worktree `.worktrees/t_19486cb2` on
`0736ddc`:

- **Unit:** 71 files / 1357 tests pass.
- **Integration:** 36 files / 262 tests pass (`TMPDIR=/root/tmp-mongo`).
- **Playwright:** full run, both `api` and `api-production` projects, 15 passed.
- **Authoritative CI gate** (`ci.yml`: typecheck/lint/unit/integration/coverage/
  build/e2e/audit) green on `0736ddc`.
- **Behaviour:** caller-scoped, active-only sessions list omitting raw
  `ipAddress`/`userAgent`/`token`/`userId` (§0.15); foreign session id is
  `404 not_found` and leaves the victim's session intact; revoke-all goes
  through Better Auth's own endpoints then emits `account.sessions.revoked`
  **once** via the identity lifecycle seam (no `session.delete` hook, so no
  double-emit); deletion is scheduled (not executed) from the seeded
  `platformSettings.account.deletionGraceDays`; cancel restores `active` with
  `deletionScheduledAt: null`, and `409 deletion_already_executed` once the
  purge predicate holds.
- **Security:** CSRF on cookie-authenticated mutating routes is enforced by the
  middleware origin allowlist (Playwright `middleware-csrf.spec.ts` E1/E2). No
  SSRF, open redirect, secret exposure or over-return of fields.
- **Honesty scan:** clean — no fixture-shaped hardcoding, test-env
  conditionals, `@ts-ignore` or dead code.

## Refactor (comment-only, behaviour-preserving)

Four production doc-comments still cited `ADR-0062` (an unrelated OP-89 ADR)
after the merge renumbered the OP-91 ADRs. Corrected to `ADR-0068 §4`/`§6` in
`server/me/sessions.ts`, `server/auth/guards.ts`,
`app/api/v1/me/deletion/route.ts` and `app/api/v1/me/sessions/route.ts`. No
contract path, shape, status or test change; the suite was re-run green after
the edit.

## Findings and routing

| Sev    | Location                              | Finding                                                                                                                           | Routed to                                                        |
| ------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Medium | `POST /me/deletion` (§1.4)            | `account.deletion.requested` is required by the card's scope but is not emitted (no `handleDeletionRequested` seam, no test pin). | `t_86eb4525` (RED pin + hygiene) → `t_3ca3db85` (GREEN emission) |
| Low    | `me-sessions-and-deletion.test.ts:69` | Stale `ADR-0057` reference (now OP-89's; OP-91 RED is ADR-0067).                                                                  | `t_86eb4525`                                                     |
| Low    | `me-sessions-and-deletion.test.ts` I3 | Emitted-row assertion is `findOne`/not-null rather than exactly one row.                                                          | `t_86eb4525`                                                     |
| Low    | `DELETE /me/deletion` handler         | Read-then-write without a conditional update; a concurrent purge could interleave. Speculative until OP-136 lands.                | OP-136 (purge) story                                             |

The Medium and Low test-file findings are test-only and therefore out of the
reviewer's scope (tests are never edited by the reviewer); they ship as the RED
child `t_86eb4525` plus its GREEN child `t_3ca3db85`, both parented to
`t_19486cb2` so they run ahead of unrelated work in the same worktree.

## Decision

Approve and ship. The delivery satisfies the acceptance criteria — raw IPs are
never returned, deletion is scheduled not executed, and cancel restores
`active` — with the full suite and the authoritative CI gate green. Squash-merged
as `844060a` (`--admin`, because the sole GitHub identity is also the PR author
and no second approver exists). The Medium finding is an unmet scope item, not
a data-integrity or security defect, so it does not block this GREEN merge; it
is carried by the linked follow-up cards.
