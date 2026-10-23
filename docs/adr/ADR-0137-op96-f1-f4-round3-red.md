# ADR-0137 — OP-96 follow-up round 3 RED: bound the repeated non-retryable digest-flush failure (F1b-r2)

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-96 follow-up round 3 (RED, `t_b6540886`) · **Parent:** `t_6163c787` (the round-2 GREEN + its review sign-off) · **GREEN card:** created by this card (`openpic-webapp-backend-coder`, gated on this one)
- **Implements / amends:** ADR-0134 §"Accepted consequence (reviewer finding F1b-r2, routed)" (the unbounded repeat it leaves open), ADR-0133 §"F1b — the design choice" (the option-(a) contract it bounds), ADR-0120 (the OP-96 contract, §10.2 `notification-digest-flush`) · **Evidence:** ADR-0133 §"Review sign-off (round 1, artifact lens)" §Findings §F1b-r2
- **Branch:** `OP-96-task-f1-f4-round3-red`, base `origin/main` `91d1101` (post-merge #217 `2c779b3`) · **Workspace:** `/root/openpic/openpic-webapp/.worktrees/t_6a4943e8`

## Context

The round-1 (artifact-lens) review of the OP-96 round-2 RED pins (`t_1e598454`, ADR-0133) was
**APPROVED with one non-blocking finding, F1b-r2 (Low)**. The round-2 F1b contract chose **option
(a)**: after a **non-retryable** digest-flush failure the bucket stays `open` and a later flush tick
re-attempts it (ADR-0134). That is correct for the _transient_ case the F1b pin scripts (one failure,
then a recovery), but it leaves this boundary unpinned:

> a **permanently** non-retryable failure — e.g. a provider `400` for a bad destination — leaves the
> bucket `open` and is therefore re-attempted on **every** subsequent flush tick, calling the
> transport again and inserting a fresh `attempts: 1` `failed` ledger row each time, until the
> bucket's `expireAt` TTL retires it. In a system where `retryable: false` means "never retry", an
> unbounded retry loop of a non-retryable failure is a contradiction.

This card writes the RED pin for that boundary. It is gated after the round-2 GREEN (`t_6163c787`)
so it is written against the F1b implementation (`failed_terminal` present on `origin/main`), not the
pre-F1b behaviour — before F1b a non-retryable flush failure **closed** the bucket, so the
unbounded-repeat premise only exists after PR #217 landed. No production code is changed by this
card; the new pin fails for the right reason against `origin/main` `91d1101`.

## Decision

### New pin (integration, real `MongoMemoryReplSet` + real seed catalogue)

| Pin    | File                                                                                  | Observable                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1b-r2 | `apps/web/src/test/integration/notification-digest-flush-non-retryable-bound.test.ts` | a permanently non-retryable transport calls the transport at most `N` times across `N + 2` flush ticks, the bucket goes terminal, no `failed` ledger rows accumulate beyond `N`, and the summary is never delivered |

The pin drives the real production paths (`runNotificationFanOut`, `flushDueDigests`) against a real
`MongoMemoryReplSet` and the real seed catalogue, and asserts only observable outcomes (transport
calls/deliveries, stored bucket/ledger state, `CronRunOutcome` counters).

### The bounded, terminal contract

Of the card's two listed shapes, this pin selects the **terminal-state** shape (the card's first
option): after a bounded number of non-retryable flush failures the bucket reaches a terminal
classification and leaves the selectable set the flush cron reads (`status: "open"`).

Concretely, the contract the pin establishes:

1. **Bound = the existing attempt ceiling.** A digest bucket is re-attempted after a non-retryable
   flush failure at most `platformSettings.pipeline.maxAttempts` times — the app's single "attempts
   before giving up" knob, read through the same `getPlatformSettings({ db, clock })` seam
   `flushDueDigests` already uses. The sibling F2b pin bounds the dispatch retry sweep by the same
   setting, so the two bounded-retry surfaces share one ceiling rather than inventing a second
   tunable (and a second `platformSettings` schema field, which would be an OP-82 contract change).
2. **Terminal marker.** When the number of non-retryable flush failures reaches the ceiling the
   bucket is closed with `status: "flushed"` and `flushOutcome: "failed"` — reusing the field the
   round-2 F1c closure introduced (ADR-0134) rather than inventing a second one. `status` stops
   being `"open"`, so the flush cron's `find({ status: "open", flushAt: { $lte: now } })` no longer
   selects it.
