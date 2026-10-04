# ADR-0006 — Cursor pagination, ETag and conditional-request helpers

- **Status:** Accepted · **Date:** 2026-10-04

## Context

Contract §0.8 fixes cursor (keyset) pagination and §0.10 fixes optimistic
concurrency via `ETag`/`If-Match`. OP-81 adds the shared helpers that both the
list endpoints and the mutation endpoints will build on: a cursor codec and page
builder, a `defineRoute` ETag stage, and a Mongo keyset query helper.

Three questions had no single answer in the contract prose and had to be settled
by the pinned RED specs:

1. The card note suggested a "sort-field type tag" inside the cursor so a
   foreign cursor could be rejected. The RED specs (`cursor.test.ts` U1) pin the
   wire format to **exactly** `base64url(JSON.stringify({ c, i }))` — no tag.
2. `ERROR_CODES`/`AppErrorCode` had to carry three new codes (`invalid_cursor`,
   `precondition_required`, `etag_mismatch`), but `errors.test.ts` asserts
   `ERROR_CATALOG` is _exactly_ the 23 Appendix-A transport rows.
3. `eventETag` was weak while `If-Match` is strict-strong, which made events
   un-editable (§0.10 self-contradiction) — resolved by making the event ETag
   strong (see Decision below).

## Decision

### Cursor wire format — strict `{ c, i }`, no tag

`encodeCursor` is `base64url(JSON.stringify({ c, i }))`; `decodeCursor` parses a
Zod `z.object({ c: z.string().min(1), i: z.string().min(1) }).strict()`. The
`.strict()` shape is the _only_ foreign-cursor defence: an extra key, wrong
type, array, empty string or non-JSON base64 becomes `400 invalid_cursor`.
Adding a type tag would break U1's byte-level assertion and the deep-equality
round trip.

### Keyset filter — compound `$or`, `limit + 1` over-fetch

`cursorFilter(sortField, direction, cursor)` emits the compound predicate

```js
{ $or: [ { <field>: { $lt|$gt: value } },
         { <field>: value, _id: { $lt|$gt: id } } ] }
```

so a tied sort value never skips or repeats the rest of its group. The repo
layer fetches `limit + 1` rows sorted `(field, _id)` and `buildCursorPage` splits
them: the extra row is the only `hasMore` signal, so an exactly-full page is
terminal and never hands a client an unfollowable cursor. `paginateByCursor`
calls `collection.find(filter)` on the tenant-scoped handle, so the paginator
cannot weaken the tenant scope (the handle stamps `tenantId`).

### ETag comparison — strong `If-Match`, weak `If-None-Match`

`ifMatchSatisfied` uses the RFC 7232 strong comparison (a weak tag on either
side never matches); `ifNoneMatchSatisfied` uses the weak comparison (opaque
values compared, weakness ignored). `etagStage({ resolve, required })` merges the
current `ETag` on a success, serves a bodyless `304` for a matching
`If-None-Match` on a safe method (via a `stageHook` replay with `body: undefined`
so `jsonResponse` emits zero bytes), and enforces `If-Match` on unsafe methods —
`428 precondition_required { header }` when absent and `required`, `412
etag_mismatch { currentETag }` on a mismatch. `resolve() === null` is a no-op.

### Events ETag — strong `"<ms>-<v>"` (option a)

`eventETag(updatedAt, schemaVersion)` returns a **strong** tag
`"<updatedAt.getTime()>-<schemaVersion>"` (no `W/` prefix). The generic
`ifMatchSatisfied` / `ifNoneMatchSatisfied` helpers stay RFC-7232-correct and
shared by every resource; the contradiction is removed on the producer side
instead of by weakening the comparison. This was the contract owner's choice
(option a) when resolving the §0.10 self-contradiction.

### Error-code placement — `PIPELINE_ERROR_CODES`, not `ERROR_CODES`

`invalid_cursor`, `precondition_required` and `etag_mismatch` are added to
`PIPELINE_ERROR_CODES` (contract Appendix A.2/A.3) and to
`PIPELINE_ERROR_TRANSPORT` in the server catalogue. They are **not** added to
`ERROR_CODES`/`ERROR_CATALOG`, because `errors.test.ts` pins `ERROR_CATALOG` to
exactly the 23 transport rows; `PIPELINE_ERROR_CODES` still flows into
`AppErrorCode` and `errorCodeSchema`, so `AppError("invalid_cursor")` resolves
its status from the stage-owned transport table.

### Module paths

The implemented paths are the ones the specs import:
`@/server/http/cursor` (codec, parser, page builder), `@/server/http/etag`
(format + conditional evaluation + stage), `@/server/repos/paginate` (Mongo
keyset helper), not the card note's single `pagination.ts`.

## Consequences

- A list endpoint gets stable pagination by declaring a `CursorSort` and calling
  `paginateByCursor`; the compound key is opaque to clients.
- A mutable endpoint gets optimistic concurrency by mounting `etagStage`, which
  emits the wire `ETag` and the `428`/`412`/`304` behaviours from one place.
- **Resolved (option a):** the events `ETag` is now strong (`eventETag` emits
  `"<updatedAt.getTime()>-<schemaVersion>"`, matching contract §0.10), so the
  value a client reads from a `GET` satisfies the strong `If-Match` comparison
  on a later `PATCH`/`PUT`. No client value could satisfy a weak current tag
  under the RFC-7232 strong comparison, which is why the producer was fixed
  rather than the comparison relaxed.

## Alternatives considered

- **Type-tagged cursor** (card note) — rejected: breaks the pinned `{ c, i }`
  wire format and U1's byte assertions; strict shape already rejects foreign
  cursors.
- **`offset`/`skip` pagination** — rejected: contract §0.8 forbids it; it skips
  and duplicates rows across concurrent writes.
- **Add the codes to `ERROR_CATALOG`** — rejected: breaks the exhaustive
  Appendix-A assertion in `errors.test.ts`.
- **Weak comparison for `If-Match`** — rejected: RFC 7232 requires strong
  comparison for state-changing preconditions, and U6 pins it.
