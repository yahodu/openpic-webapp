# ADR-0815 — OP-134 GREEN: claim an anonymous session and the cross-tenant "my events" read

- **Status:** Accepted (GREEN implementation record)
- **Consumers:** the files that cite this record —
  `packages/contracts/src/errors.ts`,
  `apps/web/src/server/http/catalog.ts`,
  `apps/web/src/server/attendee/claim.ts`,
  `apps/web/src/server/attendee/claim-decision.ts`,
  `apps/web/src/server/attendee/my-events.ts`,
  `apps/web/src/server/auth/identity-hooks.ts`,
  `apps/web/src/app/api/v1/me/attendee-sessions:claim/route.ts` and
  `apps/web/src/app/api/v1/me/events/route.ts` — plus the executable contract
  it makes true
  ([ADR-0814](ADR-0814-op134-attendee-claim-red.md)); and, from the round-1
  review's follow-up, `apps/web/src/test/integration/attendee-claim-endpoint-arms.test.ts`
  (`t_08232689`, I8 ×3, I9), which cites this record for the two §6.7 arms it
  pins and records its decisions in
  [ADR-0818](ADR-0818-op134-claim-endpoint-arms-pins.md).
- **Amends:** nothing. **Amended by:** nothing yet.
- **Consumes:** `0815` (`Next free` advances to `0816`).
- **Base:** `origin/main` `f9a0f27` + the RED pin pack `fcaf0d7`.

## Context

[ADR-0814](ADR-0814-op134-attendee-claim-red.md) delivered twenty-one unit and
seventeen integration cases as the executable contract for contract §6.7 and
left the production modules absent. This record is the GREEN: the smallest
honest implementation that makes those pins true, and the record of every
decision the pins left open.

## Decision

### 1. Two pure modules, exactly as the contract sketch writes them

- `@/server/attendee/my-events` exports `EXPIRING_SOON_WINDOW_MS`
  (`604_800_000`) and `computeExpiringSoon({galleryExpiresAt, now})`:
  `remainingMs >= 0 && remainingMs <= EXPIRING_SOON_WINDOW_MS`. The window is
  inclusive at both ends; an already-expired gallery is `false`.
- `@/server/attendee/claim-decision` exports `decideClaim`: no existing user
  profile → `repoint`; otherwise `merge` with
  `adoptAnonymousSelfie = anonymous !== null && (existing === null || anonymous > existing)`.
  The strict `>` is the tie arm — equal timestamps keep the existing profile's
  selfie.

### 2. One claim service, two callers

`claimAttendeeSession({db, userId, token, clock?})` in
`apps/web/src/server/attendee/claim.ts` is the only claim implementation. Both
the route and the session-created identity hook call it, because they must
behave identically and may run in either order.

The walk keys on `{"subject.kind": "anonymous",
"subject.attendeeSessionId": <session hex>}` and re-points each row with
schema §15.3's single `updateOne` (`$set` `subject.kind = "user"`,
`subject.userId`, `claimedAt`; `$unset` `subject.attendeeSessionId`). The `_id`,
every selfie id and every `faceMatches` row are untouched and nothing is
enqueued, so the matcher is never re-armed.

Order of the checks is load-bearing and follows the pins: a lapsed session
throws the shipped `attendee_session_expired` (through
`findAttendeeSession`), an unknown token is `404 not_found`, and a session
already named by a **different** user returns `conflict` after one `warn`
`attendee.claim_conflict` with the caller's id. The owner's repeat is not a
conflict: the walk then finds no anonymous rows and answers `200` with an empty
`claimed`.

`attendeeSessions.claimedByUserId`/`claimedAt` are stamped at the end of every
successful claim, including one where every event was skipped, so a later claim
by another account cannot steal the session.

### 3. The merge arm adopts the selfie and nothing else

