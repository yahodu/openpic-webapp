# ADR-0857 — OP-136 TEST: every post-claim step of the account purge is recoverable

- **Status:** Accepted · **Date:** 2026-11-17
- **Card:** OP-136 TEST `t_b845ed28` (Medium; finding **F3a** of the review of the
  TEST card `t_535ab5d2`; branch `OP-136-task-purge-step-window-pins`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_8901d758`, cut from `origin/main`
  `51c439f0`). Parent (already merged): the GREEN `t_8901d758`.
- **Implements:** contract §10.2 (the `account-deletion-purge` row), §1.4 (the
  deletion lifecycle), §12 (the completion receipt is _addressed to the last
  known email_, resolved from the retained tombstone), §2.3, §4.5.
- **Consumes:** [ADR-0853](ADR-0853-op136-sweep-failure-windows-pins.md) (the
  tombstone pin these extend), [ADR-0856](ADR-0856-op136-sweep-failure-windows-resume.md)
  (the `withTransaction` that turns all four pins green).
- **Consumers:** `apps/web/src/test/integration/job-sweep-failure-windows.test.ts`
  (the three appended pins) and the module they constrain,
  `apps/web/src/server/jobs/account-deletion-purge.ts`.
- **Number allocation:** the `OP-136 jobs lane` row's `Next free` cell read
  `0857` at this head (`51c439f0`), and the sweep immediately before minting
  found no `ADR-0857*` file on the trunk, in any `.worktrees/*/docs/adr`, in
  `git rev-list --objects --all -- docs/adr` or on any of the seventeen open PR
  heads (`0849`–`0856` are the highest records anywhere). This record takes
  `0857` and advances **only** that cell to `0858`; both
  `unallocated (future lanes)` cells stay `0869`. No number outside `0849`–`0868`
  is consumed.

## Context

ADR-0853 pinned the purge's **tombstone write** window, and ADR-0856 closed it
by running the claim, the contact read, the anonymize, the session delete, the
tombstone upsert and the `account.deletion.completed` emit in one
`withTransaction`. The High finding behind both is wider than the tombstone:
"_unrecoverable after **any** post-claim failure_".

The review of `t_535ab5d2` measured that width in a throwaway worktree carrying
a near-fix that **passes** the tombstone pin (contact retained, claim moved
after the tombstone write). One injected `session` `deleteMany` failure
produced:

```
{"fired":1,"first":{"scanned":1,"affected":0,"errors":1},"retryScanned":0,
 "tombstones":1,"receipts":0,"profileStatus":"deleted","purgeStartedAt":true,"sessionsLeft":1}
```

The account is `deleted`, no `account.deletion.completed` exists and the revoked
session survives: the deletion is lost permanently although the pin set is
green. A GREEN can therefore pass ADR-0853's four pins and leave this open.

## Decision

### 1. Three appended pins in the existing spec, one new `describe`

The pins live in a new `describe("when a purge step fails after the account is
claimed")` appended to `job-sweep-failure-windows.test.ts`. The card allowed
either this or a new file; appending reuses the file's injection harness and its
seven-collection `beforeEach` reset, and keeps the purge's four failure windows
in one place. **No existing assertion, helper, fixture or mock is edited** —
the diff is `277` insertions and `0` deletions — and the two new import-free
helpers are additive:

- `failNextDeleteMany(collectionName)` — the same `Collection.prototype` spy the
  file already uses for `updateOne`/`insertOne`, with its own
  `Object.getOwnPropertyDescriptor` capture of the driver method at module load
  (reading the property at call time finds the spy and recurses);
- `deletionState(userId)` — one read of the tombstone, the receipt, the profile,
  the Better Auth row and the session count. It asserts nothing, so each pin's
  failure message stays about its own step;
- plus `seedSession(userId)` and `purgeRun()` (the three-line job invocation).

### 2. One narrow injection per post-claim step

Each case trips exactly one step of the purge and then requires the **next**
run to finish the deletion because ADR-0853's pin 1 does — one
`accountDeletionTombstones` row holding the last known email, one
`account.deletion.completed` whose `payload` is `{ userId }` only, and a
`deleted` profile:

1. **the session delete** — `Collection.prototype.deleteMany`, gate
   `this.collectionName === "session"`. The case also asserts `sessions: 0`
   after the retry, because that is the step under test;
2. **the receipt emit** — `Collection.prototype.insertOne` on `domain_events`,
   gated further on the document's own
   `eventKey === "account.deletion.completed"`;
3. **the contact anonymize** — `Collection.prototype.updateOne` with
   `this.collectionName === "user"` (the collection is the narrowest honest gate:
   gating on the `$unset` document would prescribe the erase shape, and a future
   `$set: { email: null }` is the same observable anonymize). The case also
   asserts the account keeps **no** contact (`email`/`name` read `null`), because
   otherwise a purge that simply gave up on the erase would pass.

Every injection is armed for **one** call, its error is `code: 91` (a
replica-set election, never `11000`, so no caller can mistake it for the outbox's
dedupe collision), it is restored in a `finally` before the retry runs, and
`expect(injection.fired(), …).toBe(1)` is the **first** assertion in each case
so a mis-targeted spy fails loudly instead of letting the case pass on an
unimpeded run.

### 3. The mechanism stays unspoken

The pins read only persisted state after a second run. A `withTransaction` (what
ships), a resumable intermediate state (the arm ADR-0856 rejected) or an
emit-first order all satisfy them; no pin asserts that run 1 left the profile
`deletion_pending` or that run 1 rolled anything back.

### 4. Run 1's report shape is pin 1's, deliberately

Each case asserts `first.errors === 1`, the same stroke ADR-0853's pin 1 uses for
the purge, not `runReporting`'s looser `reported`. The purge's per-account
`catch` is the shipped §10.2 shape, and a change that made the whole job throw
instead would already red pin 1. The consequence is recorded here rather than
hidden: the probe mutations below show the report assertion fires before the
outcome assertions when a step is swallowed.

## Evidence

**Green on arrival** (characterization — the GREEN closed all three windows):
`npx vitest run --project integration …/job-sweep-failure-windows.test.ts` →
`Tests  7 passed (7)` (the three new pins plus ADR-0853's four).

**The pins are load-bearing.** Every probe below replaced
`apps/web/src/server/jobs/account-deletion-purge.ts` (sha256
`2dd50c645b720547724a24700b2ff82add596e085b95e6aa44b068854311139c`) and
restored it with `git checkout --`, re-hashed to the same digest each time;
`git status --short` shows the spec only.

1. **The F3a near-fix** (no transaction; tombstone write first, claim after —
   the shape that passes the tombstone pin) → `Tests  3 failed | 4 passed (7)`,
   i.e. the three new pins red and ADR-0853's four stay green:

```
AssertionError: run 2 must finish the deletion the failed session delete left unfinished
  (run 2 reported scanned: 0, errors: 0): expected { tombstones: 1, receipts: +0, …(1) }
  to match object { tombstones: 1, receipts: 1, …(1) }
AssertionError: run 2 must emit the receipt the failed write lost
  (run 2 reported scanned: 0, errors: 0): expected { tombstones: 1, receipts: +0 }
  to match object { tombstones: 1, receipts: 1 }
AssertionError: run 2 must finish the anonymize the failed write left undone
  (run 2 reported scanned: 0, errors: 0): expected { tombstones: 1, receipts: +0 }
  to match object { tombstones: 1, receipts: 1 }
```

2. **One swallowed step at a time** (the step's failure caught inside the
   transaction, so the transaction commits without it) → each mutation reddens
   **exactly its own** pin: `1 failed | 6 passed (7)` with
   `run 1 reports the account whose session delete failed: expected +0 to be 1`,
   `… whose receipt write failed: expected +0 to be 1`, and
   `… whose anonymize write failed: expected +0 to be 1`. No sibling case moves.

3. **One step moved outside the transaction** (it runs after the commit, and the
   account is not counted so the §10.2 envelope stays valid) → each mutation
   reddens **exactly its own** pin at the **outcome** assertion, which is the
   half the swallow probes mask: `1 failed | 6 passed (7)` with
   `run 2 must finish the deletion the failed session delete left unfinished
(…): expected { tombstones: 1, receipts: 1, …(1) } to match object { … }` (the
   survivor is `sessions`), `run 2 must emit the receipt the failed write lost
(…): expected { tombstones: 1, receipts: +0 } …`, and
   `the account keeps no contact of its own: expected
'user-6afc4220917b3814ea597a5d@example…' to be null`.

Gates: `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` on the spec
`No issues found` (0 errors, 0 warnings); `prettier --check` clean; the six
`adr-*` guards green. No production file touched.

## Consequences

- A GREEN that passes ADR-0853 and leaves any of these three windows open is now
  red, so the "unrecoverable after any post-claim failure" half of the High
  finding is measured for the whole purge and not just for the tombstone.
- The purge's three later steps are pinned by **outcome**, so the next GREEN may
  repurpose ADR-0856's single transaction without editing a pin — provided the
  deletion still finishes and the contact still survives in the tombstone.
- Known limit, recorded and unpinned: the `sessions` assertion counts Better
  Auth rows keyed at either the hex string or the `ObjectId`, matching the
  purge's own `$in` filter; a purge that revoked sessions under another key shape
  would pass pin 1's freeze spec and this pin would not see it.

## Alternatives

- **A new spec file** — rejected: it would duplicate the injection harness and
  the seven-collection reset, and put the purge's four windows in two places.
- **Assert that run 1 left the profile `deletion_pending`** — rejected: that
  prescribes the transaction, the arm ADR-0856 chose but no contract row
  requires.
- **Gate the anonymize injection on the `$unset` document** — rejected as
  mechanism-prescribing; the collection name is the narrowest honest gate.
- **Reuse pin 1's case name and sampling** — rejected: one behavior per case, and
  a failing case's name must name the step.

## Out of scope

- The purge's **cancel-vs-purge exclusivity** (the claim filter inside the
  transaction) — ADR-0856's own coverage-gaps list; a concurrent cancel racing a
  purge is not a post-claim failure window.
- The three sweeps ADR-0856 left write-then-emit and unpinned
  (`event.upload_window.closing/closed`, `event.starting_soon`,
  `collab.invite.expired`).
- Playwright: the purge is a cron job driven directly by the integration harness;
  no user journey is involved.
- `t_535ab5d2`'s PR #629 — closed as superseded when the GREEN merged; nothing
  in this card reopens it.
