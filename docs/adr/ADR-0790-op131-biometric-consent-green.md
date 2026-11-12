# ADR-0790 — OP-131 GREEN: biometric consent grant and withdrawal (`POST`/`DELETE /api/v1/p/events/{slug}/consent`)

- **Status:** Accepted
- **Consumers:** `apps/web/src/server/attendee/consent-evidence.ts`,
  `apps/web/src/server/attendee/deleted-counts.ts`,
  `apps/web/src/server/attendee/consent-guard.ts`,
  `apps/web/src/app/api/v1/p/events/[slug]/consent/route.ts`, and the OP-132
  selfie routes that mount `requireConsent`.
- **Lane:** the shared attendee block `0780`–`0798` (row
  `OP-129 attendee identity lane`), `Next free` read as `0790` at the branch cut
  on `OP-131-task-biometric-consent-red` (`a5a8fe6`). OP-131 is a **dependent**
  ticket of OP-130 and continues the shared attendee block per CONVENTIONS §11
  rule B; this record takes `0790` and the ledger cell advances to `0791`.
- **Amends:** [ADR-0789](ADR-0789-op131-biometric-consent-red.md) — the
  implementation choices that record left open.
- **Consumes:** `0790`.

## Context

ADR-0789 fixed the executable contract for OP-131: two pure modules
(`buildConsentEvidence`, `formatDeletedCounts`), the `requireConsent` gate, and
`POST`/`DELETE /api/v1/p/events/:slug/consent`. It also handed the GREEN six open
questions (§Open questions) and three decisions the pins had already made for it
(the `ageConfirmed` field stays optional in the body schema; a created profile
starts `selfie_pending`; `policyDocumentHash` is deterministic per policy
version). This record states what the implementation chose where the contract,
the schema and the cards were silent.

## Decision

### 1. The two pure modules

`buildConsentEvidence({salt, ip, userAgent, acceptLanguage})` returns
`{ipHash, uaHash, method: "checkbox", locale}`, where `ipHash` and `uaHash` are
**two independent** calls to the shipped `hashFingerprint` (one part each) and
`locale` is `parseLocale(acceptLanguage)`. Reusing `hashFingerprint` rather than
a second salting scheme keeps consent evidence consistent with
`attendeeSessions.deviceFingerprint` (the same module, the same deployment salt),
and an absent part hashes its empty slot — `null` never reaches the row.

`formatDeletedCounts({selfies, embeddings, matches})` renders
`selfies=<n>;embeddings=<n>;matches=<n>` from a template literal;
`DELETED_COUNTS_HEADER` is `"x-deleted-counts"`.

### 2. The grant

`POST` declares `defineRoute({route: "/api/v1/p/events/:slug/consent"})` with the
`attendee` auth label (`requireAuth("attendee", {auth: getAuth(), database: getDb()})`)
and the §6.2 `write.normal` class as the coarse `rateLimit` stage, exactly as the
billing-checkout write declares it.

The body schema makes `purpose` a literal `biometric_processing` and `granted` a
literal `true` — this endpoint is the biometric grant, and a row the guard would
never read must not be writable here — and keeps `ageConfirmed` **optional**
(ADR-0789 §5) so the missing-field refusal is `422 age_confirmation_required`,
not the generic `422 validation_failed`.

The handler refuses in the contract's order, and neither refusal writes: a
`policyVersion` that is not `settings.legal.biometricPolicyVersion` →
`422 policy_version_stale` with `{currentPolicyVersion, policyUrl}`; then
`ageConfirmed !== true` → `422 age_confirmation_required`. Only then does it
resolve the event through an **active** access link (`$elemMatch` on
`{slug, active: true}`, `404 not_found` otherwise), resolve the subject from the
`op_att` session (anonymous) or from the authenticated user, insert the §15.4
row, and link the profile.

`policyDocumentHash` is `sha256:` + `sha256Hex("<version>\u0000<url>")`.
`platformSettings.legal` carries the version and the URL but no document body,
and the schema comment already fixes that the two move together, so the digest
over the pair is deterministic per policy version — which is what the pin
requires (two attendees, one digest).

The profile link is a read-then-write, not a blind upsert: a missing row is
inserted with `status: "selfie_pending"` (schema §15.3's closed union, ADR-0789
§5), while an existing row only takes `consentId`/`updatedAt` — an attendee who
re-consents after a policy change must not lose a `ready` profile, its
`activeSelfieId` or its `matchCount`. The one exception is a `withdrawn` profile:
its biometric data was deleted, so it restarts at `selfie_pending`.

`receiptSent` is `false` for every caller on this branch and `receiptNote` is the
§6.2 sentence verbatim; the `attendee.consent.receipt` fan-out needs an
identified user, whose claim flow OP-132 owns (ADR-0789 §4).

### 3. The withdrawal

`DELETE` resolves the event and the subject the same way, finds the caller's
profile, and deletes by **`profileId`** — `selfies` and `faceMatches` of that one
profile, never a `{tenantId, eventId}` sweep, which would delete a co-attendee's
selfie. `embeddings` counts the rows that carried a vector (a queued selfie has
no `embedding` key, schema §16.4); each referenced `media_assets` row loses one
`refCount` under a `refCount: { $gt: 0 }` guard, so a double withdrawal cannot
drive the counter negative; the blob itself is left to the storage sweep, which
is what schema §16.1's `refCount: 0` purge rule is for. Then every live consent
of that subject on the event is stamped `withdrawnAt` and the profile
`status: "withdrawn"`.

The answer is `204` with `X-Deleted-Counts` from the driver's own
`deletedCount`s, so the header reports what was actually destroyed.

### 4. `requireConsent`

