# ADR-0828 — OP-132 TEST: a re-submitted selfie after a completed purge resets the asset's lifecycle fields

- **Status:** Accepted (two appended pins; the first is RED by design, the second is green on arrival; no production change)
- **Consumers:** `apps/web/src/test/integration/liveness-selfie-submit.test.ts` — the two appended
  cases ("when the same selfie bytes are submitted after a completed purge" › _resets the asset's
  lifecycle fields, so a live reference is not recorded as purged_, and "when a withdrawal's purge is
  still in flight" › _refuses a re-submit of the same bytes with 409 selfie_purged and spends no
  attempt_) plus the file-local `meHandler` / `polledBudget` reader. The GREEN `t_1805f512` is the
  only reader of the contract this record pins.
- **Lane:** the shared attendee block `0780`–`0798` (row `OP-129 attendee identity lane`) is
  exhausted, so this record draws from the `unallocated (future lanes)` pool. Both `Next free` cells
  read `0828` at this cut (`origin/main` `c023a0e` carry `4c31808`; the lane's worktree is at the
  `t_660a783e` tail, squash `cc8356e`), `git rev-list --objects --all -- docs/adr` returns `0827`
  (`ADR-0827-op132-purge-candidate-consumer-pin.md`) as the highest number on any object, no
  `.worktrees/*/docs/adr` carries `0828`, and the open PR heads stop at `0825`. So this record draws
  **`0828`** and both cells advance to `0829`. No lane row is minted and no range is re-cut.
- **Amends:** [ADR-0798](ADR-0798-op132-purge-before-delete-claim.md) §2 (the `409 selfie_purged`
  deflection is scoped to `status: "purged"` **and** `purgedAt: null`; this record pins that arm and
  the lifecycle reset a reuse needs on the other side of it) and
  [ADR-0796](ADR-0796-op132-selfie-asset-owner-expiry-purge.md) §3 (the `mediaAssets` row survives the
  purge on purpose — this record pins what that surviving row must say once the bytes are back).
  Neither decision text is edited: ADR-0798's `Consumers:` list gains this spec (the citation guard's
  requirement, and the ADR-0796 precedent), and nothing else in either record moves.
- **Consumes:** `0828`.

## Context

