# ADR-0789 — OP-131 RED: biometric consent grant and withdrawal (`POST`/`DELETE /api/v1/p/events/{slug}/consent`)

- **Status:** Accepted (RED / executable contract)
- **Consumers:** the OP-131 RED specs —
  `apps/web/src/test/unit/consent-evidence.test.ts` (U1, 13 cases),
  `apps/web/src/test/unit/deleted-counts.test.ts` (U2, 7 cases) and
  `apps/web/src/test/integration/biometric-consent.test.ts` (I1–I5 plus the
  guard and the authorization rows, 22 cases) — plus the OP-132 RED card, whose
  `I1`/`I14` rows consume `requireConsent` and whose selfie routes mount it.
- **Lane:** the shared attendee block `0780`–`0798` (row
  `OP-129 attendee identity lane`), `Next free` read as `0789` at the branch cut
  on `302ff4d`. OP-131 is a **dependent** ticket of OP-130 and does not continue
  OP-130's range (ADR-0300 §7), so it continues the shared block per
  CONVENTIONS §11 rule B: a sweep of every live worktree's `docs/adr/` and every
  `origin` head (`git ls-tree -r <ref> docs/adr`) finds no `ADR-0789`, `0790`…
  `0798`, and the highest number any in-flight ref holds is `0788`. This record
  takes `0789`; the ledger cell advances to `0790`.
- **Supersedes:** nothing. **Amended by:** the OP-131 GREEN ADR (the
  implementation choices left open here).
- **Consumes:** `0789` (`Next free` advances to `0790`).

## Context

The epic's user story is _"As an attendee, I want to give or withdraw biometric
consent so that my face data is processed only with my permission and deleted
when I withdraw."_ Contract §6.2 already fixes the surface: `POST` and `DELETE`
on `/api/v1/p/events/{slug}/consent`, auth `attendee`, rate `write.normal`, a
`consents` row carrying `policyVersion` **and** `policyDocumentHash` **and**
`evidence {ipHash, uaHash, method, locale}`, `422 policy_version_stale` with
`details.currentPolicyVersion`/`policyUrl`, and a withdrawal that sets
`withdrawnAt`, sets the profile `withdrawn`, deletes the selfie, its embedding
and every `faceMatches` row, and answers `204` with
`X-Deleted-Counts: selfies=<n>;embeddings=<n>;matches=<n>`. Appendix A.7 adds
the second refusal this story needs, `412 consent_required`.

Three gaps make this RED necessary rather than mechanical:

1. **Demonstrability is a data contract, not a status code.** GDPR/DPDPA require
   the record to survive the document being edited, so the _hash_ of the policy
   document and the _hashed_ device facts are as load-bearing as the row itself.
   Nothing in the tree hashes consent evidence yet.
2. **"Deleted" has to be countable and bounded.** The `204` has no body, so the
   counts are the only evidence the client (and a future DSR `executionLog`) can
   show, and a tenant-wide sweep would delete a stranger's data.
3. **The gate OP-132 calls does not exist.** Contract §6.3 makes consent a hard
   precondition of every selfie endpoint, but OP-132's routes are not on this
   branch, so the guard itself is the seam that must be pinned now — including
   the two ways a _granted_ consent stops being valid (withdrawn, stale
   version).

## Decision

### 1. The pure modules the specs import

```
apps/web/src/server/attendee/consent-evidence.ts
  buildConsentEvidence({salt, ip, userAgent, acceptLanguage}): ConsentEvidence
    // {ipHash, uaHash, method: "checkbox", locale}

apps/web/src/server/attendee/deleted-counts.ts
  DELETED_COUNTS_HEADER = "x-deleted-counts"
  formatDeletedCounts({selfies, embeddings, matches}): string
```

