# ADR-0826 — OP-132 TEST: the selfie retention window is bounded, and the blob is purged only at zero references

- **Status:** Accepted (two characterization pins; no production change)
- **Consumers:** `apps/web/src/test/integration/liveness-selfie-submit.test.ts`
  — the two appended cases ("when a selfie is queued on an event with no
  retention cap" › _carries the record's retention window, so a window measured
  in minutes is refused_, and "when two attendees hold one selfie's bytes and
  the first withdraws" › _keeps the object readable until the last reference is
  released_) and their one new local reader `profileById`.
- **Lane:** the shared attendee block `0780`–`0798` (row
  `OP-129 attendee identity lane`) is exhausted, so this record draws from the
  `unallocated (future lanes)` pool. Both `Next free` cells read `0825` at the
  cut (`origin/main` `c62000f`), the trunk's newest record is `0824`
  (`ADR-0824-op132-first-match-notified-pin.md`), and `0825` is held in flight by
  `ADR-0825-op134-green-review-signoff.md`; `git rev-list --objects --all -- docs/adr`
  returns `0825` as the highest number anywhere. Nothing carries `0826`, so this
  record draws **`0826`** and both cells advance to `0827`. No lane row is
  minted.
- **Amends:** [ADR-0791](ADR-0791-op132-liveness-selfie-red.md) §6 (the F1 pin
  set — this record adds two cases to the same spec, so that record's "19 cases"
  is a snapshot of its own head, not a count of the file) and
  [ADR-0792](ADR-0792-op132-liveness-selfie-green.md) §"Findings, as routed at
  review time" (the two Low gaps routed to card `t_26ab6dd7`). Neither record is
  edited.
- **Consumes:** `0826`.

## Context

The round-1 review of the F1 pins (`t_dd9cbd7c`, PR #544) measured two gaps in a
throwaway probe worktree at `7d0d215`, and both were routed to card `t_26ab6dd7`
rather than fixed in place:

- **G1 — the retention pin fixed a direction, not a window.** The shipped F1 case
  asserts only that `expireAt` is after `createdAt` and after the wall clock, so
  replacing the row's deadline with a span of the wrong unit stayed green
  (`19 passed (19)` at that head). A window of `90 * 24 * 60 * 1000` ms is
  **36 hours**, not the "90 minutes" the review's wording calls it, and the
  mislabel does not change the finding: any span shorter than the record's
  window passed.
- **G2 — the erasure pin could not see an over-broad delete.** No case in
  `liveness-selfie-submit.test.ts` or `biometric-consent.test.ts` holds two
  references to one `mediaAssets` row, so a withdrawal that dropped the
  reference guard and purged every referenced row's object stayed green
  (`41 passed (41)` at that head).

Both gaps are about the **schema §16.1** rule OP-131's own route comment states —
_"the blob is purged once nothing references it"_ — and §22's rule that a selfie
is kept for its own retention window or the event's, whichever comes first.

## Decision

1. **Two appended cases in the existing spec, not a new file.** Both need the
   same fixture chain the F1 block already uses (`readyEvent`,
   `submitHappyPath`, `createAttendeeSession`, `grantConsent`,
   `finishSelfieWorker`, `confirmSelfie`, `withdrawConsent`, `makeSelfieBytes`)
   and the same readers (`selfieById`, `assetByHash`, `selfieBytesReadable`). A
   second file would duplicate that chain and the file's `beforeEach`, and the
   `adr-consumers` invariant would then need a record naming it. The only new
   machinery is one local reader, `profileById`, because the file's `profileRow`
   asserts that exactly **one** profile exists and G2 deliberately creates two.
2. **G1 derives the window from the record, not from a literal.** The expected
   value is `SELFIE_RETENTION_DAYS * MS_PER_DAY` — the constant the implementation
   publishes and schema §22 names — asserted with a ±1 s tolerance, so a
   legitimate change to the record's window keeps the pin true instead of turning
   it red for being right. A `366 d` ceiling bounds the window even if the
   constant itself is edited, and no `retention.*` setting exists for selfies, so
   there is nothing to read through `getPlatformSettings()`.
3. **G1 clears the event's own deadline first.** §22 makes the selfie's deadline
   the _earlier_ of its own window and the event's `retentionExpiresAt`, and the
   shared fixture seeds an event deadline (`2027-02-14T18:00:00.000Z`). Measuring
   against that would pin the fixture's date, and the case would silently change
   meaning once the wall clock passed it, so the case sets the seeded event's
   `retentionExpiresAt` to `null` and measures the selfie's own window alone.
4. **G2 uses two references to one asset.** Two attendee sessions on the same
   seeded event submit **the same bytes** (one `tag` → one `contentHash` → one
   `(tenantId, contentHash)` row at `refCount: 2`), both are confirmed through the
   ordinary worker/confirm path, and the pre-state (`refCount: 2` **and** a
   readable object) is asserted before the first withdrawal — so the case cannot
   pass by measuring bytes that were never uploaded or a row that never reached
   two references. The first withdrawal must answer `204`, leave `refCount: 1`
   and the object readable; the second must make `getObject` reject `not_found`.
5. **The pins are characterization, so the PR is a normal green test PR.** Both
   cases pass on the shipped tree (the shipped route already claims an asset row
   only when `refCount <= count`), so no GREEN sibling is created and the PR is
   not a draft.

## Evidence — all measured on this branch

- **Base.** `origin/main` `c62000f`; F1's fix is on it
  (`git ls-tree -r --name-only origin/main -- apps/web/src/server/attendee/selfie-submit.ts`
  lists the file and `git show origin/main:…/selfie-submit.ts | grep -n expireAt`
  prints `48`, `322`, the second inside `insertQueuedSelfie`), so the card's base
  rule is satisfied and nothing was cut from a side branch.
- **The file, before and after.** 21 cases at the cut → **23 passed (23)** with
  the two appended cases; no existing case, helper or fixture edited (the diff is
  additive apart from the two import lines).
- **The gaps are real at _this_ head, re-measured.** With the two appended
  describes cut out of the spec and the production file mutated:
  - `expireAt: new Date(options.now.getTime() + 90 * 24 * 60 * 1000)` →
    **`21 passed (21)`**. The frozen cases cannot see a 36-hour retention window.
  - the withdrawal's claim filter reduced to `{ _id: id }` (so every referenced
    row is claimed and its object deleted) →
    **`43 passed (43)`** across `liveness-selfie-submit.test.ts` (21) and
    `biometric-consent.test.ts` (22). The frozen cases cannot see the over-broad
    delete. The card's `19 passed (19)` / `41 passed (41)` are its
    `7d0d215` figures; the counts above are this head's.
