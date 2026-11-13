# ADR-0799 — OP-133 follow-up pins: the `preview-url` success path and the `/me` selfie summary

- **Status:** Accepted
- **Consumers:** `apps/web/src/test/integration/attendee-media-access.test.ts`,
  `apps/web/src/test/integration/attendee-participation-status.test.ts`.
- **Lane:** the shared attendee block `0780`–`0798` (row
  `OP-129 attendee identity lane`) was already fully minted or reserved at the
  branch cut on `origin/main` `4cff381`. `git ls-tree -r --name-only origin/main`
  holds `0780`–`0794` and `0796`; open PR heads hold `0790`–`0797`; and `0798`
  was claimed **in flight** by the OP-132 failed-purge GREEN worktree
  (`.worktrees/t_edad86b6/docs/adr/ADR-0798-op132-purge-before-delete-claim.md`,
  minted `2026-11-13 04:04:44`, five minutes before this card's first commit at
  `04:09:32`). This record therefore yields `0798` and draws `0799` — the head
  of the `unallocated (future lanes)` pool and the first number unused on the
  trunk, on every open PR head and in every worktree. The attendee cell and the
  pool cell both advance to `0800`, so the next attendee-lane card takes a fresh
  block from `0800` instead of minting into the exhausted `0780`–`0798` block.

- **References:** [ADR-0793](ADR-0793-op133-attendee-gallery-red.md) §6 (the
  two hide semantics, whose `event_images.visibility` predicate the
  organizer-hide refusal pins) and its **Consequences** bullet "`preview-url` is
  pinned for the refusal only" (I11) — the sentence that left this success path
  out of the RED pack — plus §10 (`/me`'s fourteen-key body, which carries
  `selfie` but never asserted it);
  [ADR-0794](ADR-0794-op133-attendee-gallery-green.md) §13 (identified-only, and
  **no** `originals.download` gate on a preview) and §18 (the pin-correction
  precedent on card `t_c6d20dea`).
- **Consumes:** `0799`.

## Context

Card `t_c6d20dea` (the OP-133 pin correction that landed as PR #547, squash
`c659947`) routed one Low finding here: two success paths the GREEN shipped have
no assertion at all. `attendee-media-access.test.ts` asserted the anonymous
`401` on `POST …/images/{imageId}/preview-url` and nothing else, and
`attendee-participation-status.test.ts` declared `/me`'s `selfie` field as
`unknown` without a single case reading it.

Both paths are live on `main`, so this card is a **characterisation** pin pack:
the cases are expected to pass on the first run, there is no RED to hand off and
no GREEN sibling is created. A green pin is proved meaningful by mutation
instead (below), not by a red run.

Two premises in the card did not survive contact with the shipped code, and the
pins follow the code, not the card:

1. **`preview-url` answers `201`, not `200`.** §6.6's envelope is the same three
   keys as an original, and every attendee media URL mints through
   `signAttendeeMedia`, which the routes answer with `status: 201`.
2. **The preview route carries no plan gate.** It calls `requireSignableImage`
   with no `entitlementKey`, so `feature_not_available` is **unreachable** on
   this route — exactly as [ADR-0794](ADR-0794-op133-attendee-gallery-green.md)
   §13 decided ("a preview is not an original"). Pinning a `403
feature_not_available` here would have pinned a code this route can never
   produce. The plan refusal is therefore pinned **where it lives**, on
   `original-url`, and the preview case pins the other half of the same decision:
   the plan that withholds originals still grants the preview.

## Decision

### 1. The preview answer: `201`, `/p/`, two hours, verified signature

A matched, plan-permitted, **identified** attendee (`subject.kind === "user"`;
an `op_att` session is refused, see §3) gets the three §6.6 keys and nothing
else, `ttlSeconds: 7200` — the §5.6 `preview` lifetime, strictly between the
900-second original and the 24-hour thumbnail — and a URL whose pathname is
exactly `/p/{contentHash}.jpg`. The case asserts the pathname literally, so a
derivative signed with the original's segment (`/o/`) fails; it also asserts
`?exp=` is a future whole second, `?sig=` is present, the URL **verifies** with
the app's own signer (`createMediaSigner({currentSecret})`), and `expiresAt`
brackets the request's own clock reads at `now + ttlSeconds`. `201` is pinned by
`bodyOf(response, 201, …)`, which fails loudly on any other status.

### 2. The plan gate is pinned at its real home

One case seeds a plan whose `originals.download` entitlement is disabled and
sends both requests at the same image: the preview answers `201` with a `/p/`
URL, the original answers `403 feature_not_available`. That is the whole
decision of ADR-0794 §13 in one executable row, and a future change that gates
previews on the plan (or forgets to gate originals) reddens it.

### 3. The preview's refusals keep their documented order and shape

`requireSignableImage` fixes the order (§6.6, §0.4) and each arm now has a case:

