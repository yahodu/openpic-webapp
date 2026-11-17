# ADR-0807 — OP-132 TEST: the object-miss refusal's shape, the `expired` reason, the challenge cap, the zero-match confirmation and the reusable listing's bound

- **Status:** Accepted (pins; the one case RED by design at this record's branch cut
  went green at `bd3f8f6` — see §Decision 1)
- **Consumers:**
  `apps/web/src/test/integration/selfie-submit-refusal-edges.test.ts` (four cases)
  and `apps/web/src/test/integration/selfie-zero-match-and-reusable-pages.test.ts`
  (three cases), with their local harnesses (`readyEvent`, `uploadedHash`,
  `issueChallenges`, `profileRow`, `storedChallenges`, `selfieRows`, `submitOne`,
  `matchesNewRows`, `seedSelfie`, `seedReusablePopulation`).
- **Lane:** the shared attendee block `0780`–`0798` (row `OP-129 attendee identity
lane`) is exhausted, so this record draws from the `unallocated (future lanes)`
  pool — the [ADR-0800](ADR-0800-op132-selfies-ttl-and-kind-dedupe-pins.md)
  precedent. Before minting, the sweep was **empty**: both `Next free` cells read
  `0807`, no `.worktrees/*/docs/adr` carries an `ADR-0807*` file, and no open PR
  adds one. This record therefore draws **`0807`** and both cells advance to
  `0808`. No lane row is minted.
- **Amends:** [ADR-0791](ADR-0791-op132-liveness-selfie-red.md) and
  [ADR-0792](ADR-0792-op132-liveness-selfie-green.md) (the submit and challenge
  contract, whose `expired` reason, five-element cap and object verification had
  no cases), and [ADR-0806](ADR-0806-op132-confirm-publication-green.md) §2 (the
  zero-match arm, which [ADR-0805](ADR-0805-op132-confirm-publication-pins.md) §4
  explicitly left to this card).
- **Consumes:** `0807`.

## Context

