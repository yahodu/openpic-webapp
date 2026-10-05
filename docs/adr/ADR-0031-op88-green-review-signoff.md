# ADR-0031 — OP-88 GREEN reviewer sign-off: outbox ships as-is, two hardening follow-ups deferred

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-88 `t_c93c6765` (phase 1-Identity, epic Eventing, GREEN review) · **Reviews:** ADR-0029 (`@/server/domain/domain-events`) · **Depends on:** OP-84, OP-77
- **Supersedes / amends:** nothing. Records the independent review verdict on the OP-88 GREEN delivery.

## Context

The OP-88 GREEN implementer (`a889dcd`) and the Test Author's spec
reconciliation (`06d2852`) delivered the `domain-events` outbox against the RED
suite. This ADR records the independent review of that delivery (PR #144) and
what ships versus what is deferred.

## Decision

### 1. Verdict — APPROVED WITH FINDINGS

Green (independently reproduced in the task worktree on the merged tip
`b086b62`):

- `vitest --project unit` 1258/1258; `--project integration` 200/200;
  `--coverage` exit 0 (`domain-events.ts` 100 % lines/statements/functions,
  91.52 % branches; `server/domain/**` threshold 90 %).
- `tsc` (root + contracts + apps/web) clean; ESLint 0 errors; Prettier clean;
  `next build` clean; Playwright e2e 12/12; CI (`ci`, `secret-scan`, PR Checks)
  all pass on `b086b62`.
- Honesty audit clean: no test-environment conditionals, fixture-shaped
  hardcoding, `@ts-ignore`/lint suppressions or new dependencies in the
  production diff.
- The two disputed RED defects were reconciled test-side without weakening unit
  U4 (ADR-0029 "Spec reconciliation"); the claim predicate stays exactly
  `pending`/stale-`in_progress`, so `skipped`, `done` and `not_applicable` are
  never claimed.

No Critical or High finding; nothing blocks the merge.

### 2. Refactor applied (behaviour-preserving)

`DomainEventDocument` now declares the optional `claimedBy` that
`claimPendingEvents` already writes and the integration spec already asserts.
Type-only change; unit/integration/coverage re-run green. Commit `b086b62`.

### 3. Merge resolution

`origin/main` (`b232cc6`, 1.10.1) was merged into the GREEN branch; only
`docs/adr/README.md` conflicted (ADR index) and was resolved by keeping rows
0029 (this delivery) and 0030 (OP-85 follow-up) in numeric order. No spec or
production file altered. Commit `1c58445`.

### 4. Deferred follow-ups (routed, not fixed here)

1. **Per-emit `notificationTypes` lookup (Medium, performance).**
   `resolveNotificationsFlag` issues one `findOne` against `notification_types`
   on every `emitDomainEvent`, on a write path taken by every domain change.
   The catalogue is a frozen 81-key set; the lookup could be served from the
   same clock-once cached read path as `platformSettings`. Deferred because a
   cache introduces a staleness window — an observable choice the board owner
   should pin before implementation. Routed to `openpic-orchestrator` to
   decompose into RED + GREEN.
2. **Single shared claim lease (Low, correctness/design).**
   `claimedAt` / `claimedBy` are one top-level field while the claim predicate
   is per-consumer (`dispatch[consumer]`). Two consumers claiming the same row
   interleaved overwrite each other's lease, so stale-lease recovery can be
   delayed and `claimedBy` is ambiguous. v1 drains one consumer per event at a
   time (ADR-0029 §Consequences), so it is acceptable now; a per-consumer lease
   object is the eventual fix and should be pinned when parallel consumer
   fan-out is scheduled. Routed in the same follow-up card.
3. **Lease-null hardening (Low).** The stale filter
   (`claimedAt: { $lt: staleBefore }`) does not match a row whose `claimedAt` is
   missing, so such a row could never be reclaimed. Unreachable through this
   module (every claim stamps `claimedAt`), but worth a defensive guard + pin.

## Consequences

- OP-88 ships; the outbox is the single write point and the fan-out is
  independent per consumer, as specified.
- Follow-up work is not silently absorbed; the performance and lease items are
  on the board with an explicit owner.

## Alternatives considered

- **Block the merge on follow-up 1** — rejected: it is a performance
  optimisation with no correctness impact today, and the merge is required to
  land the RED suite that is otherwise gated behind the GREEN PR.
- **Fix the cache in the review** — rejected: it would change a staleness
  observable the reviewer must not decide unilaterally.
