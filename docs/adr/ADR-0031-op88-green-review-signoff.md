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

## 5. Follow-up resolution (OP-88 outbox hardening, 2026-10-05)

The three deferred follow-ups in §4 were decomposed by `openpic-orchestrator`
(parent `t_9f9cfe6c`) into a RED card (`t_f79fc7c8`) and this GREEN card
(`t_2505b480`), which resolves them:

1. **Finding 1 (Medium/perf) — FIXED.** `resolveNotificationsFlag` no longer
   issues a per-emit `findOne`; it reads the enabled `typeKey` set through the
   new clock-once TTL cache `@/server/notifications/notification-type-cache`
   (`getEnabledNotificationTypeKeys` / `invalidateNotificationTypeCache`,
   `NOTIFICATION_TYPE_CACHE_TTL_MS = 30_000`), mirroring `getPlatformSettings`.
   One bounded `find({}, { projection: { typeKey: 1, enabled: 1 } })` per
   window; strict-`<` expiry; the accepted staleness window is ≤30 000 ms,
   observed no later than the first call at/after the TTL (or immediately after
   invalidation).
2. **Finding 3 (Low/correctness) — FIXED.** The stale branch of the
   `claimPendingEvents` filter now also reclaims an `in_progress` row whose
   `claimedAt` is missing
   (`$or: [{ claimedAt: { $lt: staleBefore } }, { claimedAt: { $exists: false } }]`);
   a fresh `claimedAt` stays non-reclaimable and a reclaimed row is stamped like
   any claim.
3. **Finding 2 (Low/design) — DEFERRED, unchanged.** v1 still drains one
   consumer per event at a time, so the single top-level `claimedAt`/`claimedBy`
   lease stays (ADR-0029 §Consequences). A per-consumer lease object is required
   only before parallel consumer fan-out is scheduled; no per-consumer lease was
   added.

Cross-reference: ADR-0029 (§Consequences) for the single-lease decision.

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

## 6. Reviewer sign-off (OP-88 outbox-hardening follow-up, `t_3f795c26`)

Approved by `openpic-webapp-reviewer` (round 1, artifact lens) and squash-merged
to `main` as `c25fa42` (PR #152). **The Decision above is unchanged.**

- **Verified on the exact head SHA** `52f11dd751fff6f2b18ec6413a29483b86388e7b`
  in a detached git worktree, never on the moving branch; the artifact was
  self-resolved (`git ls-remote`, `git cat-file -p`, `gh pr view`) before any
  claim was trusted.
- **RED was authentic.** At the RED head `60abd3a` the module
  `@/server/notifications/notification-type-cache` did not exist, so the specs
  failed `module-missing`; independently reproduced. The new module first
  appears at the GREEN commit `cef05f6`. The one spec edit between the two RED
  commits was a pre-GREEN correction of the overridden-TTL boundary
  (`advance(501)` not `advance(1)`) while the module was still absent — not a
  weakened assertion.
- **D1/D3/D2 all reproduced as pinned.** One bounded `find` per 30 000 ms window,
  clock read once per call, strict-`<` expiry, `invalidateNotificationTypeCache`
  forces a re-read, `{ db, clock }` forwarded from `emitDomainEvent`;
  `notifications` is `pending` iff the enabled set has the `eventKey`. The
  stale branch reclaims an `in_progress` row with a missing `claimedAt` while a
  fresh `claimedAt` stays non-reclaimable, and the existing 5-minute `I4` spec
  is unchanged. No per-consumer lease was added; the single top-level
  `claimedAt`/`claimedBy` is intact.
- **Independently reproduced:** unit 63 files / 1282 passed; integration 33
  files / 204 passed (`TMPDIR=/root/tmp-mongo`); coverage exit 0 (statements
  93.8%, branches 86.18%, functions 95%, lines 93.97%; `notification-type-cache.ts`
  100% lines / 92.3% branches); `tsc` (root + contracts + web) clean; `eslint`
  0 errors / 20 pre-existing warnings; `prettier --check .` clean; `next build`
  exit 0. All 11 PR checks green.
- **Honesty audit clean.** No test-environment conditionals, no fixture-shaped
  hardcoding, no `@ts-ignore`/`eslint-disable`, no `process.env` in the changed
  production files, no new dependencies.
- **Open findings (informational, Low, no action required):** (1) the
  process-wide cache is not keyed by the `db` handle — correct today given a
  single handle and platform-scoped data, mirrors `getPlatformSettings`; (2) no
  production caller of `invalidateNotificationTypeCache()` yet, because no
  notification-type mutation route exists — pin the invalidation when an
  operator-toggle route lands.
