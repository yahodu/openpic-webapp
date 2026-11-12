# ADR-0764 — OP-127 follow-up TEST: the malformed `uploadedBy` refusal, the shared-asset delete and the route-level filter wiring

- **Status:** Accepted (characterization pins — green on arrival against the OP-127 GREEN `t_fd02050b`)
- **Date:** 2026-11-12
- **Ticket:** OP-127 — _event images management_, phase 4 (Uploads & Media), epic Media
- **Card:** `t_12cd55aa` (follow-up TEST), branch `OP-127-task-review-pins`,
  worktree `/root/openpic/openpic-webapp/.worktrees/t_93217b87`
- **Base:** the OP-127 GREEN head `8588010` on
  `OP-127-task-event-images-management-green` (see A4 — `origin/main` carries none of
  this lane, so the pins would die on import there)
- **Consumes:** contract §4.4, §0.8; ADR-0762 F7/D1/D3/D5; ADR-0763 D4/D7
- **Supersedes:** nothing

## Context

The OP-127 RED review (round 1, artifact lens) approved the 38 pins with three coverage
gaps the delivered cases cannot see, and this card pins them:

1. `buildEventImageListFilter` casts `uploadedBy` with `new ObjectId(...)`. A value like
   `not-a-hex-id` throws a driver error inside the handler, so the route answers `500` for
   client-controlled input. ADR-0762 **F7** fixed the contract (`422 validation_failed`
   before the cast) and nothing pinned it.
2. I3 seeds `media_assets.refCount = 1` and asserts `0`. An implementation that writes
   `refCount: 0` unconditionally, or purges the asset, is invisible today — and it would
   delete content another event still references (`{eventId, assetId}` is unique, not
   `assetId`).
3. U1 pins the filter builder in isolation and I7's only route-level filter assertion uses
   an event with **one** image, so `?visibility=hidden` and an unfiltered page return the
   same single item: a route that ignores the query string passes every delivered case.

All three behaviours shipped in the OP-127 GREEN (`8588010`), so these are
**characterization pins**: they are expected to pass on the first run, and a red one is a
finding about the GREEN rather than a licence to weaken the pin.

## Decision

