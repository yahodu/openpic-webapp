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

## Amendment note — F1: `eventSlug` binds through an **active** access link (t_09d9e958)

**No new decision, no new ADR number.** The behaviour was already fixed by the
contract: §6 preamble ("Every route is scoped by the event's **active**
access-link `slug`, resolved through the unique partial index on
`accessLinks.slug` where `active: true`") and §4.2 ("Already-printed QR codes stop
working"). The implementation described above did not honour it: `eventIdsFor`
resolved `{ "accessLinks.slug": slug }` with no `active` filter, and
`eventSlugsFor` projected `accessLinks[0].slug` regardless of `active`. This note
records the pin that now discriminates that defect, not a change to the contract.

**Measured defect** (probe on `741b607`, the OP-129 landing): an `events` row
whose only link is `{ slug: "revoked0", active: false }` answered `201` with a
`sessionToken` and stored `eventIds: [<that event>]`; `current` then answered
`eventSlugs: [{ slug: "revoked0", active: false, … }]`. A rotated-away QR slug
minted a bearer credential and advertised itself.

**The pin.** Three red cases and three controls in
`apps/web/src/test/integration/attendee-sessions.test.ts` (F1 `describe` blocks),
asserting only observable behaviour:

1. `F1: a deactivated access-link slug is 404 not_found and writes no session
row` — `404` + `error.code === "not_found"` + a database-wide `tokenHash`
   scan is unchanged (no session row), because a refused create must not leave a
   bearer credential behind. Red on the trunk: `AssertionError: expected 201 to
be 404`.
2. `F1: a revoked slug does not bind even when the same event carries a newer
active link` — the shape rotation actually produces (old element revoked, new
   element active **on the same document**). This is the pin that forces an
   _element-scoped_ match: `{ "accessLinks.slug": slug, "accessLinks.active":
true }` satisfies case 1 but still matches this row, because MongoDB applies
   each condition to a different array element unless `$elemMatch` (or an
   aggregation filter) binds them. Red on the trunk: `expected 201 to be 404`.
3. `F1: a link deactivated after the session was created is not reported in
eventSlugs` — create with an active slug, then rotation deactivates it on the
   same row (`accessLinks.0.active: false`), then `current` must answer
   `eventSlugs: []`. The session stays valid — the credential is the session, not
   the link — but the stale public slug must stop being advertised. Red on the
   trunk: `expected [ 'op129f100050' ] to deeply equal []`.
4. Controls (green on the trunk and after the fix, so the red cannot be
   satisfied by refusing or ignoring every slug): an active slug still binds and
   `current` reports it; a slug that matches no event is still `404 not_found`
   with no row written; and an active link still binds when it is **not** the
   first `accessLinks[]` element (a fix that reads `accessLinks[0]` would break
   the post-rotation row, where the active element is appended last).

**Satisfiability probe.** A three-line faithful fix (`$elemMatch` in
`eventIdsFor`; filter the projected `accessLinks` by `active === true` in
`eventSlugsFor`, plus the `active` field on the local `EventSlugRow` projection
type) turned the file green — **18 passed (18)** — and `tsc -p
apps/web/tsconfig.json --noEmit` exited `0` with it. Both route files were then
restored byte-identically (blob hash equal to `HEAD`), so this card ships **no
production change**: `git diff --name-only origin/main...HEAD` is this spec file
and this note.

**Evidence on the pins branch** (measured, not copied):

- `TMPDIR=/root/tmp-mongo npx vitest run --project integration
apps/web/src/test/integration/attendee-sessions.test.ts` → **3 failed | 15
  passed (18)** (the 12 pre-existing cases plus the 3 new controls);
  `-t "F1 control"` → **3 passed | 15 skipped (18)**.
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; Prettier clean; ESLint
  `0 errors, 1 warning` on the spec (`security/detect-object-injection` on
  `requireHandler`, the same single warning the `origin/main` blob carries).
- `checkAdrDirectory("docs/adr")` stays `{ ok: true, issues: [] }`: no file is
  added, renamed or renumbered by this card.

**Numbering.** The card carried no `Consumes:` line and states that a test-only
change mints none, so no number was taken and `docs/adr/README.md` is untouched:
the lane's `Next free` stays `0782`. Flag for the allocator: `0782` is currently
claimed twice **in flight** (`ADR-0782-op129-attendee-session-edge-pins.md` on
`OP-129-task-attendee-session-edge-pins`, PR #449, and
`ADR-0782-op129-attendee-session-rate-limit-pin.md` on
`OP-129-task-attendee-session-rate-limit-pins`, PR #451), and `0783`/`0784`/`0786`
are also taken by unmerged lane branches; the next card in this lane must be
allocated above the highest of them, not off the `Next free` cell.

**Open question handed to the GREEN (`t_297eae5e`).** `eventSlugsFor` now must
decide what a bound event with **several** active links reports. This pin only
constrains an event whose links are all inactive (`[]`) and one whose single
active link is the only one reported, so either "all active slugs" or "the link
that was used" satisfies it; the GREEN card prescribes filtering the projected
array by `active === true`, which is compatible with both.

**GREEN delivery (`t_297eae5e`).** `eventIdsFor` now resolves
`{ accessLinks: { $elemMatch: { slug, active: true } } }` and keeps the lookup
before the insert, so a revoked slug answers the unchanged `404 not_found` and
writes no session row. `eventSlugsFor` filters the projected `accessLinks[]` by
`active === true`, so a since-deactivated link is reported as absent. Measured
after the change: `attendee-sessions` integration **18 passed (18)**,
`attendee-session-token` **9** and `attendee-session-cookie` **6** unit passed,
ADR guards **54** passed with `checkAdrDirectory("docs/adr")` `{ ok: true,
issues: [] }`, `tsc --noEmit` exit `0`, ESLint 0 errors, Prettier clean. Of the
multiple-active-link question left open above, the "all active slugs" reading is
implemented — the array is filtered, so the order the row carries is kept.
