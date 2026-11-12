# ADR-0767 — OP-128 GREEN: batch signed media URL refresh

- **Status:** Accepted (implements [ADR-0766](ADR-0766-op128-batch-signed-media-url-refresh-red.md) unamended)
- **Date:** 2026-11-12
- **Ticket:** OP-128 — _batch signed media URL refresh_, phase 4 (Uploads & Media), epic Media
- **Card:** `t_33c02c69` (GREEN), same worktree as the RED
  (`/root/openpic/openpic-webapp/.worktrees/t_133a4093`, branch `wt/t_133a4093` → the GREEN PR
  branch `OP-128-task-batch-signed-media-urls-green`), based on the RED head `c965dfd`
- **Consumes:** contract §5.6, §5.7, §0.3, §0.6, §0.11, §0.14, §0.15; schema §16.1, §16.3, §17.5;
  ADR-0762 (D5/A5, F1), ADR-0763 (the member grid's hidden-thumbnail signing), ADR-0766 (the pins)
- **Supersedes:** nothing

## Context

The pins landed as ADR-0766: two spec files (24 unit cases on the decision table, 15 integration
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
gateway `401` (ADR-0766 D3/D4). The caller class is then: `member` when the resolved user holds an
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

- A **member** refreshing a hidden image is still unpinned (ADR-0766 O1). The implementation allows
  it, following ADR-0763's grid, which lists and signs hidden thumbnails.
- The `op_att` anonymous-session variant of I6 (ADR-0766 O2) stays with OP-129. An `attendee`
  principal (`kind: "attendee"`) has no `userId`, so its `matched` fact is `false` and every item is
  `forbidden`/`not_found` — correct for this card, but the real attendee path needs OP-129.
- Not pinned, and implemented with a documented fallback: an asset row missing the derivative format,
  an image row whose asset row is gone (treated as `not_found`), a malformed/unknown scope id
  (`not_found` per item), and the `media.sign` class itself (ADR-0766 O3, declared but unpinned).
- `expiresAt` stays the signer's RFC-3339 `…Z` string (ADR-0766 O5); the route never re-formats it.

## Alternatives

- **A schema `.max(200)`** — rejected by the pins themselves: it reaches the wire as `422`, and I4
  requires `413` from the handler (ADR-0766 D7).
- **`requireAuth("user" | "attendee")` plus a per-item `authentication_required` entry** — impossible:
  the stage would answer `401` before the handler, and I6 pins a `200`.
- **One `findOne` per item** — rejected by I5's query-budget pin and by §5.6's batch rationale.

## Round-1 review (artifact lens)

Reviewed by the `openpic-webapp-reviewer` profile on PR #440 (head `b3bff76`), squash-merged as `5aff77d`.
Verdict: **approved with findings on the code, changes requested in round 1 for the ADR number collision (F0)** —
F0 is closed by the renumber round that produced ADR-0766 / ADR-0767 (see the round-2 section below).

**Acceptance criteria, each against the pin that proves it.**

| Criterion                  | The pin that proves it                                                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-item authorization     | `media-signed-urls-authorization.test.ts` (24 unit cases over the decision table, D1) plus `I1` (a member gets both kinds, and the plan gate denies only the `original`) and `I2` (a matched attendee is signed, an unmatched one denied) |
| Partial denial stays `200` | `I1 > keeps the thumbnail working and denies the original as feature_not_available`, `I3`'s one-legal-image-plus-refused-items batch, and `I7`'s mixed batch, each asserted at `200` with both `urls[]` and `denied[]` present            |
| No N+1 queries             | `I5 > issues the same number of reads for 200 items as for 2` — `reads(200) === reads(2)` and `reads(200) < 200` over the driver's `Collection` prototype (D9)                                                                            |

**Gates the reviewer measured at `b3bff76`.** Focused unit `media-signed-urls-authorization.test.ts` **24 passed
(24)**; focused integration `media-signed-urls.test.ts` **15 passed (15)**; full unit **157 files / 2526 passed | 3
skipped**; full integration **104 files / 1016 passed**; `tsc -p apps/web/tsconfig.json --noEmit` exit **0**; ESLint
and `prettier --check` clean; the `adr-numbering` guard **29 passed (29)**; PR checks **11/11**.

**The reviewer's own refactor (`b3bff76`).** The denial codes and the derivative kinds now come from two exported
tuples — `SIGNED_URL_DENIAL_CODES` and `SIGNED_URL_KINDS` — with the union types and both zod schemas derived from
them, and the answer's entry shapes are named instead of written out inline at each site. Behaviour is unchanged,
and the suite was re-run after the refactor.

**F1 — High, security.** The route resolved the principal and never called `evaluateAuth`, so an account that is
`suspended`, `banned` or `deletion_pending` still minted signed **thumbnail and original** URLs. Measured probe: a
`200` answer with both kinds signed for a `suspended` organizer. Routed to the pin card `t_91b4e245` (PR #442) and
its GREEN card `t_658f8a67` (PR #445); each of those records states its own gates.

**F2, F4, F5 — Low, test quality and fallbacks.** The `.webp` legacy fallback, the asset-row-gone item, the
malformed and unknown scope, and the matrix breadth were implemented but not pinned, and the `U1` shape assertion
read `.code` off a decision that may carry none. Routed to card `t_8b3f316e` (PR #447).

**F3 — Low, and a correction to this record.** The Consequences line that says the `media.sign` class "keys on the
principal (signed-in) or the hashed IP" is only half true. The route declares no `rateLimitIdentity` stage, so
`ctx.principal` is undefined there and even a signed-in caller is bucketed by the hashed IP — `120` requests per
`60` s per IP, not per user. The limit is enforced; the two-class attribution is not. Nothing in this record is
retracted by this correction, and the follow-up cards named above document what came after it in their own records.

**Landing.** PR #440 was squash-merged into `OP-128-task-batch-signed-media-urls-red` (`5aff77d`). The uploads lane
is not merged into `main`, so this record lands on the lane and not on the trunk. The lane branch tips are no longer
the SHAs named in the older cards of this chain.

## Round-2 review (execution lens)

Verdict: **approved**. F0 (the ADR number collision) is closed.

**F0 closed.** The two records are ADR-0766 and ADR-0767; the OP-126 lane cell reads `0768`; the index rows read
`0766` then `0767`, ascending. A sweep over 505 refs and every worktree shows both numbers on this lane only; the
trunk tops out at `0764` (`4fdb173`) with `0765` taken by `OP-127-task-delete-idempotency-pins`.

**Gates the reviewer re-ran at `96d8b9f`.** Focused unit **24 passed (24)**; focused integration **15 passed (15)**;
full unit **157 files / 2526 passed | 3 skipped**; full integration **104 files / 1016 passed**; combined coverage
exit **0** (statements `91.79 %`, branches **`80.27 %`**, functions `96.18 %`, lines `92 %`); `tsc` exit **0**;
ESLint clean on both production files; `prettier --check` clean; `adr-numbering` **29 passed (29)**; PR checks
**11/11**. The handoff's claim that the pre-merge README resolution (`22336ff..96d8b9f`) changed no content is true
(`git diff --stat` prints 0 lines). The branch touched no test, mock, fixture or factory.

**F6 — Low, new.** Stale ADR references in the shipped doc comments: `signed-urls.ts:14,21,91` and `route.ts:39,65`
still cite `ADR-0764` / `ADR-0765`, which now name OP-127 records. Routed to card `t_f7437615`. The three
spec-header occurrences belong to card `t_8b3f316e`, because they sit in test files.

**F1 is still open by design.** No behaviour changed in round 2; the pin card `t_91b4e245` (PR #442) and its GREEN
`t_658f8a67` (PR #445) own it.

**The ledger-union merge `f7a2696` is a decision, not a repair.** It resolved three blocks of `docs/adr/README.md`
by rule: the OP-126 lane `Next free` cell keeps this lane's `0768`, because the trunk's `0765` is the older
snapshot; the index table is a union in ascending order (`0764`, then `0766`, then `0767`); the lane prose keeps
both blocks (the trunk's OP-127 follow-up paragraph, then this lane's two OP-128 paragraphs). No number was
re-minted, `checkAdrDirectory` stayed **29 passed (29)** on the merged tree, and `ls docs/adr | grep -oE
'ADR-[0-9]{4}' | sort | uniq -d` is empty. The merged lane tree was re-measured after the union: **261 files / 3548
passed | 3 skipped**, coverage exit **0** at branches **`80.20 %`**. The six extra tests are the trunk's own OP-127
pins, and the `0.20` pp branch headroom over the `80 %` gate is named here as a lane risk.
