# ADR-0771 — OP-128 follow-up: the signed-URL fallbacks, the corrected U1 precedence rationale and the wider account matrix

- **Status:** Proposed — one row (`423 account_banned`) is RED until the F-G1 GREEN lands; the rest are
  characterization pins, green on arrival
- **Date:** 2026-11-12
- **Ticket:** OP-128 — _batch signed media URL refresh_, phase 4 (Uploads & Media), epic Media
- **Card:** `t_8b3f316e` (TEST follow-up, round-1 findings **F2/F4/F5/F6** plus **F-G3**, Low), worktree
  `/root/openpic/openpic-webapp/.worktrees/t_133a4093`, branch
  `OP-128-task-signed-url-fallback-pins`, cut from `OP-128-task-account-status-gate-pins` at `cfed101`
  (PR #445's squash) and read against `origin` at the cut
- **Consumes:** contract §5.6, §0.3, §0.4, §0.14, §0.15; schema §16.1, §16.3; ADR-0766 (the endpoint
  pins, D3/D4 and the open items), ADR-0767 (the implementation), ADR-0768/ADR-0770 (the account-status
  gate), ADR-0762/ADR-0763 (the §4.4 projection whose `null` thumbnail this record reconciles with),
  ADR-0025 (the auth guard table)
- **Amends:** ADR-0766 assumption **A2** as the RED spec stated it (the pinned precedence never supported
  "an anonymous request cannot distinguish absent from not yours"). **ADR-0768 D1 is not re-asserted
  here**; its supersession by the `423 account_banned` / `423 account_suspended` transport is
  **ADR-0772**'s record, and the `I7` rows that still pin `403` belong to that follow-up.

## Context

The round-1 review of the OP-128 lane measured four residues in the delivered specs and one hole in the
account matrix. None of them is a code defect in the strict sense: every behaviour below is implemented
and was measured on a real Mongo at the lane head. What was missing is the **pin** — the sentence in a
test that makes a future refactor fail loudly instead of drifting.

1. **F2 — two surfaces disagree about a derivative that does not exist.** An asset row with no
   `derivatives.thumbnail.format` is signed as `/t/<contentHash>.webp` (`200`), while
   `toEventImageListItem` (`@/server/images/dto`) answers `thumbnailUrl: null` for the same row. Two more
   fallbacks were implemented and unpinned: an **image row whose `media_assets` row is gone** (`not_found`)
   and a **scope id that resolves no event** (per item `not_found`, credentialed batch `403`).
2. **F4 — the U1 rationale contradicted its own table.** Assumption A2 said `not_found` outranks every
   other denial "so an anonymous request cannot distinguish absent from not yours" (§0.4). The pinned
   precedence (`not_found` → `authentication_required` → `feature_not_available` → `forbidden`) produces
   the opposite: an anonymous caller gets `not_found` for an absent id and `authentication_required` for
   an existing one. A future reader would have trusted the comment.
3. **F5 — a shape assertion banned the tighter type.** `U1`'s last case read `decision.code` on the
   single object shape, so `SignedUrlDecision` had to keep `code?: …` (ADR-0765 D1) and the route kept a
   `code === undefined → internal_error` branch the table cannot reach.
4. **F6 — three stale ADR references** in the two spec headers pointed at the OP-127 records
   (`ADR-0764`/`ADR-0765`) after the round-1 F0 renumber moved this lane to `ADR-0766`/`ADR-0767`.
5. **F-G3 — the account matrix was narrow.** `I7` pinned `suspended`/`deletion_pending`/`banned` and
   two controls. The review measured four more states nobody pinned: an **expired** ban (must stay
   `200`), a **permanent** ban (`banExpires: null`), `status = "deleted"`, and the **413-vs-gate order**
   for a suspended caller's 201-item batch.

During this card the orchestrator took the **F-G1** decision (2026-11-12): the account refusal answers
Appendix A.1's transport, `423 account_suspended` / `423 account_banned` with the guard's `details`, not
the flattened `403 forbidden`. `evaluateAuth("user", …)` already returns exactly those codes and details
(`apps/web/src/server/auth/guards.ts`), so the change is the media route's `throw`, not the guard's table.

## Decision

### D1 — the derivative-less asset keeps the documented `webp` fallback, and both surfaces are pinned

`extensionOf` answers `asset.derivatives?.thumbnail?.format ?? "webp"`, so a legacy or still-processing
row is signed at the conventional `.webp` address. That stays. The reason is the endpoint's own
vocabulary: the §5.6 answer is `urls[]` + `denied[]` and its four denial codes have no "derivative not
ready yet" member, so refusing a thumbnail whose format was never recorded would report a
**still-processing image as absent** (`not_found`) — a worse client answer than a URL that 404s from the
data plane until the derivative exists.

The §4.4 projection keeps the opposite rule — `thumbnailUrl: null` — and that is also right for its job:
a grid must reserve the cell instead of calling the data plane for a 404. The two are therefore
**deliberately different, and both are pinned**: this card adds the signer-side pin
(`I8: … under the documented .webp fallback`) and names the images-side pin that already exists
(`event-images-management.test.ts` — "an image whose thumbnail has not been generated yet is listed with
null thumbnail fields"). Neither surface can change alone without a red test and a reader landing in this
record. Reconciling them (e.g. adopting a `derivative_not_ready` code, or making the grid fall back too)
is a contract change and needs its own card.

The empty-`contentHash` edge (`/t/.webp`) is **not** pinned: `contentHash` is required and unique-indexed
(§16.1), so no pipeline state can produce the row, and freezing a nonsense wire value would invite someone
to rely on it.

### D2 — the U1 precedence is stated as it is, and the strict reading is named as a behaviour change

The precedence stays `not_found` → `authentication_required` → `feature_not_available` → `forbidden`, and
A2 now says what it actually buys:

- every **out-of-scope reason** — missing id, soft-deleted image, another event's image, asset row gone —
  collapses into one code, so the _reason_ (and with it any ownership fact) is never disclosed;
- "in scope" versus "not in scope" **is** still distinguishable: an anonymous caller on a live scope gets
  `authentication_required` for an existing image and `not_found` for an absent one, and on an
  unresolvable scope it gets the `403` collapse instead of a `200`.

Putting `authentication_required` ahead of `not_found` would make the old sentence true, and it would
re-pin the anonymous out-of-scope row (`U1`'s "refuses an anonymous caller's item as not_found before
identity is considered"). That is a behaviour change plus a delivered-case edit, so this card **corrects
the comment and pins the real behaviour** — including the anonymous-on-an-unknown-scope `403` row — rather
than silently inverting the table under an existing pin.

### D3 — the U1 shape pin reads the code through `in`, so the union is allowed

`codeOf(decision)` returns `"code" in decision && decision.code !== undefined ? decision.code : null`.
A discriminated union `{ allowed: true } | { allowed: false; code }` compiles against it, while an allowed
decision that carries a code still fails, and a denial without one still fails (the expected side is read
through the same helper). The assertion is stronger than the old `hasCode` boolean — it also compares the
code value — and no table row changed.

### D4 — the breadth rows, and the transport the refusal must use

Four additive rows in `I7b`, and the F-G1 decision recorded as the contract:

| Case                                             | Pin                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| ban with `banExpires` in the past (`2020-01-01`) | `200`, `denied: []`, both kinds signed with signature + TTL — an expired ban is over, not a life sentence    |
| ban with `banExpires: null` (permanent)          | `423`, `error.code === "account_banned"`, `error.details` `{ banReason: "spam", banExpires: null }`, no URL  |
| `userProfiles.status = "deleted"`                | `403`, `error.code === "forbidden"` — the deletion states keep the `403`, never the `423`                    |
| suspended caller sending 201 items               | `413 payload_too_large` — the item cap runs **before** the account gate, and a reorder would change the wire |

The permanent-ban row is **RED on this branch** (`expected 403 to be 423`): the route still flattens the
guard's answer through `appError("forbidden")`. Its GREEN is the F-G1 card. The other three are
characterization pins, green on arrival.

`I7`'s existing rows still pin `403` for `suspended`/`deletion_pending`/`banned`. They were delivered by
`t_91b4e245` and this card may not edit them; the F-G1 decision supersedes them and `ADR-0772`'s card
re-pins them. That contradiction is recorded here on purpose instead of being hidden by editing another
card's pins.

### D5 — F6: the spec headers are repointed, and no production file is touched

`ADR-0764` → `ADR-0766` in both spec headers (three occurrences), comment-only. The five
production-side occurrences of the same stale numbers belong to `t_f7437615`. This card's diff is the two
spec files plus this record and the ledger rows.

## The pins (what this card adds)

| File                                                             | Change                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/test/unit/media-signed-urls-authorization.test.ts` | comment-only A2 + header corrections, the `codeOf` helper in place of the shape literal, `ADR-0764` → `ADR-0766`. **24 cases, count unchanged, no row edited or weakened**                                                                                                                                                                              |
| `apps/web/src/test/integration/media-signed-urls.test.ts`        | `I8` (6 cases: the `.webp` fallback, the asset-gone pair, the asset-gone-alone `403`, malformed scope, unknown scope, anonymous-on-unknown-scope) and `I7b` (4 cases: the table above); `ADR-0764` → `ADR-0766` twice; `seedBan` gains an optional expiry and `seedAssetWithoutThumbnailDerivative` is new. **21 → 31 cases, no delivered case edited** |

Reused helpers only: `seedWorkspace`, `seedImageWithAsset`, `seedImage`, `seedImageWithAsset`,
`seedProfileStatus`, `seedBan`, `requestSignedUrls`, `successfulAnswer`, `signedEntry`,
`expectSignedThumbnail`, `errorOf`, `body`.

## Evidence (measured on this branch)

**Gates.** Focused unit `media-signed-urls-authorization.test.ts` **24 passed (24)**. Focused integration
`media-signed-urls.test.ts` **30 passed | 1 failed (31)** — the single failure is the intended permanent-ban
row, `AssertionError: expected 403 to be 423`. Full suites, `tsc`, ESLint, Prettier and the `adr-numbering`
guard are recorded in the card handoff.

**Every new pin was proven load-bearing by a one-line mutation of production code, then reverted
byte-identically:**

| Mutation                                                 | New reds                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `extensionOf`: `?? "webp"` → `?? "jpeg"`                 | the `.webp` fallback row                                                          |
| the asset-gone arm dropped from the decision input       | the asset-gone pair **and** the asset-gone-alone `403`                            |
| `isUnbanned`'s expiry branch → `return false`            | the expired-ban row                                                               |
| `"deleted"` dropped from the deletion branch             | the deleted-status row                                                            |
| the item cap moved **after** the account gate            | the 413-order row                                                                 |
| `ObjectId.isValid` guard dropped from the scope id       | the malformed-scope row (a thrown BSON error, not a `403`)                        |
| `authentication_required` moved **ahead of** `not_found` | the unit anonymous out-of-scope row, the U1 shape row, the I8 anonymous-scope row |

Restored hashes: `route.ts` `ae0fa71f…`, `auth/guards.ts` `97212f51…`, `media/signed-urls.ts`
`2b3f9793…`; `git status --short` shows the two spec files only.

## Consequences

- **O1 — the `I7`/`I7b` contradiction is temporary and owned.** Until ADR-0772's card lands, the suite
  contains a `403` row and a `423` row for the same guard. The follow-up re-pins `I7`; whoever lands it
  must read this record first.
- **O2 — the two thumbnail surfaces stay different by decision.** A reader who wants them equal needs a
  new denial code or a grid change; D1 is the record to argue with.
- **O3 — the empty-`contentHash` edge stays unpinned** (D1), and the `auth.denied` log for an account
  refusal (**F-G2**) is `t_4b4c1a41`'s card, not this one.
- **O4 — the `media.sign` rate class and the hidden-image-for-a-member question** stay as ADR-0766 left
  them (O1/O3); this card neither re-opens nor pins them.
