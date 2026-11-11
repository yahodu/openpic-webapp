# ADR-0620 — OP-118 RED: access-link rotation and QR generation pinned

- **Status:** Accepted
- **Date:** 2026-11-03
- **Ticket:** OP-118 (Events epic, phase 3 — Events & Collaboration)
- **Card:** `t_4c78aa3d` (tdd_stage RED, test-author)
- **Branch:** `wt/t_4c78aa3d` (worktree `/root/openpic/openpic-webapp/.worktrees/t_4c78aa3d`)
- **Range:** `0620`–`0639` (drawn as this lane's first card; the allocator pool
  advances to `0640`+, no number outside the block is touched)

## Context

Contract §4.2 specifies two endpoints that give an organizer control over a
compromised event link and over the QR codes already printed for it:

- `POST …/events/{eventId}/access-links:rotate` — pushes a new `accessLinks[]`
  element and marks the previous one `active: false` + `revokedAt` (schema
  §15.1), after a mandatory `{ confirmUnderstood: true }` acknowledgement,
  answering `{ accessLinks, warning }` and emitting `event.link.rotated`.
- `GET …/events/{eventId}/access-links/{slug}/qr?format=png|svg|pdf&size=256..2048`
  — generate once per link, store the image as a content-addressed
  `mediaAssets` row (`kind: "export"`), and answer a redirect-free signed URL
  (`{ url, expiresAt, format, size }`).

The card's executable scope was four integration cases (I1–I4) and two unit
cases (U1, U2). Everything else the contract leaves implicit is fixed here so
the GREEN has one authority. This ADR records **test-only decisions**: the RED
delivers two spec files, no production code.

## Decision

### Module and route contract

- **`@/server/events/access-links`** exports three pure helpers:
  - `buildAccessLinkShareUrl(baseUrl: string, slug: string): string` — the
    public event link `${baseUrl}/e/${slug}`.
  - `buildQrPayloadUrl(baseUrl: string, slug: string): string` — the string the
    QR image encodes; today the same public link.
  - `parseQrQuery(searchParams: URLSearchParams): { format, size }` — the
    query validator; anything outside `png|svg|pdf` × `256..2048` throws
    `AppError("validation_failed")` with `details.fields[].path` naming the
    offending parameter.
- **Route modules** (the OP-117 global family, not the contract's
  tenant-scoped spelling — the global family is the one that admits a
  co-organizer who holds no `tenantMembers` row, ADR-0580 §D1):
  - `@/app/api/v1/events/[eventId]/access-links:rotate/route` → `POST`,
    `route: "/api/v1/events/:eventId/access-links:rotate"`.
  - `@/app/api/v1/events/[eventId]/access-links/[slug]/qr/route` → `GET`,
    `route: "/api/v1/events/:eventId/access-links/:slug/qr"`.
- **Two new error codes**: `acknowledgement_required` (already in the
  catalogue, `422`) is reused for the missing confirmation; `access_link_revoked`
  (`410`) must be appended to the contracts error enum and the server error
  catalogue (card scope §3, which asks the decision be recorded — it is: `410`,
  not `404` and not "still downloadable for audit").
- `event.link.rotated` is **already** a registered notification key
  (`notification-types.values.ts`), so no catalogue work is owed for the emit.

### Answer shapes pinned

- Rotate: exactly `["accessLinks", "warning"]`; the **new** link first
  (`{slug, active: true, shareUrl}`), the revoked one second
  (`{slug, active: false, revokedAt}`); `warning` is the contract's own sentence
  `Previously printed QR codes for <revokedSlug> will no longer work.`
- QR: exactly `["expiresAt", "format", "size", "url"]`; `url` is
  `https://pic.openpic.in/o/<sha256-hex>.<ext>?exp=<s>&sig=<b64url>` and must
  verify against `MEDIA_SIGNING_SECRET_CURRENT` through the existing
  `createMediaSigner` — no `3xx`, no `location` header.

### Assumptions (resolved unilaterally; review them here)

- **A1 — builder signatures take the base URL as an argument.** The card's U1
  says "uses the public base URL from config". A pure builder cannot prove the
  config wiring alone, so the wiring is pinned **observationally** in I1: the
  rotate answer's `shareUrl` must equal `<APP_BASE_URL>/e/<newSlug>` for the
  test environment's configured value. The builder must tolerate a trailing
  slash on the base URL (`https://openpic.in/` is a legal `APP_BASE_URL`).
