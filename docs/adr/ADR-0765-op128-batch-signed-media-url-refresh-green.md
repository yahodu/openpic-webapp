# ADR-0765 — OP-128 GREEN: batch signed media URL refresh

- **Status:** Accepted (implements [ADR-0764](ADR-0764-op128-batch-signed-media-url-refresh-red.md) unamended)
- **Date:** 2026-11-12
- **Ticket:** OP-128 — _batch signed media URL refresh_, phase 4 (Uploads & Media), epic Media
- **Card:** `t_33c02c69` (GREEN), same worktree as the RED
  (`/root/openpic/openpic-webapp/.worktrees/t_133a4093`, branch `wt/t_133a4093` → the GREEN PR
  branch `OP-128-task-batch-signed-media-urls-green`), based on the RED head `c965dfd`
- **Consumes:** contract §5.6, §5.7, §0.3, §0.6, §0.11, §0.14, §0.15; schema §16.1, §16.3, §17.5;
  ADR-0762 (D5/A5, F1), ADR-0763 (the member grid's hidden-thumbnail signing), ADR-0764 (the pins)
- **Supersedes:** nothing

## Context

The pins landed as ADR-0764: two spec files (24 unit cases on the decision table, 15 integration
cases on the endpoint) and no production code. This card writes exactly the code they demand and
nothing else.

## Decision

### D1 — the decision type keeps `code` optional

`SignedUrlDecision` is `{ allowed: boolean; code?: SignedUrlDenialCode }`, not a discriminated
union. A union is the tighter encoding of "allowed carries no code", but the U1 shape pin reads
`decision.code` on the union (`Property 'code' does not exist on type '{ readonly allowed: true }'`,
`tsc` TS2339), so the pinned type is the optional-code interface. The route therefore refuses a
denial without a code (`internal_error`) instead of inventing one — the invariant is enforced at the
one place it could leak to the wire.

### D2 — `public` label, principal resolved in the handler

The route declares no `auth` stage. The handler calls `resolvePrincipal` itself (the same resolver
`requireAuth` uses, ADR-0025) so an anonymous caller reaches the per-item table instead of a
gateway `401` (ADR-0764 D3/D4). The caller class is then: `member` when the resolved user holds an
`event_organizers` row (`organizer`/`co_organizer`, `revokedAt: null`) or an active
`tenant_members` row of the scope event's tenant (`resolveEventActorRole`), else `attendee`, else
`anonymous`.

### D3 — the batch is five reads, independent of its size

One request issues: the scope `events` row, the caller-relationship probe (two `findOne`s), the
`event_images` `$in` (scoped to `{ eventId: scope, deletedAt: null }`), the `media_assets` `$in`,
and — only for an attendee — the `face_matches` `$in` keyed on `{ eventId, imageId: { $in },
"subject.userId": <caller> }`. The plan gate is one `checkEntitlement` call and only when a
credentialed caller actually asked for an `original`. No read is per item, which is what I5's
`reads(200) === reads(2)` measures.

### D4 — the scope event names the tenant

The tenant is read off the scope `events` row (`tenantId`), and every tenant collection is reached
through `tenantRepo(tenantKey, …)`, so a foreign tenant's image cannot be signed even if a malformed
row carried the scope event id. A scope id that is not 24-hex, an unknown event, or an event without
a `tenantId` degrades to "no live image" — every item is `not_found` and the batch is `403` — rather
than throwing.

### D5 — signing inputs

Thumbnails are signed on the recorded derivative format (`derivatives.thumbnail.format`, §16.1);
originals on the stored content type's subtype (`storage.contentType` → `jpeg`), which is what the
`/o/<contentHash>.<ext>` address needs. A row without a derivative format falls back to `webp`; a
content type without a subtype falls back to `jpg` — both only reachable from a legacy row, and both
addressed by the same `$in`-read asset, never by an extra query.

## Consequences

- `POST /api/v1/media/signed-urls` exists, is rate-limited as `media.sign`, and answers the pinned
  `{ urls, denied }` envelope; a denial never fails a partial batch, an all-denied credentialed batch
  is `403 forbidden`, and an anonymous one stays `200` with `denied[] authentication_required`.
- `feature_not_available` is the entitlement service's own verdict (§0.14), and `payload_too_large`
  the catalogue's `413`; no new error code is added by this card.
- The route's `media.sign` limiter is _unattributable_ in the integration harness (no trusted client
  IP header on the synthetic `Request`), so the stage takes its documented `unavailable` branch and
  fails open with a `ratelimit.limiter_failed` warn — the same behaviour every coarse-stage route has
  in that harness. Under a real deployment the class keys on the principal (signed-in) or the hashed
  IP, so the limit is enforced.

## Evidence

- Pins unedited and green: unit `media-signed-urls-authorization.test.ts` **24 passed (24)**,
  integration `media-signed-urls.test.ts` **15 passed (15)**.
- Full suites: unit **157 files / 2526 passed | 3 skipped**, integration **104 files / 1016 passed**.
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; the combined coverage run exit `0` with
  261 test files / **3542 passed | 3 skipped**, statements `91.79 %`, branches `80.27 %`, functions
  `96.18 %`, lines `91.99 %`; the pure decision module is at lines `14/14`, branches `19/19`,
  functions `4/4` and the route at lines `53/55`, branches `48/57`, functions `10/10`.
- No test, mock, fixture, factory or handler was edited. The diff is the two production modules, this
  ADR and the README ledger cells.

## Coverage gaps handed to the Test Author

- A **member** refreshing a hidden image is still unpinned (ADR-0764 O1). The implementation allows
  it, following ADR-0763's grid, which lists and signs hidden thumbnails.
- The `op_att` anonymous-session variant of I6 (ADR-0764 O2) stays with OP-129. An `attendee`
  principal (`kind: "attendee"`) has no `userId`, so its `matched` fact is `false` and every item is
  `forbidden`/`not_found` — correct for this card, but the real attendee path needs OP-129.
- Not pinned, and implemented with a documented fallback: an asset row missing the derivative format,
  an image row whose asset row is gone (treated as `not_found`), a malformed/unknown scope id
  (`not_found` per item), and the `media.sign` class itself (ADR-0764 O3, declared but unpinned).
- `expiresAt` stays the signer's RFC-3339 `…Z` string (ADR-0764 O5); the route never re-formats it.

## Alternatives

- **A schema `.max(200)`** — rejected by the pins themselves: it reaches the wire as `422`, and I4
  requires `413` from the handler (ADR-0764 D7).
- **`requireAuth("user" | "attendee")` plus a per-item `authentication_required` entry** — impossible:
  the stage would answer `401` before the handler, and I6 pins a `200`.
- **One `findOne` per item** — rejected by I5's query-budget pin and by §5.6's batch rationale.
