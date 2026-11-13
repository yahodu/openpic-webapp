# ADR-0792 — OP-132 GREEN: liveness challenge, selfie submit/confirm/reuse and the attempt budget

- **Status:** Accepted
- **Consumers:** `apps/web/src/server/attendee/liveness-challenge.ts`,
  `apps/web/src/server/attendee/selfie-attempts.ts`,
  `apps/web/src/server/attendee/selfie-submit.ts`,
  `apps/web/src/server/attendee/attendee-rate-limit.ts`,
  `apps/web/src/server/attendee/request-event.ts`,
  `apps/web/src/server/attendee/subject.ts`,
  `apps/web/src/server/repos/cross-tenant.ts`,
  `apps/web/src/server/http/catalog.ts`,
  `packages/contracts/src/errors.ts`,
  `apps/web/src/app/api/v1/p/events/[slug]/liveness/challenges/route.ts`,
  `apps/web/src/app/api/v1/p/events/[slug]/selfies/uploads/route.ts`,
  `apps/web/src/app/api/v1/p/events/[slug]/selfies/route.ts`,
  `apps/web/src/app/api/v1/p/events/[slug]/selfies/[selfieId]/confirm/route.ts`,
  `apps/web/src/app/api/v1/p/events/[slug]/selfies:reuse/route.ts` and
  `apps/web/src/app/api/v1/p/selfies/reusable/route.ts`.
- **Lane:** the shared attendee block `0780`–`0798` (row
  `OP-129 attendee identity lane`), `Next free` read as `0792` at the branch cut
  on `OP-132-task-liveness-selfie-red` (`b257470`). OP-132 is a **dependent**
  ticket of OP-131 and OP-122 and continues the shared attendee block per
  CONVENTIONS §11 rule B; a sweep of `origin`'s `docs/adr` finds no `ADR-0792`.
  This record takes `0792`; the ledger cell advances to `0793`.
- **Amends:** [ADR-0791](ADR-0791-op132-liveness-selfie-red.md) — the six open
  questions that record handed to the GREEN.
- **Consumes:** `0792`.

## Context

ADR-0791 fixed the executable contract for OP-132 and left six questions to the
implementation (§Open questions): where the challenge lives, `liveness_failed`,
the unconfirmed-attempt purge, `uploadSessionId`, idempotency replay and
`GET /me/events`. This record states what the implementation chose, and the one
amendment it owes the contract.

## Decision

### 1. The challenge lives on the attendee profile, as a capped list

`POST …/liveness/challenges` pushes
`{challengeId, challengeKind, spec, nonce, expiresAt, usedAt: null}` onto
`attendeeEventProfiles.livenessChallenges` with `$slice: -5`. No collection is
added (card §1). A **list**, not a single field, because a re-issue must not
invalidate a challenge already on screen: I12 issues two and submits the first
with the second's nonce, which only the mismatch reason can express.

Single use is one conditional update on `usedAt: null` inside the submit
transaction. A replay therefore loses the write, not just the check, and the
route answers `409 already_used`.

`requireConsent` runs before the push, and the upsert's `$setOnInsert` keeps the
route total for a subject whose consent row exists but whose profile does not.

### 2. The evidence binding is decided, not verified

The card's §6 (`liveness_failed`, frame verification, a `LivenessVerifier`
port) has **no case** in the RED pack, so this GREEN does not invent one. What is
enforced is what the contract pins: `livenessEvidence` is required (`422`), and
its `nonce` must be the challenge's own (case-insensitively) or the refusal is
`409 mismatch` (Appendix A row 3587). Frame hashes are accepted and not yet
interpreted — the worker lane owns the verdict, exactly as it owns the embedding.

### 3. Submit is one transaction; the pointer is published after it

Consent → object (`headObject`) → challenge → budget, then one
`withTransaction`: profile upsert (`processing`), the queued `selfies` row, and
the challenge's `usedAt`. The `q:selfie`/`high` envelope is enqueued **after**
the commit through `enqueueWork`, so a broker failure leaves the row `queued` for
the sweep and never fails the request (§18.1).