3. **Bounded rows.** Each attempt still durably records its own `failed` ledger row (the failure
   stays on the ledger exactly as F1b requires); the row count is therefore bounded by the ceiling
   too. The pin asserts `1 <= rows <= N`, so it also tolerates an implementation that records the
   repeated failures on a single upserted row (the card's second listed shape) instead of one row per
   attempt.
4. **Never delivered.** The summary is never delivered (no outbox message, no `status: "sent"` ledger
   row), and the trailing ticks select nothing (`scanned: 0`).

`N` is seeded to the **non-default** value `2` in the pin, so the assertion never depends on the
shipped default (`5`). The pin drives `N + 2 = 4` flush ticks.

### Why `N >= 2` is required (preserving the round-2 F1b pin)

The round-2 F1b pin requires the bucket to stay `open` after the **first** non-retryable failure and
to be re-attempted and delivered on a later flush tick. A bound of `N = 1` (terminal on the first
failure) would break that pin (`recoveryFlush.affected` would be `0`, not `1`). The chosen bound is
read from `pipeline.maxAttempts`, whose default (`5`) keeps the F1b scenario well inside the bound.
Both pins stay green together.

### Semantics note (F1b synthetic recovery), folded in

The round-2 F1b pin's scripted transport makes a `retryable: false` error **succeed** on its second
call, so the recovery it asserts is **synthetic**: the pin proves failure _ownership_ (the bucket
stays selectable and the retry cron is not a second owner), not that a non-retryable failure actually
recovers. This is recorded in the new spec's doc comment; the new pin deliberately drives a
_permanent_ non-retryable rejection so the unbounded-repeat boundary is what is measured.

## RED evidence

- `pnpm test:int` → **1 file failed / 53 passed (54); 1 test failed / 356 passed (357)**. The only
  failure is the new pin; every previously green integration test (including the merged F1–F4 and
  round-2 F1b/F2b/F1c pins, and the OP-94/95/96 I1–I12 pins) still passes — no regression.
- The pin fails for its intended reason at the call bound:

  ```
  AssertionError: expected 4 to be 2 // Object.is equality
   ❯ apps/web/src/test/integration/notification-digest-flush-non-retryable-bound.test.ts:340:31
       expect(transport.calls).toBe(MAX_FLUSH_ATTEMPTS);
  ```

  i.e. the transport was called on **all four** flush ticks (one `failed` ledger row per tick, bucket
  still `open`) instead of being bounded to `N = 2`.

- `pnpm typecheck` clean; `pnpm exec eslint` on the new spec clean; `pnpm exec prettier --check`
  clean.

## Consequences

- The GREEN card turns the pin green by reading `pipeline.maxAttempts` in `flushDueDigests` and
  tracking the bucket's non-retryable flush-failure count, closing the bucket terminally when the
  count reaches the ceiling. It continues on **this** branch (`OP-96-task-f1-f4-round3-red`) so the
  pin ships with the implementation, and in **this** worktree
  (`/root/openpic/openpic-webapp/.worktrees/t_6a4943e8`).
- A permanently non-retryable digest flush is now bounded and observably terminal instead of an
  unbounded re-attempt loop — the contradiction F1b-r2 identified is closed.
- The terminal marker (`status: "flushed"`, `flushOutcome: "failed"`) is field-identical to the
  round-2 retryable-failure closure. This is deliberate (no second field) but means the two are only
  distinguishable through the ledger row's `lastError`; the ADR records it so a future round does not
  mistake the identity for a bug. A distinct value for the existing `flushOutcome` field (e.g.
  `"failed_terminal"`) is a possible follow-up if an operator needs to separate "will be retried by
  the retry cron" from "gave up" at a glance.
- The `notificationDigests` shape gains a per-bucket non-retryable-failure counter; the authoritative
  schema in `docs/Notification and Database Design.md` §19.6 must be updated by the GREEN card so the
  document matches the code.

## GREEN implementation (round 3, F1b-r2)

Landed on this same branch (`OP-96-task-f1-f4-round3-red`) so the pin ships with the code.

- **Counter field.** The `notificationDigests` bucket gains `nonRetryableFailures` (integer). It is
  absent on a fresh bucket, is parsed as an optional number in `asBucket`, and the authoritative
  schema (`docs/Notification and Database Design.md` §19.6) is updated to match. No index changes:
  the `{userId:1, bucketKey:1}` unique partial-on-`open` and `{status:1, flushAt:1}` partial-on-`open`
  indexes keep their semantics — a terminal bucket stops matching both because its `status` is no
  longer `"open"`.
- **Bound.** `flushDueDigests` reads `platformSettings.pipeline.maxAttempts` through the same
  `getPlatformSettings({ db, clock })` seam it already used, and on a `failed_terminal` result it
  atomically `$inc`s `nonRetryableFailures` (`findOneAndUpdate`, so a concurrent worker cannot lose
  an increment) and closes the bucket terminally (`status: "flushed"`, `flushOutcome: "failed"`) once
  the count reaches the ceiling. Below the ceiling the bucket stays `open`, preserving the round-2
  F1b contract.
- **Unchanged.** `failed_unrecorded` (an unresolvable destination or an unbuildable message) is not a
  _non-retryable transport failure_ and is left exactly as F1b shipped (bucket stays `open`); no
  second `platformSettings` field is added; the terminal marker is field-identical to the round-2
  retryable closure, as decided above.

## Alternatives considered

- **Bound `N = 1` (a non-retryable failure is terminal immediately).** Rejected: it breaks the
  round-2 F1b pin, which requires the bucket to stay selectable after the first non-retryable failure
  and to be re-attempted (the synthetic-recovery scenario the pin scripts). The bound must be `>= 2`.
- **A new dedicated setting (`notifications.digestMaxFlushAttempts`).** Rejected: it adds a
  `platformSettings` schema field, default and bounds (an OP-82 contract change) for a ceiling that
  already exists. Reusing `pipeline.maxAttempts` keeps one bounded-retry knob and matches the sibling
  F2b pin.
- **A hard-coded constant `N` in `flushDueDigests`.** Rejected: a magic number no operator can tune
  without a deploy, and it would not let the pin seed a non-default bound.
- **Pin only the ledger-row shape (the card's second option) without a terminal state.** Rejected: it
  bounds the _rows_ but not the _transport calls_ or the re-selection — the bucket would still be
  re-attempted on every tick, so the unbounded loop would remain. The terminal-state shape is what
  stops re-selection; the row bound is asserted alongside it.
- **Assert exactly `N` `failed` ledger rows.** Rejected: it would over-specify "one row per attempt"
  and fail an equally-valid single-upserted-row implementation, which the card explicitly lists as an
  acceptable shape. The pin asserts `1 <= rows <= N`.

## Assumptions & open questions

- **The bound is `pipeline.maxAttempts`.** The card left the source of `N` to the pin author. This pin
  resolves it to the existing attempt ceiling (rationale above). If the implementation team prefers a
  dedicated digest-specific ceiling, the observable the pin asserts (`<= N` calls, terminal after `N`
  failures) is unchanged — only the setting the GREEN reads, and the value the pin seeds, move.
- **Terminal marker is `status: "flushed"` + `flushOutcome: "failed"`.** Chosen to reuse the round-2
  F1c field per the reviewer's hint ("without inventing a second field"). If a distinct marker is
  preferred, the pin's `flushOutcome` assertion is the single line to update.

## Out of scope

- No production code, mock, fixture, factory or existing test is touched by this card.
- The F1c-r2 coverage gap (a retry/redelivery-path digest delivered `flushOutcome: "failed"` is never
  counted against `maxDigestEmailsPerDay`) is a **separate** round-3 card (`t_92c086f5`) and is not
  pinned here.

## Review sign-off (round 1, artifact lens)

- **Verdict: APPROVED** — no changes requested. The RED pin is genuine, precise and fit to implement
  against. Mirroring the round-1/round-2 precedent (the F1–F4 and round-2 sign-offs are sections of
  ADR-0130/ADR-0133/ADR-0134), this sign-off is recorded **inside** the delivered ADR rather than as
  a new number, so no extra ADR number is consumed.
- **Reviewer:** `openpic-webapp-reviewer` (card `t_b6540886`, run 468) · **Round:** 1 (artifact
  lens) · **Reviewed head:** `07dd940` (base `origin/main` `91d1101`) · **PR:** #218 (draft,
  RED-by-design).

### Independently verified

- **RED is genuine and reproduces exactly.** `vitest run --project integration` on `07dd940` →
  `1 failed | 53 passed (54)` files, `1 failed | 356 passed (357)` tests — byte-for-byte the claimed
  counts. The single failure is the new pin, at its intended assertion:
  `notification-digest-flush-non-retryable-bound.test.ts:340` —
  `expect(transport.calls).toBe(MAX_FLUSH_ATTEMPTS)` → `expected 4 to be 2` (the transport was called
  on all four flush ticks, one `failed` ledger row per tick, the bucket still `open`). Every
  pre-existing integration spec still passes — no regression.
- **CI red is the intended RED and nothing else.** PR #218 `ci` job: Typecheck / Lint / Unit tests =
  success, **Integration tests = failure** (the single pin above); `test_coverage` fails for the same
  pin; `secret-scan`, `lint`, `unit_test`, `env-changes`, `validate-branch-name`, `validate-pr-title`
  and CodeQL all pass. No non-pin failure masks the RED.
- **Contract hygiene.** `git diff origin/main...HEAD` touches only 3 files — the new spec, ADR-0137
  and the `docs/adr/README.md` row/allocation note. **No production file, mock, fixture, factory or
  existing test is touched.**
- **Real production paths.** The pin drives `runNotificationFanOut` + `flushDueDigests` against a
  real `MongoMemoryReplSet` and the real seed catalogue; only the transport and the recipient
  repository (external boundaries) are scripted. Deterministic: fixed clock, settings seeded with a
  non-default `N = 2`.
- **Card acceptance criteria mapped.** (i) transport ≤ `N` across `N + 2 = 4` ticks (line 340);
  (ii) `1 <= failed rows <= N` (lines 348–356); (iii) summary never delivered (lines 357–362);
  (iv) terminal observable `status: "flushed"` / `flushOutcome: "failed"` with the trailing ticks
  `scanned: 0` (lines 344–346, 365–366).
- **Semantics note folded in and accurate.** The spec's doc comment records that the round-2 F1b
  pin's scripted transport makes a `retryable: false` error _succeed_ on its second call
  (`scriptedNonRetryableTransport(failures)`, `notification-digest-flush-non-retryable.test.ts:102–129`),
  so its recovery is synthetic — independently confirmed.
- **ADR number.** `0137` is the lowest free: `docs/adr` on `origin/main` `91d1101` ends at `0134`;
  the open OP-97 refs hold `0131`/`0132`/`0135`/`0136`; no ref holds `0137`.

### Findings (non-blocking; none Critical/High/Medium)

- **ADR tolerance wording (Low, docs accuracy).** §"Bounded rows" states the pin "also tolerates an
  implementation that records the repeated failures on a single upserted row … instead of one row per
  attempt". The pin's `expect(failedRows[0]).toMatchObject({ attempts: 1 })` (lines 352–356) requires
  the row's `attempts` to be exactly `1`, so a single-upserted-row implementation that _increments_
  `attempts` per failure would fail it. The chosen contract is one-row-per-attempt, so the GREEN is
  unaffected; the wording merely overstates the tolerance. The GREEN card should keep `attempts: 1`
  on the recorded `failed` row.
- **Assertion stricter than prose (Low, informational).** The doc comment and the ADR say "at most
  `N` calls" while the assertion is exactly `toBe(N)`. With `N = 2` and the round-2 F1b requirement
  that the first failure must not terminate, exactly two calls is the forced outcome, so the
  assertion is correct; only the prose is looser.
- **Commit-identity nit (Low, no action).** The branch commit is authored as
  `openpic-webapp-backend-coder <backend-coder@openpic.local>` although the worker was the Test
  Author. The RED branch is never merged on its own and the squash-merge reattributes, so this is
  immaterial (same nit already accepted for ADR-0133).
- **Merge posture.** RED-only: PR #218 stays a **draft**; the round-3 GREEN card `t_4e4f0239`
  continues on this branch (`OP-96-task-f1-f4-round3-red`) in worktree
  `/root/openpic/openpic-webapp/.worktrees/t_6a4943e8` and turns the pin green, and the PR merges
  only then.

## Review sign-off (round 1 GREEN, artifact lens)

- **Verdict: APPROVED WITH FINDINGS** — no changes requested; PR #218 turned ready and
  **squash-merged** to `main`. As with the RED round above, this sign-off is recorded **inside** the
  delivered ADR (no new number consumed).
- **Reviewer:** `openpic-webapp-reviewer` (card `t_4e4f0239`, run 470) · **Round:** 1 (artifact
  lens) · **Reviewed head:** `5464bfc` (base `origin/main` `91d1101`, which is also the branch's
  merge base — the branch was up to date) · **PR:** #218 (ready → merged).

### Independently verified (re-run on `5464bfc`, in `/root/openpic/openpic-webapp/.worktrees/t_6a4943e8`)

- `vitest run --project integration` → **54 passed (54) files, 357 passed (357) tests**
  (`TMPDIR=/root/tmp-mongo`) — the round-3 pin is green and every pre-existing pin held.
- `vitest run --project unit` → **85 passed (85) files, 1477 passed (1477) tests**.
- `pnpm typecheck` clean · `pnpm run lint` **0 errors** (42 pre-existing warnings) · `pnpm run build`
  clean · `prettier --check` clean on the touched files.
- PR #218 CI: `ci` (typecheck · lint · unit · integration · coverage · build · **e2e** · dependency
  audit), `secret-scan`, `env-changes`, `validate-branch-name`, `validate-pr-title`, CodeQL — all
  green.
