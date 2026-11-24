# ADR-0966 — OP-132 TEST: the confirm's outbox write failing for a non-duplicate reason is a `500`, never a masked `200`

- **Status:** Accepted (characterization pins; **green on arrival**, one mutation probe per arm) · **Date:** 2026-11-24
- **Card:** OP-132 TEST `t_2a76dd08` (Low) — finding **F1** of the round-1 artifact review `t_d152cac9` of [ADR-0965](ADR-0965-op132-confirm-transaction-failure-pins.md) (PR [#869](https://github.com/yahodu/openpic-webapp/pull/869), squash `3a9231bd`, landed). Branch `OP-132-task-confirm-outbox-failure-pins`, worktree `/root/openpic/openpic-webapp/.worktrees/t_d152cac9`, cut from `origin/main` `412d64ba`.
- **Extends, does not replace:** [ADR-0965](ADR-0965-op132-confirm-transaction-failure-pins.md) pins the **activation** write of the same transaction and records the Reversal condition this record completes. The shipped cases, helpers, fixtures and harness are untouched; this is an appended `describe` in the same file, and the closed PR [#575](https://github.com/yahodu/openpic-webapp/pull/575) stays CLOSED and unmerged with `ADR-0820` unused.
- **Implements:** contract §6.3/§6.4 (the seven-key confirm envelope, `status`, the cached `matchCount`), §7.6/§7.7 ("every notification originates from a `domainEvents` row", so the row count is the notification count), §10.3.2 (the delivery identity), §0.12/§0.7 (an unhandled throw is `500 internal_error` and leaks nothing); schema §15.3 (the `firstMatchNotifiedAt` watermark), §16.4 (the active selfie).
- **Touches:** one **test-only** file — one appended `describe` with two cases in `apps/web/src/test/integration/selfie-confirm-publication.test.ts` (`+241/−0`; the twenty-one shipped cases, every helper, fixture and the harness byte-identical). Plus this record, its index row, three ledger cells and one ledger note. **No production code.**
- **Consumers:** `apps/web/src/test/integration/selfie-confirm-publication.test.ts`

## Context

`POST /api/v1/p/events/{slug}/selfies/{selfieId}/confirm` performs **three** writes inside one `withTransaction(…, { maxAttempts: CONFIRM_MAX_ATTEMPTS })`, opened at `confirm/route.ts:203`:

1. `selfies.updateOne({ _id: selfieId }, { $set: { isActive: true } }, { session })` — the §16.4 pointer (`confirm/route.ts:216`);
2. `profiles.updateOne(…)` — the activation: `activeSelfieId`, `status`, `matchCount` and the §15.3 watermark (`confirm/route.ts:217-230`);
3. `emitDomainEvent(…)` — the announcement, when `willPublish` (`confirm/route.ts:231-243`).

ADR-0965 pins write (2): stubbing `Collection.prototype.updateOne` for `COLLECTIONS.attendeeEventProfiles` reds its `F3.6-1` case under a swallow, and the whole file stayed `20 passed (21)` under a swallow-all `.catch`. Write (3) was **unmeasured**, and the review of ADR-0965 measured the difference on `origin/main` `3a9231bd`: with `Collection.prototype.insertOne` stubbed for `COLLECTIONS.domainEvents` using a non-duplicate driver error, the route answers `500 internal_error` today (correct), but wrapping the in-transaction `emitDomainEvent` call in `try { … } catch {}` answers **`200 status: "ready"`** — the activation committed (`status: "ready"`, `activeSelfieId` set, `matchCount: 3`, watermark set), `0` `attendee.matches.new` rows, the announcement silently lost — while the delivered spec stayed `21 passed (21)` and the pair with `selfie-confirm-exhausted-budget.test.ts` stayed `30 passed (30)`.

Write (1) was unpinned in the same way, one write earlier: a swallow there commits an activation for a selfie that is not the active one.

ADR-0965's Reversal condition already forbids all of that ("the confirm's transaction fails for a reason that is not the outbox's duplicate-key collision → `500 internal_error` … and announces nothing"). The reversal was broader than the coverage; this record makes the coverage match it.

## Decision

### 1. The fault is injected on the write the transaction actually performs, through the driver prototype

`Db#collection()` builds a fresh `Collection` per call, so an instance spy never fires. The cases spy `Collection.prototype.insertOne` (the emit) and `Collection.prototype.updateOne` (the `isActive` flip), gating on `this.collectionName` and forwarding every other collection to the real method — resolved **once at module load** off the property descriptor (`driverInsertOne`, `driverUpdateOne`; the `billing-checkout.test.ts:177` precedent). Resolving it inside the stub finds the spy and recurses, and a `RangeError` is also a `500`, so the pin would pass for the wrong reason.

The failure is `Object.assign(new Error("not primary"), { code: 91 })` — a replica-set election error with **no** `TransientTransactionError` label, so `withTransaction` rethrows it on the first attempt and neither case can be satisfied by a retry. `11000` is deliberately **not** used: that code is the dedupe `emitDomainEvent` owns (`domain-events.ts:357-366`) and the arm ADR-0965's control pins in the other direction. The dedupe `countDocuments` is likewise **not** stubbed, so a case cannot pass by breaking the dedupe read instead of the write.

### 2. "Announces nothing" cannot be satisfied vacuously — the recorded attempt is the guard

A zero `domainEvents` count is not evidence on its own: a route that deleted the emit would satisfy it. So each case records the attempt the stub refused.

- The emit arm requires exactly **one** outbox insert, carrying this selfie's delivery identity `attendee.matches.new:<eventId>:<profileId>:<selfieId>` (§10.3.2) and the transaction's `session`.
- The `isActive` arm requires exactly **one** `selfies` write, for **this** selfie, asking `isActive: true`, under the transaction's `session`.

A route that answered `500` before opening the transaction, or one whose write never ran, fails there. The `notifications` feed rows are **not** asserted: the fan-out is deferred through `after()`, which throws outside a request scope, so in this harness the zero-row claim cannot red on its own (ADR-0965 §Consequences, finding F2). The primary "announces nothing" observable is the `domainEvents` row count, and the recorded attempt is what makes even that non-vacuous.

### 3. "Activates nothing" is read off the row, and the injection is proven attributable

Each case asserts the profile row keeps its pre-call `status: "processing"`, `activeSelfieId: null`, `matchCount: 0` and an unset `firstMatchNotifiedAt`; the selfie is still not the active one; zero `attendee.matches.new` rows exist; and the client got the app-wide `500 internal_error` with `details` undefined.

The fixture is proven a happy path twice: the pre-call reads are the submit's own state, and after the spy is restored the **same** request answers the documented seven-key `200`, activates the row, stamps the watermark, sets the selfie active and writes exactly one outbox row. A `5xx` leaves no `Idempotency-Key` state behind, so the retry is the documented client behaviour, not a special case.

### 4. Two arms, so a swallow anywhere in the body reds one of them

The emit arm is the finding; the `isActive` arm is the same transaction one write earlier and cost one spy shape (the `fieldOf`/`setOf` readers and `driverUpdateOne` were already file-local). Together they bracket the profile write ADR-0965 pins, so the three writes of the transaction each fail a case when swallowed.

### 5. Appended cases only

The block is appended after `F3.6`; the file's top doc block, the shipped cases, every helper, fixture and the harness are untouched. The appended block reuses `driverInsertOne`, `driverUpdateOne`, `fieldOf`, `setOf`, `selfieIsActive`, `firstMatchNotifiedStamp`, `matchesNewRows`, `activationDeliveryKey`, `CONFIRM_KEYS` and the `OutboxWrite` record; it adds one local record (`SelfieWrite`) for the `isActive` attempt. The rationale lives in the describe's own doc comment.

### 6. Number allocation and ledger bookkeeping

- The record takes **`0966`**. Swept before minting: the `unallocated (future lanes)` cell at this branch head reads `0966`; `origin/main` `412d64ba` (highest record `ADR-0965`), every `.worktrees/*/docs/adr` tree (highest `0965`), every open PR head (#872 `e39ebcb6`, #871 `b6779c38`, #866 `140c0b5f`; highest `0965`) and `git rev-list --objects --all -- docs/adr` (highest `0965`) — none holds `0966`.
- The OP-132 lane holds **no row** in the reserved-range table and its numbers have been pool draws since `0877` (ADR-0877/ADR-0878 precedent), so ADR-0300 §11 item 18 applies.
- The cursor advances `0966` → **`0967`**, together with the two mirror cells it moves with (`OP-129 attendee identity lane`, `OP-136 jobs lane`). No cell is lowered and no range is re-cut.

## Evidence

Measured on the branch head (`origin/main` `412d64ba` + the spec), `CI=true pnpm exec vitest run --project integration …`:

```
# before the append
 Test Files  1 passed (1)
      Tests  21 passed (21)

# after the append
 Test Files  1 passed (1)
      Tests  23 passed (23)

# with the sibling selfie-confirm-exhausted-budget.test.ts
 Test Files  2 passed (2)
      Tests  32 passed (32)
```

**Neither new case came out RED.** Both are green-on-arrival characterization pins — the behaviour is on `main` by construction, which is why this card is a pin and not a RED. They are load-bearing only if a mutation reddens them, so each arm was probed, restored byte-identically afterwards and re-hashed:

| Arm                      | Mutation                                                                                       | Result                                                                                                                                                                                                                                                                                 | Restored                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **D** — the emit arm     | the in-transaction `emitDomainEvent` call wrapped in `try { … } catch {}` (`confirm/route.ts`) | `Tests 1 failed \| 22 passed (23)`, `AssertionError: a confirm whose outbox write failed with a non-retry driver error answered 200; it must answer the app-wide 500: expected 200 to be 500` — **only** the emit case; all twenty-one shipped cases and the `isActive` arm stay green | `confirm/route.ts` `sha256 c37b7233b0caeeea513114acdcb755ca14149b8cb172788a5fcc288250dff9a7` before and after, `cmp` byte-identical |
| **E** — the isActive arm | the `selfies.updateOne` `isActive` call wrapped in `try { … } catch {}` (`confirm/route.ts`)   | `Tests 1 failed \| 22 passed (23)`, `AssertionError: a confirm whose isActive write failed with a non-retry driver error answered 200; it must answer the app-wide 500: expected 200 to be 500` — **only** the `isActive` case                                                         | same file, same `sha256` before and after, `cmp` byte-identical                                                                     |

`git status --short` after both restores names the spec only. `prettier --check` and `eslint` are clean on the spec; `pnpm typecheck` exit `0`; the eight `adr-*` guards are green.

The runs corroborate the mechanism rather than a leak: each `500` is the injected `not primary`, not a `Maximum call stack size exceeded` (the recursion trap §1 avoids) and not a harness failure. Probe D is also the measurement that the **shipped** `F3.6-1` pin — the activation write's failure — stays green under an emit swallow, which is why the earlier pack could not see this arm.

## Reversal condition

> When a write inside the confirm's transaction — the `isActive` flip, the activation, or the outbox insert — fails for a reason that is not the outbox's duplicate-key collision, the route answers `500 internal_error` with no `details`, commits nothing (the profile keeps `processing`, `activeSelfieId: null`, `matchCount: 0`, an unset watermark; the selfie is not active; no `attendee.matches.new` row exists) and the same request retried against a healthy driver answers the documented `200` and publishes exactly once. These cases can be deleted only together with the transaction itself.

## Consequences

- **The whole transaction is now pinned, not one write.** Under a swallow of the emit, the entire shipped file (twenty-one cases) is green and only the new emit case reds; under a swallow of the `isActive` write, only its case reds. A refactor that keeps the transaction's atomicity passes untouched.
- **The pins do not constrain internal structure.** They read the HTTP status, the §0.7 envelope, the stored profile/selfie fields and the outbox rows. The only driver-level assertions are the anti-vacuity records of the _attempted_ write — without them the zero-row claims would be vacuous.
- **`11000` stays the control's code.** A pin that used `11000` here would be satisfied by the dedupe branch ADR-0965's control already pins; `91` is what discriminates "not the duplicate-key collision".
- **The exhausted-budget file keeps its own scope.** `F1.8` still pins "not the spent budget keeps its `500`" at the mocked seam; these cases pin the real callback one layer down. Neither subsumes the other.
- **Hotspot:** `docs/adr/README.md` (row `0966`, three cells `0967`), which the sibling ADR cards also append to — merge as a union keeping the highest value in every cell.

## Alternatives

- **Assert only "zero `attendee.matches.new` rows".** Rejected as vacuous: a route that removed the emit entirely satisfies it, so the pin would not distinguish a rollback from a deletion. The recorded attempt is the guard.
- **Reuse ADR-0965's profile-write stub and call the emit arm covered.** Rejected by measurement: probe D shows the shipped `F3.6-1` case green under an emit swallow, because the emit runs **after** the write it stubs and never gets stubbed itself.
- **Plant a `dedupeKey` row instead of stubbing the insert.** Rejected: with the row present the in-transaction `alreadyPublished` read is true, `willPublish` is false and the insert never runs — the case would pass on a route that had dropped the emit (the same trap ADR-0965 §Alternatives records for its control).
- **Stub the route's own `withTransaction` to reject.** Rejected: that is `F1.8`'s seam in the sibling file, and it is exactly the seam a swallow _inside_ the transaction body defeats.
- **Draw a number from a lane row.** Rejected: OP-132 has no reserved row, and its own last three records (`0877`, `0878`, `0965`) were pool draws — ADR-0300 §11 item 18 is the applicable rule.
