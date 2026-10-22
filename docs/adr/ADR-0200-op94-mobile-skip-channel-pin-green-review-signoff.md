# ADR-0200 — OP-94 fan-out follow-up: review sign-off of the pre-selection `mobile` skip-channel seam pin (GREEN)

- **Status:** Accepted · **Date:** 2026-10-20 · **Author:** `openpic-webapp-reviewer`
- **Card:** `t_b9bb5e0a` (OP-94 fan-out follow-up GREEN) · **Verdict:** **APPROVED WITH FINDINGS** — no changes requested; squash-merged
- **Reviewed:** branch `OP-94-task-fanout-mobile-skip-channel-seam`, head `e807a5a`, base `origin/main` @ `851a3c1`; PR [#210](https://github.com/yahodu/openpic-webapp/pull/210) — squash-merged to `main` as `4144983` ("test(notifications): OP-94 pin the pre-selection mobile skip channel via a groupChannel test seam (#210)")
- **Reviewed by:** round 1, **artifact lens** (diff read cold, every handoff claim reproduced); 12 CI check runs `completed/success` on the head ([run `39453140855`](https://github.com/yahodu/openpic-webapp/actions/runs/39453140855))
- **Relates to:** [ADR-0110](ADR-0110-op89-residual-adr-0043-production-citations.md) (the numbering neighbour that forced the `0110 → 0111` renumber), [ADR-0111](ADR-0111-op94-mobile-skip-channel-pin-via-test-seam.md) (the seam decision this GREEN turns green), [ADR-0112](ADR-0112-op94-mobile-skip-channel-pin-red-review-signoff.md) (the RED review sign-off — finding `mobile-skip-channel-unpinned`), [ADR-0094](ADR-0094-op94-fan-out-polish.md) (the polish under pin), [ADR-0090](ADR-0090-op94-notification-fan-out-red.md) (the fan-out contract)

## Context

This ADR records only the **review** of the OP-94 fan-out mobile skip-channel
GREEN. The decision itself — `groupChannel` is exported as an owner-authorised
test seam and the `mobile` fallback is pinned through it — is recorded in
ADR-0111. Nothing here restates or contradicts that decision; the sections below
are the delta this sign-off adds.

The lane's RED (ADR-0111/0112) was the **missing `export`** on an already-correct
total helper, not a behavioural bug. The GREEN card `t_b9bb5e0a` adds exactly that
one keyword, the `@internal` TSDoc marker the RED review asked for, the U4 pins
that read the seam, the `ADR-0110 → ADR-0111` renumber and one `docs/adr/README.md`
row.

## Decision

### 1. Verdict: APPROVED WITH FINDINGS (GREEN)

The GREEN is accepted as-is and **no changes were requested on PR #210**. The
verdict is "with findings" only because one **Low** documentation marker was owed
(§3), and that marker is a docs-only correction that does not touch the reviewed
behaviour or the merged head SHA. The finding is routed to child docs card
`t_c6bb196d` rather than left as an inline comment, and is **resolved by that same
card**.

### 2. Evidence — re-run by the reviewer, not taken from the handoff

| Check                                                         | Result                                                                                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Focused spec `--project unit …/notifications/fan-out.test.ts` | **23 passed (23)** — the 8 RED cases now pass                                                                                 |
| Full `unit` project                                           | **1485 passed / 85 files**                                                                                                    |
| Full `integration` project                                    | **358 passed / 55 files**                                                                                                     |
| Local Playwright `e2e`                                        | **16 passed**                                                                                                                 |
| `eslint .`                                                    | **0 errors** / 42 pre-existing warnings (none in the touched file)                                                            |
| `tsc -p` root + `packages/contracts` + `apps/web`             | **clean** (all three)                                                                                                         |
| `prettier --check`                                            | **clean**                                                                                                                     |
| `pnpm --filter @openpic/web build`                            | **OK**                                                                                                                        |
| `git merge-tree --write-tree origin/main HEAD`                | exit **0** (no conflict at review time)                                                                                       |
| CI on head `e807a5a`                                          | **12/12** check runs `completed/success` ([`39453140855`](https://github.com/yahodu/openpic-webapp/actions/runs/39453140855)) |

Diff scope was audited against the card's authorised scope: it is exactly the
`export` + `@internal` TSDoc, the U4 pins, the ADR-0111 renumber and one README
row — **no behaviour change, no fixture/mock scope creep, no eslint config
change**. The `export` is a pure surface addition; `groupChannel` remains internal
by contract.

Honesty audit at the reviewed head: **clean**. No fixture-specific hardcoding, no
test-environment conditionals, no `@ts-ignore`/`eslint-disable`/`TODO`, no debug
output; the only production change is the `export` keyword.

### 3. Findings

- **Low — ADR-0111 §2 documented the pre-fix seam accessor.** At the reviewed head
  `docs/adr/ADR-0111-op94-mobile-skip-channel-pin-via-test-seam.md` §2 still showed
  `typeof fanOutModule & { readonly groupChannel?: GroupChannelSeam }`, whereas the
  accessor that actually landed in `fan-out.test.ts` is
  `Omit<typeof fanOutModule, "groupChannel"> & { … }`; it also omitted **why** the
  `Omit` is required (once the `export` lands, the module's own required
  `groupChannel` declaration makes the optional intersection member subsumed, the
  `seam === undefined` guard goes statically dead and
  `@typescript-eslint/no-unnecessary-condition` — `error` under `strictTypeChecked`
  — fires). Docs-only; the pinned signature and behaviour are unchanged, and no
  test pins any of it. **→ routed to child docs card `t_c6bb196d`, which is this
  card and resolves it.**
- **Informational — no refactors were thrown.** Nothing internal was worth
  improving without invalidating the reviewed SHA; the lane ships as committed.
- **Informational — the `mobile` fallback branch is still defensively
  unreachable from stored data** (`channelGroupSchema` rejects an enabled `mobile`
  group with no `candidates`). The exported pure selector remains the correct
  minimal seam; the _reachable_ analogue stays covered by the integration spec.
  Accepted; no action.

### 4. Merge posture

PR #210 was squash-merged to `main` as `4144983` in "standard owner bypass" form,
preserving the required linear history. Local `main` was fast-forwarded, and local
`main` == `origin/main` == `4144983` at completion.

## Consequences

- `groupChannel` is part of the module's importable surface and is now a pinned,
  documented **test seam**: only tests may import it, and any future consumer goes
  through `runNotificationFanOut` / `resolveChannel`. ADR-0111 records the
  decision; this record closes it.
- Number `0200` is consumed by this sign-off. The record was first drafted as
  `0146` (the lowest number free against `main` `4144983`) and renumbered to
  `0200` under the binding per-lane reserved-range allocation (ADR-0300, merged
  as `23c236d`), which assigns the OP-94 fan-out lane the range `0200`–`0219`;
  `0146`–`0179` belongs to the OP-96 lane, so the number is settled by range
  rather than by a race against the shared high-water mark.
- This is a docs-only record: no production, test, fixture or configuration file
  is touched, so no suite's observable behaviour changes. The companion correction
  in ADR-0111 §2 (the Low finding) is likewise docs-only.
- The `docs/adr/README.md` edit is a single inserted row plus one appended
  lane-note paragraph. That file is a cross-lane hotspot; this card inserts the
  row in numeric position and keeps the title cell short so prettier does not
  widen the title column and re-pad every row.

## Alternatives considered

- **Record this sign-off as a section inside ADR-0111.** Rejected: ADR-0111 is the
  _decision_ record and lives in PR #210; the sign-off of the GREEN that closed it
  is a distinct artifact, and every prior sign-off in this lane family
  (ADR-0095, 0097, 0101, 0104, 0107, 0109, 0112) is recorded as its own file.
- **Leave the ADR-0111 §2 drift as an inline PR comment only.** Rejected: the
  repo's operating rules require every review finding to be routed to a card; the
  drift is fixed by `t_c6bb196d`.
- **Request changes on PR #210 for the docs drift.** Rejected: the drift is
  docs-only, does not touch the reviewed behaviour, and blocking a correct,
  CI-green test change on an ADR wording fix would hold the lane open for no
  behavioural benefit.
- **Edit ADR-0111 in the review lane.** Rejected: role separation — the reviewer
  reports, it does not rewrite; and ADR-0111 §2 is ADR text owned by the docs
  card.
