# ADR-0785 — OP-130 GREEN: public event resolution (`GET /api/v1/p/events/{slug}`)

- **Status:** Accepted (GREEN implementation)
- **Consumers:** the OP-130 pins — `public-event-format.test.ts` (U1, 10 cases),
  `public-event-state.test.ts` (U2, 17 cases),
  `apps/web/src/test/integration/public-event-resolution.test.ts` (I1–I5 + the
  §0.11 class pin, 36 cases), `apps/web/e2e/public-event-resolution.spec.ts` (E1)
- **Lane:** OP-130 (epic Attendee Surface). Continues the shared attendee block
  `0769`–`0788`: [ADR-0784](ADR-0784-op130-public-event-resolution-red.md) took
  `0784` and moved the ledger cell to `0785`, which this record consumes (cell →
  `0786`).
- **Consumes:** `0785`. **Supersedes:** nothing. **Amends:**
  [ADR-0784](ADR-0784-op130-public-event-resolution-red.md) §Open question 1
  (the contract appendix now carries `event.description`).

## Context

ADR-0784 fixed the executable contract for the attendee landing call and left the
implementation choices open: where the refusals are thrown, how the slug is
resolved, where `selfie`/`consent` values come from, and what a refusal body may
carry. The GREEN has to answer those without widening the surface: the pins are
the specification, and every file this record adds is traced to a pin below.

## Decision

### 1. Two pure decisions, one I/O projection

`apps/web/src/server/attendee/public-event.ts` exports exactly what U1/U2 import:

- `formatStartAtLocal(startAt, timeZone)` — `Intl.DateTimeFormat` with
  `hourCycle: "h23"` and `timeZoneName: "longOffset"`, projected through
  `formatToParts`. The offset comes from the formatter **at that instant**, so
  both 2026 `America/New_York` transitions render correctly and nothing is cached
  per zone. `longOffset` answers a bare `GMT` for a zero offset, which becomes
  `+00:00` — `startAtLocal` never says `Z`.
- `resolvePublicEventOutcome(facts)` — the §6.1 table in contract order. The
  refused rows are a private `refusalFor` helper so the rendering path reads as
  one expression. `status === null` sits **with** `draft` in row 3 rather than in
  row 1: row 1 is "the slug names no link", and a revoked link is refused before
  any status is consulted, so a caller that resolves revocation without loading
  the event cannot accidentally answer `404`.
- Retention is inclusive (`now >= retentionExpiresAt`), matching the TTL
  semantics the rest of the platform uses, and an unbounded retention
  (`null`) is open forever.

### 2. The route: one active-slug query, one probe

`apps/web/src/app/api/v1/p/events/[slug]/route.ts` is
`defineRoute({ route: "/api/v1/p/events/:slug" })` with **no** auth stage, the
`public.gallery` rate stage, and the slug read off `request.url` (a directly
invoked handler sees no Next `params`).

- The **active** lookup is
  `{ accessLinks: { $elemMatch: { slug, active: true } } }`. It is `$elemMatch`,
  not `{ "accessLinks.slug": slug, "accessLinks.active": true }`, because the
  latter matches two _different_ elements of the multikey array and would serve
  an event whose only active link is some other slug. It is also the only shape
  the schema §21 partial index (`accessLinks.slug`, partial on
  `accessLinks.active: true`) can serve, so the hot path stays index-only.
- Only after an active miss does a second, `_id`-projected probe run on
  `{ "accessLinks.slug": slug }`; a hit is `revoked`, a miss `unknown`. That is
  what keeps "get the current link" (`410`) distinguishable from "wrong QR"
  (`404`) without paying for it on every successful landing call.
- `accessLinks[0]` is never read (the I5 order pin puts the revoked element
  first).
- Refusals are `appError(...)` throws, so the shared `10.4` envelope carries
  `error` as the only top-level key. `access_link_revoked` adds
  `details: { message }` with the §6.1 sentence verbatim; `not_found` and
  `event_gone` add nothing — a rotated QR's holder and a stranger holding a
  `deleting` event's slug both stay strangers to the event (F2 pins).
- The `200` carries `cache-control: private, max-age=30` and exactly the six
  §6.1 sections; the handler's body is projected through a strict Zod schema, so
  a stray field is a serialization failure rather than a leak.

### 3. `logoUrl`, `selfie`, `consent`, `session`

- **`logoUrl`** — the `thumbnail` derivative of `events.logoAssetId`, read
  tenant-scoped from `mediaAssets` and signed with
  `createMediaSigner({ currentSecret: getConfig().media.signingSecretCurrent[, previousSecret] })`,
  the same composition the branding upload uses. The extension is the stored
  `derivatives.thumbnail.format`, defaulting to `webp` (the pipeline's photo
  thumbnail format) because the seeded asset carries no derivative row. A
  missing asset row answers `null`, never a broken URL.
