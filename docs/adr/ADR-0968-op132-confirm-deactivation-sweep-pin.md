# ADR-0968 — OP-132 TEST: the confirm transaction's deactivation sweep is a pinned write, so a swallow cannot answer `200` with two active selfies

- **Status:** Accepted (characterization pin; **green on arrival**, two mutation probes) · **Date:** 2026-11-24
- **Card:** OP-132 TEST `t_52256cb7` (Low) — finding **F1** of the round-1 artifact review `t_2a76dd08` of [ADR-0966](ADR-0966-op132-confirm-outbox-failure-pins.md) (PR [#873](https://github.com/yahodu/openpic-webapp/pull/873), squash `ed625e6d`, landed). Branch `OP-132-task-confirm-deactivation-failure-pins`, worktree `/root/openpic/openpic-webapp/.worktrees/t_52256cb7`, cut from `origin/main` `340524bc`.
- **Extends, does not replace:** [ADR-0966](ADR-0966-op132-confirm-outbox-failure-pins.md)'s §Context lists **three** writes of this transaction and its Reversal condition names them ("the `isActive` flip, the activation, or the outbox insert"). The transaction has **four**: the `selfies.updateMany` deactivation sweep runs **before** all three. This record adds the sweep to that enumeration and pins it. Nothing in ADR-0966 is retracted, edited or renumbered — an accepted record is immutable, so the extension lives here and ADR-0966's three-write §Context stands as the record of what it covered when it landed.
- **Implements:** contract §6.3/§6.4 (the seven-key confirm envelope, `status`, the cached `matchCount`), §7.6/§7.7 ("every notification originates from a `domainEvents` row", so the row count is the notification count), §10.3.2 (the delivery identity), §0.12/§0.7 (an unhandled throw is `500 internal_error` and leaks nothing); schema §15.3 (the `firstMatchNotifiedAt` watermark), §16.4 (the single active-selfie pointer).
- **Touches:** one **test-only** file — one appended `describe` with one case in `apps/web/src/test/integration/selfie-confirm-publication.test.ts` (`+223/−0`; the twenty-three shipped cases, every helper, fixture and the harness byte-identical — `head -1518` hashes to `c4cfd84a…` both before and after, equal to `origin/main`'s blob). Plus this record, its index row, four ledger cells and one ledger note. **No production code:** `confirm/route.ts` `sha256 c37b7233b0caeeea513114acdcb755ca14149b8cb172788a5fcc288250dff9a7` before and after both probes.
- **Consumers:** `apps/web/src/test/integration/selfie-confirm-publication.test.ts`

## Context

`POST /api/v1/p/events/{slug}/selfies/{selfieId}/confirm` opens one `withTransaction(…, { maxAttempts: CONFIRM_MAX_ATTEMPTS })` (`confirm/route.ts:203`) and performs **four** driver writes inside it:

1. `selfies.updateMany({ profileId: profile._id, _id: { $ne: selfieId } }, { $set: { isActive: false } }, { session })` — deactivates the profile's previously active selfie, so §16.4's pointer stays singular (`confirm/route.ts:212-215`);
2. `selfies.updateOne({ _id: selfieId }, { $set: { isActive: true } }, { session })` — the §16.4 pointer itself (`confirm/route.ts:216`);
3. `profiles.updateOne(…)` — the activation: `activeSelfieId`, `status`, `matchCount` and the §15.3 watermark (`confirm/route.ts:217-229`);
4. `emitDomainEvent(…)` — the announcement, when `willPublish` (`confirm/route.ts:231-243`).

[ADR-0965](ADR-0965-op132-confirm-transaction-failure-pins.md) pins write (3); [ADR-0966](ADR-0966-op132-confirm-outbox-failure-pins.md) pins (2) and (4) and presented the transaction as covered. Write (1) was **unmeasured**, and it is the only one of the four whose failure mode is a _silent corruption_ rather than a silent omission: without it the new selfie is activated while the previous one stays active too, and §16.4's "one active selfie" pointer is true by field and false in the data.

The review of ADR-0966 measured the difference on the merged trunk `ed625e6d`, with selfie A submitted, worked and confirmed (so a _previous_ active row exists), then selfie B submitted and worked, and `Collection.prototype.updateMany` refusing only `COLLECTIONS.selfies` with `Object.assign(new Error("not primary"), { code: 91 })`:

- **clean route:** the second confirm answers **`500 internal_error`** and the profile keeps exactly **one** active selfie (A) — correct today;
- **route with that `updateMany` wrapped in `try { … } catch {}`:** the second confirm answers **`200 status: "ready"`** and the profile ends with **two** active selfies (A and B) — the §16.4 pointer silently corrupted;
- and the whole delivered spec stayed **`23 passed (23)`**: both new cases stub `updateOne`/`insertOne`, `updateMany` is a different prototype method, and no shipped fixture ever creates a _previous_ active selfie for the sweep to deactivate.

ADR-0966's Reversal condition already forbids the outcome ("commits nothing … the selfie is not active"), but its enumeration stopped one write short of the transaction. This record makes the enumeration complete.

## Decision

### 1. The fixture creates the precondition no shipped case creates

One confirmed selfie **A** (`submitOne` → `runWorker` with `FIRST_RUN_MATCHES` → `confirm`, answering `ready`, A active, `matchCount: 3`, one `attendee.matches.new` row), then selfie **B** (`submitOne` → `runWorker` with `SECOND_RUN_NEW_MATCHES`). That is the only way the sweep has anything to deactivate: with a single selfie the `_id: { $ne: selfieId }` filter matches nothing and a dropped sweep is invisible even to a row count.

The pre-call reads are the state the refused request must leave untouched: `status: "processing"` (see §6 — the submit that created B puts the profile back to `processing`, while `activeSelfieId` and `matchCount` still describe A), `activeSelfieId` = A, `matchCount: 3`, the §15.3 watermark set, one outbox row carrying `count: 3`, and exactly one `isActive: true` selfie row.

### 2. The fault is injected on the write the transaction actually performs, through the driver prototype

`Db#collection()` builds a fresh `Collection` per call, so an instance spy never fires. The case spies `Collection.prototype.updateMany`, gates on `this.collectionName === COLLECTIONS.selfies`, and forwards every other collection to the real method — resolved **once at module load** off the property descriptor (`driverUpdateMany`, the `driverUpdateOne`/`driverInsertOne` precedent above it in the same file). Resolving it inside the stub finds the spy and recurses, and a `RangeError` is also a `500`, so the pin would pass for the wrong reason.

The failure is `Object.assign(new Error("not primary"), { code: 91 })` — a replica-set election error with **no** `TransientTransactionError` label, so `withTransaction` rethrows it on the first attempt and the case cannot be satisfied by a retry. The dedupe `countDocuments` is deliberately **not** stubbed, so the case cannot pass by breaking the dedupe read instead of the sweep.

### 3. The recorded attempt is the anti-vacuity guard

A "still one active selfie" count is not evidence on its own: a route that deleted the sweep satisfies it and leaves the new selfie as the only active row. So the case records what the stub refused and requires **exactly one** sweep: `{ profileId: this profile, excludedSelfieId: this selfie (read from the filter's `_id.$ne`), askedIsActive: false, inSession: true }`. A route that answered `500` before opening the transaction — or one whose sweep never ran — fails there.

### 4. "Nothing moved" is read off the row and the selfie set, and the announcement off the outbox

The case asserts the app-wide `500 internal_error` with `details` undefined; the profile row keeps the pre-call `status`, `activeSelfieId: A`, `matchCount: 3` and the same §15.3 watermark instant; A is still active, B is not; `find({ isActive: true })` returns **exactly one** row and it is A; and every `attendee.matches.new` row's `payload.count` is unchanged (the refused request announced nothing new).

The fixture is proven a happy path: after the spy is restored, the **same** request answers the documented seven-key `200` with `status: "ready"`, moves the pointer to B, sets `matchCount` to `FIRST_RUN_MATCHES + SECOND_RUN_NEW_MATCHES`, leaves exactly one active row (B), deactivates A and writes the second outbox row with `count: 2`. A `5xx` leaves no `Idempotency-Key` state behind, so this retry is the documented client behaviour, not a special case.

The `notifications` feed rows are **not** asserted: the fan-out is deferred through `after()`, which throws outside a request scope, so in this harness the zero-row claim cannot red on its own ([ADR-0965](ADR-0965-op132-confirm-transaction-failure-pins.md) §Consequences, finding F2).

### 5. Appended case only

The block is appended after the ADR-0966 block; the file's top doc block, the shipped cases, every helper, fixture and the harness are untouched (`git diff` is `+223/−0`). The appended section adds one operand-independent record (`SelfieSweep`), one reader (`activeSelfieIds`) and one module-load constant (`driverUpdateMany`); it reuses `driverUpdateOne`'s technique, `fieldOf`, `setOf`, `selfieIsActive`, `firstMatchNotifiedStamp`/`firstDeliveryStamp`, `matchesNewRows`, `activationDeliveryKey`-shaped helpers as needed, `CONFIRM_KEYS`, `errorBody`, `confirmSelfie`, `readyEvent`, `submitOne`, `runWorker` and `confirm`. The rationale lives in the describe's own doc comment.

### 6. Deviation recorded: the card's pre-call `status` is not what the tree does

The card body predicts the profile "keeps its pre-call `ready`". Measured, it does not: submitting B runs `upsertProcessingProfile`, whose own comment is "A submit always leaves the profile `processing`: the worker owns the verdict and the confirmation owns publication" (`selfie-submit.ts:190-192`). So after B is submitted and worked, the row reads `status: "processing"` with `activeSelfieId: A` and `matchCount: 3`. The case pins that measured state and then asserts the refusal leaves it **identical** (`after.status` equals `before.status`); it does not hard-code `ready`. The sweep's rollback is unaffected by the correction — the pin is "the refused request moved nothing", and the pointer, the total and the watermark read exactly as A's confirmation left them.

### 7. Number allocation and ledger bookkeeping

- The record takes **`0968`**. Swept before minting, at this branch head (`origin/main` `340524bc`): the `unallocated (future lanes)` cell reads `0968`; the highest record on the trunk is `ADR-0967`; every `.worktrees/*/docs/adr` tree (thirteen worktrees) holds no `0968`; `git rev-list --objects --all -- docs/adr` holds no `0968`; and `gh pr list --state open` returns **no** open pull request, so no PR head holds it either.
- The OP-132 lane holds **no row** in the reserved-range table and its numbers have been pool draws since [ADR-0877](ADR-0877-op132-confirm-burst-settled-reread.md), so ADR-0300 §11 item 18 applies: the record is a pool draw on that cursor.
- The cursor advances `0968` → **`0969`**, together with every mirror cell that named `0968` at this head: `OP-129 attendee identity lane`, `OP-136 jobs lane`, and the `board-wide / process (orchestrator)` cell — the last one measured, not assumed: [ADR-0967](ADR-0967-merged-lane-local-branch-deletion.md)'s own landing moved all four `0967` → `0968` in one edit, so leaving the board-wide cell naming `0968` would hand the next board-wide draw this record's number. The card names three cells; the fourth is advanced for the same reason the other three are. No cell is lowered and no range is re-cut.

## Evidence

Measured in the card's worktree (`origin/main` `340524bc` + the spec), `CI=true npx vitest run --project integration …`:

```
# the focused spec, after the append
 Test Files  1 passed (1)
      Tests  24 passed (24)

# the pair with selfie-confirm-exhausted-budget.test.ts
 Test Files  2 passed (2)
      Tests  33 passed (33)
```

**The new case did not come out RED.** It is a green-on-arrival characterization pin — the behaviour is on `main` by construction, which is why this card is a pin and not a RED. It is load-bearing only if a mutation reddens it, so the arm was probed twice and both files restored byte-identically:

| Probe                   | Mutation                                                                                                                                          | Result                                                                                                                                                                                                                                                                 | Restored                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — the status arm**  | the transaction's `selfies.updateMany` call wrapped in `try { … } catch {}` (`confirm/route.ts`)                                                  | `Tests 1 failed \| 23 passed (24)`, `AssertionError: a confirm whose deactivation sweep failed with a non-retry driver error answered 200; it must answer the app-wide 500: expected 200 to be 500` — **only** the new case; the twenty-three shipped cases stay green | `confirm/route.ts` `sha256 c37b7233b0caeeea513114acdcb755ca14149b8cb172788a5fcc288250dff9a7` before and after, `cmp` byte-identical               |
| **B — the pointer arm** | the same swallow, with the case's `find({ isActive: true })` assertion temporarily moved ahead of the status assertion (spec restored afterwards) | `Tests 1 failed \| 23 passed (24)`, `AssertionError: expected [ '6b058803877d802322556bac', …(1) ] to deeply equal [ '6b058803877d802322556bac' ]` — the corruption the card names, **two** active selfies                                                             | spec restored from the pre-probe copy; `head -1518` hashes to `c4cfd84a…`, equal to `origin/main`'s blob; `git diff` is `+223/−0` on the one file |

`git status --short` after both restores names the spec only. `prettier --check` and `eslint` are clean on the spec; `pnpm typecheck` exit `0`; the eight `adr-*` guards are green.

Probe A is also the measurement that ADR-0966's Reversal condition was covering one write fewer than it claimed: under it, the two cases that record declares as the transaction's coverage red **nothing**, and the file's own count is `23 passed` — the same number the delivered spec reported before this record existed.

## Reversal condition

> When a write inside the confirm's transaction — **the deactivation sweep**, the `isActive` flip, the activation, or the outbox insert — fails for a reason that is not the outbox's duplicate-key collision, the route answers `500 internal_error` with no `details`, commits nothing (the profile keeps its pre-call `status`, its `activeSelfieId`, its `matchCount` and its watermark; **exactly one** selfie is active and it is the previously active one; no `attendee.matches.new` row's count moves) and the same request retried against a healthy driver answers the documented `200`, moves the pointer to the new selfie and leaves exactly one active row. These cases can be deleted only together with the transaction itself.

This replaces the three-write enumeration in [ADR-0966](ADR-0966-op132-confirm-outbox-failure-pins.md)'s Reversal condition **forward** (ADR-0966's apparatus, its control and its two cases stand unchanged); the four writes are now the enumerated set.

## Consequences

- **The transaction's four writes are each pinned.** Under a swallow of the sweep, only the new case reds and the twenty-three shipped cases stay green; under a swallow of the emit or the `isActive` flip, only ADR-0966's arms red; under a failed activation, only ADR-0965's case reds. A refactor that keeps the transaction atomic passes untouched.
- **The enumeration is complete, and the record that was short is named.** ADR-0966's §Context and Reversal condition are not edited (records are immutable) but no longer describe the transaction's write set on their own; a reader who arrives there should read this record's Reversal condition instead. This is the recurrence [ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md) §Decision 3 warns about in another shape: coverage that matches the prose, not the code.
- **The pins do not constrain internal structure.** They read the HTTP status, the §0.7 envelope, the stored profile/selfie fields and the outbox rows. The only driver-level assertion is the anti-vacuity record of the _attempted_ write.
- **The sweep's identity is pinned, not just its effect.** The record reads the excluded id from the filter's `_id.$ne`, so a sweep that deactivated the wrong set (or the new selfie itself) fails even if one row happened to stay active.
- **Hotspot:** `docs/adr/README.md` (row `0968`, four cells `0969`), which the sibling ADR cards also append to — merge as a union keeping the highest value in every cell.

## Alternatives

- **Assert only "exactly one active selfie".** Rejected as vacuous: a route that deleted the sweep leaves the new selfie as the single active row and passes. The recorded attempt is what distinguishes a rollback from a deletion.
- **Reuse ADR-0966's `isActive` arm and call the sweep covered.** Rejected by measurement: that arm stubs `updateOne`, the sweep is `updateMany`, and probe A shows the twenty-three delivered cases blind to the swallow.
- **Assert the `notifications` fan-out rows.** Rejected: the fan-out runs through `after()`, which throws outside a request scope in this harness, so the claim cannot red on its own (ADR-0965 §Consequences F2). The outbox row counts are the primary "announces nothing" observable.
- **Use `code: 11000`.** Rejected: that is the dedupe code `emitDomainEvent` owns and ADR-0965's control pins in the other direction; `91` is what discriminates "not the duplicate-key collision".
- **Draw a number from a lane row.** Rejected: OP-132 has no reserved row, and its last four records (`0877`, `0878`, `0965`, `0966`) were pool draws — ADR-0300 §11 item 18 is the applicable rule.
