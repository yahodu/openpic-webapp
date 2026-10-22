# ADR-0147 — OP-96 follow-up (TEST): characterize the digest-flush claim/lease recovery boundary and the retryable-overlap sibling (F1)

- **Status:** Accepted · **Date:** 2026-10-22
- **Card:** OP-96 follow-up (TEST) `t_6c3b5eb8` · **Parent / origin:** the round-1 (artifact-lens) review of the OP-96 F2 GREEN (`t_4cc14cd8`, PR [#221](https://github.com/yahodu/openpic-webapp/pull/221), merged `e57eb58`), finding **F1**
- **Implements:** ADR-0143 §Consequences ("Not pinned by this card: the stale-lease recovery itself … the **retryable**-overlap sibling (ADR-0139 finding F2-3)") · **Related:** ADR-0139 §Decision (the mechanism-agnostic single-delivery pin), ADR-0130 F1, ADR-0134/ADR-0137 (the failure-ownership and non-retryable bound the release path serves)
- **Pin:** `apps/web/src/test/integration/notification-digest-flush-claim-lease.test.ts` (new file)
- **Touches:** the new spec file, this ADR + its ADR-index row. **No production code, test, mock, fixture or factory is modified**; the frozen overlap pin (`notification-digest-flush-overlap-single-send.test.ts`, ADR-0139) is byte-unchanged.
- **Branch:** `OP-96-task-flush-claim-lease-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t-flush-overlap-red` · **Base:** `origin/main` `b6b5301`

## Context

The F2 claim/lease GREEN (ADR-0143) added one atomic conditional `findOneAndUpdate` that takes a due
digest bucket **before** the send, so two overlapping `flushDueDigests` runs deliver at most one summary.
The frozen pin proves only that single-delivery contract. ADR-0143 §Consequences deliberately left two
properties of the same mechanism **unpinned** and asked the next round to cover them; the round-1 review
of the merged GREEN routed that as finding **F1** (Low, coverage gap):

1. **Stale-lease recovery** — `FLUSH_CLAIM_STALE_MS = 5 * MINUTE_MS`. A claim older than the lease must be
   reclaimable (a run that died mid-send must never strand a bucket); a claim **not** yet stale must not be
   re-sent by another run. Neither side of that boundary was asserted.
2. **Retryable-overlap sibling** (ADR-0139 finding F2-3, "optional hardening") — the overlapping pair where
   the transport rejects **retryably**: one transport call, one `failed` ledger row that owns its
   redelivery, the bucket closed `flushed`/`failed`, nothing delivered.

This card is a **characterization** follow-up: the behaviour already shipped in ADR-0143, so the pins are
expected to pass against the current `main` on first run (the precedent is the ADR-number guard edge pins,
card `t_7ac40bd9`). It is not a RED/GREEN pair.

## Decision

### Pin only observables, mechanism-agnostically

The new spec seeds one due open bucket exactly as the frozen pin does (real `MongoMemoryReplSet`, the real
fan-out, `fixedClock`, `seedPlatformSettings`, `ensureIndexes`) and drives `flushDueDigests` directly. It
asserts **only**: the transport's `calls`/`outbox`, the ledger rows, the stored bucket state (`status`,
`flushOutcome`, and the **presence/absence of `flushClaimedAt`**) and the `CronRunOutcome` delivery count
(`affected`). A different single-delivery mechanism (an atomic transition-before-send, a queue) satisfies
every pin identically. No helper name, no private function and no field name beyond the schema-documented
`flushClaimedAt` (schema §19.6, added by ADR-0143) is referenced.

### The four pins and the choices encoded in them

1. **A stale claim is reclaimable.** Park `flushClaimedAt = flushInstant − 6 min` (older than the 5-minute
   lease) on the due open bucket; one run must deliver — `calls === 1`, one `sent` row, bucket
   `flushed`/`sent`, `affected: 1`, and `flushClaimedAt` **cleared** with the close (`markFlushed`'s
   `$unset`) rather than left to outlive the work it guarded.
2. **A live claim is honoured.** Park `flushClaimedAt = flushInstant − 1 min`; one run must **not**
   deliver — `calls === 0`, no ledger rows, bucket still `open` with its `flushClaimedAt` **unchanged**,
   `affected: 0`.
3. **The retryable-overlap sibling.** Two overlapping runs (`Promise.all`) over one due bucket, with a
   transport that holds each send open a real ~150 ms and then rejects retryably (`TransportError`,
   `retryable: true`): `calls === 1`, exactly one `failed` row whose `lastError.retryable` is `true` (it
   owns the redelivery — `notification-dispatch-retry` selects on that flag), no `sent` row, bucket closed
   `flushed`/`failed`, `affected` sums to `0`.
4. **The release path.** After a **non-retryable** failure below `pipeline.maxAttempts` the bucket is
   `open` **and has no `flushClaimedAt`** — the claim is _released_, not merely left to expire — which is
   what lets the next tick re-attempt immediately (ADR-0134's F1b "stays selectable" contract).

### `skipped` is asserted on exactly one pin

The pin family deliberately leaves the per-run `CronRunOutcome` split free (ADR-0139 §Decision): on the
overlap cases `scanned`/`skipped` are **not** asserted, and only their delivery count (`affected`) is. The
single split assertion — `skipped: 1` — is made **only** on the live-claim pin (case B) and **only**
because a **single** run is under test, where the loser of the claim is unambiguously the only run and a
live claim is the only reason it would not deliver.

### Boundary values chosen

The two lease pins use `−6 min` (stale) and `−1 min` (live), both comfortably clear of the `−5 min`
boundary, so the pins do not encode the exact comparison operator of the claim filter. They pin the
**contract** ("older than the lease recovers; a live lease is honoured"), not the implementation's `$lte`.

## Consequences

- The two properties ADR-0143 §Consequences named as unpinned are now pinned as a complement to — never a
  replacement for — the frozen overlap pin, which is byte-unchanged.
- A future refactor that preserves the contract (a differently-shaped claim, an atomic transition-before-
  send) breaks **zero** of these pins; a regression in the lease boundary, in a live-claim guard, in the
  retryable-failure ownership, or in the open-bucket claim release breaks **at least one**, loudly.
- The retryable-overlap pin closes ADR-0139 finding F2-3, previously recorded as "optional hardening".
- The same pre-existing TTL-fixture flake class (ADR-0146: `2026-03-*` fixture clocks whose `expireAt` is
  in the past against the real clock) applies to this spec exactly as it applies to the frozen pin; the
  pins are written to re-run cleanly and were green on the full integration run.

## Alternatives

- **Assert the concrete ledger-row `_id`, message body or `flushClaimedAt` timestamp.** Rejected as
  coupling to implementation detail; only the observable _presence/absence_ and the `retryable` flag are
  contractual.
- **Assert `scanned`/`skipped` on the overlap sibling.** Rejected: ADR-0139 §Decision deliberately leaves
  the split free, and pinning it would forbid a legitimate re-split.
- **Assert the exact `−5 min` boundary (`$lte`).** Rejected: that encodes the comparison operator rather
  than the contract; `−6 min`/`−1 min` pin the same guarantee without over-constraining the mechanism.
- **A RED/GREEN pair.** Not applicable: this is a characterization of shipped behaviour and the pins are
  expected green on first run (precedent `t_7ac40bd9`).

## Evidence

- New spec green: `TMPDIR=/root/tmp-mongo vitest run --project integration notification-digest-flush-claim-lease`
  → `Test Files 1 passed (1) · Tests 4 passed (4)`.
- Digest family green: `vitest run --project integration notification-digest` → `9 files / 18 tests`.
- Full integration green: `58 files / 365 tests`. Unit suite green: `86 files / 1514 tests`.
  `tsc -p tsconfig.json --noEmit` clean · `eslint .` 0 errors · `prettier --check .` clean.
- Exact counts and CI status are recorded in the card handoff (`t_6c3b5eb8`).

## ADR-number allocation

This record takes the **next unused number inside the OP-96 reserved range** (`0146`–`0179`, ADR-0300
per-lane allocation), re-resolved immediately before committing: `0146` is held by the sibling OP-96
quiet-hours-fixture-TTL-flake record (`OP-96-task-quiet-release-flake-red`, `ADR-0146-…-ttl-flake.md`), so
the next free number is **`0147`**. No number outside the OP-96 range is consulted and no other lane's
branch is inspected.
