# ADR-0781 — OP-129 GREEN: anonymous attendee sessions implemented

- **Status:** Accepted (implementation of the ADR-0780 contract)
- **Consumers:** `@/server/attendee/session-token`, `@/server/attendee/session-cookie`,
  `@/server/attendee/session-resolver`, `@/api/v1/p/attendee-sessions[/current]`,
  `@/server/db/collections` + `@/server/db/indexes`, `@/server/http/catalog`
- **Lane:** OP-129 (epic Attendee Identity). Reserved range `0780`–`0798`,
  `Next free = 0782`.
- **Supersedes:** nothing. **Amends:** [ADR-0780](ADR-0780-op129-anonymous-attendee-sessions-red.md)
  (the RED contract) by answering its §Open questions.

## Context

ADR-0780 fixed the executable contract and left five decisions to this GREEN: the
persistence name, the unknown-`eventSlug` answer, the idempotency stage, the
rate-limit class, `lastSeenAt` on read and the `current` answer for a user
session. The 30 pins it delivered are the specification; nothing here adds
behaviour they do not demand.

## Decision

### 1. The collection is `attendeeSessions`, declared in `COLLECTIONS`

Schema §13.5 names the collection; the registry had no entry, so the GREEN picks
the spelling. `attendeeSessions` matches the app-owned identity block
(`userProfiles`, `notificationPreferences`, `sessionDevices`) that the same
schema chapter introduces, so the row, the resolver and the indexes share one
constant instead of three literals.

Indexes (schema §13.5): `{tokenHash:1}` unique, `{expireAt:1}` TTL `0` and
`{claimedByUserId:1}`. The schema calls the last one **sparse**; `IndexSpec` has
no `sparse` field (the same pre-existing gap already carries
`{"scheduledChange.effectiveAt":1}` sparse and `{"eventId":1}` sparse rows), so
it is declared plain and the deviation is recorded here rather than papered over
by a new option nobody's pins exercise. A plain index answers the same queries;
it only also indexes the `null` values.

### 2. The token and cookie modules are the shipped primitives

`generateAttendeeSessionToken` is `randomToken(32, "opat_")` and
`hashAttendeeSessionToken` is `sha256Hex` — both from `@/server/runtime/crypto`.
The cookie builder is pure and takes `secure` / `maxAgeSeconds`; the create route
injects `buildCookieOptions(getAppEnv()).useSecureCookies` and
`retention.attendeeSessionDays × 86 400`, **reusing** the environment policy the
Better Auth cookie already uses instead of re-deriving it.

### 3. The resolver answers three outcomes, and the route reads the row twice

`createAttendeeSessionResolver({database, clock?})` implements OP-86's port with
the cookie first (`op_att`) and the mobile header second
(`X-Attendee-Session`): no credential or no matching row → `null` (the guard
answers `401 authentication_required`); a lapsed row → throws
`attendee_session_expired` with `details.recreateUrl = "/p"`; otherwise the
principal `{kind: "attendee", sessionId, eventId}`. The throw is essential: a
`null` would collapse "your session lapsed" into "you sent nothing".

`GET .../current` reads the row a second time in the handler. The OP-86
principal deliberately carries only the session id, and widening that port would
touch every guard consumer for one read; a second indexed `tokenHash` lookup is
the smaller change. It also keeps `noAttendeeSessions` from being the silent
default, as ADR-0780's consequences required.

### 4. Answers to ADR-0780's open questions

| Question                         | Answer                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown `eventSlug`              | `404 not_found` from the create route. A slug is resolved through `events.accessLinks[].slug`; silently ignoring it would let an attendee believe their selfie was bound to an event it never reached.                                      |
| Idempotency stage on `POST`      | None. Contract §1.5 declares no `Idempotency-Key`, and I5 accepts either a replay or a second session; a stage would only add a stored snapshot that must not carry the token.                                                              |
| Rate-limit class (60/h/IP)       | **Not enforced here.** Contract §0.11 has no row for the endpoint, and the rate-limit stage is a separate story's surface; adding a class would be inventing the very knob the contract leaves undefined. Recorded as the lane's known gap. |
| `lastSeenAt` on a `current` read | Not refreshed. The pins deliberately avoid a write-per-read assumption; the field is stamped at creation.                                                                                                                                   |
| `current` for a user session     | `401 authentication_required` unless the request also presents an `op_att` token. §1.5 describes only the anonymous body, so the route never invents a user projection.                                                                     |

