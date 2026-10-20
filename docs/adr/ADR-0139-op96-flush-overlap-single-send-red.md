# ADR-0139 — OP-96 follow-up round 3 RED: overlapping digest-flush runs must not double-deliver a summary (F2)

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-96 follow-up round 3 RED pin (TEST, `t_e3369a9e`) · **Parent:** `t_4e4f0239` (the round-3 GREEN `t_4e4f0239`/PR #218 review, round 1 artifact lens) · **GREEN card:** created by this card (`openpic-webapp-backend-coder`, gated on this one)
- **Evidence:** ADR-0137 §"Review sign-off (round 1 GREEN, artifact lens)" §Findings §F2 (Medium, pre-existing, unpinned)
- **Implements / amends:** nothing — this card adds a pin only. It records the contract the GREEN must satisfy for ADR-0130 §"F1" ("the flush cron can never re-select the bucket and double-send the summary"), ADR-0028 §1 (the "concurrency-safe" cron framework claim, `apps/web/src/server/jobs/cron-job.ts` doc-comment) and ADR-0120 (the OP-96 digest contract, §10.2 `notification-digest-flush`)
- **Branch:** `OP-96-task-flush-overlap-single-send-red`, base `origin/main` `509b559` · **Workspace:** `/root/openpic/openpic-webapp/.worktrees/t-flush-overlap-red`
- **New pin:** `apps/web/src/test/integration/notification-digest-flush-overlap-single-send.test.ts`

## Context

The round-1 (artifact-lens) review of the round-3 GREEN (`t_4e4f0239`, PR #218 squash-merged as
`509b559`) returned **APPROVED WITH FINDINGS**. Finding **F2 (Medium, pre-existing, unpinned)** is a
delivery-duplication defect with no pin, so it is pinned RED first — this card.

`flushDueDigests` selects `{ status: "open", flushAt: { $lte: now } }` and guards only the **write**
(`updateOne({ _id, status: "open" })` in `markFlushed`); **nothing claims a bucket before the send**.
Two invocations whose lifetimes overlap therefore both read the bucket before either closes it and
both hand the same summary to the transport. The reviewer reproduced it empirically on `5464bfc`
(two concurrent `flushDueDigests` on one `MongoMemoryReplSet`, one due bucket, a transport delayed
120 ms): `transportCalls: 2, outboxLength: 2, sentLedgerRows: 2`, both runs reporting
`{ scanned: 1, affected: 1 }`, bucket `flushed`/`sent`. Two identical emails, two `sent` ledger rows,
both runs reporting success.

Overlap is reachable by design, not just in theory: the cron framework explicitly supports a
scheduler re-invoking to drain a backlog (`hasMore`), a platform retry after a timeout, and a
manual/signed trigger running next to the scheduled cron — all of which produce two `flushDueDigests`
calls whose lifetimes can overlap. This pin therefore sits in the same defect class as the ADR-0130
F1 pin (single-owner flush) but covers the **concurrent** case F1 left open.

The defect is **pre-existing**: the round-3 GREEN's `nonRetryableFailures` `$inc` is a single atomic
increment and only ever closes buckets, so it neither introduced nor widened the window.

## Decision

### New pin (integration, real `MongoMemoryReplSet` + real seed catalogue)

| Pin          | File                                                                                  | Observable                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F2 (success) | `apps/web/src/test/integration/notification-digest-flush-overlap-single-send.test.ts` | two concurrent flush runs on one due bucket deliver **one** summary, write **one** `sent` ledger row, end the bucket `flushed`/`sent`, and report **one** delivery in total                                   |
| F2 (failure) | same file                                                                             | two concurrent flush runs on one due bucket whose send rejects non-retryably invoke the transport **once**, write **one** `failed` ledger row, and leave the bucket **`open`** (selectable for the F1b retry) |

The pin drives the real production paths (`runNotificationFanOut`, `flushDueDigests`) against a real
`MongoMemoryReplSet` and the real seed catalogue. It adds a **new** spec file: no existing test, mock,
fixture or factory is touched, and every pre-existing pin (F1–F4, round-2 F1b/F2b/F1c, round-3
F1b-r2, OP-94/95/96 I1–I12) is preserved — in particular the single-threaded flush pins are untouched.

### The pinned contract: at most one delivery per bucket per open → flushed transition

The pin is deliberately **mechanism-agnostic**. The card's reading is that either a claim/lease taken
with a conditional `findOneAndUpdate` **before** the send, or an atomic transition-before-send,
satisfies it; the pin asserts only observables, so any mechanism that produces "one delivery" passes.
Concretely the success case asserts:

1. `transport.outbox` has length 1 and the transport was invoked once (`calls === 1`) — one delivery;
2. exactly one `status: "sent"` dispatch ledger row exists for the digest type;
3. the bucket ends `status: "flushed"`, `flushOutcome: "sent"`;
4. `firstFlush.affected + secondFlush.affected === 1` — the two runs report one delivery in total.

The `CronRunOutcome` **split** (`scanned` / `skipped` / `errors` per run) is deliberately **not**
pinned. Under the defect both runs report `{ scanned: 1, affected: 1, errors: 0 }`; a claim-based fix
may leave the loser at `scanned: 0` (its select filtered the claimed bucket out) or at `scanned: 1,
skipped: 1` (it selected the bucket and failed to claim it). Pinning either split would force the
GREEN into one mechanism for no behavioural gain. What is pinned is the **delivery count**: `affected`
summed across both runs is the number of summaries delivered, and two runs reporting `affected: 1`
each for one bucket is exactly the defect's signature. The same reasoning applies to the failure case
(`affected` sums to 0).

### Why the failure path is pinned too (and stays deterministic)

A non-retryable rejection is the case where the overlap does structural damage beyond duplicate mail:
`recordNonRetryableFailure` is an atomic `$inc`, so two overlapped runs each count their own failure.
With `pipeline.maxAttempts` seeded to the non-default `2` (so the default `5` is never assumed), a
single real attempt must leave the bucket `open` for the F1b retry (ADR-0134/ADR-0137) — a
double-count would reach the ceiling on the first flush and close the bucket **one attempt early**,
silently converting the F1b "stays selectable" contract into "terminal". The pin therefore asserts the
**consequence** rather than the counter: one transport call, one `failed` ledger row, no `sent` row,
and `status: "open"`. The stored `nonRetryableFailures` value itself is not asserted — it is a §19.6
schema field, but its observable meaning is exactly the terminal classification the pin already
measures, and asserting it would couple the pin to the counter surviving a legitimate re-implementation
(e.g. a claim generation counter, or an upserted failure row).

### Why the overlap is deterministic (and not a latch)

The scripted transport holds every send open for a real 150 ms (`setTimeout`, no fake timers) before
answering. Both runs are launched with `Promise.all` in the same tick, so both select the still-open
bucket well inside that window and neither can close it until its own send resolves — 3 consecutive
runs of the new file failed identically at the same assertions (see RED evidence).

**Alternative rejected: a barrier/latch that releases the first send only once a second send is in
flight.** It would make the _current_ defect rock-solid, but it deadlocks the _fixed_ behaviour: once
a claim prevents the second send, no second send ever arrives, the first send never resolves, and the
test hangs until the Vitest timeout instead of passing. A pin must go green cleanly on the fix; the
fixed-duration delay overlaps the reads just as reliably (the pre-send work is a handful of
milliseconds) without that failure mode.

**Alternative rejected: `vi.useFakeTimers()` for the delay.** The delay must elapse _while_ two real
Mongo operations are in flight; fake timers would need manual advancement interleaved with driver I/O
and would make the overlap depend on test-harness scheduling rather than on real concurrency.

**Alternative rejected: an in-process lock/stub on the repository.** The flush job takes no repository
seam, and stubbing the data layer would stop the pin from exercising the real select/claim
interleaving — which is precisely the defect.

### Assumptions recorded (ambiguities resolved by this card)

- **"Exactly one delivery" is asserted as `=== 1`, not `<= 1`.** With a due bucket and an accepting
  transport, zero deliveries would be a different (also wrong) behaviour — the summary must go out.
- **The two runs share one transport instance.** That is what makes "one delivery" measurable; a
  production deployment would have two processes with two transports, and the contract still holds.
- **Both runs use the same fixed instant** (`t0 + 20m`, past the bucket's `t0 + 15m` `flushAt`), so the
  overlap is in the bucket claim, not in clock skew.
- **The failure case seeds `pipeline.maxAttempts = 2`.** Any ceiling `>= 2` would do; `2` is chosen so
  a double-count is guaranteed to cross it in one overlapped flush while a single count cannot.
- **The failure case's empty-outbox assertion is an invariant, not a discriminator.** The rejecting
  stub throws before it can record a delivery, so `expect(transport.outbox).toHaveLength(0)` can only
  fail if the stub itself changes; it restates "the summary is never delivered" for parity with the
  F1b-r2 pin, which asserts the same. The discriminating assertions in that test are
  `transport.calls === 1`, the single `failed` ledger row and the bucket still being `open`. (Noted by
  the round-0 diff review; kept deliberately rather than dropped, since deleting a correct invariant
  assertion to satisfy a style preference is the weaker move.)

## RED evidence

- `pnpm test:int` → **1 failed | 54 passed (55) files; 2 failed | 357 passed (359) tests**. The only
  failures are the two new pins; all 54 pre-existing integration files pass unchanged — no regression,
  and every previously green pin (including the single-threaded flush pins this one must not disturb)
  still passes.
- The two pins fail for their intended reason:

  ```
  FAIL … notification-digest-flush-overlap-single-send.test.ts > … > F2: two concurrent runs deliver
       one summary, one sent ledger row and one reported delivery
  AssertionError: expected [ { channel: 'email', …(4) }, …(1) ] to have a length of 1 but got 2
   ❯ apps/web/src/test/integration/notification-digest-flush-overlap-single-send.test.ts:358:32
       expect(transport.outbox).toHaveLength(1);

  FAIL … notification-digest-flush-overlap-single-send.test.ts > … > F2: two concurrent non-retryable
       flush runs record one failure and leave the bucket selectable
  AssertionError: expected 2 to be 1 // Object.is equality
   ❯ apps/web/src/test/integration/notification-digest-flush-overlap-single-send.test.ts:391:31
       expect(transport.calls).toBe(1);
  ```

  i.e. the same summary reaches the transport **twice** (two outbox messages) and the overlapped
  non-retryable pair spends **two** of the bucket's bounded attempts on one flush. The runs' own
  structured log lines record the defect from the job's point of view:
  `… "event":"notification.digest_flush","scanned":1,"affected":1,"skipped":0,"errors":0 …` emitted
  **twice** for one bucket.

- **Determinism check:** the new file was run 4 times (3 consecutive repeat runs plus the full-suite
  run); all 4 runs failed at the same two assertions with the same received values (`2` / `2`). No
  flake observed.
- `pnpm typecheck` clean · `eslint` on the new spec clean · `prettier --check` clean.

## Consequences

- The GREEN card (`openpic-webapp-backend-coder`, gated on this card) turns the pin green by claiming
  a bucket **before** the send — e.g. a conditional `findOneAndUpdate({ _id, status: "open" }, …)`
  that atomically takes the bucket (a claim/lease field, or a transition to an in-flight status)
  before `flushOneBucket` is called, with the losing run leaving the bucket alone. It continues on
  **this** branch (`OP-96-task-flush-overlap-single-send-red`) in **this** worktree
  (`/root/openpic/openpic-webapp/.worktrees/t-flush-overlap-red`) so the pin ships with the
  implementation.
- **Index semantics must be preserved.** If the GREEN introduces an in-flight/claimed status it must
  keep the `{ status: 1, flushAt: 1 }` flush index and the `{ userId: 1, bucketKey: 1 }` unique index
  partial **on `open`** semantics intact (a claimed bucket must not be selectable _and_ must not
  permanently block the key), and update the §19.6 schema doc in
  `docs/Notification and Database Design.md` with the new field/status.
- **Adjacent openings deliberately left out of scope.** The crash window between a claim and its
  release (an abandoned lease), and the TTL/`expireAt` interaction with a claimed-but-unflushed bucket,
  are not pinned here: neither is deterministic to script from the observables this card's contract
  defines, and a lease TTL is a GREEN design choice this card must not pre-empt. If the GREEN adds a
  lease, the reviewer should ask for a bounded-lease pin in the next round rather than treating this
  card as covering it.
- The pin's failure sibling also freezes a consequence of the round-3 bound: the overlapped
  non-retryable pair must not consume two of the bucket's `pipeline.maxAttempts` attempts. A future
  round that changes the non-retryable bound (ADR-0137) must keep "one flush attempt = at most one
  counted failure".

## Review sign-off (round 1, artifact lens)

- **Verdict: APPROVED** — no changes requested. The RED pin is genuine, deterministic and
  mechanism-agnostic, and it reproduces exactly. Mirroring the round-1/round-2/round-3 precedent (the
  F1–F4, round-2 and round-3 sign-offs are sections of ADR-0130/ADR-0133/ADR-0134/ADR-0137), this
  sign-off is recorded **inside** the delivered ADR rather than as a new number, so no extra ADR
  number is consumed.
- **Reviewer:** `openpic-webapp-reviewer` (card `t_e3369a9e`, run 478) · **Round:** 1 (artifact
  lens) · **Reviewed head:** `1eb4420` (base `origin/main` `509b559`; `origin/main` itself at
  `3f46950`) · **PR:** #221 (draft, RED-by-design).

### Independently verified

- **RED is genuine and reproduces exactly.** `vitest run --project integration` on the new spec
  alone, 4 consecutive runs → `Tests 2 failed (2)` every time, failing at the same two sites with the
  same received values: `notification-digest-flush-overlap-single-send.test.ts:358:32`
  (`expect(transport.outbox).toHaveLength(1)` → length `2`) and `:391:31`
  (`expect(transport.calls).toBe(1)` → `2`). Full suite → `1 failed | 54 passed (55)` files,
  `2 failed | 357 passed (359)` tests — byte-for-byte the claimed counts; every pre-existing
  integration spec still passes.
- **The defect is visible from the product's own log lines.** The success case emits
  `notification.digest_flush` with `scanned: 1, affected: 1` **twice** for the one bucket, and the
  failure case emits it twice with `scanned: 1, errors: 1` — i.e. two runs both claiming to have
  flushed the same bucket.
- **CI red is the intended RED and nothing else.** PR #221 `ci` job (`Integration tests` step; the
  steps before it — typecheck, lint, unit, build — pass): `Test Files 1 failed | 54 passed (55)`,
  the two failures being this card's pins at `358:32` / `391:31`.
- **The pre-existing claim is accurate.** `91d1101` (before the round-3 GREEN `509b559`) already had
  the unguarded select `find({ status: "open", flushAt: { $lte: now } })` and the write-only guard
  `updateOne({ _id, status: "open" })` in `markFlushed`, with no claim/lease anywhere — so this pin
  does **not** pin a regression introduced by the round-3 GREEN.
- **Contract hygiene.** `git diff 509b559 1eb4420` touches only 3 files (585 insertions, **0
  deletions**): the new spec, ADR-0139 and the `docs/adr/README.md` row/allocation note. **No
  production file, mock, fixture, factory or existing test is touched.** Diff scan clean: no
  `@ts-ignore`/`eslint-disable`, no `.only`/`.skip`, no `console.*`, no TODO/FIXME, no test-env
  conditional, no fixture-shaped logic. `prettier --check` clean on all three files.
- **The pin asserts observables only, and is satisfiable.** Transport `calls`/`outbox`, the `sent`
  ledger row count, the stored `status`/`flushOutcome`, and the summed `affected` — the per-run
  `CronRunOutcome` split is deliberately unpinned, so a claim/lease-before-send and an atomic
  transition-before-send both pass. Real production paths throughout (real `MongoMemoryReplSet`, real
  seed catalogue, real `runNotificationFanOut` + `flushDueDigests`); only the transport and the
  recipient port are scripted. Deterministic: fixed clock, real 150 ms delay + `Promise.all`, no fake
  timers, no latch.
- **ADR number.** `0139` is free: `docs/adr` on `origin/main` `3f46950` ends at `0137`, no ref or
  worktree holds `0139` (the sibling F1 lane holds `0138`, the F1c-r2 lane `0140`), so the two
  parallel op-96 follow-ups cannot collide.
- **Card acceptance criteria mapped.** (1) one due bucket seeded through the real fan-out (line 328
  asserts it is `open`); (2) two concurrent `flushDueDigests` with a transport that blocks 150 ms
  (lines 352–355); (3) contract pinned on delivery, not on a run split: one outbox message + one call
  (358–359), one `sent` row (362), bucket `flushed`/`sent` (365–367), `affected` sum `1` (370);
  (4) the non-retryable sibling is deterministic and red (one call expected, received `2`);
  (5) RED counts, failing assertions and the ADR number are reported as claimed.

### Findings (non-blocking; none Critical/High — no changes requested)

- **F2-1 (Low, test-quality meta).** The RED evidence proves only the **first** failing assertion per
  test — in the failure sibling everything after `transport.calls === 1` (one `failed` ledger row, the
  bucket still `open`, `affected` sum `0`) is unproven until the GREEN runs, because Vitest stops the
  test body at the first failed `expect`. Route: the F2 GREEN's review round must confirm those
  assertions still hold; the pin itself needs no change. (Also noted: the empty-`outbox` assertion is
  an invariant given the rejecting stub — deliberately kept for parity with the F1b-r2 pin and
  documented at length in §"Assumptions recorded".)
- **F2-2 (Low, pre-existing flake in an unrelated spec — routed to its own card).**
  `notification-quiet-hours-release.test.ts` I11 failed once in 5 local full-suite runs here:
  `expected 1 to be 3` at line `305:91` — three real fan-outs produced **one** `deferred` row, and
  that file-run took 10.6 s against 2.5 s in CI. It is green in isolation (5/5), green when run
  paired with this card's new spec (2 runs), green in CI on `1eb4420`, and green in **3/3**
  pin-absent full runs on `main` — so it is not attributable to this pin, but a load-dependent
  partial fan-out is also the signature of a swallowed write error and deserves its own
  investigation rather than being left undiagnosed.
- **F2-3 (Low, coverage gap, informational).** The **retryable**-overlap sibling is not pinned. Under
  the defect an overlapped _retryable_ rejection writes two owner ledger rows, and the
  dispatch-retry cron would then redeliver the same summary twice — a second duplicate-delivery
  path. The card asked only for the non-retryable sibling, and the core assertion
  (`transport.calls === 1`) already funnels the same claim fix, so this is optional hardening for the
  F2 GREEN's round; no card is raised, since adding a RED pin **after** the fix would invert the
  RED→GREEN order.
- **Merge posture.** RED-only: PR #221 stays a **draft**; the F2 GREEN card `t_4cc14cd8`
  (`openpic-webapp-backend-coder`) continues on this branch
  (`OP-96-task-flush-overlap-single-send-red`) in this worktree
  (`/root/openpic/openpic-webapp/.worktrees/t-flush-overlap-red`) and turns the pin green, and the PR
  merges only then. Per the card, this RED pin is **not** merged on its own — a RED `main` would
  break CI.
