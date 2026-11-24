# ADR-0965 — OP-132 TEST: a genuine transaction failure is a `500`, never a masked `200`

- **Status:** Accepted (characterization pins; **green on arrival**, plus two mutation probes) · **Date:** 2026-11-24
- **Card:** OP-132 TEST `t_d152cac9` (Low) — the fresh pin [ADR-0304 §Decision 3 / §Consequences](ADR-0304-stale-draft-pr-reconciliation.md) requires for the one assertion closed PR [#575](https://github.com/yahodu/openpic-webapp/pull/575) carried and never landed. Branch `OP-132-task-confirm-transaction-failure-pins`, worktree `/root/openpic/openpic-webapp/.worktrees/t_d152cac9`, cut from `origin/main` `8ada9d7d`.
- **Recovers, does not copy:** the closed PR's tip `e7c44068` (`refs/pull/575/head`, branch `OP-132-task-confirm-tx-failure-pin` deleted 2026-11-24 under ADR-0306 §Amendment) held `describe("F3.5: a genuine transaction failure is a 500, never a masked 200")` and `ADR-0820`. Neither is rebased, reused or renumbered: `ADR-0820` stays unused and this is a **fresh pin** — the file did not contain the assertion on `main`, the technique is reused, the prose is not.
- **Implements:** contract §6.3/§6.4 (the seven-key confirm envelope, `status`, the cached `matchCount`), §7.6/§7.7 ("every notification originates from a `domainEvents` row", so the row count is the notification count), §10.3.2 (the delivery identity), §0.12/§0.7 (an unhandled throw is `500 internal_error` and leaks nothing); schema §15.3 (the `firstMatchNotifiedAt` watermark), §16.4 (the active selfie).
- **Touches:** one **test-only** file — one appended `describe` with two cases in `apps/web/src/test/integration/selfie-confirm-publication.test.ts` (`+300/−1`; the nineteen shipped cases, every helper, fixture and the harness byte-identical; the one removed line is the `mongodb` import, widened to also name `Collection`). Plus this record, its index row, three ledger cells and one ledger note. **No production code.**
- **Consumers:** `apps/web/src/test/integration/selfie-confirm-publication.test.ts`

## Context

`POST /api/v1/p/events/{slug}/selfies/{selfieId}/confirm` runs the selfie and profile writes, the §15.3 watermark and the `attendee.matches.new` emit inside **one** `withTransaction(…, { maxAttempts: CONFIRM_MAX_ATTEMPTS })` (`confirm/route.ts:203-245`), and the only `.catch` on that call is the exhausted-budget arm: it swallows **nothing** but the wrapper's own `TransactionRetryLimitError`, and only when `confirmOutcomeCommitted` shows the row already carries what this request owed (`route.ts:246-267`, ADR-0877). Every other failure — a driver error on the transaction's own write — is rethrown unchanged and lands in the app-wide `500 internal_error` (§0.12, `toErrorEnvelope`).

Nothing measured that direction. The shipped cases cover the opposite one exhaustively:

| file                                               | what it pins                                                                                | why it is blind here                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `selfie-confirm-publication.test.ts` (19 cases)    | repeat confirm, new-match count, late publisher, double-tap, four-wide burst, the watermark | all are happy paths; a `catch` that swallowed the abort leaves them green                                              |
| `selfie-confirm-exhausted-budget.test.ts` (`F1.8`) | a transaction that fails for a reason that is not the spent budget keeps its `500`          | it hands the **mocked** `withTransaction` the error, so its callback never runs: a swallow _inside_ the body passes it |

The gap is one `catch`: wrapping the activation write in `try { … } catch { return; }` answers `200 status: "ready"` for a selfie that was never activated, never counted and never announced — a silent failure with a success envelope, and no shipped case reds. That was measured here, not assumed: probe A below makes exactly that change and only the new case fails.

## Decision

### 1. The fault is injected on the transaction's own write, through the driver prototype

`Db#collection()` builds a fresh `Collection` per call, so an instance spy never fires; the case spies `Collection.prototype.updateOne` and gates on `this.collectionName === COLLECTIONS.attendeeEventProfiles`, forwarding every other collection to the real method. The real method is resolved **once at module load** off the property descriptor (`billing-checkout.test.ts:177` precedent): resolving it inside the stub finds the spy and recurses, and a `RangeError` is also a `500`, so the pin would pass for the wrong reason.

The failure is `Object.assign(new Error("not primary"), { code: 91 })` — a replica-set election error, which carries **no** `TransientTransactionError` label, so `withTransaction` rethrows it on the first attempt and the case cannot be satisfied by a retry. The dedupe `countDocuments` is deliberately **not** stubbed, so the case cannot pass by breaking that read instead.

### 2. "Activates nothing" is read off the row, and non-vacuity off the attempted write

The case asserts the profile row keeps its pre-call `status: "processing"`, `activeSelfieId: null`, `matchCount: 0` and an unset `firstMatchNotifiedAt`; the selfie is still not active; zero `attendee.matches.new` rows exist; and zero `notifications` rows exist for that workspace and type key. The fixture is proven a happy path twice: the pre-call reads are the submit's own state, and after the spy is restored the same request answers the documented `200`, activates the row, stamps the watermark and writes exactly one outbox row.

Non-vacuity is the recorded write: `profileWrites` must equal exactly one `{ profileId: this profile, askedStatus: "ready", inSession: true }`. A route that answered `500` before opening the transaction — or one that never reached this profile's activation — fails there, so the `500` cannot be credited to a broken setup.

### 3. The control makes the pin class-discriminating, not "any error is a 500"

The same describe holds the control the card requires: the same stubbing technique, but on the outbox insert, refused with MongoDB's duplicate-key code (`11000`). `emitDomainEvent` owns that code — its `catch` answers `{ deduped: true, id: null }` rather than aborting (`domain-events.ts:355-367`) — so the confirmation must still answer the **`200`**, commit its activation, the total and the watermark, and add no outbox row of its own.

That is what stops the first case from being satisfied by turning every driver error into a `500` (probe B measures it: removing the dedupe branch reds the control alone).

**The collision is injected at the driver, not planted as a row.** A planted `dedupeKey` row would make the in-transaction `alreadyPublished` read true (`route.ts:205-210`), `willPublish` false, and the insert would never run — the case would pass without exercising the branch it claims, so the injection is the only shape that can be non-vacuous. The case asserts the attempt happened, with the delivery identity `attendee.matches.new:<eventId>:<profileId>:<selfieId>` and a session.

### 4. Appended cases only

The block is appended after the watermark section; the file's top doc block is **not** edited, because the card walls the shipped prose off. The rationale lives in the appended section's own doc comment. The two reader helpers (`selfieIsActive`, `workspaceNotificationRows`) and the two operand readers (`fieldOf`, `setOf`) are file-local to the appended block; `firstMatchNotifiedStamp()` (shipped by the F5 section) is reused for the watermark, and `errorBody` is added to the existing helper import list.

### 5. Number allocation and ledger bookkeeping

- The record takes **`0965`**. Swept before minting: `origin/main` `8ada9d7d` (highest record `ADR-0964`), every `.worktrees/*/docs/adr` tree (highest `0964`), the single open PR head (#866, `140c0b5f`, no `docs/adr` entry above `0964`) and `git rev-list --objects --all -- docs/adr` (highest `0964`) — none holds `0965`.
- The OP-132 lane holds **no row** in the reserved-range table and its numbers have been pool draws since `0877` (ADR-0877/ADR-0878 precedent), so ADR-0300 §11 item 18 applies: the `unallocated (future lanes)` cursor read `0965`.
- The cursor advances `0965` → **`0966`**, together with the two mirror cells it already moved with (`OP-129 attendee identity lane`, `OP-136 jobs lane`). No cell is lowered and no range is re-cut.

## Evidence

Measured on the branch head (`origin/main` `8ada9d7d` + the spec), `CI=true pnpm exec vitest run --project integration selfie-confirm-publication.test.ts`:

```
 Test Files  1 passed (1)
      Tests  21 passed (21)
```

**Neither new case came out RED.** Both are green-on-arrival characterization pins — the behaviour is on `main` by construction, which is why this card is a pin and not a RED. They are load-bearing only if a mutation reddens them, so each half was probed, restored byte-identically afterwards and re-hashed:

| Arm                 | Mutation                                                                                                                            | Result                                                                                                                                                                                                                                                                          | Restored                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **A** — the pin     | the confirm's `.catch` swallows **every** error (`if (error !== undefined) { return; }`) instead of rethrowing a non-budget failure | `Tests 1 failed \| 20 passed (21)`, `AssertionError: a confirm whose transaction failed with a non-retry driver error answered 200; it must answer the app-wide 500: expected 200 to be 500` — **only** the new case, and the control stays green                               | `confirm/route.ts` `sha256 c37b7233b0caeeea513114acdcb755ca14149b8cb172788a5fcc288250dff9a7` before and after |
| **B** — the control | `emitDomainEvent`'s `isDuplicateKeyError` dedupe branch deleted, so the `11000` propagates                                          | `Tests 1 failed \| 20 passed (21)`, `AssertionError: a confirm whose outbox insert was refused as a duplicate key answered 500; the shipped writer dedupes it and must answer 200: expected 500 to be 200` — **only** the control, and the transaction-failure case stays green | `domain-events.ts` `sha256 741e9a7ac6e6e512dc15aa2d3e6b9e2507fb7994735c582f79df78b50c272bad` before and after |

`git status --short` after both restores names the spec only. `pnpm typecheck` (root, `packages/contracts`, `apps/web`) exit `0`.

The run's own log corroborates the mechanism rather than a leak: the `500` is logged by `http.error` with `err.message: "not primary"` at the spec's stub line, not a `Maximum call stack size exceeded` (the recursion trap §1 avoids) and not a harness failure.

## Reversal condition

> When the confirm's transaction fails for a reason that is not the outbox's duplicate-key collision, the route answers `500 internal_error`, writes no activation, leaves the §15.3 watermark unset and announces nothing; when the outbox refuses the announcement with `E11000`, the route still answers the documented `200` and commits. These cases can be deleted only together with the transaction itself.

## Consequences

- **A silent failure is now a test failure.** Arm A shows the whole existing file (`20` cases) is green under a swallow-all `catch`; only this pin reds, and its message names both the received and the owed status.
- **The failure _class_ is pinned, not one code.** The pair discriminates in both directions: an implementation that turns every driver error into a `500` reds the control (arm B), and one that swallows every error into a `200` reds the pin (arm A).
- **The pins do not constrain internal structure.** They read the HTTP status, the §0.7 envelope, the stored profile/selfie fields, the outbox rows and the feed rows. A refactor that keeps the transaction's atomicity and the duplicate-key dedupe passes untouched; only the attempted-write record names a driver call, and that is the pin's anti-vacuity guard.
- **The `notifications` assertion is corroborating, not primary.** The fan-out is deferred through `after()`, which throws outside a request scope (`domain-events.ts:260-266`), so in the integration harness it never runs; the zero-row claim cannot red on its own. The primary "announces nothing" observable is the `domainEvents` row count.
- **The exhausted-budget file keeps its own scope.** `F1.8` still pins "not the spent budget keeps its `500`" at the mock seam; this record pins the same direction one layer down, where the real callback runs, and neither subsumes the other.
- **Hotspot:** `docs/adr/README.md` (row `0965`, three cells `0966`), which the sibling ADR cards also append to — merge as a union keeping the highest value in every cell.

## Alternatives

- **Reopen / rebase PR #575 and land its case.** Rejected by ADR-0304 §Consequences and the card: a genuinely absent assertion gets a fresh pin, its branch was deleted under ADR-0306 §Amendment, and its ADR number (`0820`) has since been spent by the lane's own records. The technique is reused; the record and the prose are new.
- **Plant a `dedupeKey` row and let the real unique index produce the collision.** Rejected: with the row present the in-transaction dedupe read answers true, `willPublish` is false, and the insert never executes — the control would pass on a route that had removed the emit entirely. §3 states this on the record so the next reader does not "simplify" it back.
- **Stub the route's own `withTransaction` to reject.** Rejected: that is `F1.8`'s seam in the sibling file, and it is exactly the seam a swallow _inside_ the transaction body defeats. The pin has to fail at the write the transaction actually performs.
- **Inject a labelled transient error to prove the retry does not mask it.** Rejected as a different pin: a labelled error burns the attempt budget and ends as `TransactionRetryLimitError`, which is the exhausted-budget arm ADR-0878 already owns. `code: 91` without the label is what proves "not retried into a success".
- **Assert `response.json()` twice to inspect the envelope and the code.** Rejected as unnecessary indirection: `errorBody` reads the body once and returns the `error` object; asserting `details` is `undefined` is the §0.7 "never leak internals" clause and needs no second read.
- **Draw a number from a lane row.** Rejected: OP-132 has no reserved row, and its own last two records (`0877`, `0878`) were pool draws — ADR-0300 §11 item 18 is the applicable rule.
