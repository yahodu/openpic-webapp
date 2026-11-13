# ADR-0803 — OP-132 TEST: reuse honours `selfies.per_attendee`, concurrency cannot exceed it, and reuse mounts a §0.11 limiter

- **Status:** Accepted (RED / executable contract)
- **Consumers:**
  `apps/web/src/test/integration/selfie-reuse-attempt-cap.test.ts` — the whole
  file (five cases) and its local harness (`readyEvents`, `eventAt`,
  `prepareSelfie`, `submitAttempt`, `readySelfie`, `reuseOn`, `rateHeader`,
  `selfieRows`, `selfiesOf`).
- **Lane:** the shared attendee block `0780`–`0798` (row
  `OP-129 attendee identity lane`) is **exhausted**: the records above it
  ([ADR-0799](ADR-0799-op133-preview-url-selfie-summary-pins.md),
  [ADR-0800](ADR-0800-op132-selfies-ttl-and-kind-dedupe-pins.md),
  [ADR-0801](ADR-0801-op132-selfies-ttl-and-kind-dedupe-green.md)) drew from the
  `unallocated (future lanes)` pool and advanced both cells to `0802`. At this
  branch cut (`origin/main` `9c5bbbb`) the sweep is **not** empty: `0802` is
  claimed in flight by the OP-133 soft-delete pins
  (`ADR-0802-op133-soft-deleted-image-and-null-preview-pins.md`, in the
  `t_2c32cef3` worktree). This record therefore draws **`0803`**, the first
  number above every in-flight reservation, and both cells advance to `0804`. No
  new lane row is minted.
- **Amends:** [ADR-0791](ADR-0791-op132-liveness-selfie-red.md) and
  [ADR-0792](ADR-0792-op132-liveness-selfie-green.md) — the reuse half of the
  selfie contract, which that lane pinned without a budget and without a rate
  stage.
- **Consumes:** `0803`.

## Context

Review finding **F2** (Medium) of `t_3b8151c3` / PR #543. Three defects of one
family, measured on the branch cut:

| probe                                                                                | result                                                                                                                          |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `POST …/selfies:reuse` by an attendee whose `selfies` count already equals `allowed` | `202` — a fourth attempt is minted: one `selfies` row and one high-priority `q:selfie` pointer per call                         |
| the reuse route's stage declarations                                                 | `rateLimit` and `rateLimitIdentity` are both **absent**, while every other POST in §0.11 carries one (`write.normal` at 60/min) |
| the reuse route's budget resolution                                                  | `selfieAttemptNumbers` is read **after** the write, only to fill the envelope — the cap is never consulted                      |
| five concurrent submits on one profile, `allowed = 3`, two attempts already spent    | `[202, 202, 202, 500, 500]` — the cap is overshot by two attempts, and two racers die on `TransactionRetryLimitError`           |

The submit route's own check is the third defect: `selfieAttemptNumbers` reads
`countDocuments({profileId})` **outside** the `withTransaction` that inserts the
row, so two calls that both observe `used = allowed - 1` both pass. This is a
write-skew: snapshot isolation does not conflict on inserts into different
documents, so merely moving the read inside the transaction does not close it —
and, measured above, five concurrent racers additionally exhaust the submit
route's `withTransaction` retry budget through their own concurrent
`upsertProcessingProfile` writes, which is why the pre-fix status list carries
two `500`s.

§14.1 calls `selfies.per_attendee` "the hard cap" and §0.11 gives every write a
class. A reuse is a write that mints an attempt, so both apply.

This card (`t_75bc5afe`) is **pins only**: no production change, no edit to an
existing case, fixture or helper. The GREEN sibling `t_476a4abe` makes the pins
pass.

## Decision

### 1. The cap is resolved before any write, and a refusal spends nothing

An attendee whose target-event profile already holds `allowed` `selfies` rows
and asks to reuse a confirmed selfie from another event receives
`403 plan_limit_exceeded` with `details.entitlementKey: "selfies.per_attendee"` —
the same refusal the submit route answers — and the route writes **nothing**: no
fourth `selfies` row and no new `q:selfie` pointer. The pin asserts the stored
row count and the memory queue's outbox length, not the absence of a call: a
reuse that inserts and then enqueues cannot pass it by reordering alone.

### 2. Reuse and submit draw on one budget

A mixed sequence on one event — submit, reuse, submit — reports `attemptsUsed`
`1, 2, 3` and `attemptsRemaining` `2, 1, 0`, and the fourth call on **either**
path is `403 plan_limit_exceeded` with the same `entitlementKey`. The budget is
read per **profile**, and a profile is per event, so the attempts spent on the
source event do not pay for the target event; the case therefore spends them on
the target event and reuses a source selfie that belongs to the same subject on
another event (which is the §6.2 per-event consent shape the reuse route already
enforces).

