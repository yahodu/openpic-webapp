# ADR-0128 — OP-96 GREEN review sign-off: integration renumber, one redelivery path, four routed findings

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-96 phase 1 (GREEN, `t_609968cf`), review lane round 1 · **Reviewed:** PR #203, branch `OP-96-task-digest-retry-quiet-hours-crons-green`
- **Implements / refactors:** ADR-0126 (the GREEN implementation), ADR-0127 (per-dispatch failure ownership) · **Contract:** ADR-0120
- **Verdict:** Approved with findings (ship; findings feed the next cycle)

## Context

The OP-96 GREEN implementation (ADR-0126) arrived for review with one formally
disputed RED pin — OP-94's `notification-fan-out.test.ts` I5, which pinned the
retired event-level retry (ADR-0127 supersedes it) — and with `origin/main` moved
on by two commits. This record captures the integration work the review lane had
to do to make the PR mergeable, the one behaviour-preserving refactor it made,
and the findings it routed out.

## Decision

### 1. The lane's ADRs are renumbered to `0120`–`0128`

`origin/main` claimed the numbers the lane had moved into, one PR at a time (`0110` OP-89 #209, `0118` OP-101 #211, `0119` its sign-off #212), so the block finally moved above main's high-water mark as a contiguous unit: the nine ADR files were renamed, and every reference in the lane's own artefacts (the ADR files, `docs/adr/README.md`, `docs/adr/ADR-0092`, and the production comments in `fan-out.ts`, `digest.ts`, `dispatch-retry.ts`, `quiet-hours-release.ts`, `dispatch-redelivery.ts`, `collections.ts`, `indexes.ts`, `notification-cron-jobs.ts` and the three cron routes) was shifted with them.

Scope guard: **no test file was touched** — the stale `ADR-0100` references in
the six OP-96 spec files remain the reconciliation card's (`t_a4cdff8f`) work,
and its target numbers are restated on that card as `ADR-0120` / `ADR-0124`.

### 2. The retry and release crons share one redelivery implementation

`retryOneRow` and `releaseOneRow` were byte-for-byte identical apart from which
rows their sweeps select. Both now call
`redeliverDispatchRow(db, row, now, transport)` in
`@/server/notifications/dispatch-redelivery`, which owns the destination
re-resolution, the message rebuild, the failure classification and the
`sent`/`failed` transition. `dispatch-redelivery`'s own module docstring already
claimed the two crons "share one implementation"; this makes that true instead
of aspirational. Behaviour is unchanged — the transition payloads, the
`no_destination` classification and the `attempts` increment are identical, and
the row narrowings (including the `typeKey` presence check) were preserved.

### 3. Findings routed (details and evidence on the card and PR #203)

| #   | Severity | Finding                                                                                                                                                                                                                                                           | Routed to                                  |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| F1  | Medium   | A digest flush failure leaves the bucket `open` **and** writes a retryable failed dispatch row, so the flush cron and the retry cron can both re-send the same summary                                                                                            | RED pins + GREEN (new cards)               |
| F2  | Medium   | Retry attempts are unbounded: `pipeline.maxAttempts` (5) is never read, so a permanently retryable row is re-attempted forever (backoff caps at 5 min) — the card's "attempts < max" / "retries are bounded" is unmet                                             | RED pins + GREEN (new cards)               |
| F3  | Medium   | All three sweeps `.toArray()` the whole selectable set and only then apply `limit` in memory; a post-outage backlog is read in full                                                                                                                               | RED pins + GREEN (new cards)               |
| F4  | Medium   | `buildRedeliveryMessage` substitutes `""` for an unretained body, so a retried `retainBody:false` type (e.g. `auth.otp.email.requested`) is re-sent with an empty body                                                                                            | RED pins + GREEN (new cards)               |
| F5  | Low      | `upsertDigestBucket`'s "atomic pipeline upsert" comment over-claims: a concurrent duplicate arrival can still raise `E11000` against the unique-open partial index and is then treated as an unexpected fan-out error                                             | Test Author (pin)                          |
| F6  | Low      | Branch coverage (80.22% global, gate 80) has ~0.2pp head-room because the crons' error paths (no-destination, unbuildable message, `hasMore` boundary, cap-vs-limit interaction) are unexercised                                                                  | Test Author (`t_a4cdff8f` comment)         |
| F7  | Info     | `releaseDeferredDispatches` hard-codes `skipped = 0`, and its `message === null` path returns `error` without writing the row — a silent no-op that would leave a row `deferred` forever (unreachable today: `deferChannel` only ever yields an outbound channel) | Test Author (pin, if it becomes reachable) |

Pre-existing, not introduced by OP-96 (noted for the OP-97 feed lane): an
`in_app` group whose `resolveChannel` decision is `defer` writes no feed row at
all (`fanOutToRecipient` handles only `send`/`digest` and continues). Quiet
hours therefore suppress the in-app badge for non-critical types.

### 4. Merge posture

The single red is the disputed OP-94 I5 pin, whose retirement the user approved
on 2026-10-20 and whose edit is owned by the reconciliation card `t_a4cdff8f`;
the review lane did not touch it. PR #203 ships with that pin red, the
integration merge and this refactor on top.

## Verified on the reviewed head

- `vitest run --project unit` → 85 files, **1477/1477 passed** (before and after
  the refactor).
- `vitest run --project integration` → 47 files, **346 passed / 1 failed**, the
  single failure being the disputed `notification-fan-out.test.ts` I5
  (`expected 'done' to be 'pending'`) — unchanged before and after the refactor.
- `tsc -p apps/web/tsconfig.json --noEmit` clean; `eslint` on the three touched
  notification modules clean; `prettier --check .` clean.
- Coverage measured on the reviewed head (`--coverage`, unit + integration):
  statements **91.90%**, branches **80.29%**, functions 95.61%, lines 92.64% —
  above the 80% global gate, with the head-room caveat of finding F6.
- Honesty audit of the diff: no test-environment conditionals, no `@ts-ignore`
  / `eslint-disable`, no fixture-shaped hardcoding, no console noise in
  production code.

## Consequences

- The lane's ADR block is contiguous and collision-free against `origin/main`;
  this sign-off is `0128`.
- One redelivery path serves both crons, so a future change to the redelivery
  transition cannot drift between retry and release.
- F1–F4 are behaviour changes and were deliberately **not** made by the review
  lane; they are pinned-then-implemented through new cards, so the observable
  behaviour stays exactly what the tests describe until those cards land.