`buildConsentEvidence` is a pure function of the request facts and the
deployment salt. `ipHash` and `uaHash` are **separate** salted SHA-256 digests
(the repo's shipped `hashFingerprint` scheme, so evidence digests are consistent
with the `attendeeSessions.deviceFingerprint` digests and no raw IP or user agent
is ever stored or logged, §0.15), deterministic for the same facts, and computed
even when a part is absent (a `null` IP hashes the empty part; it is never
`null`). `locale` is resolved through the shipped `parseLocale`, so a stored tag
is always one the product serves — the U1 pins compare against `parseLocale`
rather than a literal, which is what makes the composition, not the string,
the contract.

`formatDeletedCounts` produces exactly `selfies=<n>;embeddings=<n>;matches=<n>`
in that order, `;`-separated, no whitespace, base-10 integers. U2 pins the
contract's own example, the segment list, the zero case (a zero must render `0`,
not an empty segment) and a round trip through a client's `split(";")` /
`split("=")` parse — the header is the client's confirmation copy, so its shape
is a wire contract.

### 2. The route

```
apps/web/src/app/api/v1/p/events/[slug]/consent/route.ts
  POST   : 201 {consentId, purpose, policyVersion, grantedAt, receiptSent, receiptNote}
  DELETE : 204 + X-Deleted-Counts
```

Both methods declare `defineRoute({route: "/api/v1/p/events/:slug/consent"})`
with the `attendee` auth label and read the slug off `request.url`
(`segments.at(-2)`), exactly as the OP-130 landing route reads `at(-1)`. The
event is resolved through an **active** access link (`$elemMatch` on
`{slug, active: true}`), the attendee session comes from
`findRequestAttendeeSession`, and the consent subject is
`{kind: "anonymous", attendeeSessionId}`.

The grant validates in the order the contract's error rows imply:

1. `policyVersion ≠ settings.legal.biometricPolicyVersion` →
   `422 policy_version_stale` with `{currentPolicyVersion, policyUrl}` and **no**
   write (I1 pins both the envelope and the absence of the row);
2. `ageConfirmed !== true` → `422 age_confirmation_required` and **no** write
   (I5; see §5 for why the field must stay optional in the body schema);
3. otherwise insert the `consents` row and upsert the profile.

The withdrawal is scoped by the profile (`selfies`/`faceMatches` both carry
`profileId`, and the design document indexes exactly that), counts the selfies
whose row carried an `embedding`, deletes the selfies and the matches, drops one
`refCount` from each referenced `media_assets` row, stamps `withdrawnAt` on the
consent and `withdrawn` on the profile, and answers `204` with the header.

`policyDocumentHash` is deterministic for a policy version — two attendees
granting the same version store the same `sha256:<64 hex>` digest (I2). A digest
minted per row (a random salt, an ObjectId) would make the evidence
unverifiable, which is the one thing the field exists to prevent.

### 3. `requireConsent` — the gate

```
apps/web/src/server/attendee/consent-guard.ts
  requireConsent({db, tenantKey, eventId, subject})
    : Promise<{consentId: ObjectId}>
```

It reads the current policy from `getPlatformSettings`, resolves the latest
non-withdrawn `consents` row for the subject **at that policy version**, and
returns its id. Anything else throws
`appError("consent_required", {details: {purpose, requiredPolicyVersion,
policyUrl}})` — the three details Appendix A.7 fixes, so the client can render
the policy and retry. The four I4 rows pin the four states that matter: no row,
a granted row, a granted-then-withdrawn row, and a row whose `policyVersion` is
no longer the current one.

### 4. What the pins refuse to observe

- The `attendee.consent.receipt` notification fan-out (§6.2: email only, skipped
  for anonymous attendees, whose profiles have no verified contact). The
  observable facts are `receiptSent: false` and the contract's `receiptNote`;
  the dispatch path needs an **identified** user, whose claim flow OP-132 owns.
- The DSR `executionLog` append (§6.2): `dataSubjectRequests` does not exist
  until OP-138.
- Rate limiting. §6.2 names `write.normal`, whose only rule is keyed on the
  `user` scope; an anonymous attendee is keyed by the hashed IP, so the class is
  attributable and no `503` is reachable — but pinning the bucket would freeze a
  table row this story does not own.
- Re-granting on an event that already has a live consent, and `DELETE` with no
  consent to withdraw. The contract is silent on both; §Open questions routes
  them to the GREEN.

