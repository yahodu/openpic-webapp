# ADR-0791 — OP-132 RED: liveness challenge, selfie submit/confirm, the attempt budget and reuse

- **Status:** Accepted (RED / executable contract)
- **Consumers:** the OP-132 RED specs —
  `apps/web/src/test/unit/liveness-challenge.test.ts` (U1 + U3, 17 cases),
  `apps/web/src/test/unit/selfie-attempts.test.ts` (U2, 10 cases),
  `apps/web/src/test/integration/liveness-selfie-submit.test.ts` (19 cases),
  `apps/web/src/test/integration/selfie-reuse.test.ts` (7 cases),
  `apps/web/src/test/integration/selfie-submit-user.test.ts` (2 cases),
  `apps/web/e2e/liveness-selfie.spec.ts` (E1) and the shared fixture module
  `apps/web/src/test/helpers/selfie-flow.ts` — plus the gated GREEN card
  `t_3b8151c3`, which must not edit any of them.
- **Lane:** the shared attendee block `0780`–`0798` (row
  `OP-129 attendee identity lane`), `Next free` read as `0791` at the branch cut
  on `1298529` (`OP-131-task-biometric-consent-green`). OP-132 is a **dependent**
  ticket of OP-131 and OP-122 and continues the shared attendee block per
  CONVENTIONS §11 rule B; a sweep of `origin`'s `docs/adr` finds no `ADR-0791`.
  This record takes `0791`; the ledger cell advances to `0792`.