- **A2 — the QR payload _is_ the public share link.** Two functions, one value:
  `buildQrPayloadUrl` is the seam a later per-channel tracking parameter would
  use, so the equality is pinned instead of leaving it unpinned.
- **A3 — `format` and `size` are optional, defaulting to `png` and `1024`**
  (the contract's own example spells `?format=png&size=1024`). Only bounds and
  membership are asserted; the card names no default and the contract does not
  forbid one.
- **A4 — the QR cache key is `(slug, format, size)`.** Two identical downloads
  are one stored object; a different `format` is a second object. Whether the
  implementation keys on `accessLinks[].qrAssetId` or on the content hash is
  deliberately **not** pinned — only storage/row counts and the answered body
  are.
- **A5 — `mediaAssets.tenantId` is a string.** `mediaAssets` is in
  `TENANT_SCOPED_COLLECTIONS`; the spec pins the stored row's `tenantId` to the
  event tenant's hex string, exactly as the branding-upload lane does.
- **A6 — a revoked slug answers `410 access_link_revoked` with
  `details.message`.** The card left this open; the API contract's own `410`
  row already names "revoked access link", so `410` is the contract-consistent
  choice over `404` (an oracle question) or "still downloadable".
- **A7 — the QR endpoint admits every event member** (organizer,
  co-organizer, tenant member), as §4.2's "Auth `user` + event member" says;
  rotation stays organizer-only. Unauthenticated `401`, unrelated `404`.

### Extra cases beyond the card's list

- **Rotation**: missing/`false` `confirmUnderstood` → `422
acknowledgement_required` writes nothing; outsider `404`; unauthenticated
  `401`; ordering + `warning` text; the stored single-active invariant; the
  `event.link.rotated` outbox row.
- **QR**: signature verification via the real signer; a different format is a
  different asset; invalid `format` → `422`; revoked slug → `410`; co-organizer
  `200`; outsider `404` with no asset written; unauthenticated `401`.
- These are all in the GREEN card's own `scope_and_implementation_notes` (§§1–3)
  or directly in contract §4.2, so they are contract surface rather than
  invention.

## Consequences

- The GREEN must add the `qrcode` (and, for `pdf`, `pdf-lib`) dependency: the
  card names both libraries and neither is in `pnpm-lock.yaml` today. The pins
  never import them, so the RED carries no dependency change.
- `access_link_revoked` is a new contracts error code; the GREEN owes the
  enum + catalogue + transport-status rows in the OP-102/OP-117 append-only
  shape.
- The two route paths sit on the global `/api/v1/events/{eventId}` family,
  consistent with OP-117's PATCH/archive/delete and `upload-window:extend`;
  the deviation from contract §4.2's tenant-scoped spelling is the lane's
  standing decision (ADR-0580 §D1, ADR-0601 §Path decision) and is repeated
  here so no later reader re-litigates it.
- The rotation write must be **one** `$set` of the whole array (or an atomic
  array pipeline update): a two-step "deactivate then push" leaves a window in
  which either zero or two links are active, and I1 asserts the post-answer
  invariant.

## Alternatives considered

- **A separate `access_links` collection** — rejected: schema §15.1 keeps the
  links embedded (1–3 rows per event), and the rotation is one array write.
- **`404` for a revoked slug** — rejected: the link still exists and the
  organiser's audit trail needs to distinguish "never existed" from "rotated
  away"; contract §4.2's `410` row already names exactly this case.
- **Returning the QR bytes directly** — rejected by the contract ("redirect-free
  signed URL in JSON"), which is also what keeps the control plane out of the
  byte path (§5.6–§5.7).
- **Pinning the content-hash computation itself** (e.g. `sha256(bytes)`) —
  rejected as an implementation detail: the observable is "one stored asset,
  one signed URL, reused on the second request".

## Evidence (RED at handoff)

- 2 new files, **no production code** (`git status` shows the two specs only):
  - `apps/web/src/test/unit/access-links-qr.test.ts` — U1 (4 cases) + U2 (12
    cases, four of them `it.each` rows).
  - `apps/web/src/test/integration/event-access-links.test.ts` — I1 (2), I3 (3),
    I2 (3), I4 (2) and four further contract cases; 14 cases.
- With throwaway stubs at the three intended module paths (deleted before
  handoff, `git status` clean): `npx tsc -p apps/web/tsconfig.json --noEmit`
  exit `0`; the unit spec ran **12 failed | 2 passed (14)** and the integration
  spec **14 failed (14)**, every failure assertion-level (`expected "…" to be
"https://openpic.in/e/k7m2xq9p"`, `expected the call to throw, but it
returned`, `expected 500 to be 200/403/404/410/422/401`).
- At handoff the RED is the honest missing-module failure:
  `Cannot find package '@/server/events/access-links'` and
  `Cannot find package '@/app/api/v1/events/[eventId]/access-links:rotate/route'`.
- `eslint` 0 errors (1 accepted `security/detect-object-injection` warning on
  the shared `requireHandler` helper, the OP-117 precedent) and
  `prettier --check` clean on both files.

## Review — round 1 (carried unchanged)

The round-1 review of the paired GREEN (card `t_5a121a37`, sign-off
`t_f55a6e5f`) found no contradiction in this RED record — the A1–A7 assumptions
and the pinned answer shapes hold on the merged trunk; the findings and routing
are in ADR-0621 §Review — round 1.

## Review — round 1 follow-up pins (card `t_451b5476`)

The round-1 review's three coverage gaps were closed with three pins appended to
the same two specs (test-only: no production file, no existing assertion changed
or relaxed). These pins add no decision beyond §Decision and §Consequences, so
**no ADR number is consumed**.

- **R1 — rotation under concurrency.** Eight `POST …/access-links:rotate`
  requests on one event, in flight together (`Promise.all`), must each answer a
  settled HTTP status — no throw, no `500` — and leave the stored row with
  exactly one `active: true` element and a `revokedAt` on every other one. A
  loser may serialise, retry or answer `409`; only a `500` violates the
  contract. **RED on the merged trunk** (`1aeca52`), deterministically 3/3
  isolated runs: three of the eight answer `500`. The write itself is one array
  pipeline, so the stored invariant survives; the `500` comes from
  `@/server/db/transaction`, whose three-attempt cap is exhausted by eight
  writers on one document and surfaces as `TransactionRetryLimitError`. Cannot
  be weakened — routed to the GREEN sibling card `t_a37c8098`
  (`openpic-webapp-backend-coder`, gated on this card). Distinct from the
  `409`-after-commit defect pinned by `t_b0d14648`.
- **R2 — object-level slug scope (two cases).** A well-formed slug that is not in
  the event's `accessLinks` answers `404 not_found`, stores nothing and never
  calls `putObject`; the same holds for a slug that belongs to another tenant's
  event (the slug is globally unique, so the event scope is what bounds it).
  Both **GREEN on arrival** — characterisation pins for §A7's event-scoped read,
  kept so the scope cannot regress.
- **R3 — builder edge.** `buildAccessLinkShareUrl("https://openpic.in/", …)`
  collapses the trailing slash directly, so the two builders cannot diverge.
  **GREEN on arrival** (§A1).
- Evidence at this card's head: unit `15 passed`, integration `1 failed | 16
passed` (the R1 arm), ADR guard `29/29`; `prettier --check` clean and
  `eslint` 0 errors (the one accepted `security/detect-object-injection` warning
  on the pre-existing shared `requireHandler` helper).

## GREEN — round 1 follow-up (card `t_a37c8098`)

R1 is fixed without weakening it and without a new decision, so **no ADR number
is consumed** (the lane cell stays `Next free 0622`).

- **Decision — an exhausted write race is a `409`, not a `500`.** The rotation
  still runs as the single transactional array update of §Consequences, with the
  unchanged three-attempt budget. `@/server/db/transaction` now exports
  `isTransactionRetryLimitError(error): boolean` — a predicate over its own
  `TransactionRetryLimitError` (the class stays module-private, so the public
  surface is a boolean rather than a private name). The rotate handler attaches
  a `.catch` to the `withTransaction` call: an exhausted-retry signal is
  re-thrown as `appError("conflict")` (`409`), and every other error — including
  the callback's own `not_found` — propagates unchanged, so a genuine failure is
  still not swallowed.
- **Why the aborted attempt leaves the stored invariant intact.** The retry cap
  fires _inside_ the callback, before the driver commits, so the whole attempt —
  the array pipeline write and the `event.link.rotated` outbox insert, which
  share the session — is aborted. A losing request therefore stores nothing and
  emits nothing: exactly one `active: true` element survives, every other one
  carries a `revokedAt`, and `event.link.rotated` is emitted once per **committed**
  rotation. The answer is a settled `409`, which R1 permits ("a loser may
  serialise, retry or answer `409`").
- **Rejected alternative — raising `maxAttempts` only.** A larger budget shrinks
  the number of losers but cannot bound it: eight writers on one document can
  also spend any fixed budget, which would leave R1 flaky. The deterministic
  guarantee is the mapping, so the budget is left at its default.
- **Evidence at this head.** R1 green, 3/3 isolated runs:
  `TMPDIR=/root/tmp-mongo vitest run --project integration
apps/web/src/test/integration/event-access-links.test.ts` → `17 passed (17)`;
  the run's rejected-request log shows 3 of the 8 concurrent rotations answered
  `409` (the catch arm biting) and the rest `200`. Unit `access-links-qr.test.ts`
  `15 passed`, ADR guard `29/29`; `tsc -p apps/web` exit `0`; `prettier --check`
  and `eslint` clean on both touched files. R2/R3 assertions untouched.

## Review — round 1 (artifact lens) — R1 GREEN follow-up

This sign-off consumes **no ADR number** (the lane cell is already `Next free
0626` on the trunk) and appends nothing to the ledger; `docs/adr/README.md` is
untouched.

| Field         | Value                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewer card | `t_c32ceaf0` (this docs-only sign-off)                                                                                                                                        |
| Reviewed head | `33c47a5` on `OP-118-task-rotation-concurrency-pins`, merged with `origin/main` `c6d1fb6` as `92ca3d0`                                                                        |
| Landed        | PR #391, squash-merged as `81e0b78`                                                                                                                                           |
| Verdict       | **APPROVED WITH FINDINGS** — the R1 pin holds on the merged trunk; the single finding is Info and outside the pinned criteria, so the delivery ships (see §The finding below) |

### What was verified

The numbers below are the reviewer's own, measured on the merged tree at
`92ca3d0`; they are not transcribed from the implementer's handoff.

| Check                                                                                                             | Result                                     |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `event-access-links.test.ts` (integration)                                                                        | **20 passed (20)**, 3/3 isolated runs      |
| R1 (rotation under concurrency), R2/R3 (slug scope, builder edge) and main's F1 refusal pin, all in that same run | green                                      |
| `access-links-qr.test.ts` (unit pins)                                                                             | **15 passed (15)**                         |
| ADR guard (`adr-numbering.test.ts`)                                                                               | **29/29**                                  |
| `prettier --check`, `eslint`, `tsc -p apps/web`                                                                   | clean / 0 errors / exit `0`                |
| PR checks on `92ca3d0`                                                                                            | all 14 pass                                |
| `git diff 92ca3d0 81e0b78` (whole tree)                                                                           | **empty** — reviewed bytes == landed bytes |

### The probe that proves R1 is load-bearing

In a throwaway probe worktree at the merged head, removing **only** the
`.catch(isTransactionRetryLimitError → 409)` arm from the rotate route reddens
R1 with `expected [ 500, 500 ] to deeply equal []` — an exhausted-retry write
race answers `500` again. The rest of the spec stays green. The arm was restored
byte-identically and the probe worktree discarded, so R1 is not green by
accident.

### The merge note

The lane branch predated main's sibling fix PR **#400** (`6227241`, the F1
refusal → `409` before any write). The `origin/main` merge kept both changes:
the `$elemMatch`-scoped `findOneAndUpdate` filter that makes a no-active-link
rotation refuse without writing, and the new `.catch` that maps an
exhausted-retry race to `409`. Neither half was weakened or dropped.

### The finding (Info, no card)

§GREEN above says the lane cell "stays `Next free 0622`". That is stale: the
trunk later advanced the OP-118 cell to `0626`. The historical section is **not
retracted** — it was accurate when written, and the later lane cards moved the
cell; the current value is re-read on the trunk and recorded here. No card is
raised for it.
