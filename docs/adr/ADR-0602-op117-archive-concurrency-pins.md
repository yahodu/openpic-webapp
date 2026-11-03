# ADR-0602 — OP-117 review round 2 pins: the archive write's version predicate and two `upload-window:extend` edge paths

- **Status:** Accepted · **Date:** 2026-11-03
- **Card:** OP-117 review round 2 TEST (`t_95c68c28`), follow-up of the round-2 review (`t_a6a8f636`, PR #380 merged as `858fe39`) · **Branch:** `OP-117-task-archive-concurrency-pins` (cut from `origin/main` `b09ef5b`) · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_a6a8f636`
- **Relates to:** [ADR-0601](ADR-0601-op117-events-update-delete-green.md) (the shipped GREEN these pins review), [ADR-0600](ADR-0600-op117-events-update-delete-red.md) (the lane's RED contract), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §0.10 (a conditional write carries the read row's version), §4.1 (`POST /events/{e}/archive`, `POST /events/{e}/upload-window:extend`) · **Schema:** §15.1 (`events`), §18.3 (outbox)

## Context

The round-2 review found two gaps (F11, F12) in the shipped OP-117 surface that
no existing pin covers. This card adds the pins only; it writes no production
code.

## Decision

### P1 — F11: the archive write is conditional on the read row's version

`POST /events/{eventId}/archive` read the row, called `assertEventNotDeleting(row)`
and then wrote `updateOne({ _id: eventId }, { $set: { status: "archived", updatedAt: now } })`.
PATCH, DELETE and `upload-window:extend` all carry the read row's version into
the write predicate (`{ _id, status, updatedAt }`); archive did not. A DELETE
that committed between the read and the write was therefore overwritten from
`status: "deleting"` back to `"archived"`, silently un-scheduling a purge the
organizer asked for.

`R7` (`apps/web/src/test/integration/event-update-delete.test.ts`, appended,
no existing case edited) uses the same deterministic shape as `R4`: a
`Collection.prototype.updateOne` spy whose first call against `events` applies
the other writer's committed `{$set: {status: "deleting", deletedAt, updatedAt}}`
through the captured driver method, then delegates the route's own write. It
asserts:

- `409 event_deleting` — the answer the GREEN card `t_473da231` prescribes for
  the `matchedCount === 0` re-read showing `deleting` (the card also allows
  `412 etag_mismatch` for the version-mismatch shape; the GREEN's own body
  fixes `409` for this branch, so the pin names it);
- the stored row is still `status: "deleting"` with its `deletedAt` untouched;
- no `event.archived` row in `domain_events`.

### P2 — F12: two `upload-window:extend` paths (characterisation pins)

Appended to `apps/web/src/test/integration/event-extend-upload-window.test.ts`:

- `E7` — a row whose stored `uploadWindowEndsAt` is `null` on an unlimited plan
  (`events.post_upload_days` → `limit: null`) answers `200`, leaves
  `uploadWindowEndsAt` `null`, and only bumps `updatedAt`. Pins today's
  behaviour; no production change owed.
- `E8` — the lost-race refusal (`matchedCount === 0`) answers `412
etag_mismatch` with **no** `details.currentETag` (this route has no `If-Match`
  contract) and the concurrent writer's `uploadWindowEndsAt` survives.

## Evidence

- `R7` RED on `origin/main` `b09ef5b`: `AssertionError: expected 200 to be 409`
  (the archive succeeded and overwrote the pending delete).
- Mutation probe (throwaway copy of `archive/route.ts`, restored byte-identical):
  a conditional predicate `{ _id, status, updatedAt }` plus a
  `matchedCount === 0` → re-read → `409 event_deleting` refusal turns `R7`
  green (`Tests 1 passed | 18 skipped`), and `git diff` on `apps/web/src/app/`
  is empty afterwards.
- `E7`/`E8` green on `origin/main` without any production change: focused file
  `12 passed (12)`.

## Implementation (GREEN `t_473da231`)

`apps/web/src/app/api/v1/events/[eventId]/archive/route.ts` now writes through
`archiveWritePredicate(eventId, row)` — `{ _id, status: row.status }` plus
`updatedAt: row.updatedAt` when the read row carries one, the same shape as
`eventWritePredicate` (PATCH / DELETE) and `extendWritePredicate`
(`upload-window:extend`). The `event.archived` emit stays inside the existing
transaction and runs only when `matchedCount !== 0`; the transaction returns
that boolean.

On `matchedCount === 0` the handler re-reads the row and refuses before any
further write or announcement:

- re-read `status: "deleting"` → `409 event_deleting` (`assertEventNotDeleting`,
  so `details.purgeScheduledAt` carries the winning DELETE’s `deletedAt`);
- otherwise → `412 etag_mismatch` with `details.currentETag` from the re-read
  row, the tag PATCH/DELETE already report.

No other archive behaviour moved: co-organizer `403` (I3), organizer `200` +
`event.archived` (I3b) and the pre-existing `deleting` → `409 event_deleting`
admission check are untouched. `R7` is green; `E7`/`E8` stay green with no
production change on their route. No ADR number consumed — the OP-117 lane
`Next free` remains `0603`.

## Consequences

- The GREEN card `t_473da231` owes the conditional write, the `409`/`412`
  refusal on a zero match, and the emit only when the write matched. No other
  archive behaviour (co-organizer `403`, organizer `200`, `deleting` →
  `409`) may move.
- `E7`/`E8` are regression locks; they add no contract beyond what the shipped
  route already does.
- Sequence allocation unchanged: the OP-117 lane `Next free` advances from
  `0602` to `0603`.
