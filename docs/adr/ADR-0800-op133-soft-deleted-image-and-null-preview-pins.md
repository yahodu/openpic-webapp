# ADR-0800 — OP-133 follow-up pins: a soft-deleted photo is unsignable, and `/me` reports a null selfie tile

- **Status:** Accepted
- **Consumers:** `apps/web/src/test/integration/attendee-media-access.test.ts`,
  `apps/web/src/test/integration/attendee-participation-status.test.ts`.
- **Lane:** the shared attendee block `0780`–`0798` (row
  `OP-129 attendee identity lane`) is **exhausted** at this branch cut on
  `origin/main` `55e665a`: `git ls-tree -r --name-only origin/main -- docs/adr`
  holds `0780`–`0794` and `0796`–`0799` (`0795` was never minted), and both the
  attendee cell and the `unallocated (future lanes)` pool cell read `0800`. A
  sweep of every open PR head (`gh pr list --state open --json headRefOid`, then
  `git ls-tree -r --name-only <sha> -- docs/adr`) found no `ADR-07xx` above
  `0794`, and `.worktrees/*/docs/adr/` holds no `ADR-0800-*` file anywhere —
  the check the OP-133 pack under PR #549 needed after `0798` was lost to an
  untracked record in a sibling worktree. This record therefore takes `0800`,
  the first number unused on the trunk, on every open PR head and in every
  worktree; the attendee cell and the pool cell both advance to `0801`.
- **References:** [ADR-0799](ADR-0799-op133-preview-url-selfie-summary-pins.md)
  (the follow-up pin pack whose review raised **F1** and **F2** — its §3 pins the
  `preview-url` refusals and `404 not_found` for an id that names **no** image,
  which is what left the soft-deleted row unpinned, and its §4 pins the
  **signed** `previewUrl` arm only);
  [ADR-0794](ADR-0794-op133-attendee-gallery-green.md) §4 (the
  `requireSignableImage` order and the two routes that share it);
  [ADR-0793](ADR-0793-op133-attendee-gallery-red.md) §6 (the two hide semantics
  and `event_images.visibility`) and §10 (`/me`'s body and the `selfie`
  projection);
  [ADR-0796](ADR-0796-op132-selfie-asset-owner-expiry-purge.md) (the selfie's
  own `mediaAssets` row, one per `(tenant, contentHash)`, whose id the `selfies`
  row stores as `assetId`) and
  [ADR-0798](ADR-0798-op132-purge-before-delete-claim.md) (the purge that claims
  and then deletes that row, so a live selfie whose asset is gone is a shape the
  pipeline itself can leave behind).
- **Consumes:** `0800`.

## Context

Card `t_2c32cef3` reviewed and landed PR #549 (the OP-133 success-path pins) and
routed two **additive coverage gaps** here. Both behaviours are already shipped
on `main`, so this is a **characterisation** pin pack: every case is expected to
pass on the first run, there is no RED to hand off and no GREEN sibling is
created. A green characterisation pin is proved meaningful by **mutation**
(§4), not by a red run.

1. **F1 (Medium) — the soft-delete predicate was unpinned.** `requireSignableImage`
   (`apps/web/src/server/attendee/image-access.ts:76`) resolves an image with
   `{ _id, eventId, deletedAt: null }`. The reviewer deleted `deletedAt: null`
   in a throwaway worktree and `attendee-media-access.test.ts` stayed **14
   passed (14)**: a soft-deleted `event_images` row would still be signed for a
   matched attendee and nothing in the suite noticed. The existing `404` case
   cannot cover it — a random `ObjectId` names no row whether or not the
   predicate exists — so the case has to soft-delete a **real** row.
2. **F2 (Low) — `/me`'s two `previewUrl: null` arms were unpinned.** Only the
   signed thumbnail arm was exercised (ADR-0799 §4). `SelfieRow.assetId` is
   typed `assetId?: ObjectId | null`, so a legacy selfie written without an
   asset and a selfie whose `media_assets` row was purged are both shapes the
   route explicitly handles — and neither was asserted, so a `500` on either
   would have shipped silently.

## Decision

### 1. A soft-deleted image is not a signable image (F1)

One case in the `when an identified attendee asks for a preview` block builds
the **success fixture exactly** (`seedIdentifiedGallery`, one match, the image
matched to the caller), then stamps the image's `deletedAt` and requests
`preview-url`. It asserts `404`, `error.code: "not_found"`, and that the body
carries **no URL** — `keysOf(body)` is exactly `["error"]`, so the refusal is the
error envelope only.

The soft-delete is performed by a local `softDeleteImage` helper that issues
`updateOne({ _id, deletedAt: null }, { $set: { deletedAt } })` and throws unless
`matchedCount === 1`. That guard is load-bearing for the pin's meaning: it makes
the case state "a row that **was** live and matched is now deleted", so a `404`
can never be explained by a fixture that never existed (which is what the
random-id case proves, and the reason the predicate survived unmeasured).

### 2. The shared predicate is pinned on **both** routes that read it

