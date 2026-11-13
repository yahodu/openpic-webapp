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

## Review sign-off (OP-132 GREEN, round 1 — artifact + execution lens)

**Verdict: APPROVED WITH FINDINGS.** The delivery is PR #543, reviewed at head
`b695005` and merged into the lane branch `OP-132-task-liveness-selfie-red` as
the squash `3eb7c7d`. `git diff b695005 3eb7c7d` is **empty**, so the squash kept
the tree and every measurement below holds for both commits. This record did not
move across that chain: its blob is `d3d91ec` at `b695005`, at `3eb7c7d` and on
the trunk the append was cut from (`a9c6d59`), i.e. only this section changes it.
**No section of this record is retracted or rewritten.** The items at the end are
routes and observations, not corrections.

The lens was the artifact **and** the execution: every count below is the
reviewer's own run at the reviewed head, not a transcription of the implementer's
handoff. The trunk has grown since — the ADR ledger alone reads 325 records at
`a9c6d59`, lane cell `0824` — so each figure is stated with the commit it belongs
to.

### What the artifact proved

The three pinned criteria of the GREEN card, each read at its assertion:

- **Consent resolves before the handler's own input** in all five biometric
  handlers, through one `requireAttendeeScope` preamble — pinned by the cases
  that expect `412` at `liveness-selfie-submit.test.ts` `:263` and `:289` and at
  `selfie-reuse.test.ts` `:309` (line numbers as at the reviewed head; the two
  submit cases now sit at `:266` and `:292` on the trunk, `:309` is unchanged).
- **A challenge is single-use.** The submit consumes it with a conditional
  `usedAt: null` update **inside** the submit transaction, so a replay cannot
  read it consumed and continue — I2 (`409 already_used`) and I12
  (`409` with `reason: "mismatch"`) are green, and the unit precedence cases
  `:196`–`:251` agree. At the reviewed head the two assertions read `:317` and
  `:709`; on the trunk the same assertions read `:357` and `:740`.
- **The embedding is never returned.** One seven-key envelope plus the reusable
  projection (`id`, `createdAt`, `contentHash`, `quality`), and
  `selfie-reuse.test.ts:213` asserts the absence of the vector.

### What the review measured

At `b695005`:

- full `vitest run`: **283 files, 4057 passed, 3 skipped**, exit `0`;
- OP-132 focused unit: **154 passed** (4 files, both ADR guards among them);
- OP-132 focused integration: **47 passed** (4 files: OP-132 ×3 and the OP-131
  consent pack);
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; eslint **0 errors**;
  prettier clean;
- the ADR ledger at that head: **298 records**, **0 duplicate numbers**, lane
  range `0780`–`0798`, `Next free` read as `0793`;
- CI on `b695005`: **twelve check runs, all `success`** — the eleven gates
  (`ci`, `unit_test`, `test_coverage`, `lint`, `audit`, `audit-dev`,
  `secret-scan`, `env-changes`, `validate-branch-name`, `validate-pr-title` and
  the evidence job) plus the `notify-discord` close side-effect. The
  pre-refactor head carried the same eleven.

### The refactor, and the guard it tripped

The review shipped one refactor commit, `b695005`, touching **seven production
files, `+117/−112`, and no test, fixture or mock**:

- `requireAttendeeScope` in `request-event.ts` — one contract-ordered preamble
  (consent first, then the handler's own input) for five handlers, replacing
  five hand-rolled copies;
- `pathSegmentFromRequest` in the same module, replacing the confirm route's
  duplicated path-segment reader;
- one `SELFIE_ENVELOPE_SCHEMA` instead of three verbatim copies of the seven-key
  response envelope;
- the submit route's refusal reason typed as `LivenessChallengeFailureReason`
  instead of a re-spelled union.

All 27 unit and 25 integration OP-132 cases and the 22 OP-131 consent cases
stayed green, unedited, after the commit.

Recorded honestly, because it is the interesting part: the first attempt put
`requireAttendeeScope` in a **new** module. That module's header cites this
record, so this record's `Consumers:` field no longer named every file that cites
it, and the `adr-consumers` invariant went red. The guard was right — a citing
file the record does not list is a claim the record makes and does not honour.
The fix was to fold the helper into `request-event.ts`, which this record already
lists, **not** to widen the `Consumers:` field: a refactor must leave the
artefact alone, and adding a consumer row to a frozen record to legalise a new
file would have made the record describe code the GREEN never shipped.

### The F1 pin review, same round

Round 1 also reviewed the F1 pins, so this record does not read as if only the
GREEN were seen. Card `t_dd9cbd7c` (OP-132 TEST, F1 — the selfie's asset row,
expiry and erasure), PR #544 at head `7d0d215`: **approved with findings, Low
only**. That PR was a **draft against `main` by design and must not be merged** —
it was red until the GREEN carried the three pin cases. Measured on it:

- `3 failed | 16 passed (19)` on the branch — exactly the three new cases, at
  `liveness-selfie-submit.test.ts` `:862`, `:889` and `:914`;
- its `ci` job: `1 failed | 111 passed (112)` files, with only those three
  failures;
- the five ADR guards: `218 passed (218)`; prettier, eslint and `tsc` clean;
- the spec diff `+151/−0`: no existing case changed.

The pin set is **§6 of ADR-0791** — the TEST author amended that record in place,
which is why the F1 contract lives in ADR-0791 and not here. The pins are
**satisfiable**: a candidate fix answered `50 passed (50)` across
`liveness-selfie-submit`, `biometric-consent`, `selfie-reuse` and
`selfie-submit-user`. Two Low pin-tightening gaps (the retention pin fixes no
window, so a 90-minute `expireAt` passes; the erasure pin cannot see an
over-broad delete) were routed to `t_26ab6dd7`, not fixed in place.

### Findings, as routed at review time

All seven are beyond the pinned criteria. None of them changes a decision above;
each is a gap the contract and the tests did not yet reach.

| Finding | Severity | What it was                                                                                                                                 | Routed to, at review time                       |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| F1      | High     | The selfie's object was orphaned: `assetId: null`, no `mediaAssets` row of kind `selfie`, no `expireAt`, and a withdrawal deleted no object | TEST `t_dd9cbd7c` (PR #544), GREEN `t_fb098cce` |
| F2      | Medium   | Reuse ignored `selfies.per_attendee` and had no rate class; the submit's cap check was a TOCTOU                                             | TEST `t_75bc5afe`, GREEN `t_476a4abe`           |
| F3      | Medium   | The confirm notified twice (no `dedupeKey`), re-counted known matches and could not publish a late worker result                            | TEST `t_ab2af8f3`, GREEN `t_ed3785df`           |
| F4      | Medium   | Contract §6.3 drift: no nonce, a documented submit body that 422s, no confirm endpoint, no two-step wording, no reuse rate row              | `t_a1fbb7a7` (PR #559)                          |
| F5–F7   | Low      | A bare `not_found` on an object miss, unpinned expired / cap-eviction / zero-match arms, and an unbounded reusable listing                  | TEST `t_325903f6`                               |

### Post-review status

The routing above is stated as at review time. Everything it names has landed,
each fix carries its own record, and this sign-off mints no number.

- F1 landed as PR #546 (the asset row and the purge path), PR #553 (the TTL index
  and the kind-aware asset dedupe) and PR #550 (a retryable purge); the three pins
  are green at the trunk — `liveness-selfie-submit.test.ts` answers
  **21 passed (21)** in the run this append was cut against.
- F2 landed as PR #554 — reuse is charged against the attempt cap and the cap
  check moved inside the submit transaction.
- F3 landed as PR #557 (one publication, the new-match count, the late worker
  result) with its pins in PR #560.
- F4 landed as PR #559, squash `e760e80`. §6.3 of `docs/API Contract.md` now
  carries the amendment §8 owes — the challenge nonce, the shipped submit body,
  the confirm endpoint, the two-step wording, reuse's rate row and the reusable
  listing's bound — and retires `409 gallery_closed` and the submit's
  `413 file_too_large`, which moved to `…/selfies/uploads`. It also declares
  `410 gallery_expired` on the four biometric write endpoints ahead of the
  implementation: a decided refusal, ordered by ADR-0812 and closed by
  `t_4503b5cf`, whose fix is on this trunk (`gallery_expired` resolves in
  `request-event.ts`, in the error catalogue and in `catalog.ts`).
- F5–F7 landed as PR #561 (the object miss names the selfie resource), PR #562
  (the listing is bounded and paged) with its pins in PR #564 and PR #566, and
  PR #563 (the upload-window arm).
- Still open: `t_26ab6dd7`, the two Low pin-tightening gaps of the F1 review.