- **The pins bite.** Three mutation probes, each on a throwaway edit that was
  restored byte-identically (`sha256` equal before and after, `git status` clean
  apart from the spec):
  - `expireAt` → `now + 90 * 24 * 60 * 1000`:
    `AssertionError: the queued selfie's retention window is 129600000 ms (1.5
days); the record names 90 days (7776000000 ms): expected 129600000 to be
greater than or equal to 7775999000`.
  - claim filter → `{ _id: id }`: `Tests 1 failed | 22 skipped (23)` with
    `AssertionError: expected +0 to be 1` on the `refCount` assertion, i.e. the
    first withdrawal had already claimed the asset another profile still held.
  - a withdrawal that keeps the count honest but deletes the blob anyway:
    `AssertionError: expected false to be true` on the readability assertion, so
    the object half of the pin bites independently of the count half.
- **The four focused suites:** `4 passed (4)` files, **`54 passed (54)`**
  (`liveness-selfie-submit`, `biometric-consent`, `selfie-reuse`,
  `selfie-submit-user`).
- **Gates:** `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` on the
  spec reports no issues; `prettier --check` clean on the spec, this record and
  the ledger; the five ADR guards green (recorded in the PR evidence).

## Consequences

- **The retention pin now fails a unit error and passes every legitimate
  window.** A 36-hour (or 90-minute) deadline fails with a message that names
  both spans; the shipped 90-day window passes; a future change to
  `SELFIE_RETENTION_DAYS` keeps the pin true as long as the row and the constant
  agree, and the `366 d` ceiling makes an absurd constant fail.
- **The erasure pin now distinguishes release from purge.** An asset another
  profile still references cannot be erased by one profile's withdrawal, and the
  last reference is still what purges the blob.
- **Known limit — G1 pins the uncapped window only.** The interaction "event
  `retentionExpiresAt` shortens the selfie window" is _not_ pinned here: the F1
  case covers only that the row carries a future deadline, and pinning the cap
  would require a fixture whose event deadline is inside the 90 days, which is a
  second decision the card did not ask for. A regression that reads the event
  deadline first and its own window second would pass both cases.
- **Known limit — G2 does not cover the queued arm.** Both selfies are confirmed
  before either withdrawal, because that is what the card pins. A withdrawal that
  miscounts references for a **queued** selfie is not measured here.
- **No production change is owed.** The record documents pin upgrades only; it
  states no new contract.

## Alternatives

- **Write `90 * MS_PER_DAY` into the assertion.** Rejected: a legitimate change
  to the record's window would break the pin for being right, which is exactly
  what the card forbids.
- **Pin only "the window is not tiny" (e.g. `> 1 day`).** Rejected: it is the
  same unit-blind shape one step wider — a 2-day window would pass.
- **Add the window assertion to the existing F1 case.** Rejected: the card
  forbids editing existing cases, and the F1 case's own comment describes a
  narrower contract.
- **Seed `refCount: 2` directly in `mediaAssets` and skip the second submit.**
  Rejected: a hand-written row proves the withdrawal's arithmetic but not that
  the submit path really takes a second reference to one row; the second submit
  costs two helper calls.
- **Assert `X-Deleted-Counts` on the first withdrawal.** Rejected for scope: the
  counts are the F1 case's contract, and pinning them here would redden a
  legitimate change to the count format on a card that is about bytes.

## Out of scope

- Any production file: the shipped submit, consent route, storage port and
  settings are unchanged by this card.
- The event-deadline cap arm and the queued-selfie reference arm named under
  §Consequences.