- **Card contract mapped to code.** (i) transport ≤ `N` across `N + 2` ticks → the `failed_terminal`
  branch in `flushDueDigests` increments `nonRetryableFailures` and stops selecting the bucket at the
  ceiling; (ii) `1 <= failed rows <= N` → one row per attempt (`attempts: 1`); (iii) never delivered →
  no outbox message, no `sent` row; (iv) terminal `status: "flushed"` + `flushOutcome: "failed"` with
  trailing `scanned: 0`. The round-2 F1b pin (bucket stays `open` under one failure, default
  `maxAttempts: 5`) still passes.
- **Honesty / scope audit.** `git show 5464bfc --stat` → 3 files: `digest.ts` (+66/−9), the §19.6
  schema doc (+4) and this ADR (+21). **No test, mock, fixture or factory is touched**; no
  `@ts-ignore`/lint suppression, no debug print, no TODO, no new dependency, no
  test-environment conditional, and no fixture-shaped logic: the bound is read generically from
  `platformSettings.pipeline.maxAttempts` (zod `min(1)`, default `5`), and the pin's non-default `N =
2` is never referenced in production code.

### Findings (none blocking)

- **F1 — a `failed_unrecorded` bucket is still re-attempted forever (Low, coverage gap; routed to a
  NEW round-3 TEST card).** `failed_unrecorded` (an unresolvable destination or an unbuildable
  message, `digest.ts:354`/`digest.ts:361`) is deliberately left `open`, but it now shares the same
  defect class **this card just fixed for the transport-failure variant**: it never reaches a
  terminal classification, so the flush cron re-selects it on every tick — re-resolving the
  destination and re-rendering the summary — and counts an `errors: 1` until the bucket's `expireAt`
  TTL retires it. Those conditions are effectively permanent (a user with no address for the channel
  never gains one), so the asymmetry the bound introduces is: a permanent transport failure is
  bounded at `N`, a permanent _unrecorded_ failure is unbounded. Both need the same
  contract decision (bound + terminal marker, or an explicit exemption), and neither is pinned. New
  card created from this review; not a defect in this delivery.
- **F2 — two _overlapping_ flush invocations deliver the same summary twice (Medium, pre-existing,
  unpinned; routed to a NEW round-3 TEST card).** `flushDueDigests` selects `{ status: "open", flushAt
<= now }` and only the _write_ is guarded (`updateOne({ _id, status: "open" })`), so two
  invocations that overlap both read the bucket before either closes it and both call the transport.
  Reproduced empirically on `5464bfc` with a throwaway reviewer probe (two concurrent
  `flushDueDigests` on one `MongoMemoryReplSet`, one due bucket, delayed transport):
  `transportCalls: 2, outboxLength: 2, sentLedgerRows: 2`, both runs reporting
  `{ scanned: 1, affected: 1 }`, bucket `flushed`/`sent`. That contradicts ADR-0130 F1's stated
  intent ("the flush cron can never re-select the bucket and double-send the summary") and ADR-0028
  §1's "concurrency-safe" cron claim. It is **not** introduced by this card (the new counter is
  atomically incremented and only closes buckets), but it is adjacent and unpinned. New card created
  from this review.
- **F3 — the crash window between the `$inc` and the close can cost one extra transport call (Low,
  informational).** `recordNonRetryableFailure` and `markFlushed` are two writes: if the process dies
  between them on the attempt that reaches the ceiling, the next tick records failure `N + 1` and
  closes, so the transport is called `N + 1` times. Bounded by one, only reachable on a crash, and
  outside what the pin scripts — recorded here so a future round does not read "at most `N`" as
  absolute (the pin asserts exactly `N`; see the RED round's "assertion stricter than prose").
- **F4 — the counter is observability-only on the document (Low, informational).** `errors` counts
  each non-retryable attempt and the closing tick alike, and `nonRetryableFailures` never reaches the
  `notification.digest_flush` summary line, so an operator cannot see how close a still-`open` bucket
  is to the ceiling. No action required; noted for a future observability pass.

### Test-quality note (report only)

The new pin is a strong behaviour pin: real `MongoMemoryReplSet`, the real fan-out + flush jobs, a
non-default `N = 2` so the default is never assumed, `N + 2` ticks, delivery-based observables, and
no coupling to internals beyond the §19.6 fields the schema already defines. The one soft spot is the
prose/assertion gap it inherits from the RED round ("at most `N` calls" vs `toBe(N)`); the assertion
is the stronger and correct one.