The submit half of the fourth call is already green (the submit suite pins it);
it is repeated here because the point of the case is that **both** paths answer
the same refusal at the same boundary.

### 3. Concurrency cannot exceed the cap — status and stored state

With `allowed = 3` and two attempts already spent, five submits for one profile
with distinct `Idempotency-Key` values are fired concurrently. The case pins
**both** halves:

- the status multiset — exactly one `202` and four `403`s, each refusal carrying
  `plan_limit_exceeded`/`selfies.per_attendee`;
- the invariant — the profile's stored `selfies` count is exactly `allowed`
  afterwards, and exactly one queue entry was published.

The second half is stated as data so that a fix which answers the right statuses
while leaking a row still fails.

**A bare `Promise.all` is not a pin here, and that was measured.** Run under
`Promise.all` alone the buggy tree answered `[202, 202, 202, 500, 500]` three
times out of three when the file ran alone, but in one full-suite run the five
requests happened to execute one after another and produced exactly
`[202, 403, 403, 403, 403]` — the case **passed on the bug**. So the case parks
every submit at the route's own first step, `headObject` (contract §6.3: the
object exists before anything is charged), on the memoized storage adapter, and
releases all five together: all five cap reads then happen before any insert can
commit, which is exactly the window the read-outside-the-transaction check cannot
close. The release is bounded (`SUBMIT_PARK_MS = 300`) so a fix that serializes
the whole handler still finishes instead of deadlocking on a "wait for four
peers" gate. With the park the buggy tree answers `[202, 202, 202, 500, 500]` on
three consecutive runs — never one `202` and four `403`s, because four refusals
first require a fix — and the near-fix in §Satisfiability is green three runs
running.

### 4. The reuse route mounts a limiter — pinned class-agnostically

§0.11 has **no row for reuse** (the contract-drift card amends it), so this pin
does not invent a class. It asserts the three properties every limited route in
this repository has:

1. a successful reuse answer carries the `RateLimit-Limit`, `RateLimit-Remaining`
   and `RateLimit-Reset` headers (`rateLimitHeaders`), with `Limit > 0` and
   `Remaining < Limit` — a route with no stage carries none of them;
2. consecutive reuse calls **count down**: `Remaining` drops by exactly one per
   call, so the limiter is live and the call is what consumes the token;
3. past the **loosest** POST class §0.11 lists (`write.normal`, 60/min), the
   route answers `429 rate_limited` with `Retry-After` and the same
   `RateLimit-*` headers — i.e. reuse is not unlimited under any admissible
   class.

A stricter class (`selfie.submit`, 6/hour/attendee) satisfies all three: the
`429` then arrives earlier, and the assertions are bounds, not exact counts. The
case drives 61 calls with a well-formed but absent `selfieId` (cheap `404`s that
still traverse the stage), and asserts the elapsed time is under 60 s so the
counter cannot have reset under the assertion.

### 5. Deliberately not pinned

- **The class itself, and its numbers.** Which class reuse declares (and whether
  it is `write.normal` coarse, `attendeeRateLimitStage("selfie.submit")`
  post-auth, or a new row) is the GREEN's decision to record — the card says so —
  and the DOCS card in this chain amends §0.11 to match. Pinning a name here
  would either invent a contract row or forbid the decision the card delegates.
- **The per-IP arm.** Whether the class is also IP-keyed is the class decision
  above; the countdown assertion only requires _a_ rule.
- **The withdrawal/purge interaction on a reuse** (`409 selfie_purged`, ADR-0798)
  — already pinned by the OP-131 and F-A2 suites; this file does not re-pin it.
- **Cross-instance serialization.** The concurrency pin observes one process, so
  a process-local serializer satisfies it. It does **not** prove the cap holds
  across several instances of the app; that would need a database-level claim and
  a second process. Recorded in §Open questions rather than pretended.

## Evidence — the measured red list

On `origin/main` `9c5bbbb` (branch `OP-132-task-reuse-cap-and-rate-pins`), all
five cases fail for the stated reason:

| case                                            | failure                                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — a spent budget refunds nothing to reuse     | `AssertionError: expected 202 to be 403` — the reuse is accepted and mints a fourth attempt                                                               |
| 2 — submits and reuses are mixed on one event   | `AssertionError: expected 202 to be 403` — the fourth call on the reuse path is accepted                                                                  |
| 3 — five submits race for one remaining attempt | `AssertionError: expected [202, 202, 202, 500, 500] to deeply equal [202, 403, 403, 403, 403]` — two overshoots, two `TransactionRetryLimitError` (`500`) |
| 4a — a reuse answer carries the §0.11 headers   | `Error: expected the reuse answer to carry the §0.11 \`ratelimit-limit\` header`                                                                          |
| 4b — past the loosest POST bound                | `AssertionError: the reuse route never answered 429: statuses 404,404,…,404` (61 × `404`): expected -1 to be greater than or equal to 0                   |