### 5. `eventSlug` binds, and the current body reads the slugs back

The create body is `{eventSlug?: string}`; a slug is looked up by
`events.accessLinks.slug` and its `_id` is stored in `eventIds`. `current`
projects `eventIds` back to `events.accessLinks[0].slug`. Both sides exist so the
body's `eventSlugs` is honest the moment a slug is bound; with no slug it is `[]`
as the pins require.

### 6. The device fingerprint reuses the OP-89 hasher and the deployment salt

`deviceFingerprint` is three independent `hashFingerprint()` calls (the shipped
salted SHA-256 helper) over the user-agent, the client IP and the accepted
languages, salted with `getRateLimitConfig().salt`. Salting is what keeps a
leaked `ipHash` from being reversed into an address; the IP itself is resolved by
`resolveClientIp` with the configured trusted header, so a forged
`x-forwarded-for` does not become the fingerprint.

### 7. `attendee_session_expired` joins the auth code set

Appended to `AUTH_ERROR_CODES` and `AUTH_ERROR_TRANSPORT` (`401`,
non-retryable, Generic message), the repository's append-only pattern: a code in
contract Appendix A.1 that the executable catalogue lacked. `ERROR_CATALOG` stays
the exact Appendix A copy its spec pins.

## Consequences

- An attendee read of `current` costs two indexed lookups (auth stage + handler)
  and, when the session is bound, one `events` read for the slugs.
- The endpoint has **no rate limit** on this branch. Until the rate-limit story
  lands a class for it, a caller can mint sessions unthrottled; the only bound is
  the TTL and the storage each row costs.
- `attendeeSessions` now participates in `INDEX_SPECS`, so
  `pnpm db:ensure-indexes` creates the unique digest index and the TTL index in
  every environment.
- The `current` body for a signed-in user remains undefined by design; a later
  card that wants "my anonymous sessions" must add its own route.

## Alternatives considered

- **Widen `AttendeePrincipal`** to carry `claimedByUserId`/`expiresAt` so the
  handler needs no second read. Rejected: it changes an OP-86 port every guard
  consumer types against, for one read.
- **Ignore an unknown `eventSlug`.** Rejected: a silent no-op is the failure mode
  the session exists to avoid — the attendee would upload into nothing.
- **Add `sparse` to `IndexSpec`.** Rejected for this card: it widens the index
  registry's contract for one unobserved index while three schema rows already
  live with the gap. A later index-registry card can add it once for all of them.
- **Declare an idempotency stage on `POST`** to make retries cheap. Rejected: the
  contract does not require a key, and I5 explicitly allows a second session.

## Assumptions

1. `recreateUrl = "/p"` — the public attendee surface root; §1.5 names the field
   but not the page, and the pin only requires a site-relative path.
2. The `events` slug lives on `events.accessLinks[].slug` (schema §15.1); the
   first link is the event's public slug, matching `@/server/events/dto`.
3. `expireAt` is inclusive (`now >= expireAt`), and the resolver reads the clock
   per call so `vi.setSystemTime` controls it.
4. MongoDB TTL deletion is asynchronous; a row may outlive `expireAt` by the
   monitor's interval, which is why expiry is decided in code as well.

## Evidence

All commands run in `/root/openpic/openpic-webapp/.worktrees/t_8b1c0dfe` on
`OP-129-task-anonymous-attendee-sessions-green` (based on the pins branch tip
`f7660c2`, not on bare `origin/main`).

1. Honest RED before the change: `Cannot find package
'@/server/attendee/session-token'` for both unit specs; the integration spec
   could not import either route module.
2. Unit: `attendee-session-token.test.ts` 9/9, `attendee-session-cookie.test.ts`
   6/6; full unit project **149 files, 2390 passed | 3 skipped**.
3. Integration: `attendee-sessions.test.ts` **12/12** on a real
   `MongoMemoryReplSet`; full integration project **99 files, 920 passed**.
4. Coverage (`vitest run --project unit --project integration --coverage`):
   all files 91.93 % statements / 80.49 % branches / 95.7 % functions /
   92.19 % lines — above the configured 80 % global thresholds.
5. E2E: `pnpm build` then `playwright test` — **27 passed**, including
   `E1: a created session's cookie authenticates GET .../current`.
6. `tsc -p apps/web/tsconfig.json --noEmit` exits `0`; ESLint reports no errors
   on the changed files (two `security/detect-possible-timing-attacks` warnings on
   `=== null` guards, the class the repository already tolerates); Prettier
   clean.
