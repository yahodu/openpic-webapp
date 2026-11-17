# ADR-0603 — OP-117 review round 2 (TEST): the archive `412 etag_mismatch` refusal arm pinned

- **Status:** Accepted · **Date:** 2026-11-03
- **Card:** OP-117 review round 2 TEST (`t_77fdac73`), follow-up finding **F13** of the round-2 review sign-off (`t_7cd963c6`, PR #384 merged as `d09b8cc`) · **Branch:** `OP-117-task-archive-412-pin` (cut from `origin/main` `760b06f`) · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_a6a8f636`
- **Relates to:** [ADR-0601](ADR-0601-op117-events-update-delete-green.md) (the shipped GREEN), [ADR-0602](ADR-0602-op117-archive-concurrency-pins.md) (the `R7` sibling pin for the `409` arm), [ADR-0600](ADR-0600-op117-events-update-delete-red.md) (the lane's RED contract), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §0.10 (a conditional write carries the read row's version; a zero match refuses instead of overwriting), §4.1 (`POST /events/{e}/archive`) · **Schema:** §15.1 (`events`), §18.3 (outbox)

## Context

`POST /api/v1/events/{eventId}/archive` refuses a lost race with **two** arms,
both shipped in `d09b8cc`:

1. the re-read row shows `status: "deleting"` → `409 event_deleting`;
2. any other mismatch — `matchedCount === 0` on the conditional
   `{ _id, status, updatedAt }` write while the re-read row is **not** deleting
   — → `412 etag_mismatch` with `details.currentETag` from the re-read row.

Only arm 1 was pinned (by `R7`, ADR-0602). Arm 2 was a self-reported coverage
gap on card `t_473da231` (finding **F13**, Low). A concurrent PATCH — or any
non-delete writer — landing between the archive's read and its write was
therefore unconstrained by the suite: a regression to
overwrite-then-announce would have stayed green.

The behaviour is already correct on the trunk. This card pins it; it writes no
production code.

## Decision

Append `R8` to `apps/web/src/test/integration/event-update-delete.test.ts`
(nothing existing edited). It reuses the deterministic shape of `R4`/`R7`: the
module-load-captured `Collection.prototype.updateOne` driver method, called
through a `Collection.prototype.updateOne` spy whose **first** call against
`events` applies the other writer's committed
`{$set: {name, updatedAt: <later>}}` before delegating the route's own write.
Both sides carry the same valid ETag by construction: the route read the seed
row, the concurrent writer only moves `updatedAt`.

`R8` asserts:

- the archive answers `412`, envelope code `etag_mismatch`;
- `details.currentETag` equals `eventETag(reRead.updatedAt, reRead.schemaVersion)`
  computed against the row the spy left behind — the **re-read** tag, not the
  tag this request read (`expect(...).not.toBe(seedTag)`, so the pin cannot be
  satisfied by echoing the request's own version);
- the stored row still carries the concurrent writer's `name` and is still
  `status: "published"` (not `archived`);
- no `event.archived` row was appended to `domain_events`.

### Card deviation

The card names the concurrent writer's field `title`. The `events` row — and
the Event DTO — spell that field **`name`** (`@/server/events/dto.ts`), so the
pin uses `name`. There is no `title` field on the collection; writing one would
have made the "the other writer's value survives" assertion vacuous.

## Evidence

- Focused run at the pin head (green — this is a characterisation pin, no GREEN
  sibling is owed):
  `TMPDIR=/root/tmp-mongo npx vitest run --project integration apps/web/src/test/integration/event-update-delete.test.ts`
  → `Test Files 1 passed (1)`, `Tests 20 passed (20)`.
- **Mutation probe** (the pin bites): revert the conditional write in the route
  to `updateOne({ _id: eventId }, …)` →
  `× R8: a concurrent PATCH that commits between the archive read and its write answers 412 etag_mismatch naming the re-read tag, and nothing is archived`
  → `AssertionError: expected 200 to be 412`. That is exactly the
  overwrite-then-announce regression F13 describes.
- The route was then restored **byte-identically**:
  `restored byte-identical: True`, `git diff --stat -- apps/web/src/app/` empty,
  and `sha256sum` of the file equals the blob at `HEAD`
  (`c510380d805b80a24ddf5eb1a0213c46d350181b54bf0928e796c5e6f9c7856f`).

## Consequences

- Both archive refusal arms are now regression-locked: `R7` the delete race
  (`409`), `R8` every other version mismatch (`412` naming the re-read tag).
  A future refactor that preserves the behaviour breaks neither; a regression
  to an unconditional write breaks `R8` loudly.
- The pin also constrains the _announcement_ boundary: an archive that refuses
  must not have written the outbox row. The `event.archived` emit staying
  inside the `matchedCount !== 0` branch is now observable from outside.
- No contract change: §0.10 already required the conditional write and §4.1
  already prescribed this refusal. This record documents the pin upgrade and
  the mutation evidence only.
- Sequence allocation: `0600`/`0601`/`0602` are consumed, so this record takes
  `0603` and the OP-117 lane `Next free` advances from `0603` to `0604`. No
  number outside the lane range `0600`–`0619` is touched.
