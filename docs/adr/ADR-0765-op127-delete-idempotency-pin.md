# ADR-0765 — OP-127 follow-up TEST: the repeat `DELETE` is idempotent for a shared asset

- **Status:** Accepted (characterization pin — green on arrival against the OP-127 GREEN
  `9c431f7`)
- **Date:** 2026-11-12
- **Ticket:** OP-127 — _event images management_, phase 4 (Uploads & Media), epic Media
- **Card:** `t_a642b7ca` (review follow-up TEST, finding **F1** of the `t_12cd55aa` review),
  branch `OP-127-task-delete-idempotency-pins`,
  worktree `/root/openpic/openpic-webapp/.worktrees/t_93217b87`
- **Base:** `9c431f7` on `OP-127-task-event-images-management-green` (the lane is unmerged,
  so the PR is stacked on that branch; `origin/main` carries none of this lane — see A2)
- **Consumes:** contract §4.4, §0.4, §0.14 C6; ADR-0762 D5/A3; ADR-0763 D4/D7; ADR-0764 R2
- **Supersedes:** nothing

## Context

The review of PR #437 (card `t_12cd55aa`) approved the three pins **R1/R2/R3** with one
Low coverage finding. `DELETE …/images/{imageId}` reads the join row as
`{ _id: imageId, eventId, deletedAt: null }`
(`apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/images/[imageId]/route.ts:150`),
so a repeat call is the uniform `404 not_found` and cannot reach the decrements in the same
transaction. The reviewer measured the gap: with `deletedAt: null` removed from that lookup
the whole file stayed **26/26 green**.

That predicate is the only thing standing between a double-submit and a second release of a
**shared** asset: the reference count of a `media_assets` row two events point at would go
`1 → 0` (the other event's reference silently lost, and the asset eligible for the purge job)
while the tenant's `storage.bytes` meter releases the bytes twice — the second release is a
pure capacity refund for content the tenant still stores.

R2 pins the first delete of each reference only. Nothing in the suite sees the same
`event_images` row deleted twice.

The behaviour is already correct on the lane head, so this is a **characterization pin**: it
is expected to pass on the first run, and a red one is a finding about the shipped handler
rather than a licence to weaken the assertion.

## Decision

One case in one new `describe` block appended to
`apps/web/src/test/integration/event-images-management.test.ts`, reusing that file's harness
and R2's fixture shape — one `media_assets` row seeded `refCount: 2`, referenced from one
image in event A and one in event B of the **same** tenant, with `seedRoomyPlan` and a
`usageCounters` `storage.bytes` row seeded at `ORIGINAL_BYTES * 2` exactly as I3 does, so a
second release is observable instead of vacuous. The change is additive (26 → 27 cases,
0 deletions): no delivered case is edited.

`describe("DELETE …/images/{imageId} — a repeat call changes nothing (F1)")`:

1. **First** `DELETE` of event A's image → `204`; the asset reads `refCount === 1`; the join
   row is soft-deleted; event A's `counters.imageCount`/`counters.storageBytes` are `0`; the
   tenant's meter is `ORIGINAL_BYTES`. These are the baseline the repeat must preserve, and
   they are asserted rather than inferred.
2. **Second** `DELETE` of the **same** image id → `404` with `error.code === "not_found"`
   (§0.4's uniform not-found: an already-deleted row is not an existence oracle, and a
   `204` here would claim an effect that did not happen).
3. After the second call the asset `refCount` is still `1` (not `0`), the `media_assets` row
   still exists with its `storage` and `derivatives` sub-documents deep-equal to the
   post-first-delete capture, and the join row's `deletedAt` is **the first call's instant**,
   not rewritten.
4. Event A's nested `counters.imageCount`/`counters.storageBytes` are still `0`, and the
   tenant's `storage.bytes` meter is still `ORIGINAL_BYTES` — one image's bytes, never zero.
5. Event B still lists its image, and event A's grid is still `[]`.

The pin is deliberately scoped to the _repeat of the same image_: not `refCount` underflow
from two concurrent deletes (a transaction-level concern), not the purge job.

## Assumptions

- **A1 — the second call's status is asserted as `404`, not `204`.** §4.4 does not spell out
  a repeat `DELETE`; `404 not_found` is what the shipped handler does and what §0.4's uniform
  not-found implies. Pinning `204` would invent an idempotent-response contract the lane does
  not implement, and would hide the fact that no effect occurred.
- **A2 — the branch is cut from the lane tip, not `origin/main`.** `origin/main` carries no
  `@/server/images/**` and none of the OP-127 specs, so a pin branched there would fail on
  import. The lane (OP-123 → OP-127) is unmerged; the PR is stacked on
  `OP-127-task-event-images-management-green`, the same posture as #437.
- **A3 — the meter is seeded at two references.** Seeding it at one image's bytes would make
  "the second call released nothing" indistinguishable from "the release was clamped at
  zero" (A3 of ADR-0764) — the double release would look like a no-op.
- **A4 — `PROCESSED`/`failed` counters and `matchCount` are not asserted.** The delete does
  not touch them (ADR-0762 A4) and the repeat cannot either; asserting them would pin the
  nightly reconcile's territory.

## Out of scope

- `refCount` underflow from two **concurrent** deletes of the same reference, and the purge
  job at `refCount 0` (ADR-0762 D5) — unchanged by this card.
- The `409`/`422`/`403` ladder for the repeat call: authorization is already pinned as a
  table (X1–X3), and a repeat call by an outsider or a member is denied by the same stages.
- A repeat `PATCH` (hiding an already-hidden image) — R2/I7 pin the state, and hide is not an
  accounting mutation.

## Number allocation

`0765` is the value the OP-127 lane's previous follow-up card (`t_12cd55aa`, ADR-0764) left
in the **OP-126 uploads lane** row (`0760`–`0779`) of `docs/adr/README.md`; this card uses it
and advances the cell to `0766`. No number outside that range is touched.

## Evidence

- Focused suite `vitest run --project integration …/event-images-management.test.ts` →
  **27/27 passed** (the 26 pre-existing cases plus this one).
- Full `vitest run --project integration` at this head → **103 files / 1008 passed** (the
  lane's 1007 at `9c431f7` plus this one; no regression in the other 102 files).
- `tsc -p apps/web/tsconfig.json --noEmit` → exit 0.
- `prettier --check` clean on the spec, this ADR and the ledger; the ADR-numbering guard
  (`unit` → `adr-numbering.test.ts`) stays green with no duplicate `ADR-NNNN`.
- Load-bearing, proven by two mutation probes on the production route (each reverted
  byte-identically — `sha256 693a91b2…` before and after, `git status --short` leaves only
  the spec modified):

  | probe | mutation                                                                                                                                                                                                              | observed failure                                                                                                                  |
  | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
  | 1     | `[imageId]/route.ts` DELETE lookup drops `deletedAt: null` (the reviewer's measured regression)                                                                                                                       | `AssertionError: expected 204 to be 404` (1 failed / 26 skipped)                                                                  |
  | 2     | the same lookup without `deletedAt: null` **and** the `404` thrown after the transaction commits, so the repeat is answered `404` while the decrements land (an idempotent _response_ with a non-idempotent _effect_) | `AssertionError: expected +0 to be 1` (1 failed / 26 skipped) — the status arm passes, the `refCount`/counter/meter arms catch it |

  Probe 2 is why the pin asserts the persisted state and not only the status: a handler can
  answer `404` and still release the bytes.