The attempt budget is the profile's stored `selfies` count against
`selfies.per_attendee`, falling back to `settings.selfie.attemptsAllowed`
(ADR-0791 §3). The 403 is built from `effectiveLimit` rather than the
entitlement verdict's reason, because §6.3 names exactly one code for an
exhausted budget.

### 4. Confirmation publishes; nothing else does

`POST …/selfies/{selfieId}/confirm` is the only writer of
`isActive`/`activeSelfieId`/`matchCount`/`status: "ready"` and the only emitter of
`attendee.matches.new`. It activates the row the submit created (one attempt),
never inserts a second, and never enqueues a second job — I7 pins the queue
length across the confirm.

The worker's `embedding` is the publication test: with it the profile goes
`ready` and `matchCount` is the stored `faceMatches` count; without it the
profile stays `processing` with `matchCount: 0` and the confirmation only makes
the row `activeSelfieId` (I9b). The event is emitted only when a confirmed selfie
actually matched something, so a zero-count "new photos" notification cannot
happen.

### 5. Reuse re-processes the bytes; it never copies a vector

`…/selfies:reuse` resolves consent for the **addressed** event first (I14), then
looks the source selfie up by id **within the caller's own subject** and only if
it is `isActive` (I5, I15). A foreign or destroyed id is `404`, never `403`.

The new row carries the source's `contentHash` and is `queued`: the worker
re-embeds it on this event. Copying the embedding would be a biometric value
travelling between events and would make the worker's readiness meaningless.

### 6. The reusable listing is the second whitelisted cross-tenant read

`GET /p/selfies/reusable` is `user`-labelled (an `op_att` session is `401`) and
must find the caller's selfies across events **and tenants**, so it queries the
tenant-scoped `selfies` collection without a tenant scope. That is the one
legitimate cross-tenant read §6.7 permits, so it is
`crossTenantReads.findReusableSelfiesBySubjectUser` — the module's own
projection, which returns id, `createdAt`, `contentHash` and the quality verdict
and can therefore never carry the vector.

`subjectUserValue` now matches `subject.userId` as an `ObjectId` **or** a string:
schema §10.3 stores the id as an `ObjectId`, while the OP-77 fixtures seeded
strings, and OP-132 is the first lane whose rows are written by real code and
read back through the whitelist (I13). The projection of the preview URL is
`createMediaSigner().sign({kind: "preview"})`, so the listing answers exactly the
four §6.3 keys.

### 7. The rate limit is keyed on the resolved attendee

`selfie.submit` (6/h per attendee, 20/h per IP) and `liveness.challenge` (12/h per
attendee) have attendee-scoped rules only, so the classes are declared as the
`rateLimitIdentity` stage — after auth, never before it — and keyed on the
session the server resolved, never on the client's `X-Attendee-Session` header.
An anonymous caller publishes no `ctx.principal`, so the stage re-resolves the
`op_att` session (one indexed lookup, the same one the session read pays); a
signed-in caller keys on the user id. Both classes stay fail-closed, so an
unattributable request is a `503`, never an unlimited pass.

### 8. The contract amendment this owes

§6.3's challenge `201` carries `nonce` and the submit body is
`{hash, challengeId, livenessEvidence: {nonce, frameHashes}}`
(ADR-0791 §1). §6.3's submit example still shows `uploadSessionId` and
`livenessFrameHashes`; the implementation follows the pinned body and omits
`uploadSessionId` because selfies are always single-PUT.

## Consequences

- **Out of scope, by the same evidence rule as §6**: `liveness_failed` and the
  frame verifier (card §6), the `unconfirmedTtlMinutes` purge (card §5 —
  a sweep, not a route), `409 gallery_closed` (no case), idempotency _replay_
  (declared, and covered by its own lane) and `GET /me/events` (OP-134).
  `gallery_closed` remains a contract code with no transport: adding one nothing
  emits would be dead code.
- One challenge list of five and one attempt counter make a replayed challenge
  and an extra attempt impossible; the confirm makes provisional results
  invisible until the attendee agrees, which is the card's two-step guarantee.
- The whitelisted read now matches both subject-id representations, so a later
  lane that seeds profiles with `ObjectId`s cannot silently miss them.