### 5. Assumptions (contract, schema or card is silent)

- **Deletion is scoped by `profileId`.** The alternative — filtering `selfies`
  by `{tenantId, eventId}` — would delete a sibling attendee's selfie on the
  same event, so the spec seeds exactly one profile and asserts zero remaining
  rows for it. `selfies.tenantId`/`eventId` are seeded as hex strings and
  `faceMatches` under the registered `faceMatches` collection name, matching how
  this repo's routes write tenant-scoped rows.
- **`embeddings` counts the selfies that carried a vector**, not the selfie
  count. The vector is embedded on the `selfies` row (schema §16.4), so a selfie
  still queued has no `embedding` key at all; I3 seeds exactly that shape
  (2 selfies, 1 embedded → `selfies=2;embeddings=1;matches=3`). Without this the
  field would be the selfie count under another name.
- **The profile a grant creates starts `selfie_pending`.** Schema §15.3's
  `status` is a closed union (`selfie_pending | processing | ready |
no_match | failed | withdrawn`); the GREEN card's prose says `no_selfie`, which
  is **not** a member of it. CONVENTIONS §10 puts the schema above a card, so the
  pin asserts `selfie_pending` and the conflict is routed to the GREEN in the
  handoff and on its card.
- **`ageConfirmed` is optional in the request schema and refused in the
  handler.** The contract has no row for the age confirmation, so a _required_
  Zod field would answer the generic `422 validation_failed`; the card's `I5`
  needs `422 age_confirmation_required`. I5 therefore sends the current policy
  version and the absent/false field, so the age check is the only failing fact.
- **The receipt note is the contract's sentence verbatim**
  ("A consent receipt is emailed only to signed-in attendees.") — it is quoted
  in §6.2's response example, so it is contract text, not copy to invent.
- **`consents` and `selfies` are read by their schema names.** `COLLECTIONS` has
  no entry for either yet; both are single words, so the snake_case convention
  that turned `faceMatches` into `face_matches` cannot change them. The GREEN may
  register them; the spec's literals stay correct either way.
- **`content-type` and a client IP are always sent.** Direct handler invocation
  skips middleware (no CSRF header needed), but `parseJsonBody` needs the content
  type and the `attendee.session` class is fail-closed, so every case sends
  `x-forwarded-for` from a per-case address.

## Consequences

- The GREEN owes four modules plus the six-key response schema, the profile
  upsert, the counters, and three error codes appended to the catalogue
  (`consent_required` `412`, `policy_version_stale` `422`,
  `age_confirmation_required` `422`). Appendix A.7 already documents the first
  two; the third is this lane's own append and is **not** in the contract
  document, so the GREEN should also add its Appendix A row and note it in its
  ADR.
- The evidence digests are salted with the deployment salt, so a rotated salt
  makes old digests non-comparable. Accepted: the digest is evidence of _a_
  device, and the contract does not promise cross-salt correlation.
- `X-Deleted-Counts` is the only record of the deletion a client sees; the DSR
  log (OP-138) and the `consents.withdrawnAt` stamp are the durable ones. A
  client that ignores the header still learns nothing wrong — it just cannot
  render "we deleted 3 matches".
- The withdrawal is **not** transactional in the probe implementation; a crash
  between `deleteMany` and the `withdrawnAt` stamp leaves deleted data with a
  live consent. The pins do not demand a transaction (the counts are still
  reported), and §Open questions hands the ordering to the GREEN.

## Evidence (this RED)

- **Honest RED** after the probe stubs were deleted:
  `Cannot find package '@/server/attendee/consent-evidence'` (U1),
  `'@/server/attendee/deleted-counts'` (U2),
  `'@/app/api/v1/p/events/[slug]/consent/route'` and
  `'@/server/attendee/consent-guard'` (integration), with
  `npx tsc -p apps/web/tsconfig.json --noEmit` reporting **exactly four**
  `TS2307`s naming only those modules and nothing else.