`Test Files 1 failed (1)`, `Tests 5 failed (5)`. `tsc -p apps/web/tsconfig.json
--noEmit` exits `0` on this head, so no case is red for a type or load reason.

## Satisfiability — the near-fix probe

Two throwaway edits, reverted byte-identically afterwards (`sha256` equality and
an empty `git diff`):

1. **The reuse route** — resolve the profile, run the existing
   `selfieAttemptNumbers`/`selfieAttemptBudget` pair before the source lookup and
   throw `403 plan_limit_exceeded` with `SELFIE_ATTEMPTS_KEY`, plus
   `rateLimitIdentity: attendeeRateLimitStage("selfie.submit")`.
2. **The submit route** — a per-profile serializer around a re-read of the budget
   plus the existing transaction (the same shape `seed-plans.ts` uses as
   `runExclusive`).

| probe run                                               | result       |
| ------------------------------------------------------- | ------------ |
| all five cases, with both edits                         | 5 passed (5) |
| the same file after both production files were restored | 5 failed (5) |

So each pin is satisfiable by the minimal repair, and none of them passes
vacuously. The probe also measured the arithmetic the cases depend on: with
`selfie.submit` on reuse, case 1 spends six `selfie.submit` tokens (one per
submit and per reuse), case 2 five, case 3 five, and case 4b trips its `429` on
the seventh call.

## Consequences

- **The GREEN has three sentences to satisfy**: reuse resolves the budget before
  it writes; the cap is claimed atomically (or the write path is serialized) so
  concurrent submits mint one attempt; reuse declares a §0.11 class whose
  strictness is at least the table's loosest POST class.
- **Moving the read inside the transaction is not enough.** Measured: the five
  racers' own `upsertProcessingProfile` writes exhaust `withTransaction`'s
  three-retry budget, so an in-transaction `countDocuments` still answers `500`
  to two of them. The minimal shape that satisfies case 3 serializes the
  read-and-insert per profile (or claims the attempt with one conditional write)
  so the losers never open a transaction.
- **A suite-wide constraint, recorded here because it is invisible in the test
  body**: `selfie.submit` allows six calls an hour per attendee session
  (`liveness.challenge` twelve), and every live submit or reuse in this file
  spends one. The two "already spent" attempts in case 3 are therefore seeded as
  `selfies` rows, and the object is put through the storage port instead of the
  presign route. An editor who replaces the port write with `uploadSelfie` pushes
  case 1 to exactly six and case 2 past the bound, and the failure will be a
  `429` that looks like a cap bug.
- `docs/adr/README.md` stays the shared-ledger hotspot: both `Next free` cells
  move `0802` → `0804`, and the row plus the note merge as a union keeping the
  highest value. `0802` remains the OP-133 soft-delete pins' number in flight.
- No number outside `0803` is consumed, and no lane row is created.

## Alternatives

1. **Pin the class by name** (`write.normal`, or `participant`-keyed
   `selfie.submit`). Rejected: the GREEN card explicitly delegates the choice and
   the DOCS card amends §0.11 to match, so a name here would either invent a
   contract row or forbid the delegated decision — and the class-agnostic trio
   (headers present, counter counts down, a bound at the loosest POST class)
   discriminates just as sharply against "no limiter".
2. **Pin only the stored count** (the card's fallback). Rejected _after_ the
   probe: the status multiset is deterministic under the minimal repair, and it
   is the observable a client sees. Both halves are pinned instead, so a status-
   only or a count-only fix fails.
3. **Drive the two spent attempts as real submits.** Rejected: two more
   `selfie.submit` calls push the race to seven an hour and the losers would
   answer `429` instead of the cap.
4. **Pin a `409` for the losers** instead of `403`. Rejected: §14.1's cap refusal
   is `plan_limit_exceeded` (`403`), the same code the submit route already
   answers, so two codes for one boundary would be a contract drift of its own.
5. **Assert the exact `RateLimit-Limit` value.** Rejected: that is the class
   decision in disguise.

## Open questions (for the GREEN `t_476a4abe`)

1. **Which class does reuse declare, and is it coarse or post-auth?** The card
   asks the choice to be recorded and to be stated in the handoff so the §0.11
   amendment matches. Both shapes satisfy the pins; `selfie.submit` is the
   stricter and the one this probe exercised.
2. **Where does the serialization live?** A shared helper (a `runExclusive`
   module, the shape `seed-plans.ts` and `seed-notification-types.ts` already
   use privately) would serve both the reuse and the submit route; an atomic
   per-profile attempt counter would additionally survive multiple instances.
   The pins do not choose between them.
3. **Does the submit route's serialization belong in this card?** Case 3 is a
   submit-only pin, so yes — the card names the submit TOCTOU as the second half
   of F2. Expect the GREEN's diff to touch both route files.
