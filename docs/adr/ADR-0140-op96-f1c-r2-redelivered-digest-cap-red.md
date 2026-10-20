# ADR-0140 — OP-96 follow-up round 3 RED: a digest delivered by the retry sweep counts against the daily cap (F1c-r2)

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-96 follow-up round 3 (RED, `t_92c086f5`) · **Parent:** `t_6163c787` (the round-2 GREEN + its review sign-off) · **GREEN card:** created by this card (`openpic-webapp-backend-coder`, gated on this one)
- **Implements / amends:** ADR-0120 A4 as amended by ADR-0134 (§"F1c — the delivered-only cap"): this closes the redelivery exemption that amendment leaves open · **Evidence:** ADR-0134 §"Review sign-off (round 2 GREEN, artifact lens)" §Findings §F1c-r2 · **Related:** ADR-0127 / ADR-0130 F1 (the `failed` ledger row owns the redelivery)
- **Branch:** `OP-96-task-f1c-r2-cap-red`, base `origin/main` `3f46950` (contains the round-2 GREEN, PR #217 squash-merged `2c779b3`, and the round-3 GREEN, PR #218 squash-merged `509b559`) · **Workspace:** `/root/openpic/openpic-webapp/.worktrees/t_6a4943e8`

## Context

The round-1 (artifact-lens) review of the OP-96 round-2 GREEN (`t_6163c787`, PR #217) returned
**APPROVED WITH FINDINGS**. Its one new finding, **F1c-r2 (Medium, coverage gap)** — recorded in
ADR-0134 §"Review sign-off (round 2 GREEN, artifact lens)" §Findings — is a behaviour/contract gap
with no pin, so it is pinned RED first (this card).

The gap: on a **retryable** digest-flush failure `flushDueDigests` closes the bucket with
`flushOutcome: "failed"` (`digest.ts` `markFlushed(bucket, "failed")`), while the `failed`
`notificationDispatches` ledger row stores the digest summary's own `subject`/`body` and is
redelivered by `notification-dispatch-retry` through `redeliverDispatchRow`
(`dispatch-redelivery.ts`, used by `dispatch-retry.ts`). The summary **is** delivered on that
redelivery — but `countFlushedToday` (`digest.ts`) counts only `{ status: "flushed",
flushOutcome: "sent" }`. A digest delivered through the redelivery path therefore never counts
against `notifications.maxDigestEmailsPerDay`, so a recipient can exceed the documented per-day cap
by the number of fail-then-recover digests in a local day.

ADR-0120 A4 (as amended by ADR-0134) says the cap bounds how many digest emails one recipient
**receives** in a day; a redelivered summary is received. No existing pin covers this:
`notification-digest-flush-failure.test.ts` asserts the delivery (one outbox message, one ledger
row, bucket `flushed`) but never the cap interaction, and
`notification-digest-flush-daily-cap.test.ts` (F1c) asserts only the _opposite_ direction — that a
failed flush does **not** burn the allowance in the same run.

No production code is changed by this card; the new pin fails for the right reason against
`origin/main` `3f46950`.

## Decision

### The chosen contract — option (a), count the recovery

Of the card's two listed shapes this pin selects **option (a)**, the reviewer's recommendation: a
digest delivered by the retry sweep consumes the recipient's daily allowance **exactly like a
first-attempt success**. Rationale: A4's wording is about how many digest emails a recipient
**receives**, and a redelivered summary is received; the alternative (option (b), declaring the
redelivery path exempt) would mean the cap bounds "first-attempt deliveries", which is not what A4
says and would need A4 itself rewritten. Option (a) keeps A4 intact and makes the accounting match
the delivery.

The pin asserts the **behavioural consequence**, not the mechanism: it does not dictate how the
recovered delivery is accounted for (a marker on the bucket, a linked ledger row, a join at count
time, …), only that the allowance is consumed. This keeps the pin green under any legitimate
implementation of (a) and leaves the GREEN card free to pick the cheapest one.

### New pin (integration, real `MongoMemoryReplSet` + real seed catalogue)

| Pin    | File                                                                                   | Observable                                                                                                                                                                                                                        |
| ------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1c-r2 | `apps/web/src/test/integration/notification-digest-flush-daily-cap-redelivery.test.ts` | with `maxDigestEmailsPerDay: 1`, a digest that fails retryably then is **delivered by the retry sweep** consumes the allowance, so a later digest due the same local day is **deferred** (`skipped`, left `open`) instead of sent |

The pin drives the real production paths (`runNotificationFanOut`, `flushDueDigests`,
`retryDueDispatches`) against a real `MongoMemoryReplSet` and the real seed catalogue, and asserts
only observable outcomes (transport deliveries, stored bucket state, `CronRunOutcome` counters).

### The scenario the pin scripts (deterministic)

1. Seed `notifications.maxDigestEmailsPerDay` to the **non-default** value `1` (as the F1c pin does),
   so the assertion never depends on the shipped default (`3`).
2. One arrival → one open digest bucket, due at `t0 + 15m`.
3. **Failure tick** (`t0 + 20m`): the scripted transport rejects the send **retryably**; the bucket
   closes `flushed`/`failed`, one `failed` ledger row owns the redelivery, nothing is delivered
   (`affected: 0`, `errors: 1`, outbox empty).
4. **Retry tick** (`t0 + 22m`): `retryDueDispatches` re-sends the row — the summary **is delivered**
   (`affected: 1`, one outbox message). This is the premise the pin establishes before asserting the
   cap.
5. A later digest arrives the same local day; its bucket is due at `t0 + 40m`.
6. **Second flush** (`t0 + 50m`): because the recipient has already received one digest today (the
   recovered one), with a cap of one the new digest must be **deferred** — `affected: 0`,
   `skipped: 1`, still exactly one delivered message, and the deferred bucket left `open`.

Fixed clock throughout; only the transport and the recipient repository (external boundaries) are
scripted, exactly as the existing OP-96 pins do.

### Relationship to the existing F1c pin (both stay green)

`notification-digest-flush-daily-cap.test.ts` (F1c, ADR-0134) pins that a **failed** flush consumes
**no** allowance _within the same run_ — the next digest in that run is still sent. This pin pins
that the same failure, **once actually delivered by the retry sweep**, _does_ consume the allowance
for later runs. The two are consistent: the allowance is consumed at **delivery** time, not at
**attempt** time. A GREEN that made a failed bucket count immediately would break F1c; a GREEN that
made a redelivered bucket never count breaks this pin. The pair bounds the contract from both sides.

## RED evidence

- `pnpm test:int` (`TMPDIR=/root/tmp-mongo`) → **1 file failed / 54 passed (55);
  1 test failed / 357 passed (358)**. The only failure is the new pin; every previously green
  integration test (including the merged F1–F4, round-2 F1b/F2b/F1c and round-3 F1b-r2 pins, and the
  OP-94/95/96 I1–I12 pins) still passes — no regression.
- The pin fails for its intended reason at the cap accounting:

  ```
  AssertionError: expected 1 to be +0 // Object.is equality
   ❯ apps/web/src/test/integration/notification-digest-flush-daily-cap-redelivery.test.ts:309:32
        expect(outcome.affected).toBe(0);
  ```

  i.e. the second digest was **sent** (`affected: 1`) because the digest delivered by the retry
  sweep was not counted against the cap (it was `flushOutcome: "failed"`).

- `pnpm typecheck` clean; eslint + prettier clean on the new spec.

## Consequences

- The GREEN card turns the pin green by making a digest summary that is actually **delivered by the
  retry sweep** count against the recipient's daily allowance — e.g. by linking the redelivered
  ledger row back to its bucket (or marking the bucket when its `failed` row is redelivered) and
  having `countFlushedToday` count that delivery. It continues on **this** branch
  (`OP-96-task-f1c-r2-cap-red`) in **this** worktree
  (`/root/openpic/openpic-webapp/.worktrees/t_6a4943e8`).
- The per-recipient per-local-day digest cap now bounds the emails a recipient **receives**,
  including those recovered via `notification-dispatch-retry` — closing the over-delivery F1c-r2
  identified. The existing F1c pin still holds: a failure that is _not yet_ delivered consumes no
  allowance.
- If the GREEN needs a new persisted link between a digest's `failed` ledger row and its bucket, the
  authoritative schema (`docs/Notification and Database Design.md` §19.5/§19.6) must be updated by
  the GREEN so the document matches the code.

## Alternatives considered

- **Option (b): declare the redelivery path exempt and pin the exemption with an observable marker.**
  Rejected: A4 (ADR-0120, amended by ADR-0134) bounds how many digest emails a recipient _receives_,
  and a redelivered summary is received, so (b) would require an explicit A4 amendment to be honest,
  and it leaves the over-delivery in place. (a) is the reviewer's recommendation and matches A4.
- **Pin the mechanism (e.g. `expect(bucket.flushOutcome).toBe("sent")` after redelivery).**
  Rejected: it prescribes one implementation and would fail an equally valid one (a join at count
  time, a dedicated recovery marker). The behavioural consequence — the next digest is deferred — is
  the contract.
- **Assert the private `countFlushedToday` value.** Rejected: it is not exported, and asserting an
  internal counter rather than an observable delivery would couple the pin to internals.
- **Reuse `notification-digest-flush-daily-cap.test.ts`.** Rejected (per the card): the card says to
  add a new spec rather than edit an existing one, and the scenarios differ (F1c = same-run
  non-consumption; F1c-r2 = cross-run consumption after redelivery).

## Assumptions & open questions

- **The deferred observable is the right cap signal.** With `maxDigestEmailsPerDay: 1` and one
  already-received digest, `withinDigestDailyCap(1, 1)` is false, so the due bucket is **deferred**
  (`skipped`, left `open`), matching the documented "deferred, not dropped" behaviour. If the team
  prefers a different observable for "the allowance is consumed", the cap arithmetic in the pin is
  the single line to change.
- **"Delivered by the retry sweep" is the accounting trigger.** The pin treats the redelivery as the
  delivery event (the ledger row flips to `sent`). An implementation that instead counts the failed
  bucket the moment its row is redelivered, or at count time, satisfies the same observable.

## Out of scope

- No production code, mock, fixture, factory or existing test is touched by this card.
- The two sibling round-3 findings from the same review (F1: a `failed_unrecorded` bucket still
  unbounded; F2: overlapping flush runs double-deliver) are **separate** cards (`t_c9e903c5` ADR
  `0138`, `t_e3369a9e` ADR `0139`) and are not pinned here.
- E2E: this behaviour is fully exercisable as an integration pin against the real jobs and a real
  Mongo replica set, so no Playwright spec is added.

## ADR-number allocation

`0140` is the lowest free number that does not tread on a binding reservation, re-checked against
fresh `origin/main` `3f46950` and **every** ref immediately before committing: `docs/adr` on
`origin/main` ends at `0137`; the still-open OP-97 GREEN worktree (`t_58825ec3`) holds `0135` (with
`0136` reserved for its sign-off); and the binding allocation (`t_cf0b1f77`, extended by the round-3
review) reserves `0138`/`0139` for the two sibling round-3 finding cards (`t_c9e903c5`,
`t_e3369a9e`). `0138`–`0139` are reserved, so the next free is `0140`.
