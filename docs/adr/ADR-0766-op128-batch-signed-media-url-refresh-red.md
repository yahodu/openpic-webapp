# ADR-0766 — OP-128 RED: batch signed media URL refresh

- **Status:** Accepted (RED pins; the implementation is the gated GREEN `t_33c02c69`)
- **Date:** 2026-11-12
- **Ticket:** OP-128 — _batch signed media URL refresh_, phase 4 (Uploads & Media), epic Media
- **Card:** `t_133a4093` (RED), branch `wt/t_133a4093` pushed as
  `OP-128-task-batch-signed-media-urls-red`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_133a4093`
- **Base:** the OP-127 GREEN head `8588010` merged into the worktree branch (the uploads lane
  OP-123 → OP-127 is unmerged, so this branch carries the whole lane; the GREEN must base on
  **this** branch, never bare `origin/main`)
- **Consumes:** contract §5.6, §5.7, §0.3, §0.6, §0.11, §0.14 (feature enforcement),
  §0.15; schema §16.1, §16.3, §17.5; ADR-0762 (D5/A5, F1), ADR-0582/ADR-0583 (the signer)
- **Supersedes:** nothing

## Context

A gallery page outlives its URLs: thumbnails are signed for 24 h and originals for 15 min
(§5.6, media doc §8), so a tab left open overnight holds dead `<img src>` values and a
`403` from the data plane is answered by calling §5.6 again. OP-128 builds that refresh
endpoint — `POST /api/v1/media/signed-urls`, up to 200 items, **per-item** authorization,
one `200` that mixes `urls[]` and `denied[]`, and a `403` only when nothing at all was
allowed.

The endpoint exists nowhere today (`apps/web/src/app/api/v1/media/` does not exist), and the
policy it enforces — who may see which derivative of which image — is the gate ADR-0762's
F1 named as unreachable from OP-127: hiding an image writes **only**
`event_images.visibility`, so the signed-URL gate is the place a hidden-but-matched image
must stop being deliverable. This card writes the pins only.

## Decision

The executable contract is the two spec files. Their module headers carry the full
statement; this ADR records the decisions the card left open.

### D1 — the pure seams

`@/server/media/signed-urls` exports:

- `authorizeSignedUrlItem(input): SignedUrlDecision` — the whole per-item policy, with
  `input = { kind, caller, matched, originalsAllowed, image }` where `caller` is
  `"member" | "attendee" | "anonymous"` and `image` is `{ hidden } | null` (`null` = no live
  image of the scope event: missing, soft-deleted, or another event's). `SignedUrlDecision`
  is `{ allowed: true }` or `{ allowed: false, code }` with `code` in
  `authentication_required | forbidden | not_found | feature_not_available`.
- `signedUrlBatchStatus(decisions): 200 | 403` — the aggregate rule: `403` **iff** every
  decision is denied **and** none of them is `authentication_required`; an empty batch is
  `200` (the wire validation refuses it first, with `422`).

Denial precedence is fixed and pinned: `not_found` (never an existence oracle, §0.4) →
`authentication_required` → `feature_not_available` (only for `original`) → `forbidden` →
allow. A member passes on identity alone; an attendee passes only with a match **and** an
unhidden image.

### D2 — the route

`apps/web/src/app/api/v1/media/signed-urls/route.ts` exports `POST` on `defineRoute`, with
`scope.kind` literal `"event"`, `items` 1..200, the `media.sign` rate-limit class (§0.11) and
the §5.6 answer schema **exactly**: `{ urls: [{ imageId, kind, url, expiresAt }], denied:
[{ imageId, kind, code }] }`.

### D3 — the endpoint is `public`-labelled, and that is a deliberate deviation

§5.6 says "auth `user` or `attendee`", and the GREEN note repeats it. The card's I6
(`an anonymous session asking for original gets denied[] with authentication_required`)
cannot hold behind an `attendee`/`user` label: `requireAuth` answers such a request with
`401 authentication_required` before the handler runs, so there is no `denied[]` to inspect.
The observable contract therefore wins: the route is `public`, resolves the principal itself
(or through a `public` stage, which still publishes `ctx.principal` for a user session), and
answers **per item**. A `403` remains the aggregate answer for a credentialed caller, and the
`authentication_required` denials never aggregate (§D4).

### D4 — `authentication_required` does not escalate to `403`

An anonymous caller has no identity to authorize, so every item is denied
`authentication_required` and the batch answers `200` with the `denied[]` list. Without the
exemption a one-item anonymous `original` request would be an all-denied batch and therefore
a `403`, directly contradicting I6. The rule is pinned as five `U2` rows plus two `I6` cases,
and the near-fix probe confirms it is the only shape that satisfies both I6 and I3's
all-denied `403`.

### D5 — denial codes reuse the catalogue, and one of them is the entitlement's own reason

- `not_found` — the id is not a live image of the scope event. Pinned for another event's
  image (same tenant), a foreign tenant's image, a soft-deleted image and an unknown id, all
  in one batch alongside one legal image so the batch stays `200`.
- `forbidden` — no relationship grants the kind. This is also the code for the **hidden**
  image (D6) and for the aggregate `403`'s envelope.
- `feature_not_available` — the tenant plan's `originals.download` gate is off. That is
  `@/server/services/entitlements`' own denial reason (§0.14) and the code §6.6 already uses
  for the same condition on the attendee original-url route, so no new media code is owed.
- `authentication_required` — no credential at all (I6). Existing catalogue code, `401`
  class, used here as an **item** code inside a `200`.

### D6 — the §5.6 gate applies ADR-0762's `{ visibility: "visible", deletedAt: null }`

`deletedAt: null` is part of the data scope (a soft-deleted image is never deliverable), and
`visibility: "visible"` is pinned on the **attendee** branch: a hidden image that still
carries a `face_matches` row for the caller must appear in `denied[]` while a visible matched
image in the same request succeeds. That is exactly the bypass ADR-0762 F1 handed to this
card, and it is pinned at both levels (two `U1` rows — thumbnail and original — and one
integration case).

A **member** asking for a hidden image is deliberately not pinned (open item O1): §4.4's
curation grid lists hidden images and signs their thumbnails (`hide is not delete`), so a
blanket `visibility` filter would be a regression on that surface, but the card does not
name the case and either answer is defensible here.

### D7 — the 413 is the route's own check, not the schema's

Zod's `.max(200)` fails through the pipeline as `422 validation_failed` (§0.6), which the
card's I4 does not accept: it pins `413`. The body schema therefore must **not** cap the
array, and the handler refuses `items.length > 200` with `appError("payload_too_large")`
(`413`, the catalogue's existing code — no new code). The near-fix probe proved this the
hard way: with `.max(200)` the case failed `expected 413, received 422`; moving the check
into the handler made it pass. I4 also pins the inclusive boundary (exactly 200 items →
`200`) so the cap cannot drift one lower.

### D8 — the anonymous derivation is a request with no principal, today

OP-129 owns the `op_att` attendee-session resolver and is still `todo`; `requireAuth`'s
`noAttendeeSessions` stub resolves nothing. So:

- **attendee** cases drive a signed-in **user** who is neither a tenant member nor an event
  organizer, with an `attendee_event_profiles` row and `face_matches` rows bound to their
  `subject.userId`. §0.3 says a user session satisfies the `attendee` label, so this is the
  same handler path an `op_att` session will take.
- **anonymous** is a request that resolves no principal at all. The `op_att` variant of the
  same denial is open item O2, unpinnable until OP-129 lands.

### D9 — the query budget is measured at the driver's `Collection` prototype

I5 needs a query-count spy and the suite's client is not built with `monitorCommands`, so the
pin counts `find` / `findOne` / `aggregate` / `countDocuments` / `distinct` calls through
`vi.spyOn(Collection.prototype, …)` (which forwards to the real method) and compares the
**same** request at 2 and at 200 items. Both measured requests run after a warm-up so the
platform-settings and plan caches are in the same state, and both answers are asserted to be
full (`urls` 2 and 200) so the count cannot be a refused request's zero. The assertion is
`reads(200) === reads(2)` plus `reads(200) < 200` — a constant, not a magic number, so a
legitimate implementation may change the constant without breaking the pin.

## Evidence

Measured in `/root/openpic/openpic-webapp/.worktrees/t_133a4093` (base `8588010` + `ced39b6`).

- **Honest red, no implementation:** `npx tsc -p apps/web/tsconfig.json --noEmit` reports
  exactly two errors — `TS2307 Cannot find module '@/server/media/signed-urls'` and
  `TS2307 Cannot find module '@/app/api/v1/media/signed-urls/route'`. Both suites then die
  on `Cannot find package …` (`Test Files 1 failed (1)`, `Tests no tests`).
- **Probe stub 1 (naive pure module + `500` route):** `tsc` exit 0; unit
  **9 failed | 15 passed (24)** with exactly the intended rows failing (the
  `feature_not_available` rows, the unmatched-attendee rows, both hidden rows, the
  designation sweep and both `authentication_required` aggregate rows); integration
  **15 failed (15)**, every case at `expected 200, received 500` (and `413`/`403`/`422` for
  the refusal cases) — so the harness, the seeds and the auth path all work.
- **Probe stub 2 (faithful near-fix):** unit **24 passed (24)**, integration
  **15 passed (15)**, `tsc` clean. The near-fix also corrected two test-side assumptions
  before handoff: the pipeline's validation status is `422` (not `400`), and the `413` must
  come from the handler (D7).
- **Mutation probes** (each restored byte-identically; `sha256` recorded before/after):
  1. drop `|| input.image.hidden` from the pure decision → unit **3 failed | 21 passed** and
     the hidden integration case fails `expected [ …(3) ] to deeply equal [ Array(1) ]`;
  2. add one `findOne` per item in the route (the N+1 shape) → I5 fails
     `expected 414 to be 18`;
  3. make `signedUrlBatchStatus` always answer `200` → unit **2 failed | 22 passed** and
     I3's all-denied case fails `expected 200 to be 403`.
     After the restores the suites were green again (24/24 and 15/15) and both probe files were
     deleted with `rm -f`; `git status --short` shows the two spec files only.

## Assumptions carried in the specs

- **A1** `authentication_required` never escalates to `403` (D4).
- **A2** `not_found` outranks every other denial, so an id that is not a live image of the
  scope event is refused before identity (no existence oracle).
- **A3** hidden denies a matched attendee, and the member branch is left unpinned (O1).
- **A4** `urls[]`/`denied[]` order is not part of the contract; every assertion compares sets
  keyed by `(imageId, kind)`.
- **A5** the TTL bracket allows the signer's whole-second floor (one second of slack), exactly
  as OP-127's thumbnail pin does.

## Open items handed to the GREEN

- **O1** May an event **member** refresh a hidden image's thumbnail/original? §4.4's grid
  signs hidden thumbnails, so "yes" keeps the two surfaces coherent; the pins allow either.
- **O2** The `op_att` anonymous-session variant of I6 belongs to OP-129 (see D8); do not
  build an attendee-session resolver here.
- **O3** The `media.sign` class (120/min per user) is declared by the GREEN but not pinned:
  the harness fires at most four requests per identity, far below the window.
- **O4** `payload_too_large` (`413`) is reused rather than minting a media-specific code; if
  the lane later wants a `too_many_items` code it is an append-only catalogue change, not a
  pin change.
- **O5** `expiresAt` must stay an RFC-3339 UTC millisecond string (`…Z`) — the pin rejects a
  numeric epoch, because the §5.6 example shows the string form.

## Consequences

The signed-URL policy is now executable, so a refactor that keeps the observable behaviour
(per-item authorization, partial `200`, the `authentication_required` exemption, the 24 h/15
min lives, the two-key envelope) breaks none of these 39 pins, while any regression on the
hidden-image bypass, the entitlement gate, the `413` cap or the batched reads breaks at least
one — loudly, with a failure message that names the fact.

## Number allocation

The lane row `OP-126 uploads lane` (`0760`–`0779`) read `Next free = 0764` at this branch's cut,
but the sibling OP-127 lane landed `0764` (`ADR-0764-op127-event-images-followup-pins`) off the same
snapshot (ADR-0300 §7) and its `#439` carries `0765`, so the round-1 review had this record and the
GREEN renumber to `0766`/`0767`; the cell then reads `0768`. No number outside `0760`–`0779` is
touched.
