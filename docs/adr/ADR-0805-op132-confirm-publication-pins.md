# ADR-0805 — OP-132 TEST: the confirmation publishes once, counts the new matches, and publishes a late worker result

- **Status:** Accepted (RED / executable contract)
- **Consumers:**
  `apps/web/src/test/integration/selfie-confirm-publication.test.ts` — the whole
  file (three cases) and its local harness (`readyEvent`, `prepareSelfie`,
  `submitOne`, `runWorker`, `confirm`, `profileRow`, `matchesNewRows`).
- **Lane:** the shared attendee block `0780`–`0798` (row
  `OP-129 attendee identity lane`) is **exhausted**: the records above it
  ([ADR-0799](ADR-0799-op133-preview-url-selfie-summary-pins.md) through
  [ADR-0804](ADR-0804-op132-reuse-attempt-cap-and-rate-green.md)) drew from the
  `unallocated (future lanes)` pool and advanced both cells to `0805`. At this
  branch cut (`origin/main` `26cc00d`) the sweep is **empty**: `0804` is the
  newest record on the trunk, and no worktree under `.worktrees/` and no open PR
  carries `0805`. This record therefore draws **`0805`** and both cells advance
  to `0806`. No new lane row is minted.
- **Amends:** [ADR-0791](ADR-0791-op132-liveness-selfie-red.md) and
  [ADR-0792](ADR-0792-op132-liveness-selfie-green.md) — the confirmation half of
  the selfie contract, which that lane pinned with exactly one confirm and never
  with a repeat.
- **Consumes:** `0805`.

## Context

Review finding **F3** (Medium) of `t_3b8151c3` / PR #543. The confirmation is the
lane's only publisher (`…/selfies/[selfieId]/confirm/route.ts:92-117`), and three
probes on the branch cut measure what it publishes:

| probe                                                                      | result                                                                                         |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| the same selfie confirmed twice                                            | `200` both times, but **two** `attendee.matches.new` rows — the second is a duplicate arrival  |
| selfie A confirmed (3 matches), then selfie B submitted and confirmed (+2) | B's row carries `count: 5` — the profile's **total**, so A's three are announced a second time |
| confirm, worker writes, confirm again, then a third confirm                | the third confirm inserts a **second** row for a result already published                      |

