# ADR-0969 — OP-132 TEST: the confirm transaction's deactivation sweep is a pinned write, so a swallow cannot answer `200` with two active selfies

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

A "still one active selfie" count is not evidence on its own: a route that deleted the sweep satisfies it and leaves the new selfie as the only active row. So the case records what the stub refused and requires **exactly one** sweep: its `profileId` is this profile, its `excludedSelfieId` is this selfie (read from the filter's `_id.$ne`), its `askedIsActive` is `false` and its `inSession` is `true`. A route that answered `500` before opening the transaction — or one whose sweep never ran — fails there.

### 4. "Nothing moved" is read off the row and the selfie set, and the announcement off the outbox

The case asserts the app-wide `500 internal_error` with `details` undefined; the profile row keeps the pre-call `status`, `activeSelfieId: A`, `matchCount: 3` and the same §15.3 watermark instant; A is still active, B is not; `find({ isActive: true })` returns **exactly one** row and it is A; and every `attendee.matches.new` row's `payload.count` is unchanged (the refused request announced nothing new).

The fixture is proven a happy path: after the spy is restored, the **same** request answers the documented seven-key `200` with `status: "ready"`, moves the pointer to B, sets `matchCount` to `FIRST_RUN_MATCHES + SECOND_RUN_NEW_MATCHES`, leaves exactly one active row (B), deactivates A and writes the second outbox row with `count: 2`. A `5xx` leaves no `Idempotency-Key` state behind, so this retry is the documented client behaviour, not a special case.

The `notifications` feed rows are **not** asserted: the fan-out is deferred through `after()`, which throws outside a request scope, so in this harness the zero-row claim cannot red on its own ([ADR-0965](ADR-0965-op132-confirm-transaction-failure-pins.md) §Consequences, finding F2).

### 5. Appended case only

The block is appended after the ADR-0966 block; the file's top doc block, the shipped cases, every helper, fixture and the harness are untouched (`git diff` is `+223/−0`). The appended section adds one operand-independent record (`SelfieSweep`), one reader (`activeSelfieIds`) and one module-load constant (`driverUpdateMany`); it reuses `driverUpdateOne`'s technique, `fieldOf`, `setOf`, `selfieIsActive`, `firstMatchNotifiedStamp`/`firstDeliveryStamp`, `matchesNewRows`, `activationDeliveryKey`-shaped helpers as needed, `CONFIRM_KEYS`, `errorBody`, `confirmSelfie`, `readyEvent`, `submitOne`, `runWorker` and `confirm`. The rationale lives in the describe's own doc comment.

### 6. Deviation recorded: the card's pre-call `status` is not what the tree does

The card body predicts the profile "keeps its pre-call `ready`". Measured, it does not: submitting B runs `upsertProcessingProfile`, whose own comment is "A submit always leaves the profile `processing`: the worker owns the verdict and the confirmation owns publication" (`selfie-submit.ts:190-192`). So after B is submitted and worked, the row reads `status: "processing"` with `activeSelfieId: A` and `matchCount: 3`. The case pins that measured state and then asserts the refusal leaves it **identical** (`after.status` equals `before.status`); it does not hard-code `ready`. The sweep's rollback is unaffected by the correction — the pin is "the refused request moved nothing", and the pointer, the total and the watermark read exactly as A's confirmation left them.

### 7. Number allocation and ledger bookkeeping

- The record takes **`0969`**. It was first drafted as `0968` and renumbered before review sign-off: PR [#880](https://github.com/yahodu/openpic-webapp/pull/880) (OP-134) merged as `7c2d315c` while this card was in review, so `origin/main` `2a7f4f85` holds `docs/adr/ADR-0968-op134-attendee-claim-i2-clock.md`. Both files carry different names, so a merge keeps both records and `adr-numbering.test.ts` answers `code: "duplicate"` — measured, `1 failed | 28 passed (29)` on a worktree at that trunk. The trunk's number wins; this lane moves. Swept after the renumber, at this branch head merged with `origin/main` `2a7f4f85`: the highest record on the trunk is `ADR-0968`; every `.worktrees/*/docs/adr` tree (twelve worktrees, this one included) holds no `0969`; `git rev-list --objects --all -- docs/adr` holds no `0969`; and the only open PR heads ([#883](https://github.com/yahodu/openpic-webapp/pull/883), OP-140, and this one) hold none either.
- The OP-132 lane holds **no row** in the reserved-range table and its numbers have been pool draws since [ADR-0877](ADR-0877-op132-confirm-burst-settled-reread.md), so ADR-0300 §11 item 18 applies: the record is a pool draw on that cursor.
- The cursor advances `0969` → **`0970`**, together with every mirror cell that named `0969` at this head: `OP-129 attendee identity lane`, `OP-136 jobs lane`, and the `board-wide / process (orchestrator)` cell, which [ADR-0967](ADR-0967-merged-lane-local-branch-deletion.md)'s landing and then [ADR-0968](ADR-0968-op134-attendee-claim-i2-clock.md)'s moved to `0969` in one edit each — leaving the board-wide cell behind would hand the next board-wide draw this record's number. The card names three cells; the fourth is advanced for the same reason the other three are. No cell is lowered and no range is re-cut.

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

**The new case did not come out RED.** It is a green-on-arrival characterization pin — the behaviour is on `main` by construction, which is why this card is a pin and not a RED. After the record was renumbered to `0969` and `origin/main` `2a7f4f85` merged in, both counts were re-measured at the merge head `3d6149cb` and are unchanged (focused `24 passed (24)`, pair `33 passed (33)`, the eight `adr-*` guards `280 passed (280)`). The `adr-consumers` guard reddened once on the way, on the appended doc comment's stale `ADR-0968 §Evidence` citation — after the merge that number resolves to OP-134's record — and is green again with the citation reading `ADR-0969`; the shipped prefix still hashes to `c4cfd84a…`. It is load-bearing only if a mutation reddens it, so the arm was probed twice and both files restored byte-identically:

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
- **Hotspot:** `docs/adr/README.md` (row `0969`, four cells `0970`), which the sibling ADR cards also append to — merge as a union keeping the highest value in every cell.

## Alternatives

- **Assert only "exactly one active selfie".** Rejected as vacuous: a route that deleted the sweep leaves the new selfie as the single active row and passes. The recorded attempt is what distinguishes a rollback from a deletion.
- **Reuse ADR-0966's `isActive` arm and call the sweep covered.** Rejected by measurement: that arm stubs `updateOne`, the sweep is `updateMany`, and probe A shows the twenty-three delivered cases blind to the swallow.
- **Assert the `notifications` fan-out rows.** Rejected: the fan-out runs through `after()`, which throws outside a request scope in this harness, so the claim cannot red on its own (ADR-0965 §Consequences F2). The outbox row counts are the primary "announces nothing" observable.
- **Use `code: 11000`.** Rejected: that is the dedupe code `emitDomainEvent` owns and ADR-0965's control pins in the other direction; `91` is what discriminates "not the duplicate-key collision".
- **Draw a number from a lane row.** Rejected: OP-132 has no reserved row, and its last four records (`0877`, `0878`, `0965`, `0966`) were pool draws — ADR-0300 §11 item 18 is the applicable rule.

## Review — round 2 (execution lens)

**Verdict: APPROVED.** PR [#879](https://github.com/yahodu/openpic-webapp/pull/879) merged as squash `7f7b0f1b` on `main` at 2026-11-24T14:24:25Z. Round 1 asked for one change — **F1, a duplicate `ADR-0968`** — and the renumber to `0969` landed: `docs/adr` holds exactly one file with that number (`git ls-tree -r --name-only origin/main docs/adr/ | grep -c 'ADR-0969'` prints `1`), and `adr-numbering.test.ts` is green in the eight-guard run below.

**Checks, measured by this reviewer.** The reviewed head is `6b4e0441`; this record, the spec and `confirm/route.ts` have the same blobs at that head, at the squash `7f7b0f1b` and at `origin/main` `8e1a0ec4` — the base this section was measured on — so each count below was run at `8e1a0ec4` and holds for both trees. The branch then merged `origin/main` `712b94d0` (PR #884), whose only paths are `docs/adr/README.md`, its own new record and `docs/Notification and Database Design.md`; none of the three blobs measured here moved.

- Focused `selfie-confirm-publication.test.ts`: `24 passed (24)`. The pair with `selfie-confirm-exhausted-budget.test.ts`: `33 passed (33)`.
- The eight `adr-*` guards: `280 passed (280)`.
- `prettier --check` clean on the three changed files (the spec, this record, `docs/adr/README.md`).
- CI on `6b4e0441`: every check-run is `success` — 20 entries because the head carried both a `push` and a `pull_request` run, naming 15 distinct checks: the 14 gates plus the close-time `notify-discord` side effect (`14/14`).

**Integrity.**

- Spec: `head -1518` hashes to `sha256 c4cfd84a…` at `6b4e0441`, at `7f7b0f1b` and at `origin/main`; the blob is `5c91f7bd` at all three.
- No production change: `confirm/route.ts` is `sha256 c37b7233…dff9a7`, blob `6f48ab5f`, identical at the reviewed head and at `8e1a0ec4`.
- Diff at the squash: `git diff --numstat 7f7b0f1b^ 7f7b0f1b` reads spec `+223/−0`, this record `+114/−0`, `docs/adr/README.md` `+6/−4` — three files. The card says README `+10/−4`; measured, `10` is the `git diff --stat` change count (6 additions plus 4 deletions), and this section quotes the numstat.
- The four mirror cells (`board-wide / process`, `OP-129`, `OP-136`, `unallocated`) read `0970` at `7f7b0f1b` and at `8e1a0ec4`, and `0971` at `712b94d0`, the trunk this section merges into after PR #884 drew `0970` in the merge window; no cell was lowered at any of the three, and this record consumes only `0969`.

**Land proof.** `6b4e0441^{tree}` = `7f7b0f1b^{tree}` = `0a7a1332369f8123c507d8de11a89a70a164f02c`, and `git diff --stat 6b4e0441 7f7b0f1b` is empty.

**Probes.** Each arm was re-run by this reviewer at `8e1a0ec4`, one at a time, with `confirm/route.ts` restored to `sha256 c37b7233…dff9a7` (and the spec to `head -1518` = `c4cfd84a…`) after it; `git status --porcelain` was empty before the next arm.

| Probe                   | Mutation                                                                                            | Result                                                                                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — the status arm**  | the transaction's `selfies.updateMany` call wrapped in `try { … } catch {}`                         | `1 failed \| 23 passed (24)`, `expected 200 to be 500` — only the new case red, the twenty-three shipped cases green                                                                                                                                |
| **B — the pointer arm** | the same swallow, with the case's `activeSelfieIds()` assertion moved ahead of the status assertion | `1 failed \| 23 passed (24)`, `expected [ '6b05a2b34d52957a07630c30', …(1) ] to deeply equal [ '6b05a2b34d52957a07630c30' ]` — two active selfies                                                                                                   |
| **C — the sweep gone**  | the `selfies.updateMany` call deleted (new in this round; not in the implementer's handoff)         | `1 failed \| 23 passed (24)`, `expected [] to deeply equal [ { …(4) } ]` — the anti-vacuity record (`sweeps`) bites on its own, so a route that dropped the sweep cannot pass on the "one active selfie" count alone                                |
| **D — not evidence**    | the sweep rewritten as a `bulkWrite`                                                                | `24 failed (24)` with `tenant scope violation` on every confirm: a tenant-scoped handle refuses `bulkWrite` (`apps/web/src/server/repos/collection.ts:372-378`), so the rewrite is not behaviour-identical and this arm says nothing about the pins |

**Findings, Info only, no code change:**

- **F1 — the "do not constrain internal structure" sentence reads narrower than measured, and narrower than the card assumes.** §Consequences' "The pins do not constrain internal structure" is imprecise: the anti-vacuity record does pin that the sweep is issued as `updateMany` on the driver `Collection`, because the case spies `Collection.prototype.updateMany` and requires exactly one recorded sweep. The card's illustration — a behaviour-identical `bulkWrite` rewrite that reds the guard — did **not** reproduce: the tenant-scoped handle refuses `bulkWrite` outright (probe D, `24 failed (24)`, every confirm a `tenant scope violation`), so that rewrite is not behaviour-identical in this route and no measurement of a behaviour-identical alternative exists. The finding stands in the measured form above; the class is the one [PR #881](https://github.com/yahodu/openpic-webapp/pull/881) recorded against ADR-0966, not its instance.
- **F2 — the ledger table break has landed.** At review time the `docs/adr/README.md` table break hid rows `0965`–`0969`; it was owned by card `t_a2124da9` and has since landed as [PR #886](https://github.com/yahodu/openpic-webapp/pull/886), squash `8e1a0ec4`, and rows `0965`, `0966`, `0968` and `0969` render on the trunk this section lands on.
- **F3 — the cells read `0970` while records in flight drew it.** The four mirror cells read `0970` at `7f7b0f1b` and at `8e1a0ec4`. Open [PR #884](https://github.com/yahodu/openpic-webapp/pull/884) (branch `OP-101-task-member-mutation-audit-records`) added a record drawing the bare number `0970` and has since landed as squash `712b94d0`, which advances all four cells to `0971`; open [PR #885](https://github.com/yahodu/openpic-webapp/pull/885) (branch `OP-134-task-attendee-sessions-ttl-regressions`) adds the record that draws `0973`. The card names `0971`–`0973` for the OP-134 lane; measured, `0971` and `0972` exist on no ref and that lane's open PR carries `0973` alone. This record lowers no cell and consumes only `0969`; the mechanism for a concurrent pool draw is card `t_0904efc1`.

**Post-review status.** F1 needs no code change, F2 landed as PR #886 under card `t_a2124da9`, and F3's concurrent draw happened as PR #884 (`712b94d0`) with the mechanism recorded under card `t_0904efc1`. Nothing in this record is retracted: no sentence of §Context, §Decision, §Evidence, §Reversal condition, §Consequences or §Alternatives is withdrawn, edited or renumbered, and the numbers the record drew — `0969` consumed, four cells `0970` at the squash and none lowered — stand as measured.
