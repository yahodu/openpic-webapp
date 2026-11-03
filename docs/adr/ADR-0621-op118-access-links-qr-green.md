# ADR-0621 — OP-118 GREEN: access-link rotation and QR generation implemented

- **Status:** Accepted
- **Date:** 2026-11-03
- **Ticket:** OP-118 (Events epic, phase 3 — Events & Collaboration)
- **Card:** `t_5a121a37` (tdd_stage GREEN, backend implementer)
- **Branch:** `OP-118-feature-access-links-qr` (worktree
  `/root/openpic/openpic-webapp/.worktrees/t_4c78aa3d`, stacked on the pins head
  `224eba0`)
- **Supersedes nothing.** Consumes `0621` of the OP-118 lane range `0620`–`0639`
  (ADR-0300 §7); the pins record is
  [ADR-0620](ADR-0620-op118-access-links-qr-red.md).

## Context

ADR-0620 fixed the executable contract for the two §4.2 endpoints and left the
implementation choices to this card. Two of them decide the shape of the code
and are expensive to reverse, so they are recorded here: **how the rotation is
written** (the alternative leaves a two-active-link window) and **how the QR
answer stays byte-identical on a repeat request** (an `exp` minted per request
moves on a second boundary).

## Decision

### Rotation is one server-side array update

`POST /api/v1/events/{eventId}/access-links:rotate` performs the rotation with a
single `findOneAndUpdate({ _id }, pipeline, { returnDocument: "before" })` inside
`withTransaction`, so the write that revokes the previous link and the write that
appends the new one are the same document update:

- the pipeline prepends the new element and rewrites every currently
  `active: true` element to `active: false` with the rotation instant in
  `revokedAt`, so the engine's per-document serialisation is the invariant
  ("exactly one active link") — a read-modify-write would leave a window in
  which zero or two links are active;
- `returnDocument: "before"` names the link that was active at the instant of
  the write, so the response and the `Previously printed QR codes for <slug> …`
  warning describe the link this request actually revoked, not one a concurrent
  rotation replaced;
- the `event.link.rotated` outbox row joins the same transaction
  (`emitDomainEvent(..., { db, session })`), so a failed rotation leaves no
  event and a committed one always has its event.

`{ confirmUnderstood: true }` is validated in the handler, not by the body
schema: the contract's refusal is `422 acknowledgement_required`, and a schema
refusal would answer the generic `validation_failed` instead. A missing or
`false` acknowledgement therefore writes nothing.

### The QR cache is keyed on the content hash and carries its signed URL

`GET /api/v1/events/{eventId}/access-links/{slug}/qr` renders the image, hashes
the bytes (lowercase SHA-256) and treats that hash as the cache key — which is
what the card's second acceptance criterion asks for and what schema §16.1
already makes the `mediaAssets` identity:

- **object**: written through `getObjectStorage().putObject("exports", …)` only
  on a miss, at `buildObjectKey(contentHash, ext)`;
- **row**: one `mediaAssets` document per `(tenantId, contentHash)` with
  `kind: "export"` (the unique `media_assets_tenant_content_hash_unique` index
  dedupes a racing second request);
- **signed URL**: minted once with `createMediaSigner({ … })` for the `export`
  derivative and persisted on the row as `qrUrl` / `qrExpiresAt`, so a repeat
  request answers the **same** URL and `expiresAt` (I2 asserts the whole body
  with `toEqual`). A row whose URL has expired is re-signed and rewritten — the
  object itself is never regenerated, so the stored-object count stays one.

The `expiresAt` in the answer is the media URL's own expiry (the `export` TTL,
15 minutes), not a gallery-retention instant.

### Contract and dependency surface

- `access_link_revoked` (`410`) is appended to `EVENT_ERROR_CODES`
  (`packages/contracts/src/errors.ts`) and `EVENT_ERROR_TRANSPORT`
  (`apps/web/src/server/http/catalog.ts`) — **never** to `ERROR_CATALOG`, which
  `apps/web/src/server/http/errors.test.ts:53` pins to exactly the contract's
  Appendix A key set.
- `acknowledgement_required` is reused as-is (it is already a catalogue code,
  `422`); no new code is invented for the confirmation.
- `buildObjectKey` admits `pdf`, the one non-image extension the `export`
  derivative now produces; the file's existing pins stay green because `pdf`
  was not in their rejected set.
- New runtime dependencies in `apps/web`: `qrcode` (raster + SVG renderer),
  `pdf-lib` (PDF wrapper), and the dev type package `@types/qrcode`.
- Both routes read their own path segments (the pipeline exposes no Next
  `params`): the event id at `segmentFromEnd: 2` (rotate) / `4` (QR), the slug
  at `segmentFromEnd: 2` (QR).

## Consequences

- A rotation now costs one transaction with one document write plus the outbox
  insert; there is no read-then-write race to test around, which is what the
  follow-up pin card (`t_451b5476`, eight concurrent rotations) will exercise.
- The QR answer is stable for the lifetime of the signed URL; a client that
  caches it sees the same `exp` until it expires, after which a new signature is
  minted on the next request.
- The `mediaAssets` row carries two QR-specific fields (`qrUrl`, `qrExpiresAt`).
  They are additive and tenant-scoped like every other media row; no other
  reader of the collection asserts an exact key set.
- A slug that is not on this event's `accessLinks` is `404` (never an oracle);
  a slug that exists and is revoked is `410` with `details.message`.

## Alternatives considered

- **Read-modify-write with a write predicate** — rejected: it needs a retry loop
  whose refusal path no current pin exercises, and it still relies on the
  predicate to close the window the pipeline closes by construction.
- **Signing the URL on every request** — rejected for the reason above: `exp`
  moves, so the second answer differs and I2's `toEqual` fails (or flakes on a
  second boundary).
- **Storing the QR bytes in the `events` row / a new collection** — rejected:
  schema §16.1 already owns content-addressed export assets, and a second
  identity would duplicate the dedupe.
- **Returning the image bytes from the control plane** — rejected by §4.2 (the
  signed URL is the answer, §5.6–§5.7 keep the byte path off the control plane).

## Evidence at handoff

- Both pin files green: `access-links-qr.test.ts` **14 passed**, `event-access-links.test.ts` **14 passed**.
- Full `unit` project **141 files / 2276 passed | 3 skipped**; full `integration`
  project green; `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; ESLint 0
  errors on every touched file; `prettier --check` clean; the ADR-numbering guard
  green.
- Coverage: see the PR body (global lines/branches/functions/statements above
  their 80 % bars).

## Coverage gaps for the next Test-Author cycle

Behaviours this GREEN implements that the current pins do not constrain:

1. `format=pdf` renders a real PDF (`application/pdf`, `.pdf` object key) — no
   case requests it.
2. The expired-signed-URL refresh path (`cachedSignedUrl` returns `undefined`)
   — nothing travels 15 minutes of media TTL.
3. A rotation on an event whose stored `accessLinks` carry no active element
   (answers `409 conflict` today, nothing written).
4. A `slug` that is not on this event at all (answers `404`) — named as finding
   F2 and routed to `t_451b5476`.