`emitDomainEvent` already supports an optional `dedupeKey` with a unique partial
index on `domainEvents` (`indexes.ts:585`), and contract §10.3.2 defines the
semantics ("`dedupeKey` is optional; when present, a duplicate is silently
dropped"). The handler passes none, and it has no state guard: every call emits.
`payload.count` is `countDocuments({ profileId })` — a total — and the schema's
`firstMatchNotifiedAt` (§15.3) is never written, so no delivery can be derived as
a delta. And because publication is gated on the worker's `embedding` being
present, a confirm that arrives first activates the row and publishes nothing;
the I9b pin stops there, and only a _second_ confirm ever publishes.

This card (`t_ab2af8f3`) is **pins only**: no production change, and no edit to
an existing case, fixture or helper. The GREEN sibling `t_ed3785df` makes the
pins pass.

## Decision

### 1. A repeat confirm is idempotent in its effect, not only in its status

The second confirm answers the **same** `200` envelope — the seven §6.3 keys,
`status: "ready"`, the same `selfieId`/`profileId`/attempts — and exactly **one**
`attendee.matches.new` row exists for the result, with `count` equal to what the
first confirm announced. The case asserts the envelope with `toEqual` on the
whole body, then the outbox row count, then the surviving row's payload, then
`matchCount`.

That ordering is the point: on the buggy tree the **status arm already passes**
(the repeat is a well-formed `200`) and only the state arm reddens. This is the
idempotent-response / non-idempotent-effect shape the repository's idempotency
rule warns about, so a status-only pin here would have been vacuous.

### 2. The notification counts the **new** matches, `matchCount` stays the total

Selfie A's run finds 3 photos; A's confirm notifies `count: 3`. Selfie B is then
submitted (new challenge, new bytes, a new `selfies` row) and its run finds 2
photos the profile had never seen. B's confirm answers `status: "ready"`, leaves
`attendeeEventProfiles.matchCount` at **5** — §6.4 defines it as the cached total
("the PRD requires a live total count") — and its `attendee.matches.new` row
carries `count: 2`.

The pinned reading of "new" is **the arrival since the last notification**, not
the profile's total and not §6.4's gallery-scoped `newMatchCount`:

- §7.6's catalogue describes `attendee.matches.new` as **"additional matches
  later"** — the arrival of more photos, i.e. a delta;
- the in-app feed is one rolling row whose `groupCount` is `$inc`'d by
  `newMatchCount` (notification design §4), so a total would re-count every
  earlier notification on each arrival;
- §15.3's `firstMatchNotifiedAt` is the schema's "fires exactly once" anchor for
  a match delivery — the only notification watermark the delivery's own row
  carries.

The case also pins the arithmetic that makes the two definitions inseparable:
the two announced counts **add up to** `matchCount` (3 + 2 = 5).

### 3. A worker result that arrives late is published, exactly once

The confirm that arrives before the worker writes is the I9b arm and is **not**
re-pinned here; this case starts from it. After it, the worker writes the
embedding and three `faceMatches` rows for the row that is **already active**,
and `attendee.matches.new` is still empty — publication is the confirmation's
property, not the worker's timing. The next confirm then answers
`status: "ready"` with `matchCount: 3` and emits **one** row with `count: 3`, and
a further confirm answers the same envelope and emits **nothing**.

The case name reads as the recovery path ("publishes the late result on the next
confirm, and still notifies only once") and its comment records the honest fact:
**no client-facing text requires the re-confirm.** §6.4 tells the client to poll
`/me`; the pin takes the card's reading — that the poll-driven confirm is the
recovery — rather than inventing a worker-side publisher. Whether the worker
should publish instead is left to the GREEN as an open question; the pins would
not forbid it as long as one confirmation still yields one row.

### 4. Deliberately not pinned

- **The mechanism.** A `dedupeKey` on the emit, a written `firstMatchNotifiedAt`
  watermark, a `notifiedAt` stamp on `faceMatches`, or a state guard are all
  admissible. The pins assert the client-visible count and the row count, never a
  field name — no paragraph of the contract names the mechanism.
- **`firstMatchNotifiedAt` itself.** Asserting the field would freeze one of the
  four mechanisms above. The near-fix in §Satisfiability does write it, which is
  evidence that the pin is satisfiable, not a requirement.
- **The confirm's own idempotency-key stage.** Not pinned: two confirms here carry
  **different** `Idempotency-Key` values (the helper mints a fresh UUID), so an
  idempotency-key store cannot satisfy case 1 by itself. Whether the route also
  declares the stage is the GREEN's call.
- **`attendee.matches.ready` / the SMS watermark.** §15.3 gives
  `firstMatchNotifiedAt` that duty too; that event is emitted by the pipeline, not
  by this route, and is out of this card's scope.
- **The zero-match arm.** A published selfie with no matches emits nothing on the
  trunk (`matched > 0`) and the new count is 0, so any correct delta reading keeps
  it silent; F5–F7's card (`t_325903f6`) owns that arm.

## Evidence — the measured red list

On `origin/main` `26cc00d` (branch `OP-132-task-confirm-publication-pins`), all
three cases fail for the stated reason, twice consecutively
(`Test Files 1 failed (1)`, `Tests 3 failed (3)`):

| case                                                   | failure                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 1 — a confirmed selfie confirmed a second time         | `AssertionError: expected [ { …(9) }, { …(9) } ] to have a length of 1 but got 2` (`:349`)            |
| 2 — a second selfie finds more photos than the first   | `AssertionError: expected { …(2) } to match object { …(2) }` — `"count": 5` for `"count": 2` (`:393`) |
| 3 — the worker's result arrives after the confirmation | `AssertionError: expected [ { …(9) }, { …(9) } ] to have a length of 1 but got 2` (`:444`)            |

`tsc -p apps/web/tsconfig.json --noEmit` exits `0` and `eslint
--max-warnings=0` is clean on this head, so no case is red for a type or load
reason. The five frozen neighbour files that drive the confirm route
(`liveness-selfie-submit`, `selfie-reuse`, `selfie-reuse-attempt-cap`,
`attendee-participation-status`, `selfie-upload-collision`) are **50 passed (50)**
on the same head — the new pins do not contradict a single shipped case.

## Satisfiability — the near-fix probe

One throwaway edit to `…/confirm/route.ts`, reverted byte-identically afterwards
(`sha256 04104d5f…b31f3b33ef` before and after, empty `git diff`):

1. project `firstMatchNotifiedAt` with the profile and treat it as the watermark;
2. count `newMatches = countDocuments({ profileId, createdAt: { $gt: watermark ??
epoch } })` when the embedding is present;
3. emit only when `newMatches > 0`, with `payload.count: newMatches` and a
   `dedupeKey` of `attendee.matches.new:<event>:<profile>:<instant>`;
4. stamp `firstMatchNotifiedAt: now` on the profile in the same transaction.

| probe run                                                | result              |
| -------------------------------------------------------- | ------------------- |
| this file, with the edit                                 | 3 passed (3)        |
| the five frozen neighbour files, with the edit           | 50 passed (50)      |
| this file, after the route was restored byte-identically | 3 failed (3), twice |

So every pin is satisfiable by a minimal repair, none passes vacuously, and none
of them forces a refactor of a frozen case.

## Consequences

- **The GREEN has three sentences to satisfy**: a repeat confirm publishes nothing
  new; the delta — matches that arrived since the last notification — is what the
  event counts, while `matchCount` keeps the total; and a result that lands after
  the activation is still published by the next confirm, once.
- **A dedupe-only fix is not enough.** A `dedupeKey` alone can suppress the
  duplicate arrival, but case 2 still fails: the surviving row's `count` is the
  total. Conversely a delta-only fix satisfies cases 2 and 3 and fails case 1
  (the second confirm re-emits the delta 0 times only because it is 0 — it does
  not stop a re-emit of a non-zero delta). Both halves are needed, and the two
  cases separate them.
- **Timestamp boundary, recorded because the probe met it**: a delta anchored on
  `createdAt > watermark` is exact only while the watermark is strictly later
  than every counted row. The probe used the confirm's `now` and passed three
  runs, but two rows written in the same millisecond as the watermark would be
  skipped; the GREEN should prefer an anchor that cannot tie (a monotonic
  stamp, or the newest row's `createdAt`).
- **Budget arithmetic invisible in the test bodies**: `selfie.submit` allows six
  calls an hour per attendee session, and every presign and submit shares that
  bucket. Case 2 needs two submits, so the bytes are put through the storage port
  instead of the presign route (the uploads suite pins that envelope). An editor
  who replaces `prepareSelfie` with `uploadSelfie` pushes the case to four calls
  and the suite-wide runs closer to the bound.
- `docs/adr/README.md` stays the shared-ledger hotspot: both `Next free` cells
  move `0805` → `0806`, and the row plus the note merge as a union keeping the
  highest value.
- No number outside `0805` is consumed, and no lane row is created.

## Alternatives

1. **Pin `firstMatchNotifiedAt` by name.** Rejected: the contract names no
   mechanism, and pinning the field would forbid a `dedupeKey`-plus-state-guard
   fix that answers the same three sentences. Behaviour, not storage.
2. **Use §6.4's literal `newMatchCount` (`createdAt > lastSeenGalleryAt`) as the
   event's count.** Rejected after measuring the scenario: with the gallery never
   seen, B's row would carry `5` — the total — which is exactly the bug. The
   gallery-scoped definition exists to drive the "New" badge for a _viewer_, and
   it would make a notification depend on whether the attendee had opened the
   gallery.
3. **Expect a `409`/`204` on the repeat.** Rejected: the card says the second
   answers the same `200` envelope, and a poll-driven client that re-issues the
   confirm should get its result, not a refusal.
4. **Re-send the same `Idempotency-Key` on both confirms.** Rejected: the
   idempotency-key store would then satisfy the case without any state guard,
   which is the bug surviving behind a different door. Two requests is the honest
   repeat.
5. **Write cases 2 and 3 as `it.todo` with an open question.** Rejected: both have
   a defensible reading (§7.6 "additional matches later" for the count; the card's
   own recovery wording for the late result), so a skipped case would have hidden
   two genuinely red behaviours.
6. **Assert `faceMatches.seenAt` or the gallery's `isNew` flags instead.** Rejected:
   those answer "has the attendee looked", not "what was announced".

## Open questions (for the GREEN `t_ed3785df`)

1. **Which watermark, and where is it written?** `firstMatchNotifiedAt` (§15.3) is
   the schema's field for exactly-once delivery and is currently never written;
   a `faceMatches.notifiedAt` stamp or a `dedupeKey` per arrival are also
   admissible. Whatever the choice, it must be written **inside** the confirm's
   transaction, or a crash between the emit and the stamp re-announces.
2. **Should the worker publish instead of the next confirm?** The pins take the
   card's reading (the next confirm publishes) and would tolerate a worker-side
   publisher as long as one confirm still yields one row. No client-facing text
   requires the re-confirm, so if §6.4 is meant to carry the result without one,
   the contract owes that sentence — the DOCS card `t_a1fbb7a7` owns §6.3/§6.4.
3. **Does the confirm also want an idempotency stage?** Not required by these
   pins (different keys are used), but a client-retry path would benefit and it
   costs one `defineRoute` option.
4. **What is the anchor's tie-breaker?** See §Consequences — a `$gt` on the
   confirm's `now` can skip a match written in the same millisecond.