- **Amends:** nothing. **Amended by:** the OP-132 GREEN ADR, and amended **in
  place** by the F1 follow-up card `t_dd9cbd7c` (review of `t_3b8151c3`,
  PR #543): §6 and three integration cases below.
- **Consumes:** `0791` (`Next free` advances to `0792`).
- **Base:** the RED branch is cut from `origin/OP-131-task-biometric-consent-green`
  (`1298529`), not from `main`, because every selfie route mounts
  `requireConsent` and `main` did not carry it yet (OP-131's PR #541 is open).
  The F1 follow-up (`t_dd9cbd7c`) is cut from `origin/main` (`1857540`): the
  lane branch was deleted once the lane landed, and `main` now carries both the
  RED pack and the implementation.

## Context

OP-132 is the first card that writes biometric data of an attendee. The contract
(§6.2/§6.3/§6.4, Appendix A row 3587), the design document (§15.3, §16.4,
§17.5, §18.1/§18.2) and the GREEN card (§1–§6) agree on most of it and are
silent on five points that decide whether the tests can be written at all. This
record fixes those five, states the executable contract the specs pin, and hands
the GREEN the questions it must answer while keeping every test unchanged.

The lane's shape is a **two-step submission**: `POST …/selfies` inserts the
selfie, enqueues it on `q:selfie` immediately and answers `202`; the worker then
embeds it and writes its matches; `POST …/selfies/{selfieId}/confirm` is the one
place where any of that becomes visible, counted or notified. Everything the
card asks about "before confirm" (I7, I8) is therefore a statement about
_publication_, not about the worker.

## Decision

### 1. The evidence binding: `nonce` is the sixth key of the challenge `201`

§6.3's challenge answer is `{challengeId, challengeKind, spec, expiresAt}`. I12
("evidence tied to a different challenge → `409 liveness_challenge_invalid`
`{reason: "mismatch"}`") is unimplementable without a value the evidence must
echo back, so the contract gains **one** key:

```json
{
  "challengeId": "…",
  "challengeKind": "gesture",
  "spec": { "sequence": ["look_left", "blink", "look_center"], "timeoutMs": 15000 },
  "nonce": "3f2c1d8899aa55bb66cc77dd88ee99ff",
  "expiresAt": "2026-11-12T09:20:00.000Z"
}
```

The nonce is 16 random bytes as lowercase hex, compared case-insensitively. The
submit body is `{hash, challengeId, livenessEvidence: {nonce, frameHashes}}`;
`livenessEvidence` is required (I11's `422`), and a nonce that is not the
challenge's own is the `mismatch` refusal (I12). The GREEN owes contract §6.3 an
update for the extra key and for the evidence object.

### 2. The confirmation is a nested segment, not a colon verb

The GREEN card writes `POST /selfies/{id}:confirm`. Next.js cannot express a
dynamic segment followed by a literal in one folder (`[selfieId]:confirm` is a
literal path, not a dynamic one), and the repo's colon precedent
(`me/sessions:revoke-all`) works only because that verb is static. The
confirmation is therefore **`POST /api/v1/p/events/{slug}/selfies/{selfieId}/confirm`**
(`apps/web/src/app/api/v1/p/events/[slug]/selfies/[selfieId]/confirm/route.ts`,
`defineRoute({route: "/api/v1/p/events/:slug/selfies/:selfieId/confirm"})`).

### 3. Attempts are counted from the stored selfies, and the fallback is the §6.1 one

Schema §15.3 has no attempt counter, so `attemptsUsed` is the number of
`selfies` rows the profile holds on that event; the two-step submission is
therefore **one** attempt (I10), because the confirm activates the row the
preprocess created instead of inserting another. The limit is the tenant's
`selfies.per_attendee` entitlement, **falling back to
`platformSettings.selfie.attemptsAllowed` (3)** when the tenant's plan does not
gate the key — the same fallback §6.1's `attemptsAllowed` already advertises
(OP-130, ADR-0785), so the advertised budget and the enforced budget cannot
disagree. This matters in the fixtures: a seeded tenant has **no** `plans` row,
so the entitlement resolves `null` and the fallback is the only thing that
produces the §6.1 answer of 3. `selfieAttemptBudget` (below) is the one place
that arithmetic lives.

### 4. Publication is a property of the submission, not of the row

The worker the specs simulate writes the embedding, the quality verdict,
`processing.status: "done"` and one `faceMatches` row per photo, and marks none
of them. "Provisional" is therefore a state of the _attempt_: before the confirm
`attendeeEventProfiles.matchCount` stays `0`, `activeSelfieId` stays `null`,
`selfies.isActive` is not `true` and no `attendee.matches.new` is emitted; the
confirm sets all four and reports `status: "ready"`. The queue item exists
**before** the confirm (I7) because the worker has to start on submit, and the
confirm never enqueues a second one.

### 5. Precedence: consent, then ownership, then existence

§6.2 calls consent "a hard precondition for selfie processing" and says no
selfie endpoint may be reached without it, so every route resolves consent
**before** it looks at an object, a challenge id or a selfie id. The ordering is
pinned where it is observable: I1 submits a fabricated challenge id and an
un-uploaded hash and must still see `412`; I14 reuses a selfie on an event with
no consent and must see `412` even though the selfie exists; I5's foreign selfie
is `404` (never `403`) once the caller's own consent is valid; I15's withdrawn
selfie is `404` after the consent is granted again.

### 6. The selfie's object is owned, bounded and erasable (added by `t_dd9cbd7c`)

F1 of the round-1 review: a submit stored the bytes at
`originals/selfies/<sha256>` but wrote `assetId: null`, created no
`mediaAssets` row and stamped no `expireAt`, so §16.1's refcount and the
OP-131 withdrawal had nothing to act on and "delete my biometric data" left the
probe image in storage forever. Three cases now pin the object's lifecycle, and
they fix these decisions:

- **One owner row per content hash.** A `202` leaves exactly one `mediaAssets`
  row with `kind: "selfie"` (the §15.2 vocabulary), the submitted
  `contentHash` and `refCount: 1`, and the stored `selfies` row's `assetId`
  (§16.4 "The image") is that row's id. The `(tenantId, contentHash)` unique
  index stays the arbiter of a repeat submit; the pins assert one row, never a
  second.
- **Retention is a property of the row, not of the confirmation.** A queued
  (`processing.status: "queued"`) selfie already carries `expireAt` (§16.4's
  TTL field) **after** its `createdAt` and in the future. The exact retention
  window is deliberately **not** pinned here — the GREEN's record fixes which
  setting supplies it — so a legitimate change of duration breaks no case.
- **Withdrawal erases the bytes.** After submit + confirm, `DELETE …/consent`
  must still answer `204` with `selfies=1;embeddings=1;matches=2`, leave zero
  `selfies`/`faceMatches` rows, **and** make `getObject` at the selfie's own
  location/object key reject `not_found` through `getObjectStorage()` — the
  memoized port the submit route wrote through. A `refCount` decrement alone
  is not enough: the probe recorded below measured that.

## The executable contract

### Pure modules

```ts
// @/server/attendee/liveness-challenge
const LIVENESS_GESTURES: readonly string[];        // the gesture vocabulary
const LIVENESS_SEQUENCE_LENGTH: number;            // 3
const LIVENESS_TIMEOUT_MS: number;                 // 15000
createLivenessChallenge({now, random?}):
  {challengeKind: "gesture", spec: {sequence, timeoutMs}, nonce: string, expiresAt: Date}
  // expiresAt = now + 60_000; nonce = 32 lowercase hex, fresh per call
decideLivenessChallenge({challenge: {nonce, expiresAt, usedAt}, now, evidenceNonce}):
  {valid: true} | {valid: false, reason: "already_used" | "expired" | "mismatch"}
  // precedence already_used → expired → mismatch; expiry is inclusive

// @/server/attendee/selfie-attempts
selfieAttemptBudget({used, allowed}):
  {attemptsUsed: number, attemptsRemaining: number, exhausted: boolean}
  // remaining is clamped at 0; exhausted when remaining === 0; used echoed verbatim
```

### Routes

| Route                                            | Success                                                      | Refusals pinned                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `POST /p/events/:slug/liveness/challenges`       | `201` six-key body above                                     | `412 consent_required` (A.7 details)                                                                                |
| `POST /p/events/:slug/selfies/uploads`           | `201` `{method,url,headers,expiresAt,confirmUrl}`            | `413 file_too_large {maxBytes, actualBytes}`                                                                        |
| `POST /p/events/:slug/selfies`                   | `202` seven-key envelope                                     | `412 consent_required`, `422 validation_failed`, `409 liveness_challenge_invalid`, `403 plan_limit_exceeded`, `401` |
| `POST /p/events/:slug/selfies/:selfieId/confirm` | `200` same seven keys                                        | `401`                                                                                                               |
| `GET  /p/selfies/reusable`                       | `200` `{data: [{selfieId, createdAt, previewUrl, quality}]}` | `401` (anonymous attendee)                                                                                          |
| `POST /p/events/:slug/selfies:reuse`             | `202` same seven keys                                        | `412 consent_required`, `404 not_found`                                                                             |

Stored shapes the specs assert: `selfies` rows carry `tenantId`/`eventId`,
`profileId`, the `subject` §10.3 pair, `processing.{status:"queued",
priority:"high", queueRef:{queueKey:"q:selfie", provider:"memory"}}`; the
`attendeeEventProfiles` row is `status:"processing"`, `activeSelfieId:null`,
`matchCount:0` until confirmed; the queue receives **one** §10.4 envelope
(`kind:"selfie"`, `priority:"high"`, `id` = the selfie id) at submit time; the
confirm emits exactly one `attendee.matches.new` domain event whose payload
carries `{eventId, count}`.

## Evidence recorded by this card

- **Type-correct RED.** With the eight modules stubbed, `tsc -p
apps/web/tsconfig.json --noEmit` exits 0; without the stubs the only eight
  diagnostics are the `TS2307` "cannot find module" rows for exactly those
  modules — no type errors of the specs' own.
- **Honest import-level RED.** `vitest run --project unit` on the two unit specs
  and `--project integration` on the three integration specs fail with
  `Cannot find package '@/server/attendee/liveness-challenge'` … and
  `…'@/app/api/v1/p/events/[slug]/liveness/challenges/route'`.
- **Probe (satisfiability + bite).** Transient stubs were written and deleted
  (`git status --short` afterwards lists only the seven new test files): a
  correct probe implementation turned the 27 unit cases green, and three
  mutations each reddened **exactly one named case** —
  un-clamping the remainder (`never reports a negative remainder …`), swapping
  the decision's precedence (`reports already_used, not expired …`) and ignoring
  the evidence nonce (`refuses evidence tied to a different challenge as
mismatch`). Files were restored byte-identical (sha256 verified).
- **Integration probe.** With the six route stubs answering `501`, all 25
  integration cases fail — the two I1 rows at assertion level (`expected 501 to
be 412`), the rest at their first fixture step (`expected 201 … received
501`). No case passes by construction.
- **e2e evidence.** With the same stubs the standalone build succeeds and
  `playwright test --project api -g "E1: session"` drives the real HTTP surface:
  organizer sign-up, phone verify, published event, landing `GET`, attendee
  session and the consent `201` all pass for real, and the journey fails at its
  own step (`expect(challengeResponse.status()).toBe(201)` → `Received: 501`,
  `apps/web/e2e/liveness-selfie.spec.ts:222`). That is the OP-93/ADR-0306
  "RED-by-design" evidence: the spec drives the shipped path, and the GREEN's PR
  is where it turns green.

### Evidence measured for §6 (`t_dd9cbd7c`)

- **Red list on the current tree** (measured on `3eb7c7d`, re-measured identical
  on `origin/main` `1857540` once the lane branch was deleted): 3 failed |
  16 passed.
- **Red, asset accounting** — `expected [] to have a length of 1 but got +0`.
- **Red, retention** — `expected undefined to be an instance of Date`.
- **Red, erasure** — `promise resolved "Uint8Array[ … ]" instead of rejecting`:
  the object was still readable after the withdrawal.
- **Near-fix probe, pass A** (throwaway edit: one `mediaAssets` upsert with
  `refCount: 1` + `assetId`, plus `expireAt`, in `insertQueuedSelfie`):
  **1 failed | 18 passed** — the two accounting cases went green and the
  erasure case stayed red at its `getObject` assertion.
- **Near-fix probe, pass B** (pass A plus `deleteObject` for a
  `mediaAssets` row that reached `refCount: 0` in the OP-131 `DELETE` handler):
  **41 passed (41)** across this spec and `biometric-consent.test.ts`, i.e. the
  pin is satisfiable without breaking the consent suite.
- Both probes were deleted with `git checkout --` and re-hashed: the two
  production files are byte-identical to `3eb7c7d` (sha256 verified), and
  `git status --short` lists only the amended spec.

## Open questions handed to the GREEN

- **Where the challenge lives.** GREEN card §1 allows "a pending selfie doc or a
  short-TTL field — no new collection". The specs never look, so any store is
  legal; a field on the `attendeeEventProfiles` row is the natural single-write
  choice (one challenge per profile, replaced on re-issue).
- **`liveness_failed` (card §6).** A challenge whose evidence the worker rejects
  must store no embedding and run no matching. The card's test list contains no
  case for it, so this record does not pin it; the worker's verdict is the
  subject of the pipeline lane.
- **The purge of unconfirmed attempts** (`settings.selfie.unconfirmedTtlMinutes`,
  card §5) is a sweep, not a route: out of scope here.
- **`uploadSessionId`.** §6.3's example body names one, but selfies are
  "always single-PUT", so the pinned body omits it. If the GREEN keeps it in the
  schema it must stay optional, or every submit fixture breaks.
- **Idempotency replay.** `POST …/selfies` declares the idempotency stage; the
  specs send a fresh `Idempotency-Key` per call and do not pin the replay
  (§0.9 is already covered by its own lane).
- **`GET /me/events` is OP-134's route.** I13's "shows it right away" is pinned
  at the shipped whitelisted read (`crossTenantReads.
findAttendeeProfilesBySubjectUser`) that `/me/events` projects; OP-134's own
  spec owes the HTTP projection.

## Consequences

- Six new route modules, two new pure modules and one contract amendment (§6.3:
  the `nonce` key and the `livenessEvidence` body) are owed by the GREEN. The
  `liveness_challenge_invalid` code already exists in Appendix A; only its
  `details.reason` vocabulary is exercised here.
- The queue and storage adapters stay `memory` in the suites (`QUEUE_PROVIDER` /
  `STORAGE_PROVIDER`), so the same specs pin every adapter: the envelope is
  produced by `enqueueWork`, and the presigned PUT is redeemed through the shipped
  test-support route exactly as the e2e client does.
- A later refactor that keeps consent-first precedence, single-use challenges,
  publication-on-confirm and the per-profile budget breaks none of these cases;
  breaking any one of them breaks a named case.
