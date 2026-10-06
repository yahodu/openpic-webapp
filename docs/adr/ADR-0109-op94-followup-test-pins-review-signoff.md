# ADR-0109 — OP-94 §1 follow-up TEST review sign-off: the non-memory transport branch, the recipient audiences and the `after()` trigger failure path

- **Status:** Accepted · **Date:** 2026-10-06
- **Card:** OP-94 §1 follow-up DOCS sign-off (`t_6b01f1ea`, assignee `openpic-webapp-reviewer`)
- **Reviewed artifact:** branch `OP-94-task-followup-test-pins`, review round 2 at head `fe8a102` (base `origin/main` `dc74c58`, which includes the pinned implementation head `49126f4`)
- **PR:** [#205](https://github.com/yahodu/openpic-webapp/pull/205) — review summary at [#issuecomment-6007848217](https://github.com/yahodu/openpic-webapp/pull/205#issuecomment-6007848217)
- **Follow-up:** the GREEN child `t_b0ef19fc` (`openpic-webapp-backend-coder`) extended the same branch/PR with the fail-closed guard and owned the merge
- **Relates to:** [ADR-0108](ADR-0108-op94-followup-test-pins.md) (the reviewed TEST decision), [ADR-0107](ADR-0107-op94-followup-fanout-cron-route-green-review-signoff.md) (the parent GREEN sign-off that routed M1/M2 here), [ADR-0106](ADR-0106-op94-followup-fanout-cron-route-green.md) (the implementation under pin), [ADR-0105](ADR-0105-op94-followup-fanout-cron-route-red.md) (the original pins), [ADR-0090](ADR-0090-op94-notification-fan-out-red.md) / [ADR-0092](ADR-0092-op94-notification-fan-out-green.md) (the fan-out consumer)

## Context

The OP-94 §1 follow-up TEST card (`t_bd94250c`, ADR-0108) pinned the three
ADR-0106 coverage gaps: the non-memory branch of the shared transport factory,
the concrete `RecipientRepository` audiences, and the opportunistic `after()`
trigger failure path. Its acceptance was _"the gap is now pinned and `main`
stays green"_ — with one deliberate, intended RED: the empty/blank
`NOVU_API_KEY` posture was pinned as fail-closed while the implementation still
built a transport with an empty key.

The review ran two rounds. **Round 1** (head `5e9818d`) returned **CHANGES
REQUESTED** — the test pins themselves were verified correct, but the lane ADR
collided with `ADR-0107` already on `main` (PR #204 / `dc74c58`) and the GREEN
child was mis-provisioned. **Round 2** (head `fe8a102`) confirmed both round-1
fixes landed and returned **APPROVED WITH FINDINGS**. Nothing in this card
changes production or test code — it records the sign-off, matching the lane
precedent (ADR-0101, ADR-0104, ADR-0107).

## Decision

### Item 1 — round-2 verdict recorded

**APPROVED WITH FINDINGS**, no code changes requested and no new code cards.
The lane merged only after the GREEN child turned the intended RED green; the
open items were a process/coverage routing concern (below).

### Item 2 — round-1 findings verified fixed

- **M-1 (ADR number collision, was merge-blocking) — FIXED.** The lane ADR was
  renamed `0107 → 0108` (`docs/adr/ADR-0108-op94-followup-test-pins.md`), its
  title and self-reference updated, and the cross-reference at
  `apps/web/src/server/adapters/message-transport-provider.test.ts:34` corrected.
  `docs/adr/README.md` keeps **both** the `0107` sign-off row (already on `main`)
  and the new `0108` row, and the lane-note paragraph was merged for the two
  lanes.
- **L-1 (branch behind `origin/main`) — FIXED** by the same merge
  (`dc74c58`; the reviewed head `fe8a102` was 0 behind / 2 ahead).
- **L-2 (child card provisioning) — FIXED.** The mis-provisioned child
  `t_5fa948f5` (`workspace_kind: scratch`, stale ADR path) was superseded by
  `t_b0ef19fc`, provisioned `workspace_kind: worktree` under
  `/root/openpic/openpic-webapp/.worktrees/` with the ADR-0108 path and branch
  tip `fe8a102`.

### Item 3 — independent evidence reproduced at `fe8a102`

The reviewer re-ran the gates on the reviewed head, not only the focused specs:

- Focused unit (transport factory + trigger) → **6 tests, 2 failed** — exactly
  the intended U2 RED, for the right reason:
  `AssertionError: expected undefined to be an instance of ConfigError` at
  `message-transport-provider.test.ts:145`.
- Full `unit` → **83 files, 1458 passed / 2 failed** (the intended RED only).
- Full `integration` → **43 files, 326 passed**; focused `notification-recipients`
  green (both id storage forms, invitation kinds/statuses, `subject.kind`,
  billing contact, admin status, missing-collection/field resilience).
- `tsc` (root + contracts + web) exit 0; `eslint` 0 errors on the new specs;
  `prettier --check` clean.
- Honesty scan (fixture-specific hardcoding, test-environment conditionals,
  suspiciously narrow logic): **clean**; production files changed: **none** —
  the diff vs `origin/main` was **3 test files + 2 docs**. The reviewer changed
  no file (`changed_by_reviewer: []`).

### Item 4 — findings routed

No finding required a code change before merge.

- **L-3 (Low, process) — superseded card left dispatchable.** The superseded
  child `t_5fa948f5` remained `todo`; on the TEST card's completion it would
  have dispatched `openpic-webapp-backend-coder` alongside `t_b0ef19fc` (same
  scope, two implementers). → routed to orchestrator card `t_0f9d9cc4`, which
  gates both `t_5fa948f5` and `t_b0ef19fc` until it archives the superseded
  card. **Handled there, not here.**
- **Acknowledged, not a finding — the intended RED posture.** Production
  `getMessageTransport()` building `novuTransport` with a possibly-empty
  `NOVU_API_KEY` is the sanctioned characterization of the current behaviour;
  the fail-closed fix stays routed to the GREEN child `t_b0ef19fc` and is not a
  defect this card may fix (a behaviour change needs the green tests first).

### Item 5 — merge posture (a red suite must never land on `main`)

At sign-off, PR #205 was an **OPEN DRAFT** and red-CI _by design_: the two
intended U2 cases failed until the GREEN child landed its guard. A red suite
must never land on `main`, so the sign-off explicitly kept the PR in draft and
routed the merge **ownership** to the GREEN child `t_b0ef19fc`, which extended
this same branch/PR. That child later added the fail-closed guard, turned the
two intended RED cases green and, after its own round-1 review (APPROVED,
head `40d4534`), squash-merged PR #205 to `main` as `f16e26d`. The pins and the
guard therefore landed **together**, green — never a red intermediate on `main`.

## Consequences

- The OP-94 §1 follow-up TEST lane has a durable review record; a reader
  arriving from ADR-0108 finds the round-1 → round-2 verdict, the reproduced
  evidence, the routed process finding and the merge posture.
- The regression pins (non-memory POST URL/key, the fail-closed empty-key
  posture, every recipient audience, the trigger swallow-and-log path) are on
  `main` via `f16e26d`; a regression in any of them now fails a named test.
- The process finding lives on orchestrator card `t_0f9d9cc4` rather than in
  this docs-only card, so the ADR remains a record and not a re-review.
- No production or test file changed here; the suite is unaffected by this ADR.

## Alternatives considered

- **Land the TEST pins green without the intended RED (characterize empty-key).**
  Rejected by the lane's own ADR-0108 and the round-1 review: the codebase's
  deploy posture is fail-closed (`getRateLimitConfig()`, the production `memory`
  refusal), and the card explicitly routed the posture to a GREEN child instead
  of editing production in the TEST lane.
- **Record the sign-off inside ADR-0108.** Rejected: ADR-0108 is the lane's own
  immutable decision record; the review sign-off is a separate decision and
  follows the per-lane `RED → GREEN → sign-off` numbering precedent
  (e.g. ADR-0105/0106/0107).
- **Take ADR-0109 without re-checking `origin/main`.** Rejected: `docs/adr/README.md`
  is a cross-lane hotspot; the lowest free number was re-verified against fresh
  `origin/main` (highest was `0108`, so `0109` is free) before allocating.

## Out of scope

- Any production behaviour change (the merged GREEN is authoritative).
- Test edits (the pins are authoritative; no change was requested).
- The archive of the superseded card `t_5fa948f5` (orchestrator card `t_0f9d9cc4`).
- The RED pins themselves (`t_1a77ec00`, ADR-0105).