- an id that names no live image of the event → `404 not_found`;
- a visible image the caller holds no match for → `403 forbidden`;
- an image the **organizer** hid (`event_images.visibility: "hidden"`) →
  `403 forbidden` **even though the caller is in it** — the predicate
  [ADR-0793](ADR-0793-op133-attendee-gallery-red.md) §6 hands this gate;
- an anonymous attendee session (`op_att`, so a real credential and a real
  profile) → `403 forbidden` with `details.reason: "identified_only"`. That is
  the route's own distinction from the no-credential `401` (I11), and it is the
  only observable of the identified-only rule.

### 4. `/me`'s selfie summary: the seven keys, projected from the active selfie

The spec now types the projection instead of declaring it `unknown`
(`SelfieSummary`, the shape of `selfieSummarySchema`) and pins an
**activated** selfie — driven through the shipped submit → worker → confirm
path, never a hand-inserted row. The summary carries exactly `accepted`,
`attemptsRemaining`, `attemptsUsed`, `id`, `liveness`, `previewUrl`, `quality`;
`id` is the confirmed selfie's id; `accepted` and `quality.accepted` are `true`
with `rejectionReason: null`; `liveness` is `{required: true, passed: true}`;
the budget is one attempt used of the default three.

`previewUrl` is the §6.4 "your photo" tile: a signed **thumbnail**
(`/t/{contentHash}.webp`, the asset carries no `derivatives.thumbnail`, so the
signer's documented `.webp` fallback applies), verified with the app's signer,
its `?exp=` in the future. It is never the original's `/o/` path — that is what
"a signed preview URL that is not the original key" means.

### 5. `selfie: null` and the `no_selfie` wire status before a submission

A profile created by the consent route and never submitted carries
`selfie_pending` and no attempts, which §6.4 names `no_selfie` on the wire; the
case asserts both `selfie: null` and `status: "no_selfie"` and that the stored
row holds no `activeSelfieId`. The fixture is the shipped consent route, so the
stored state is the pipeline's own, not a hand-set status.

### 6. A poll is a read: a stable summary, no badge cleared, no attempt consumed

Two consecutive `GET`s of the same profile return the same `selfie.id`, the same
`liveness`/`quality` verdicts and the same `attemptsUsed`, and the preview URL
signs the same **pathname** (the token may be re-minted across a second
boundary — asserting URL equality would flake). Both polls keep
`newMatchCount: 2`, the two `face_matches` rows keep `seenAt: null`, the profile's
`lastSeenGalleryAt` stays `null`, and the event still holds exactly one `selfies`
row: a poll never spends an attempt and never fires the seen watermark.

## Consequences

- **No production change.** `git diff --name-only` shows the two spec files,
  this record and `docs/adr/README.md`. `prettier --check`, `eslint` over both
  specs and `tsc -p apps/web/tsconfig.json --noEmit` are clean.
- **Case counts.** `attendee-media-access.test.ts` 8 → 14 cases (six new, one
  `describe`); `attendee-participation-status.test.ts` 8 → 11 (three new). Both
  files are green on the branch cut (`origin/main` `4cff381`): 14 passed and 11
  passed respectively; the full `--project unit --project integration
--coverage` run is recorded in the card handoff.
- **The pins bite.** Each was proved by one-line mutation of the shipped file,
  restored byte-identically afterwards:
  - `signAttendeeMedia("preview"` → `"original"` in the preview route →
    `AssertionError: expected 900 to be 7200` (1 failed | 13 skipped);
  - the route's `subject.kind !== "user"` guard removed → `expected 201 to be
403` on the `identified_only` case (1 failed | 13 skipped);
  - `… || image.visibility === "hidden"` dropped from `requireSignableImage` →
    `expected 201 to be 403` on the organizer-hide case (1 failed | 13 skipped);
  - `/me`'s `selfie,` projection replaced with `selfie: null` → the summary case
    fails on its own "expected a selfie summary, received null" throw
    (1 failed | 10 skipped);
  - `kind: "thumbnail"` → `"original"` in `selfiePreviewUrl` → `expected
'/o/f17568c9…' to be '/t/f17568c9…'` (1 failed | 10 skipped).
- **`feature_not_available` stays unreachable on `preview-url`.** If a later
  card wants previews gated by plan, it must amend ADR-0794 §13 first; this
  record pins the decision as shipped rather than leaving it to drift.
- **The attempt budget is a settings default** (`settings.selfie.attemptsAllowed`
  = 3, the same `ATTEMPTS_ALLOWED` constant the OP-132 spec uses), so a tenant
  entitlement that changes it would need its own case; this pack pins the
  default-path projection only.
- **Out of scope:** the preview's rate-limit bucket, a re-minted token after
  expiry (only "still valid and same path" is pinned), and a **rejected** selfie
  summary (`quality.accepted: false` with a `rejectionReason`) — the OP-132
  specs already pin the rejected envelope on the submit path.
