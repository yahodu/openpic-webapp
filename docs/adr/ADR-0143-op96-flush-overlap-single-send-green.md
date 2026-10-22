# ADR-0143 — OP-96 follow-up round 3 GREEN: claim a digest bucket before the send so overlapping flush runs deliver one summary (F2)

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-96 follow-up round 3 GREEN (F2, `t_4cc14cd8`) · **Parent:** `t_e3369a9e` (the F2 RED pin review, APPROVED — see ADR-0139 §"Review sign-off (round 1, artifact lens)")
- **RED pin:** `apps/web/src/test/integration/notification-digest-flush-overlap-single-send.test.ts` (unchanged by this card), decision record **ADR-0139**
- **Implements:** ADR-0139 §Decision (at most one delivery per bucket per open → flushed transition) · ADR-0130 §"F1" ("the flush cron can never re-select the bucket and double-send the summary") · ADR-0028 §1 (the "concurrency-safe" cron-framework claim, `apps/web/src/server/jobs/cron-job.ts`)
- **Touches:** `apps/web/src/server/notifications/digest.ts` (production), `docs/Notification and Database Design.md` §19.6 (schema doc), this ADR + the ADR index row. **No test, mock, fixture or factory is touched.**
- **Branch:** `OP-96-task-flush-overlap-single-send-red` (carries the RED pin + this GREEN; PR **#221**) · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t-flush-overlap-red` · **Base:** `origin/main` `3f46950`, merged up to `origin/main` `23c236d` before the final verification run (via `52f742e`; the `23c236d` merge also resolved the `docs/adr/README.md` conflict against the ADR-0300 reserved-range policy and kept both this lane's `0139`/`0143` index rows)

## Context

The round-1 (artifact-lens) review of the round-3 GREEN (PR #218, `509b559`) returned **APPROVED WITH
FINDINGS**. Finding **F2 (Medium, pre-existing, unpinned)** was a delivery-duplication defect:
`flushDueDigests` selected `{ status: "open", flushAt: { $lte: now } }` and guarded only the **write**
(`updateOne({ _id, status: "open" })` in `markFlushed`) — nothing **claimed** a bucket before the send.
Two invocations whose lifetimes overlap therefore both read the bucket before either closed it and both
handed the same summary to the transport: two identical emails, two `sent` ledger rows, both runs
reporting `affected: 1`, and — on a non-retryable rejection — two `$inc`s of `nonRetryableFailures`, so
an overlapped pair could reach `pipeline.maxAttempts` and close the bucket **one attempt early**,
breaking the F1b "stays selectable" contract (ADR-0134/ADR-0137).

ADR-0139 pinned the contract (**at most one delivery per bucket per open → flushed transition, even when
flush runs overlap**) as a new integration spec on this same branch, deliberately **mechanism-agnostic**:
only observables are asserted (transport `calls`/`outbox`, the `sent`/`failed` ledger rows, the stored
bucket `status`/`flushOutcome`, and `affected` summed across the two runs). This card turns that pin
green.

## Decision

### Claim the bucket before the send, with a lease

`flushDueDigests` now takes each selected bucket with **one atomic conditional `findOneAndUpdate`**
before it calls `flushOneBucket`:

```ts
findOneAndUpdate(
  {
    _id: bucket._id,
    status: "open",
    $or: [
      { flushClaimedAt: { $exists: false } },
      { flushClaimedAt: { $lte: staleBefore } }, // staleBefore = now - 5 min
    ],
  },
  { $set: { flushClaimedAt: now } },
  { returnDocument: "after" }
);
```

- **Only the winner sends.** Of two overlapping runs exactly one matches the filter and transitions the
  bucket to claimed; the loser's update matches nothing and returns `null`, so it never calls
  `flushOneBucket` — it counts the bucket `skipped` and leaves it exactly as it found it. The loser
  genuinely does not send: there is no retry, sleep, backoff or interleaving window, and the pin's
  determinism (a real 150 ms send hold + `Promise.all`) is untouched.
- **The claim is a lease, not a lock.** `FLUSH_CLAIM_STALE_MS = 5 * MINUTE_MS` mirrors the outbox
  consumer's `STALE_CLAIM_MS` (`@/server/domain/domain-events#claimPendingEvents`): a claim older than
  the lease is reclaimable, so a run that dies mid-send cannot strand a bucket forever — the next tick
  (or any later tick) reclaims and re-attempts it. That is the bounded recovery path ADR-0139 asked for.
- **The claim is released deterministically on every path that leaves the bucket `open`.** `markFlushed`
  clears `flushClaimedAt` with the close (a `flushed` bucket is already out of the selectable set), and
  the two `open`-leaving paths — a non-retryable failure below `pipeline.maxAttempts` (F1b, ADR-0134) and
  a failure recorded nowhere (`failed_unrecorded`) — release it explicitly, so the next tick re-attempts
  immediately instead of waiting out the lease.
- **Claim ordering.** The claim happens **after** the daily-cap check (a deferred bucket is never
  claimed) and **after** the `affected >= limit` break, and **before** the send. `scanned` still counts
  every selected bucket; a lost claim counts as `skipped`. The per-run `CronRunOutcome` split is
  deliberately not pinned (ADR-0139 §Decision), so this split is free — the pin measures delivery
  (`affected` summed = 1 on success, 0 on the non-retryable sibling).

### Why the status stays `"open"` (index semantics preserved)

The two `notificationDigests` partial indexes (`apps/web/src/server/db/indexes.ts:170-192`, schema
§19.6) are partial **on `status: "open"`**: `{ userId: 1, bucketKey: 1 }` unique (one open bucket per
key) and `{ status: 1, flushAt: 1 }` (the flush cron's read). A claim field added **in place** — rather
than an in-flight `status` — keeps both indexes byte-identical and keeps their semantics intact:

- the flush select (`{ status: "open", flushAt: { $lte: now } }`) is unchanged, so a claimed bucket is
  still selected (and then fails to claim, correctly), and a bucket whose lease went stale is picked up
  by the same query with no separate recovery sweep and no new index;
- a **claimed** bucket is still `status: "open"`, so it keeps serving the fan-out's
  `{ userId, bucketKey, status: "open" }` upsert (`upsertDigestBucket`) and a claimed-but-abandoned
  bucket **cannot block the `(userId, bucketKey)` key** — the key is never freed-and-re-taken behind the
  fan-out's back, so no `E11000` window is opened by the claim;
- no new status value means no migration, no union widening and no change to any other reader of
  `status`.

The only schema-doc change is the new optional `flushClaimedAt` field, recorded in
`docs/Notification and Database Design.md` §19.6 (the precedent the round-3 GREEN set for a new field).
The index list in §19.6 is unchanged — the claim field is deliberately not indexed.

### Files

| File                                                  | Change                                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/server/notifications/digest.ts`         | `FLUSH_CLAIM_STALE_MS`; `staleBefore`; `claimBucket`/`releaseClaim`; claim wired into the flush loop; `markFlushed` clears the claim; module/TSDoc updated (F2, ADR-0143) |
| `docs/Notification and Database Design.md` §19.6      | `flushClaimedAt` documented on the bucket                                                                                                                                 |
| `docs/adr/ADR-0143-…-green.md` + `docs/adr/README.md` | this decision record + its index row/allocation note                                                                                                                      |

No exported symbol is added (both helpers are function-scoped), so no new TSDoc-visible public surface
exists; the module and job doc-comments are updated. Logging is unchanged — the existing
`notification.digest_flush` structured log line via the `Logger` port remains the only log, and it now
shows the loser as `skipped: 1`.

## Alternatives

- **An in-flight `status: "flushing"` (transition-before-send).** The reviewer's other reading, and it
  satisfies the pin identically. Rejected as the _first_ choice because it changes index semantics in two
  ways that need compensating machinery: a `flushing` bucket leaves the `{ userId, bucketKey }` partial
  unique index (so the fan-out can insert a second bucket for the same key while one is in flight — new
  churn and an extra open bucket per key during a flush) and leaves the flush index (so a crashed run's
  bucket is **not** selectable by the normal read and needs a second, differently-indexed recovery sweep
  for stale `flushing` rows). The in-place claim gets the same single-delivery guarantee with a strictly
  smaller blast radius: no status union change, no index change, no extra sweep, and the recovery path is
  the existing select.
- **Filter claimed buckets out of the select** (`$or` on the select rather than only on the claim).
  Rejected: it changes the read's `scanned` semantics and `hasMore` accounting (a claimed bucket would
  vanish from `scanned`) for no behavioural gain — the atomic claim is what guarantees single delivery,
  and the pin explicitly leaves `scanned`/`skipped` free. Keeping the select as-is also keeps the
  `{ status, flushAt }` index path exactly as ADR-0130 F3 tuned it (bounded read, `hasMore`).
- **An owner/claimer stamp (`flushClaimedBy`) beside the timestamp.** Rejected as YAGNI: no reader,
  no test and no operational runbook consumes it, and the outbox consumer's `claimedBy` exists because
  its claims are visible across cron jobs in one collection where the owner matters for triage. Adding it
  here would be untested surface; if a future round wants per-run attribution, it can be added with the
  pin that demands it.
- **A `$set` of `null` instead of `$unset` on release.** Rejected: the claim filter distinguishes
  "unclaimed" via `{ $exists: false }`, and a literal `null` would additionally need `{ flushClaimedAt:
null }` in the `$or`. `$unset` keeps one representation of "unclaimed" (absent) and matches the
  round-3 precedent of not inventing a second encoding of a state.

## Consequences

- **At most one delivery per bucket per `open → flushed` transition, even under overlap** (F2). The
  transport is invoked once, one `sent` ledger row is written, the bucket ends `flushed`/`sent`, and the
  two runs report one delivery in total.
- **One flush attempt spends at most one bounded non-retryable attempt** (the failure sibling): one
  `failed` ledger row, one `$inc`, the bucket still `open` and immediately re-selectable for the F1b
  retry. The overlapped pair can no longer close the bucket one attempt early.
- **Every pre-existing pin still passes** — F1–F4, round-2 F1b/F2b/F1c, round-3 F1b-r2 and the
  OP-94/95/96 I1–I12 pins, including the single-threaded flush pins (which never contend for a claim) —
  with `hasMore`, the bounded read, the daily cap, quiet hours and the non-retryable bound untouched
  (ADR-0120, ADR-0130, ADR-0134, ADR-0137).
- **A crash mid-send delays a bucket by at most the lease (5 min)**, never indefinitely.
- **Not pinned by this card:** the stale-lease recovery itself (a crashed/abandoned claim being
  reclaimed) and the claim/`expireAt` (TTL) interaction. ADR-0139 §Consequences deliberately left both
  out of scope; with a lease now in the schema, the reviewer should ask for a bounded-lease pin in the
  next round rather than treating this card as covering it. Also unpinned: the **retryable**-overlap
  sibling (ADR-0139 finding F2-3, optional hardening) and the pre-existing window in which an arrival
  merged into a bucket between its claim-read and its close is delivered only in the next bucket.
- **Numbering.** The card expected `0140`; re-checked immediately before committing against fresh
  `origin/main` and every open ref/worktree, `0140` is **taken** (the F1c-r2 lane,
  `OP-96-task-f1c-r2-cap-red` / PR #219, `ADR-0140-op96-f1c-r2-redelivered-digest-cap-red.md` — by the
  time of the final run it had merged and `origin/main` itself carried `0140`/`0141`). `0142` is the
  OP-101 CI audit-job-split lane (`t_a3d52d6e`), and `0141` is additionally held by the F1
  unrecorded-bound GREEN (`t_c9e903c5`, PR #220). The lowest free number is therefore **`0143`**, which is
  what this ADR takes. The GREEN's review sign-off will be recorded as a section **inside** this ADR (the
  ADR-0130/0134/0137/0139 precedent), so no second number is consumed.
- **Merged up to `origin/main` `52f742e`.** `origin/main` advanced past this branch's base while the GREEN
  was being written: the F1c-r2 GREEN (PR #219, `4424e74`) merged and also touched `digest.ts`
  (`countFlushedToday` now counts a retry-redelivered summary via `redeliveredAt`, and the `failed` ledger
  row carries `digestBucketId`). `git merge origin/main` auto-merged `digest.ts` cleanly — the two changes
  are orthogonal (the F1c-r2 work changes the count and the ledger row; this one adds a pre-send claim) —
  and the only conflicts were the two shared docs, resolved by keeping **both** sides: §19.6 now documents
  `redeliveredAt` **and** `flushClaimedAt`, and the ADR index keeps `0139`/`0140`/`0141` plus this
  `0143` row and every allocation note. The final verification run below is on the merged tree.

## GREEN evidence

- **Pin green.** `vitest run --project integration notification-digest-flush-overlap-single-send` →
  `Test Files 1 passed (1) · Tests 2 passed (2)`. The loser's own log line proves the mechanism from the
  job's point of view: success case `scanned: 1, affected: 0, skipped: 1` (loser) next to
  `scanned: 1, affected: 1, skipped: 0` (winner); failure case `scanned: 1, errors: 1` once and
  `scanned: 1, affected: 0, skipped: 1` once — no run reports the same bucket as delivered.
- **Full integration suite (final, on the merged tree at `origin/main` `23c236d`):**
  `Test Files 57 passed (57) · Tests 361 passed (361)` (84 s) — the extra files over this branch's
  pre-merge `55` are the integration specs merged in from `main` (the F1c-r2 spec, PR #219; the OP-94
  mobile skip-channel pin, PR #210), against the RED baseline `1 failed | 54 passed (55)` files,
  `2 failed | 357 passed (359)` tests (ADR-0139 §RED evidence; independently reproduced on this branch
  before coding). An intermediate run on the earlier merge base `52f742e` was `56 passed (56)` /
  `360 passed (360)`.
- **Unit suite:** `Test Files 85 passed (85) · Tests 1485 passed (1485)` (unchanged before/after —
  `digest.test.ts` covers the two pure functions only; the count is above the ADR's earlier 1477 only
  because `origin/main` added unit specs while this GREEN was in flight).
- **Pre-existing TTL-fixture flake, not this lane's (observed once during verification).** One
  `pnpm test:int` run on the loaded host failed two _unrelated_ specs in one pass
  (`notification-dispatch-retry-cap.test.ts:309`, `notification-bounded-sweeps.test.ts:349`) and the
  pin's own second case once (`:391`, `transport.calls` 0). Every one passes in isolation and the
  re-run above is fully green. The root cause is documented and routed by the sibling lane
  `t_e8e658fd` (**ADR-0146**): the ~23 integration specs that pin a `2026-03-*` fixture clock persist
  rows whose `expireAt = instant + retention.dispatchDays` (180 d) is already in the past against the
  real clock, so mongod's 60 s TTL monitor can delete a fixture mid-test on a slow host. It is a
  harness defect in the frozen specs, not a product defect and not caused by the claim: the pin's
  `countDocuments` at line 348 runs **before** any flush, and the claim adds no reader of `expireAt`.
  Re-anchoring the fixtures to the real clock is ADR-0146's routed class-wide follow-up; this lane is
  card-restricted from editing any spec but its own pin, and the pin itself was reviewed and frozen.
- **Coverage.** `pnpm test:coverage` is not re-run here (the locally disabled CI step); the claim
  helpers are function-scoped additions inside `flushDueDigests` and are exercised by the pin.
- `pnpm typecheck` clean · `pnpm run lint` 0 errors (42 pre-existing warnings) · `pnpm run build`
  successful · `pnpm exec prettier --check .` clean.

## Review sign-off (round 1, artifact lens)

**Verdict: APPROVED WITH FINDINGS** (no changes requested). Review lane `t_4cc14cd8`; reviewed head
`9c64fe710007be50f89c9d1b9e4451813b416cf7` (tree-identical to the merged commit — `git diff --stat 9c64fe7
e57eb58` is empty), squash-merged as `e57eb589de2d9fab02146e16fdff3ae8efd6a854` at 2026-10-20T23:28:07Z,
ancestor of `origin/main` `b6b5301`. Review comment:
<https://github.com/yahodu/openpic-webapp/pull/221#issuecomment-6334162087>.

### What the review reproduced independently

The review re-ran the whole gate on the reviewed head (`TMPDIR=/root/tmp-mongo`) as a cold read of the diff
rather than trusting this ADR's own §GREEN evidence:

- **Pin (integration):** `Test Files 1 passed (1) · Tests 2 passed (2)` — the loser's own log line proves
  the mechanism from the job's point of view: success case `scanned: 1, affected: 0, skipped: 1` (loser)
  beside `scanned: 1, affected: 1, skipped: 0` (winner); failure case `scanned: 1, errors: 1` once and
  `scanned: 1, affected: 0, skipped: 1` once — no run reports the same bucket as delivered.
- **Full unit project:** `85 passed (85)` files / `1485 passed (1485)` tests.
- **Full integration project:** `57 passed (57)` files / `361 passed (361)` tests.
- **Playwright e2e:** `16 passed`.
- **`pnpm typecheck`** (root + contracts + apps/web): clean (exit 0).
- **`eslint .`:** 0 errors / 42 pre-existing warnings (exit 0).
- **`prettier --check .`:** clean.
- **CI on the head:** 12 of 13 checks green including the `ci` job; the only red is the repo-wide `audit`
  job, already red on `origin/main` (since addressed by the OP-101 PRs #228/#230).

### Scope audit

The diff is limited to `apps/web/src/server/notifications/digest.ts`, the frozen pin spec, schema §19.6,
ADR-0139/ADR-0143 and `docs/adr/README.md`; no existing test, mock, fixture or factory was edited. ADR
number `0143` is unique on `main` (no duplicate numbers across `docs/adr/`); `docs/adr/README.md` carries
the `0143` row; §19.6 documents the new optional `flushClaimedAt`.

### Mechanism audit (accepted)

One atomic conditional claim `findOneAndUpdate` on `{ _id, status: "open" }` gated on an absent-or-stale
`flushClaimedAt`, before the send; the loser counts `skipped` and never sends; the claim is released on
every `open`-leaving path; `markFlushed` `$unset`s the claim; `status` stays `"open"` so both partial
indexes and the fan-out upsert keep their semantics; `FLUSH_CLAIM_STALE_MS` is the bounded recovery path.
The honesty audit was clean: no fixture hardcoding, no test-env conditionals, no `@ts-ignore`/
`eslint-disable`/`console.*`/TODO.

### Findings (both non-blocking; carded rather than merely flagged)

- **F1 — Low, coverage gap.** The stale-lease recovery boundary (a claim older than `FLUSH_CLAIM_STALE_MS`
  must be reclaimable; an unexpired claim must not be re-sent) and the **retryable**-overlap sibling
  (ADR-0139 finding F2-3) are unpinned — this ADR's own §Consequences asks for the bounded-lease pin next
  round. Routed to Test Author card `t_6c3b5eb8` (`OP-96 follow-up (TEST) — pin the flush-claim lease
recovery and the retryable-overlap sibling`), child of `t_4cc14cd8`.
- **F2 — Low, documentation.** This section. The card's ADR section and this ADR's line 155 both promise
  the GREEN's review sign-off is recorded **inside** this ADR (no second number consumed); that section was
  missing on `main`. Resolved by this card.