- **Type-correctness and satisfiability** were proved with throwaway stubs
  (deleted): with a faithful near-fix implementation the unit project ran
  **20 passed (20)** (U1 13, U2 7) and the integration spec
  **22 passed (22)** against a real `MongoMemoryReplSet`. A `500` route stub
  first produced assertion-level failures only (`expected 201 from POST consent,
received 500`), so the specs fail on behaviour, not on load.
- **The pins are load-bearing** — six single-anchor mutations, every file
  restored byte-identically (`sha256` checked) after each run:
  - `ipHash` returned as the raw IP → `4 failed | 9 passed (13)` in U1
    (`expected '198.51.100.24' to match /^[0-9a-f]{64}$/`,
    `expected '{"ipHash":"198.51.100.24",…}' not to contain '198.51.100.24'`);
  - `formatDeletedCounts` reversed the field order → `4 failed | 3 passed (7)` in
    U2 (`expected 'matches=3;embeddings=1;selfies=1' to be
'selfies=1;embeddings=1;matches=3'`);
  - the withdrawal counted every selfie as an embedding →
    `expected 'selfies=2;embeddings=2;matches=3' to be
'selfies=2;embeddings=1;matches=3'` (I3, `1 failed | 21 skipped`);
  - the withdrawal left the `faceMatches` rows behind →
    `expected 3 to be +0` (I3);
  - the guard ignored `withdrawnAt: null` → `expected an AppError, received
null` (I4, the withdrawn arm);
  - the grant accepted a missing age confirmation → both I5 rows
    (`expected 201 to be 422`, `2 failed | 20 skipped`).
- **Ledger/format**: the shared ledger `docs/adr/README.md` is the only contended
  file (index row, the lane's `Next free` cell `0789 → 0790`, and one appended
  lane note); `prettier --check` and `eslint` are clean on the three specs, and
  no production file is touched.

## Alternatives

1. **Pin the withdrawal through the counts only.** Rejected: a route that
   reported the right counts and deleted nothing would pass, and the whole point
   of the story is the deletion.
2. **Pin consent by reading the `consents` row only.** Rejected: the profile link
   (`consentId`, `status`) is what the selfie routes resolve, so the row alone
   would let a grant that never linked a profile pass.
3. **Test the guard through a mounted liveness route.** Impossible on this
   branch — OP-132 owns it — and inventing a second route would duplicate
   OP-132's surface. The guard is pinned as the module OP-132 imports, which is
   also where its error contract belongs.
4. **Assert the raw `Accept-Language` string in `evidence.locale`.** Rejected:
   §15.4 says `locale`, and the product serves exactly one tag; pinning the
   header would freeze a browser artefact instead of the served locale.
5. **Pin `no_selfie` because the GREEN card says so.** Rejected: schema §15.3's
   `status` union is closed and does not contain it (see §5).
6. **A unit-level pin of `requireConsent`.** Rejected: the guard's contract is a
   database read plus a settings read; a stubbed-db unit test would pin the
   query shape rather than the four answers that matter.

## Open questions (for the GREEN)

1. A second `POST` on an event whose consent is already granted and current:
   insert a second row, reuse it (`200`), or `409`? No pin exists; pick the
   behaviour that keeps the guard's "latest non-withdrawn row" unambiguous.
2. `DELETE` with no live consent: `404 not_found`, `412 consent_required`, or a
   `204` with zeros? Unpinned.
3. Is the withdrawal transactional (`withTransaction`-wrapped) or ordered
   delete-then-stamp? §Consequences records the failure window; the pins accept
   either, and a transaction is the safer choice.
4. Does `DELETE` also purge the `media_assets` row when `refCount` reaches zero,
   or leave that to the storage sweep? The pin asserts `refCount === 0` and
   nothing about the blob.
5. `eventIds` scoping: must the attendee session be bound to the event (its
   `eventIds` contains the resolved event)? The spec's sessions are bound, so a
   stricter implementation passes; an unbound-session answer is unpinned.
6. The `age_confirmation_required` row in contract Appendix A.7 is this lane's
   own addition — the GREEN should add it to `docs/API Contract.md` and say so in
   its ADR.