- **`selfie`** — `acceptedMimeTypes` and `maxBytes` are the platform's upload
  allow-list and ceiling (`settings.upload.*`); `livenessRequired` is `true`
  because §6.3 makes the challenge a precondition of every selfie;
  `attemptsAllowed` is the tenant's `selfies.per_attendee` entitlement
  (`checkEntitlement(..., amount 0)` — a read-only verdict, so a public GET can
  never consume budget) falling back to a new `settings.selfie.attemptsAllowed`
  when the active plan does not gate the key; `attemptsUsed` is `0` (a non-zero
  count needs the `selfies` rows OP-131 owns).
- **`consent`** — `required: true`, `purpose: "biometric_processing"`, and
  `policyVersion`/`policyUrl` from a new `settings.legal` section; `granted` is
  `false` because §6.2's `POST /p/events/{slug}/consent` is the only writer.
- **`session`** — `kind: "anonymous"` and `canClaimByLogin: true` (the landing
  call resolves only the attendee credential; claiming by login is §6.2).
  `hasProfile` is the profile row for **this event** and **this session**:
  `{ eventId: <this event>, "subject.attendeeSessionId": <session id> }`, read
  tenant-scoped.
- A lapsed `op_att` cookie still renders: the hint lookup hashes the token and
  matches `attendeeSessions.tokenHash` **without** judging `expireAt`, because
  §6.1's error table is closed and has no `401`. Turning a dead cookie into a
  refusal would strand an attendee with no way forward.
- The handler does **not** stamp `accessLinks[].scanCount`: §6.1 does not say the
  landing call is a scan, and ADR-0784 leaves it unpinned.

### 4. Catalogue, settings and contract corrections

- `event_gone` is appended to `EVENT_ERROR_CODES`
  (`packages/contracts/src/errors.ts`) and to `EVENT_ERROR_TRANSPORT`
  (`apps/web/src/server/http/catalog.ts`) as `410`, non-retryable. It is **not**
  added to `ERROR_CATALOG`, which its own spec pins to exactly Appendix A.
  `event_deleting` (`409`) is not borrowed — a write refusal is the wrong
  statement to make to an attendee.
- `platformSettings` gains `selfie.attemptsAllowed` and
  `legal.{biometricPolicyVersion,biometricPolicyUrl}`. Both are Zod-`.default()`ed
  so a singleton seeded before the sections existed still parses; the documented
  defaults are `3` and `biometric-2026-03` /
  `https://openpic.in/legal/biometric/2026-03`.
- `docs/API Contract.md` §6.1's example body and its appendix `PublicEvent`
  interface gain `event.description` — the field the card requires and the
  landing page renders (ADR-0784 §Open questions 1).

## Consequences

- The landing call resolves the slug in at most two indexed reads, then reads
  tenant name, logo asset, the attendee profile and the tenant's selfie
  entitlement. The entitlement resolution (subscriptions → plans → grants →
  counters) is the heaviest part of the call and is deliberately chosen over a
  constant: a Pro attendee must be told the budget the submit route will enforce.
  If the landing call ever becomes a measured hot spot, the answer is a cached
  per-tenant entitlement projection, not a stale page.
- `session.kind` is always `anonymous`: no account credential is read here. A
  signed-in attendee's `user` kind belongs to the §6.2 claim flow, which is not
  pinned by this card.
- The route is one I/O projection: the two decisions live in
  `public-event.ts`, the wire schemas sit beside the handler that serves them,
  and the settings/catalogue edits are one row each. Its length is docblocks and
  six Zod section schemas, not branching logic.

## Evidence

- `npx vitest run --project unit apps/web/src/test/unit/public-event` →
  **27 passed (27)**.
- `npx vitest run --project integration apps/web/src/test/integration/public-event-resolution.test.ts`
  → **36 passed (36)** on a real `MongoMemoryReplSet`.
- Full `unit` project → **2417 passed | 3 skipped (2420)**; full `integration`
  project → **100 files passed**.
- `npx tsc -p apps/web/tsconfig.json --noEmit` and
  `npx tsc -p packages/contracts/tsconfig.json --noEmit` → exit `0`.

## Alternatives

- **Single `{ "accessLinks.slug": slug }` query plus in-memory inspection.**
  Simpler, but it cannot use the partial index, so every landing call would scan
  `events`. Rejected for the platform's widest public read.
- **Resolve revocation by searching the whole `access_links` collection.**
  That collection is the OP-118 projection, not the addressing surface; a
  rotation writes the event document. Rejected.
- **Hard-code `attemptsAllowed: 3`.** Rejected: the entitlement service already
  owns the per-plan answer, and the page must agree with the submit route.
- **Answer the lapsed cookie with `401 attendee_session_expired`.** Rejected:
  §6.1's error table is closed and the page must still render.