Six cases in three new `describe` blocks appended to
`apps/web/src/test/integration/event-images-management.test.ts`, reusing that file's
harness (`seedWorkspace`, `seedEvent`, `seedAsset`/`seedImage`, `seedRoomyPlan`,
`seedStorageMeter`, `seedFilterFixture`'s siblings). The change is purely additive: the
file gains 6 cases (20 → 26) and `git diff` carries **0 deletions**, so no existing case
is edited or weakened.

### R1 — `?uploadedBy=` is validated before the id cast (F7)

- `?uploadedBy=not-a-hex-id` with the organizer's session → **`422`**,
  `error.code === "validation_failed"` — never the driver error's `500`.
- A well-formed 24-hex `uploadedBy` → **`200`** listing **only** that uploader's image, so
  the guard narrows the page instead of refusing every value ("reject everything" is not a
  fix).

### R2 — one reference of a shared asset (`refCount` 2 → 1 → 0)

Two `event_images` rows in **two different events of one tenant** point at one
`media_assets` row seeded with `refCount: 2`; the plan and `usageCounters` row are seeded
exactly as I3 does, so the `storage.bytes` release is not vacuous.

- First `DELETE` → `204`, asset `refCount === 1`; the asset row still exists with its
  `storage` and `derivatives` sub-documents **deep-equal** to the pre-delete capture, and
  unchanged `status`; the other event's grid still lists its image; the tenant's meter
  moved by exactly one image's bytes.
- Second `DELETE` → `204`, `refCount === 0`, the asset row **still exists** (the purge is a
  job — ADR-0762 D5) with `storage`/`derivatives` still intact, and the meter reaches `0`.

### R3 — the query string actually narrows the page (route-level wiring)

Fixture: one visible `done`, one visible `failed`, one **hidden `queued`** image.

- `?visibility=hidden` → exactly the hidden image, while the unbounded page lists all
  three (the unbounded half is the discriminator I7 lacked).
- `?status=failed` → exactly the failed image.
- `?status=queued&visibility=hidden` → exactly the hidden image **and**
  `?status=done&visibility=hidden` → `[]`: the clauses are `$and`-composed, not
  last-one-wins, and the positive control keeps "return `[]` for two filters" from passing.

## Assumptions

- **A1 — the hidden image in R3 is `queued`.** The card fixes the two _visible_ statuses
  (`done`, `failed`) but leaves the hidden one open; it must not be `done`, or the
  composed `?status=done&visibility=hidden` case could not be `[]`. Recorded here because
  a reader could otherwise assume the hidden original keeps the default `done`.
- **A2 — R1's second uploader is a bare `ObjectId`.** `uploadedBy` filters a stored id, so
  no second session is needed; seeding one would only add auth cost.
- **A3 — R2 also asserts the meter at both steps.** The card asked to _seed_ the
  `usageCounters` row; asserting `ORIGINAL_BYTES` after the first delete and `0` after the
  second is what proves the seeding was not decorative.
- **A4 — the branch is based on the lane's GREEN head, not `origin/main`.** The card says
  "branch off the current `origin/main`", but at this head
  `git ls-tree -r origin/main --name-only | grep -E 'server/images/(filters|dto)\.ts'` is
  empty and `origin/main` carries none of the OP-127 specs: a pins branch off `main` would
  fail on import (`Cannot find package '@/app/api/…/images/route'`) and could not satisfy
  this card's acceptance ("both pins exist and pass against the implemented behaviour").
  The lane is unmerged (PRs #435/#436 open, both stacked, same as #433/#428), so the pins
  PR is stacked on `OP-127-task-event-images-management-green` and folds into that lane.

## Out of scope

- `POST …/images/originals:archive` (ADR-0762 F4, OP-133) and the delete-then-reupload
  resurrection question (ADR-0762 F5) — untouched here.
- `uploadedBy=` shapes beyond "malformed" and "24-hex": an empty value, uppercase hex and
  a 12-byte hex string are not pinned, because §4.4 does not state a preference and pinning
  one would invent a contract.
- `refCount` underflow (a delete racing another delete of the same reference) and the purge
  job itself: the job owns the purge, and the pins only assert the row outlives `refCount 0`.
- The event counters' `processedImageCount`/`failedImageCount` after a delete remain the
  nightly reconcile's (ADR-0762 A4); R2 seeds them so the summary stays coherent but does
  not assert them.

## Number allocation

`0764` is the value the OP-127 GREEN left in the **OP-126 uploads lane** row
(`0760`–`0779`); this card uses it and advances the cell to `0765`. No number outside that
range is touched.

## Evidence

- Each pin is proven load-bearing by a mutation probe on the production file it guards.
  Every mutation was reverted byte-identically (`sha256` equality printed per probe,
  `git status --short` leaves only the spec modified):

  | pin    | mutation                                                                   | observed failure                                                         |
  | ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
  | R1     | `filters.ts`: the 24-hex guard before the cast disabled                    | `AssertionError: expected 500 to be 422`                                 |
  | R2     | `[imageId]/route.ts`: `$inc {refCount: -1}` → `$set {refCount: 0}`         | `AssertionError: expected +0 to be 1`                                    |
  | R3 (a) | `images/route.ts`: `?visibility` no longer spread into the builder         | `AssertionError: expected [ '6af5…', …(2) ] to deeply equal [ '6af5…' ]` |
  | R3 (b) | `filters.ts`: the two clause blocks chained into `else if` (last-one-wins) | `AssertionError: expected [ { …(15) } ] to deeply equal []`              |

- Focused suite `vitest run --project integration …/event-images-management.test.ts` →
  **26/26 passed** (the 20 pre-existing OP-127 cases plus these 6).
- Full `vitest run --project integration` at this head → **103 files / 1007 passed** (the
  lane's 1001 at `8588010` plus these 6; no regression in the other 102 files).
- `tsc -p apps/web/tsconfig.json --noEmit` → exit 0.
- `eslint` on the spec → 0 errors (the single `security/detect-object-injection` warning is
  the pre-existing `requireHandler` namespace read at line 212).
- `prettier --check` clean on the spec, this ADR and the ledger; the ADR-numbering guard
  stays green.

## Round-1 review (artifact lens)

**Verdict: APPROVED WITH FINDINGS.** This is the review of card `t_12cd55aa` and PR #437. It
read the branch head `4264b0a` cold from the diff, before the handoff narrative, so every count
below is the reviewer's own measurement rather than a transcription. The spec change is
additive: `git diff --numstat 8588010 4264b0a` over
`apps/web/src/test/integration/event-images-management.test.ts` answers `312` / `0` — 6 new
cases in 3 new `describe` blocks (R1, R2, R3) — and no delivered case is edited or weakened.

**No section of this record is retracted.** §Context, §Decision (R1/R2/R3), §Assumptions
(A1–A4), §Out of scope, §Number allocation and §Evidence all stand as written. This sign-off
consumes **no** ADR number and leaves `docs/adr/README.md` byte-identical, so the lane's
`Next free` cell stays where the follow-up pins left it.

### The reviewed bytes are what shipped

`git diff --stat 4264b0a 9c431f7` is **empty**, so every line cited here is a line on the lane
trunk. `gh pr view 437` answers `MERGED` with `mergeCommit` `9c431f7`
(2026-11-12T02:40:34Z), and `9c431f7` is the tip of
`OP-127-task-event-images-management-green`: for downstream readers the GREEN branch tip is
**no longer `8588010`**, it is this squash.

### Gates — measured at `9c431f7`, not transcribed

| Gate                | Measurement                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| Focused integration | `vitest run --project integration …/event-images-management.test.ts` → **26 passed (26)**         |
| Full integration    | `vitest run --project integration` → **103 files / 1007 passed**, exit 0                          |
| ADR guard           | `vitest run --project unit …/adr-numbering.test.ts` → **29 passed (29)**, no duplicate `ADR-NNNN` |
| Types               | `tsc -p apps/web/tsconfig.json --noEmit` → exit **0**                                             |
| Formatting          | `prettier --check` clean on the spec, this ADR and the ledger                                     |

### Load-bearing — re-probed in a detached probe worktree at the same SHA

Each mutation below was applied in a throwaway worktree at `9c431f7`, the focused spec was run,
and the file was restored with `git checkout --` (`git status --short` clean afterwards). The
collateral count is printed beside each failure so a later reader can tell attributability from
noise: an attributable probe fails the case it names, and the pass count shows what else the
mutation left alone.

| Probe | Mutation                                                           | Observed failure                                                 | Collateral    |
| ----- | ------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------- |
| R1    | `filters.ts`: the 24-hex guard before the id cast disabled         | `AssertionError: expected 500 to be 422`                         | 1 failed / 25 |
| R2    | `[imageId]/route.ts`: `$inc {refCount: -1}` → `$set {refCount: 0}` | `AssertionError: expected +0 to be 1`                            | 1 failed / 25 |
| R3 a  | `images/route.ts`: `visibility` no longer passed into the builder  | the `?visibility=hidden` case **and** the composed disjoint case | 2 failed / 24 |
| R3 b  | `filters.ts`: `status` and `visibility` chained as `else if`       | `AssertionError: expected [ { …(15) } ] to deeply equal []`      | 1 failed / 25 |

R3 a's two failures are the point of the probe: the first is the plain filter, the second the
`?status=done&visibility=hidden` negative control that would otherwise pass a last-one-wins
implementation. That is why the pin is wired, not merely present in the builder's unit test.

### Findings

| #      | Severity | Finding                                                                                                                                                                                                                                                                                                                                                 | Route              |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **F1** | Low      | `DELETE` idempotency is unpinned. The handler's lookup is `{ _id, eventId, deletedAt: null }` (`[imageId]/route.ts:150`), so a repeat `DELETE` answers `404`; removing that predicate leaves the whole file **26/26 green**. A double submit that decrements a **shared** asset's `refCount` again and releases the meter twice is therefore invisible. | TEST `t_a642b7ca`  |
| **F2** | Info     | The arrange comment at spec line 1470 ("one image, so the same route can answer 200 for a valid filter") sits inside the malformed case, which never asserts a `200`. Harmless as written; recorded so a reader does not mistake it for a claim the case proves.                                                                                        | recorded here only |
| **F3** | Info     | `readStoredAsset` (spec line 706) sits beside `readAsset` (line 685). Its own docblock justifies it — it reads the raw row so `storage` and `derivatives` can be deep-compared — so the pair is not duplication to collapse.                                                                                                                            | recorded here only |
| **F4** | Info     | The stacked posture is correct: `origin/main` (`ced39b6` at the time of writing) carries **0** files under `apps/web/src/server/images/` and none of the three OP-127 specs, so a pins branch off `main` could not import. A4 stands, and this branch must fold into the lane rather than `main`.                                                       | recorded here only |

F1 is routed to the TEST card `t_a642b7ca` and, deliberately, to its **PR number** rather than
an ADR number: a follow-up ADR may renumber while its PR is open, and a stale number in a frozen
record is worse than a card id. No Critical or High finding: the delivery adds no route, no
authorization surface and no user input, and the spec's only new network call is the same
in-process route harness the delivered cases already use.

### Post-review status

The F1 pin exists as card `t_a642b7ca` on PR #439 (branch
`OP-127-task-delete-idempotency-pins`, head `715756b`), open at the time of writing and stacked
on this lane's base; that card's own ADR is the authority for what the pin asserts, so this
sign-off names the routing and stops there. F2, F3 and F4 are recorded here only — no card,
because none of them can change behaviour and a pin or a rewrite for any of them would freeze
prose, not contract.