Review of `t_3b8151c3` (OP-132 GREEN, PR #543) raised three **Low** coverage gaps
(F5, F6, F7). All the behaviour ships; this card is the last unobserved edge, and
it is deliberately **pins only** — no production change, no edit to an existing
case, fixture or helper.

| gap    | what was unobserved                                                                                                                                                                                                                                                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F5** | `POST …/selfies` verifies the uploaded object with `getObjectStorage().headObject(SELFIE_LOCATION_KEY, selfieObjectKey(hash))` (`selfies/route.ts:112`) and lets the port's bare `AppError("not_found")` escape. Every other refusal in these routes carries `details.resource`; this one carries no `details` at all, and no case pinned it. |
| **F6** | `expired` was implemented (`decideLivenessChallenge`, precedence `already_used` → `expired` → `mismatch`) but only `already_used` and `mismatch` had cases. The five-element `livenessChallenges` cap (`KEPT_CHALLENGES = 5`, `$slice: -5` on `attendeeEventProfiles`) had none either.                                                       |
| **F6** | The `matched === 0` arm of the confirm's publication branch: all three ADR-0805 cases have at least one match, so "a ready selfie that matched nothing announces nothing" was unproven.                                                                                                                                                       |
| **F7** | `GET /p/selfies/reusable` calls `crossTenantReads.findReusableSelfiesBySubjectUser(principal, {}, getDb())` — no `limit` — so the answer is every active selfie the subject holds in every tenant, and the `200` carries no cursor.                                                                                                           |

## Decision

### 1. F5 — two cases, one green and one deliberately red

The refusal is split in two, because they are different behaviours with different
statuses on the branch cut:

- **`answers 404 not_found and spends neither the challenge nor an attempt`**
  (green). The submit is driven with the hash of bytes that were never uploaded;
  the case first proves the object is really absent through the same port the
  route reads (`headObject` rejects `not_found`), so the refusal cannot be an
  artefact of a broken fixture. Then: `404`, `error.code === "not_found"`, zero
  `selfies` rows (an attempt is a row, §15.3 has no counter), the presented
  challenge's `usedAt` still `null`, and no new `q:selfie` pointer in the memory
  queue's outbox. That is §6.3's ordering (consent → object → challenge →
  budget) observed from outside.
- **`names the selfie resource in the refusal's details`** (RED on the branch cut:
  `expected undefined to deeply equal { resource: 'selfie' }`). This is the only
  deliberate red of the card, sanctioned by its own text ("that is a legitimate
  red for a GREEN to fix"). The demand is the route's own existing vocabulary: the
  confirm handler refuses this resource with `appError("not_found", { details: {
resource: "selfie" } })`, so a client branching on `details.resource` must not
  have to special-case the submit's object miss.

The token is `"selfie"`, not a new `"selfie_object"`: §6.3 has no vocabulary for a
sub-object, and the client's own upload is the missing resource. The GREEN that
adds it must satisfy this literal — the case is a spec, not a suggestion.

### 2. F6 — `expired` is driven through the clock port

The challenge is issued for real, then `systemClock.now()` is spied to one second
past the challenge's own `expiresAt` before the submit. That exercises the shipped
comparison (`decideLivenessChallenge`) instead of a hand-edited document, and it
keeps the inclusive-deadline boundary where it is already pinned (the unit
precedence cases). The refusal is `409`, `error.code ===
"liveness_challenge_invalid"`, `details.reason === "expired"` — a distinct reason,
not a collapsed `mismatch`. Nothing is charged: zero `selfies` rows and the
challenge's `usedAt` still `null`.

### 3. F6 — the cap keeps five and the evicted challenge is a `mismatch`

Six challenges are issued through the shipped route for one profile. The stored
list is asserted at length **5** (the card asks for the length explicitly) and its
surviving ids are asserted to be exactly the five most recent — the cap is a
`$slice: -5`, so eviction is by issue order, which is what makes "the challenge on
screen is the newest one" hold. Presenting the evicted challenge then answers
`409 … reason: "mismatch"`: it is no longer a challenge the caller holds, which is
the same observable the route already uses for evidence bound elsewhere (§6.3) —
no new reason code is invented for it. The fifth and sixth then answer `202` (the
cap must not have broken the usable end of the list), and no submit changes the
stored length.

Rate-limit arithmetic, recorded because it is invisible in the body:
`liveness.challenge` is 12/hour per attendee and `selfie.submit` is 6/hour per
attendee (plus 20/hour per IP), so six issues + three submits fit, and the bytes
are written through the storage port rather than the presign route so the two
`202`s do not also spend presign tokens.

### 4. F6 — a zero-match confirmation publishes nothing, and stamps nothing

The worker is played by `finishSelfieWorker` with `matches: 0`: it writes the
vector, the quality verdict and `processing.status: "done"`, and no `faceMatches`
row. The case asserts the vector is present before confirming — without it the
confirm would answer `processing` and the case would be measuring the pre-worker
arm instead. Then `200`, the seven §6.3 keys, `status: "ready"`,
`matchCount: 0`, **no** `attendee.matches.new` row, and §15.3's
`firstMatchNotifiedAt` still unset: the one-shot watermark belongs to a delivery
that happened, and this is the arm where none did. [ADR-0806](ADR-0806-op132-confirm-publication-green.md)'s
`willPublish` (`newMatches > 0 && no existing dedupeKey row`) satisfies it; the
pin exists so that a future `published`-only guard cannot.

### 5. F7 — no literal page size is asserted, because there is no bound to assert

**Measured**: with a 50-row population (25 active selfies in each of two tenants,
plus one newer _inactive_ row and one newer row belonging to another subject),
`GET /p/selfies/reusable` answers **50** items — the whole set, newest first,
inactive and foreign rows correctly excluded. The route passes `{}` to a port
whose documented default is "no limit", so the answer is every active selfie the
subject holds anywhere.

Asserting that number would freeze the defect: any legitimate bound would break
the case. Asserting an invented page size would either pass vacuously or fail a
correct implementation. So the file pins what **any** bound must preserve, at a
population larger than a page:

- the first returned item is the subject's newest **active** selfie (the inactive
  and the foreign rows are seeded _newer_ than every active one, so a listing that
  dropped `isActive` or the subject filter answers one of them first);
- no returned id lies outside the seeded population, and no id repeats;
- the answer reaches **both** tenants (the rows alternate, so this holds for any
  page size ≥ 2);
- every item carries exactly the four §6.3 keys;
- the returned `createdAt` values are descending.

Beside it, the seam a bound would use is pinned directly on the whitelisted read:
`findReusableSelfiesBySubjectUser(principal, { limit: 5 }, db)` answers the five
newest, and `{}` answers all 50 — the port's documented default, which is exactly
what the route passes. That pair is the executable statement of F7: the capability
exists, the route does not use it.

## Evidence — measured on the branch cut

Branch `OP-132-task-refusal-edge-pins`, cut from `origin/main` `70ae5ec`
(the release commit on top of `fa350d3`, which already carries the OP-132 code
and the ADR-0805/0806 pins — the card's named base
`origin/OP-132-task-liveness-selfie-red` is deleted, so the reviewer's instruction
to cut from the trunk was followed).

| file                                           | cases | result                                                        |
| ---------------------------------------------- | ----- | ------------------------------------------------------------- |
| `selfie-submit-refusal-edges.test.ts`          | 4     | `3 passed, 1 failed` — the `details.resource` case is the red |
| `selfie-zero-match-and-reusable-pages.test.ts` | 3     | `3 passed`                                                    |

The failure text of the red case is the spec:
`AssertionError: expected undefined to deeply equal { resource: 'selfie' }` at the
`expect(error.details).toEqual({ resource: "selfie" })` line.

Whole-suite evidence at this head:

| gate                                                                                                                   | result                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| integration, full project                                                                                              | `120 files, 1 failed \| 1273 passed (1274)` — the one failure is the deliberate `details.resource` case; the baseline before this branch is `118 files / 1267 passed`, i.e. every pre-existing case still passes |
| unit, full project                                                                                                     | `175 files, 2909 passed \| 3 skipped (2912)` — unchanged (both new files are integration)                                                                                                                        |
| the five ADR guards (`adr-numbering`, `adr-lane-ranges`, `adr-record-links`, `adr-source-references`, `adr-consumers`) | `218 passed`                                                                                                                                                                                                     |
| `tsc -p apps/web/tsconfig.json --noEmit`                                                                               | exit `0`                                                                                                                                                                                                         |
| `eslint --max-warnings=0` on both new files                                                                            | clean                                                                                                                                                                                                            |
| `prettier --check` on both new files, this record and the ledger                                                       | clean                                                                                                                                                                                                            |

### Load-bearing probes (each reverted byte-identically, `git status` clean)

| mutation                                       | case that must notice        | measured |
| ---------------------------------------------- | ---------------------------- | -------- |
| confirm's `willPublish` drops `newMatches > 0` | zero-match confirm           | 1 failed |
| `KEPT_CHALLENGES` 5 → 6                        | cap eviction                 | 1 failed |
| `expired` reason → `mismatch`                  | expired challenge            | 1 failed |
| the submit's `headObject` call removed         | object-miss `404`            | 1 failed |
| the reusable read drops `isActive: true`       | reusable listing scope/order | 1 failed |

Five mutations, five different cases, each mutation reddening exactly one — so
none of the seven cases passes vacuously.

## Consequences

- **The GREEN owes exactly one sentence to this record**: the submit's object miss
  names `details.resource: "selfie"`. Nothing else in the two files is red, so the
  PR that lands these pins may be a draft until that GREEN lands.
- **The reusable listing stays unbounded and is now recorded as such.** A follow-up
  that adds a `limit` (and, because the `200` has no cursor, a `nextCursor` in
  §6.3) will keep all three F7 assertions green: none of them names a size. The
  measurement (50 of 50) is the number that must change, and it lives here rather
  than in an assertion.
- **The cap's eviction is pinned as `mismatch`, not as a new reason code.** If a
  later card wants `unknown_challenge` or similar, it must supersede this record —
  today the API's own vocabulary treats a challenge the caller does not hold and
  evidence bound elsewhere identically, which is what makes an evicted challenge
  indistinguishable from a forged one (a privacy-positive property).
- **The zero-match arm now guards the publication branch from both sides**: a
  matched selfie announces (ADR-0805/0806), an unmatched one does not (here).
- `docs/adr/README.md` is the shared-ledger hotspot: both `Next free` cells move
  `0807` → `0808`; the row and the note merge as a union keeping the highest value.

## Alternatives

1. **Pin only the `404` and leave `details` to a docs card.** Rejected: F5's finding
   _is_ the shape. A status-only pin would have closed the finding while the
   inconsistency survived, and the next reviewer would file it again.
2. **Pin `details.resource` as a free-form string matcher** (`expect.any(String)`).
   Rejected: that would pass for any token, including the empty-ish ones a hurried
   fix might choose, and the value is exactly what a client branches on.
3. **Rewrite the stored `expiresAt` into the past instead of moving the clock.**
   Allowed by the card and equally deterministic, but it measures a hand-edited
   document rather than the route's own comparison, and it would also leave the
   challenge's `expiresAt` inconsistent with the `expiresAt` the route reported to
   the client in the `201`.
4. **Assert the reusable listing's size.** Rejected — see §Decision 5: it would
   freeze the defect.
5. **Skip the reusable route case entirely and pin only the port's `limit`.**
   Rejected: the port pin alone would leave "the route returns everything" as an
   untested property, and the scope/order case is what catches a bound added
   _without_ the subject or `isActive` filter.

## Open questions

1. **What bound, and how is it paged?** §6.3's `200` has no cursor, so a `limit`
   alone silently truncates. The owner of the fix must decide whether the listing
   grows `nextCursor` (the repo's cursor convention, §0.8) or caps at a
   documented maximum. This record deliberately does not decide it.
2. **Should `headObject`'s port error be shaped at the port or at the route?**
   Shaping it in the route keeps the port a storage primitive (and the reuse/confirm
   routes already shape their own `not_found`); shaping it in the memory/S3
   adapters would leak an HTTP detail into storage. This record assumes the route.

## Post-review note — the F5 arm is green on the trunk, and the other half of the port method

The `details.resource: "selfie"` case that was the only deliberate red at this record's
branch cut is green: the fix landed as `bd3f8f6` (PR #561), the same commit that carried
these pins, so §Decision 1's "RED on the branch cut" is history and the status line above now
states the trunk. **Nothing in §Decision 1 is retracted** — the token `"selfie"`, not a new
`"selfie_object"`, is what shipped, and the two files named under `Consumers:` — four cases
and three — answer `7 passed (7)` on the trunk.

The **swallowing** half of the same port method is pinned separately by
[ADR-0812](ADR-0812-op132-submit-object-transport-500.md) (card `t_5f76eab8`): `headObject`
throws `AppError("not_found")` for the client's absent object and a retryable
`TransportError` for our own storage outage, and the submit's narrowed catch must rethrow the
second as `500 internal_error` instead of answering the client-actionable `404` that makes an
attendee re-upload and spend `selfie.submit` on our failure. ADR-0812 is the record that
names that pin's own consumer file; this record's `Consumers:` list stays exactly as it is.