A twin case in the `when the attendee asks for an original` block repeats the
soft-delete against
`POST …/images/{imageId}/original-url` with `originals.download` **granted**, so
the `404` cannot be confused with the plan refusal. `requireSignableImage` is
the security boundary for both routes (ADR-0794 §4); pinning one route would let
a later per-route lookup lose the predicate on the other, and the two pins fail
under one mutation each (an `201` with a signed `/p/…` or `/o/…` URL).

### 3. `/me`'s two null arms: no asset id, and a purged asset row (F2)

Two cases in the `when the poll projects the attendee's selfie` block, each on a
selfie **activated through the shipped submit → worker → confirm path** (the
`activateSelfie` helper, unchanged):

- **No `assetId`** — the stored row is set to `assetId: null`, the "legacy
  selfie" shape the route's own type admits. It is produced by `updateOne` and
  not by a route, because since ADR-0796 the submit path always writes an asset
  id; this is a **stored** shape, not a route-reachable one, which is exactly
  why the card could only point at the type.
- **Asset row gone** — the selfie's `media_assets` row is deleted (the purge
  ADR-0798 performs), leaving a live selfie whose tile has nothing to sign.

Each case first polls while the row is normal and asserts a signed
`/t/{hash}.webp` pathname, so the `null` afterwards is the mutation's effect and
not a fixture that never had an asset. Each then asserts `200` (a `500` fails
`pollBody`'s own status check with the received body), the exact seven §6.4
selfie keys (so `previewUrl` stays **present** as `null` rather than being
omitted), `previewUrl: null`, and the unchanged `id`, `accepted`, `attemptsUsed`
(1) and `attemptsRemaining` (2 of the default 3). The existing signed-arm case
is untouched: this pack is additive.

### 4. The pins bite

Each pin was proved by a one-line mutation of the shipped file, restored with
`git checkout --` afterwards:

- `deletedAt: null` dropped from the `requireSignableImage` filter →
  `2 failed | 14 passed (16)`, both new cases at
  `AssertionError: expected 201 to be 404` (`original-url` and `preview-url`),
  every pre-existing case still green — the reviewer's measured gap reproduced
  from the other side;
- the `assetId === null || undefined` early return replaced with a `throw` →
  `1 failed | 12 passed (13)`, only "answers previewUrl: null when the stored
  selfie carries no asset id", failing as
  `expected 200 from GET …/me, received 500`;
- the `asset === null` early return replaced with a `throw` →
  `1 failed | 12 passed (13)`, only "answers previewUrl: null when the selfie's
  media asset row is gone".

Each mutation reddens exactly its own case, so the two F2 arms are independent
and neither pin is satisfied by the other.

## Consequences

- **No production change.** `git diff --name-only origin/main...HEAD` shows the
  two spec files, this record and `docs/adr/README.md`. The three mutations above
  were reverted byte-identically (`git status --short` holds only the two spec
  files between runs).
- **Case counts.** `attendee-media-access.test.ts` 14 → 16; the file's focused
  run is **16 passed (16)**. `attendee-participation-status.test.ts` 11 → 13;
  focused **13 passed (13)**. Both files together: **29 passed (29)** on the
  branch cut (`origin/main` `55e665a`).
- **Full suite + coverage.** `TMPDIR=/root/tmp-mongo npx vitest run --project unit
--project integration --coverage` on this branch: **290 files, 4162 passed |
  3 skipped (4165), exit 0**, statements `92.57 %`, branches `81.09 %`,
  functions `96.99 %`, lines `92.74 %` — every configured bar met, none relaxed.
  A first run of the same command hit two `5000ms` timeouts in
  `subscription-read.test.ts` and `tenant-members.test.ts` (unrelated files, no
  shared code with this pack); both pass in isolation (`30 passed (30)`), which
  is the notification-timeout flake recorded as F3 on card `t_2c32cef3`.
- **What the F1 pin does not cover.** It pins the **route-level read** — the
  predicate as observed through `preview-url` and `original-url` — not the
  projection or the update path that stamps `deletedAt`; the organizer's delete
  route owns that write and its own specs pin it. A future "restore a deleted
  image" feature would have to teach these two cases a third state.
- **What the F2 pins do not cover.** A selfie with `assetId` **undefined**
  (`$unset`) is not a separate case: the route's guard is one `||` over `null`
  and `undefined`, and §3 already pins the observable outcome, so a case for the
  second discriminant would pin the same behaviour twice. A `media_assets` row
  that exists but carries no `contentHash` is also out of scope — §16.1 makes
  the hash the asset's identity, and no shipped path writes such a row.
- **No new fixture.** Both F1 cases reuse `seedIdentifiedGallery` /
  `seedAnonymousGallery`, `seedImage`, `seedOriginalsPlan` and the existing
  `SEED_INSTANT`; F2 reuses `seedConsentingAttendee` and `activateSelfie`. The
  only new test-side code is the `softDeleteImage` helper in the media spec,
  which exists so the "the row was live" guard cannot be forgotten by one of the
  two cases.