The unique partial index `{eventId:1, "subject.userId":1}` on
`subject.kind:"user"` forbids a second user profile per event, so the anonymous
row stays anonymous and the existing user row's `activeSelfieId` is rewritten
only when the decision adopts the anonymous selfie. No selfie row is replaced or
deleted, and no match is touched.

### 4. `attendee.event.linked` is emitted once per **claimed** event

The emit is inside the repoint arm, with `tenantId` the profile's tenant,
`actorRef`/`subjectRef` the caller, and `payload: { eventId }`. The key is
already registered in `NOTIFICATION_TYPE_KEYS` (in-app only), so no catalogue
work was needed. A skipped (merged) event emits nothing: §6.7's sentence is
"per claimed event".

### 5. `GET /me/events` goes through the whitelist, and the whitelist grows

The route builds no filter of its own. `crossTenantReads` gains
`findAttendeeEventsBySubjectUser(userId, page, db)` in
`apps/web/src/server/repos/cross-tenant.ts` — the one directory the lint rule
permits to hold the driver. Its only subject predicate is
`subject.userId === caller`; every join key is the row's own `eventId` /
`tenantId`.

Ordering is `{updatedAt: -1, _id: -1}` with a strict keyset filter on the
compound `(updatedAt, _id)` key, so §0.8's cursor neither skips nor repeats a
row when two participations share an instant. The route pages with the shared
`parsePageQuery`/`buildCursorPage` codec, so the default is `40`, the ceiling
`100`, and a foreign cursor is `400 invalid_cursor` — §0.8's own answer, as
ADR-0814 §9 chose (the gallery's `422` remains flagged, not copied).

The item is exactly the thirteen §6.7 keys. `coverThumbnailUrl` is `null`
(`events` has no cover-asset pointer), `organizerDisplayName` is `tenants.name`,
`galleryUrl` is `/e/{active slug}/gallery`, `matchCount` is the profile cache,
`newMatchCount` is an aggregation over unseen, non-hidden `faceMatches`,
`status` is the profile status, and `galleryExpiresAt`/`expiringSoon` come from
`events.retentionExpiresAt` through the pure window function.

### 6. The session-created hook's default claim is the real service

`resolveDeps` in `apps/web/src/server/auth/identity-hooks.ts` replaces the
`noopClaim` placeholder with `defaultClaim(db)`, so the app built exactly as
production builds it (`createAuth({db})`) claims at sign-in with no client
cooperation. The hook's existing `runClaim` still swallows a claim failure and
logs `identity_hook.claim_failed`, because ADR-0038 forbids a hook failure from
failing a sign-in.

### 7. `session_claimed_by_other_user` is a new catalogue row

Appended to `AUTH_ERROR_CODES` with a `409`, non-retryable row in
`AUTH_ERROR_TRANSPORT`, in the OP-129 `attendee_session_expired` shape. The code
exists in no Appendix A row, so the lane owns its transport; the client enum and
`AppErrorCode` pick it up through the existing union.

### 8. The claim clears `op_att` in the session cookie's own attribute set

`buildAttendeeSessionCookie({token: "", maxAgeSeconds: 0, secure})` — an expired
cookie with an empty value, `Path=/`, `HttpOnly`, `SameSite=Lax`, and `Secure`
only on a TLS deploy. A browser keeps an unset cookie, so an absent header would
not clear it.

## Consequences

- A sign-in that still holds `op_att` now claims, so the profile moves before the
  sign-in response is served and the account's list is non-empty immediately.
- A user can hold two profiles for one event (the claimed one and the
  merged-away anonymous one). That is the schema's shape; the anonymous row is
  inert and remains a candidate for the session-TTL sweep ADR-0814 §Consequences
  already names.
- `GET /me/events` is the second caller of `@/server/http/cursor`, and the
  gallery/§0.8 `invalid_cursor` divergence is still open (ADR-0814 §9).
- A broken outbox fails the claim after the rows moved: the emission is direct
  rather than best-effort. The hook path already swallows and logs it, so a
  sign-in is never failed; the explicit route answers the outbox failure. No pin
  covers a partial failure, and a retry is safe because the walk finds no
  remaining anonymous row.

## Alternatives

- **Delete-and-recreate the profile.** Rejected: it would mint a new profile id,
  re-embed the face and lose the attendee's gallery — the exact damage the pins
  exist to catch.
- **Walk `attendeeSessions.eventIds`.** Rejected: a profile can exist for an
  event the session was never bound to (the attendee reached a second event's
  page holding the cookie she already had), and a pinned case seeds exactly
  that shape.
- **Answer `409` on the owner's repeat.** Rejected: the client would have to
  special-case the order of its own sign-in hook and explicit call.
- **A second pagination codec for the list.** Rejected: §0.8's shared module is
  exact and already ships.

## Amendment — round-1 review F1/F2 (record [ADR-0818](ADR-0818-op134-claim-endpoint-arms-pins.md) discharged)

The round-1 review of this GREEN measured two contract §6.7 arms the shipped
codes left unsatisfied, and [ADR-0818](ADR-0818-op134-claim-endpoint-arms-pins.md)
pinned them (`I8` ×3, `I9`). Card `t_07786aa0` turns those pins green with the
two changes below and no test, fixture or helper edit; **no number is
consumed**, because both decisions belong to this record.

### 9. Session ownership is decided by the write, not by the read

`§2` above walked the profiles and stamped `attendeeSessions.claimedByUserId`
at the end, after a plain read of that field. A read cannot answer _who owns
this session_ for two accounts that read it together: both passed the check, and
the last write won the field while both callers were told they had moved the
profile.

`claimAttendeeSession` now opens with one conditional `findOneAndUpdate` on
`{_id, $or: [{claimedByUserId: null}, {claimedByUserId: userId}]}` setting
`claimedByUserId`/`claimedAt`, and answers `conflict` → `409
session_claimed_by_other_user` when it matches nothing. The owner's repeat still
matches (the second `$or` arm), so it stays a `200` no-op, and the trailing
unconditional session write is gone — the same field, written once, atomically.

A re-point whose `updateOne` reports `matchedCount === 0` is **dropped**: the
row was moved by someone else between the read and the write, so it is neither
reported in `claimed[]` nor announced with `attendee.event.linked`. Dropping
rather than adding a `skipped[]` reason keeps the §6.7 reason set and the error
catalogue unchanged.

### 10. The omitted body is the documented arm; an empty one is treated the same

§6.7 states the body as `{ "sessionToken": "opat_…" }` **"(or omitted, reading
the `op_att` cookie)"**. `defineRoute`'s `body:` option is all-or-nothing — a
declared schema makes a bodyless request `415 unsupported_media_type` — so this
route drops `body:` and reads the stream through the house helper
`optionalJsonBody` (§6.5's `gallery:seen` and `hide`), keeping the cookie as the
fallback. `define-route.ts` is **not** touched: a pipeline-wide change would
alter the media-type behaviour of every route.

`content-type: application/json` with an **empty** body is now also a valid
cookie-only claim, i.e. read as an omission: an empty stream carries no body to
parse, and a client that has nothing to say should not be refused. That choice
is recorded in §6.7 of the contract; it is not pinned by ADR-0818. `{}`,
`{sessionToken}` and a malformed body keep their shipped behaviour (`200`,
`200`, `400 malformed_json`).

### 11. Measured

`I8` ×3 + `I9` on the carried spec: `Tests 4 failed (4)` before (I8 "more than
one account reported a claimed event", I9 "expected 200 from a bodyless claim,
received 415"), `Tests 4 passed (4)` after, on three consecutive whole-file
runs. The neighbouring claim suites stay `17 passed (17)`. The file takes ~8 s
green instead of ~5 s red: each `I8` run waits out the pin's `1_000 ms` park
bound when the loser is refused before the park — expected, and not shortened.