The gate reads the current policy through `getPlatformSettings`, then the latest
`consents` row for the subject on the event at that version with
`withdrawnAt: null`. Both ways a granted consent stops being valid are therefore
structural: a withdrawal and a retired policy version. Anything else throws
`appError("consent_required", {details: {purpose, requiredPolicyVersion,
policyUrl}})` — the three Appendix A.7 details.

### 5. The codes and the contract document

`consent_required` (412), `policy_version_stale` (422) and
`age_confirmation_required` (422) are a new `CONSENT_ERROR_CODES` set in
`@openpic/contracts`, appended to `API_ERROR_CODES`/`AppErrorCode`, and
transported from a new `CONSENT_ERROR_TRANSPORT` table in
`@/server/http/catalog` — **not** from `ERROR_CATALOG`, which `errors.test.ts`
pins to exactly the base Appendix A rows. `consents` and `selfies` are registered
in `COLLECTIONS` so no route reads a bare literal.

Contract §6.2's example body gains `ageConfirmed: true` with one sentence on the
refusal, and its error appendix A.7 gains the `age_confirmation_required` row —
the contract document had no row for it, and it is this lane's own append.

## The six open questions of ADR-0789

1. **A second grant on an event whose consent is live** inserts a second row.
   The guard sorts by `grantedAt: -1` and asks only for the latest non-withdrawn
   row, so the answer is unambiguous, and the second row is the re-consent
   evidence a policy change or an in-app re-confirmation needs.
2. **`DELETE` with nothing to withdraw** answers `204` with zeros. Consent
   withdrawal is idempotent in REST terms and a client must always be able to
   retry a withdrawal it could not confirm; answering `412` would strand exactly
   the caller whose first attempt timed out.
3. **The withdrawal is not transactional**: the deletes run, then the stamps.
   Combined with (2), a crash between the two leaves a live consent with no
   biometric data, and the caller's retry completes the stamp. A
   `withTransaction` wrap is the safer choice once OP-132's selfie writes and the
   DSR log share the operation; the pins accept either.
4. **`refCount: 0` does not purge the `media_assets` row here.** The pin asserts
   the counter only, and schema §16.1 gives the purge to the sweep.
5. **The attendee session's `eventIds` is not required to contain the event.**
   The slug is the authority: it names an **active** access link, and a session
   created before a rotation (or on a sibling event of the same organizer) must
   not be refused a consent the page it is standing on asks for. The session is
   the subject key, not the event key.
6. **The contract document gains both rows** — see §5.

## Consequences

- The `policyDocumentHash` covers the version and the URL of the policy, not the
  document's bytes, because the settings document has no body to hash. When a
  policy body (or its storage object) lands in `platformSettings.legal`, the
  digest must switch to it: a URL can be republished with the same content, so
  the pair is the strongest identity available today but not the strongest
  possible one.
- The age confirmation is asserted at grant time and **not persisted**. Schema
  §15.4's `evidence` is a closed four-key object and the U1 pin asserts exactly
  those keys, so there is nowhere to keep it yet. A reviewer reading the
  `consents` row cannot show that the age box was ticked; recording it needs a
  schema decision (a fifth `evidence` key or a top-level field) and a pin.
- Dry-run withdrawals are indistinguishable from real ones: an attendee who never
  granted consent and calls `DELETE` gets `204` + zeros, the same answer as one
  whose data was just deleted. The alternative (`412`) was rejected for the retry
  reason above.
- The §6.2 `write.normal` class is declared as the **coarse** stage, like every
  other write route. On this pair the class's single rule is `user`-scoped and
  an anonymous attendee has no user identity, so the rule is skipped and the
  stage fails open (the class is not in the fail-closed set). That is the state
  ADR-0789 §4 recorded as unattributable rather than pinned; moving the stage to
  `rateLimitIdentity` would enforce it for a signed-in attendee but is a new
  pattern no other route uses, so it is left to the card that owns the §0.11
  table row.
- A lapsed `op_att` cookie still throws `attendee_session_expired` through the
  auth stage before this handler runs, so the attendee is told to recreate the
  session rather than being silently refused.

## Alternatives

1. **Derive `ipHash`/`uaHash` with a local `sha256(salt + value)`.** Rejected:
   `hashFingerprint` already is that scheme, salted and canonical, and shares the
   deployment salt with the session fingerprint — a second implementation would
   drift on the separator and the encoding.
2. **Hash `policyVersion` alone for `policyDocumentHash`.** Rejected: the URL
   distinguishes a re-published document under the same version label, and the
   pair is what the settings document fixes.
3. **Enforce the session's event binding on both methods.** Rejected (§5.5): the
   active slug is the authority, and the binding would refuse legitimate
   multi-event attendance.
4. **`withTransaction` for the withdrawal.** Not yet: no second writer shares the
   operation, and the retry-safe ordering in (2)/(3) covers the failure window.
   Revisit when the DSR `executionLog` append (OP-138) lands.
5. **A row-per-grant `withdrawnAt` "unset" on re-grant.** Rejected: consent rows
   are evidence and are never rewritten; a re-grant is a new row.

## Evidence

- Unit: `consent-evidence.test.ts` **13 passed**, `deleted-counts.test.ts`
  **7 passed** — the RED pins, unedited.
- Integration: `biometric-consent.test.ts` **22 passed (22)** against a real
  `MongoMemoryReplSet`.
- Full `unit` project **2819 passed | 3 skipped (2822)** over 169 files, full
  `integration` project **109 files / 1186 passed**, and the combined
  `test:coverage` run green with the configured thresholds met — statements
  **92.12%**, branches **80.98%**, functions **96.38%**, lines **92.33%**.
- `tsc -p apps/web/tsconfig.json --noEmit` and
  `-p packages/contracts/tsconfig.json --noEmit` both exit `0`; `eslint` and
  `prettier --check` are clean on every touched file.