The F-A2 GREEN (`t_0f7341d7`, PR #550, squash `4c31808`) added the purge-before-delete claim of
[ADR-0798](ADR-0798-op132-purge-before-delete-claim.md). The review of that merge measured, in a
throwaway worktree at the squash, that a re-submit of the same bytes **after a completed purge**
leaves the `mediaAssets` row claiming a purge although it holds a live reference:

```
{"firstWithdrawal":204,"afterPurge":{"refCount":0,"status":"purged","purgedAt":"Date"},
 "purgedReadable":false,"regrant":201,"resubmitStatus":202,
 "afterReuse":{"refCount":1,"status":"purged","purgedAt":"Date"},"readableAfterReuse":true,
 "secondWithdrawal":204,"afterSecondWithdrawal":{"refCount":0,"status":"purged","purgedAt":"Date"},
 "readableAfterSecondWithdrawal":false}
```

The cause is one upsert. `insertQueuedSelfie`
(`apps/web/src/server/attendee/selfie-submit.ts`) writes `status: "stored"` **only** inside
`$setOnInsert` of the `mediaAssets` `findOneAndUpdate`, and a re-submitted content hash can never be
an insert: the `(tenantId, kind, contentHash)` row already exists, so the `$inc: { refCount: 1 }`
applies to the purged row and the lifecycle fields are never touched again. The bytes themselves are
re-uploaded to the same content-addressed key (`originals/selfies/<sha256>`), so the row and the store
disagree: `refCount: 1` and readable bytes on one side, `status: "purged"` plus a stale `purgedAt` on
the other.

That disagreement is the defect class, not a cosmetic label. Every consumer of the marker reads a
**live biometric object as purged**: the withdrawal retry is the record's purge consumer
(ADR-0798 §1), the `409 selfie_purged` deflection reads the claim (ADR-0798 §2), and an operator query
or a future sweep keyed on `status: "purged"` would either skip a live object or, worse, treat it as
already erased. `refCount: 0` is the invariant the whole purge path rests on (ADR-0796 §3, ADR-0826
G2), and a row claiming `purged` while it holds a reference breaks it in the one direction no
`refCount` guard can see.

## Decision

### 1. A reuse after a completed purge is pinned end to end, with the pre-state asserted

The first case drives the whole lifecycle rather than hand-writing the row: a confirmed selfie, a
`204` withdrawal, then — after the purge is **proved** complete (`refCount: 0`, `status: "purged"`,
`purgedAt` a `Date`, and `selfieBytesReadable(hash) === false`) — a second `grantConsent` (`201`), a
re-upload of the **same** bytes to the same key, and a `202` submit. Only then does it assert the row:
exactly one `mediaAssets` row for the hash, `refCount: 1`, `status: "stored"`, and `purgedAt` null (or
absent — the assertion is `purgedAt ?? null`, so a fix that unsets the field passes), plus
`selfieBytesReadable(hash) === true`.

The pre-state matters: without it the case could pass on a withdrawal that never purged anything (the
bytes still readable, the row still `stored`), i.e. on a state that does not exercise the defect. The
`refCount: 1` + `countDocuments === 1` pair is what makes the reset a reset of **that** row rather than
a second row inserted beside it, which the unique index forbids anyway.

### 2. The `409 selfie_purged` deflection is pinned as the in-flight arm, and it must cost nothing

The second case pins the other side of the same window, which the reset must not widen: a withdrawal
whose `deleteObject` rejected once leaves the row claimed (`refCount: 0`, `status: "purged"`,
`purgedAt: null`, bytes still stored), and a submit of the same bytes must answer `409` with
`error.code === "conflict"` and `details.reason === "selfie_purged"` — ADR-0798 §2's scope, verbatim.
A fix that reset the lifecycle fields on **every** matched row (dropping the `purgedAt: null` half of
the guard, for instance) would hand a reference to bytes the purge is about to delete, so this arm is
a constraint on the GREEN, not a restatement.

"Spends no attempt" is asserted where the attendee can see it. Schema §15.3 has no attempt counter, so
the budget is the profile's stored `selfies` count (the file's own documented assumption, and
`selfieAttemptNumbers`' implementation), and a refusal that writes no row spends nothing. The case
reads it through the §6.3 poll surface — `GET …/me`, the very `pollUrl` the `202` advertises — before
and after the refusal, and requires `attemptsUsed` / `attemptsRemaining` to be unmoved. It also
requires the refusal to take no reference (`refCount` still `0`) and to complete no purge (bytes still
readable), so the arm is measured on three observables instead of a status code alone.

### 3. Measured, not argued

Baseline on the shipped tree, before the pins: `24 passed (24)`. After appending them:
**`1 failed | 25 passed (26)`** — the reuse case reddens for exactly the reason the card names, and the
in-flight case is **green on arrival**:

```
AssertionError: the asset row still claims a purge although it holds a live reference and its bytes
are readable: {"_id":"…","kind":"selfie","contentHash":"65941312…","tenantId":"…",
"createdAt":"2026-11-13T22:47:14.647Z","refCount":1,"status":"purged",
"purgedAt":"2026-11-13T22:47:14.699Z"}: expected 'purged' to be 'stored'
```

Two throwaway probes, each on a production file restored byte-identically afterwards
(`sha256 7f9b7274…` before and after, `git status` clean apart from the spec):

| probe                                                                          | result                       | red text (abridged)                                                                                                                                              |
| ------------------------------------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 — the GREEN's own minimal fix: `status`/`purgedAt` moved to `$set` on reuse | `26 passed (26)`             | — (the pin this record is RED for goes green; the four attendee specs are `57 passed (57)`)                                                                      |
| M2 — the in-flight guard defused (`claimed !== null` → always false)           | `3 failed \| 23 passed (26)` | _expected the in-flight purge to deflect the re-submit (the failed withdrawal answered 500): expected 202 to be 409_ — the second case reddens alone for its arm |

M1 is the satisfiability proof the card's RED needs: the single change the GREEN card describes
(`status` out of `$setOnInsert`, `purgedAt: null` alongside it) turns the file green without touching
any other case, so the pin is passable by the fix and by nothing narrower. It also keeps the four
attendee specs green (`liveness-selfie-submit` 26, `biometric-consent`, `selfie-reuse`,
`selfie-submit-user` — `57 passed (57)`), which is the evidence the reset does not disturb the
existing reference accounting. M2 shows the second case is load-bearing even though it is green on
arrival: with the guard defused the refused submit answers `202` and would hand out a reference to
bytes the purge is about to delete.

## Consequences

- A `mediaAssets` row may no longer claim `status: "purged"` while `refCount > 0`. The two halves of
  the row's lifecycle — the reference count and the purge marker — must move together, and the only
  place that can move them together is the submit's own upsert.
- The GREEN `t_1805f512` carries both pins unchanged. Its described change (move `status` into `$set`,
  add `purgedAt: null`) is the one measured by M1; a different shape that still satisfies both cases
  is acceptable, because both cases assert observables (row fields, bytes, status codes) and never the
  update document.
- The in-flight arm couples the reset to ADR-0798 §2: widening the `409` guard to a stored row
  reddens the second case, and narrowing it (dropping the reset) reddens the first.
- The pins read the budget through `GET …/me`, so they also hold that surface's own contract: a
  refusal must not move `attemptsUsed`/`attemptsRemaining`. If §15.3 ever gains an attempt counter,
  both the helper and this record must move together.
- `docs/adr/README.md` stays the shared-ledger hotspot: this row, this note and the two cells merge as
  a union keeping the higher cell (`0829`).

## Alternatives

1. **Assert the update document instead of the row.** Rejected: `$set` vs `$setOnInsert` is an
   implementation detail; a fix built on `findOneAndUpdate` with a pipeline, or on an explicit
   `updateOne` before the upsert, is equally correct and must not redden the pin.
2. **Seed a `status: "purged"` row directly and submit against it.** Rejected: the fixture would then
   be the record's claim shape rather than the path's, and a change to the claim (a different marker
   field, a separate candidate collection) would let the pin pass on a state the real flow no longer
   produces. Driving the withdrawal keeps the fixture the implementation's own.
3. **Assert the budget from the `selfies` row count instead of `GET …/me`.** Rejected as the primary
   observable: the card asks for the attempt budget, and the attendee's own surface answers it.
   Counting rows would pin the mechanism (`budget = stored count`) rather than the fact, and the count
   is already implied: the refusal writes no row, which the `refCount` assertion covers.
4. **Pin only the reuse arm.** Rejected: the reset a reuse needs is one line away from a fix that also
   widens the in-flight guard, and that regression would let a submit take a reference to bytes the
   purge has already committed to deleting — the ADR-0798 §2 hazard, measured by M2.

## Not pinned here

- **The sweep that would act on a `refCount: 0` row.** No sweep exists (ADR-0798 §1: the withdrawal
  retry is the consumer); the round-2 F2 pin (ADR-0827) covers the consumption, and an endpoint that
  does not exist cannot be pinned.
- **Operator queries keyed on `status: "purged"`.** The defect is the row's contradiction, which this
  record pins; a reporting surface does not exist in this repo to pin beside it.
- **The `X-Deleted-Counts` numbers of either withdrawal.** ADR-0797 §1 pins that header as a format on
  purpose; the second withdrawal here asserts only its `204` and the row's end state.
- **A second asset kind for the same bytes.** `kind` is part of the unique index (ADR-0801) and the
  organizer's row is a different asset; this record's two cases are selfie-only by scope.
