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
at this record's cut the lane's `Next free` cell read `0782`. Flag for the
allocator: `0782` was then claimed twice **in flight**
(`ADR-0782-op129-attendee-session-edge-pins.md` on
`OP-129-task-attendee-session-edge-pins`, PR #449, and the rate-limit pin, minted
as `0782` and renumbered to
`ADR-0787-op129-attendee-session-rate-limit-pin.md` — see ADR-0787 §Number
allocation), and `0783`/`0784`/`0786` were also held by unmerged lane branches;
the next card in this lane had to be allocated above the highest of them, not off
the `Next free` cell. The flag was honoured: the pin took `0787`, the edge-pins
record kept `0782`, and the lane cell now reads `Next free = 0788`, with `0786`
and `0787` landed.

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

## Amendment note — F1 follow-up: the `eventSlug` lookup must be **index-backed** (`t_067135c7`)

- **Status:** Accepted (test-only pin; no production change on this branch)
- **Consumers:** `apps/web/src/test/integration/attendee-sessions-slug-lookup-plan.test.ts`
- **Numbering:** no number is taken. A test-only pin mints none, so
  `docs/adr/README.md` and the lane's `Next free` cell are untouched.

**Context.** The round-1 review of the F1 GREEN measured the create route's
`eventSlug` lookup on the trunk tip (`main` @ `9219d03`). The route resolves
`{ accessLinks: { $elemMatch: { slug, active: true } } }`, and the only `events`
index that carries a slug is `events_active_slug_unique`
(`{accessLinks.slug: 1}`, unique, partial on `{"accessLinks.active": true}`).
The planner's subset check does not accept an `ELEM_MATCH_VALUE` predicate, so
the partial index cannot serve the shipped filter. `POST
/api/v1/p/attendee-sessions` is public and unauthenticated, and each call
full-scanned `events` (500/500 documents examined, 0 keys). Contract §1.5 says
the slug is "resolved through the unique partial index on `accessLinks.slug`
where `active: true`", so the docs described a plan that never ran. Nothing in
the correctness pins can see this: the answer stays right, only the cost is
wrong.

**Decision.** Pin the plan, not the answer, in a **new** spec file
(`attendee-sessions.test.ts` is a multi-lane conflict hotspot: PRs #449, #451,
#453, #464). The pin seeds 300 `events` rows after `ensureIndexes`, then
explains the route's filter shape **verbatim** against the real index set. It
asserts three properties: the winning plan contains an `IXSCAN` stage, it carries
no `COLLSCAN` stage, and `executionStats.totalDocsExamined` is `<= 5`. The pin
names **no index**: any index, or any equivalent filter, that keeps the
element-scoped semantics satisfies it. Two controls keep the pin from being
satisfied by a weaker match — an `events` row shaped
`[{slug: "…revoked", active: false}, {slug: "…active", active: true}]` returns
0 documents for the revoked slug and 1 for the active one — and two route-level
controls keep the _route_ on that semantics while the lookup is optimised: the
revoked slug is `404 not_found`, the active slug is `201`.

The explain runs **without** `limit(1)`: a limited collection scan stops at the
first match and would hide the cost this pin exists to catch. The target row is
seeded last for the same reason.

**Measured RED on this branch** (draft PR, not merged; the GREEN carries the file
forward unchanged):

- `serves the slug lookup from an IXSCAN and never from a COLLSCAN` →
  `AssertionError: expected '{"stage":"COLLSCAN","filter":{"access…' to contain
'"IXSCAN"'`. The winning plan is `{"stage":"COLLSCAN","filter":{"accessLinks":
{"$elemMatch":{"$and":[{"active":{"$eq":true}},{"slug":{"$eq":
"op129plan-target-0001"}}]}}},"direction":"forward"}`.
- `examines at most 5 event documents to resolve one slug` →
  `AssertionError: expected 300 to be less than or equal to 5`.
- The four controls pass on the same run: **2 failed | 4 passed (6)**.

**Satisfiability probe.** A throwaway non-partial, non-unique compound index
`{accessLinks.slug: 1, accessLinks.active: 1}` added to `INDEX_SPECS` (and
removed again) turned the whole file green — **6 passed (6)** — with the winning
plan `FETCH` over `IXSCAN` on that index, `docsExamined: 1`, `advanced: 1`. So
the pin is satisfiable **while the filter stays `$elemMatch`**: the fix is an
index, not a dotted filter (a dotted `accessLinks.slug` + `accessLinks.active`
filter would be index-usable but would re-open the cross-element match the F1
pin kills, and the rotated-row control above fails it). `indexes.ts` was restored
byte-identically afterwards (sha256
`5e04a3a7f1e3dadb1689f1b263e533059f60952d9ad47f52aa92fde0b341ce60`, `git
diff` empty), so this card ships no production change.

**Consequences.** The GREEN owes a decision that this amendment deliberately
leaves open: a new non-partial compound index on `events.accessLinks` costs one
more index on a write path, while a unique **partial** replacement must keep the
`E11000` slot that the create route's slug-collision retry relies on. The pin
accepts either, because it asserts the plan and the semantics, not the index
name. `tsc --noEmit` exits `0`, ESLint reports 0 errors and 0 warnings, and
Prettier is clean on the spec.

**CI on the draft (`#473`).** `lint`, `unit_test`, `audit`, `audit-dev`,
`secret-scan`, `validate-branch-name`, `validate-pr-title` and CodeQL pass. `ci`
(the integration job) and `test_coverage` fail with **exactly** the two
assertions above and nothing else: `Test Files 1 failed | 106 passed (107)` and
`Test Files 1 failed | 268 passed (269)`. Every other spec in the repo is green
on this head, so the RED cannot be read as collateral damage.

## Delivery note — F1 follow-up GREEN: the `eventSlug` lookup index (`t_02dac037`)

- **Status:** Accepted (production change; no new ADR number — this note carries
  the decision the amendment above delegated to the GREEN)
- **Consumers:** `@/server/db/indexes` (`INDEX_SPECS`),
  `@/api/v1/p/attendee-sessions[/current]` (docblock only),
  `docs/API Contract.md` §Part 6 + index table, `docs/Notification and Database
Design.md` §15.1 + §21

**Decision.** `INDEX_SPECS` gains one entry: collection `events`, keys
`[["accessLinks.slug", 1]]`, name `events_active_slug_lookup`, **non-unique,
non-partial**. It costs one extra index on the event write path and keeps the
whole `E11000` slot where the create-route collision retry reads it.
`events_active_slug_unique` (`{accessLinks.slug: 1}`, unique, partial on
`{"accessLinks.active": true}`) is untouched and still owns slug uniqueness.

**Why single-key, not the two-key probe shape.** The satisfiability probe in the
amendment above used a compound `{accessLinks.slug, accessLinks.active}`. Two
constraints narrow it down, and the shipped shape is the only one that satisfies
both:

- The U1 unit lint (`apps/web/src/server/db/indexes.test.ts`) requires every
  **compound** index on a tenant-scoped collection (which `events` is) to lead
  with `tenantId`, except the names in `DOCUMENTED_TENANT_SCOPE_EXCEPTIONS` — a
  literal owned by the **test**, so adding a second exception is a test-author
  change, not an implementation one. A compound lookup index without a
  `tenantId` lead fails U1.
- A `tenantId`-led compound (`{tenantId, accessLinks.slug, accessLinks.active}`)
  was measured against the same 300 rows and is **not** planner-usable for this
  filter: the plan stayed `COLLSCAN`, 300 documents examined. The route has no
  `tenantId` predicate to bound the leading key, so the prefix stays unbounded
  and the planner declines the index.

The single-key `{accessLinks.slug: 1}` form is outside U1, which governs
compound indexes only (the shipped `events_active_slug_unique` is already a
single-key index on the same path), and it gives the `$elemMatch`'s slug
equality a bound. If the test author prefers the two-key shape, the change is
one entry in `DOCUMENTED_TENANT_SCOPE_EXCEPTIONS`; this card did not edit a test,
so it shipped the single-key form that greens every existing guard.

**No migration file.** `ensureIndexes` reconciles `INDEX_SPECS` against the live
index list by **name** (`indexes.ts:930-966`): an absent name is created, a
differing definition is dropped and recreated, an identical one is skipped. A
new entry is therefore created by the next bootstrap with no data migration —
the declared half of schema change is the registry.

**The query is unchanged.** `eventIdsFor` still resolves
`{ accessLinks: { $elemMatch: { slug, active: true } } }`. The dotted form
(`{"accessLinks.slug": s, "accessLinks.active": true}`) is also index-usable but
matches a row whose _different_ elements carry the two predicates — the
post-rotation shape the F1 amendment and PR #469 exist to refuse.

**Measured `explain("executionStats")`, 300 seeded `events` rows, the route's
filter verbatim, no `limit`:**

| index set                     | plan                                                           | `totalDocsExamined` | `totalKeysExamined` | `nReturned` |
| ----------------------------- | -------------------------------------------------------------- | ------------------- | ------------------- | ----------- |
| shipped (partial unique only) | `COLLSCAN`                                                     | 300                 | 0                   | 1           |
| + `events_active_slug_lookup` | `FETCH` over `IXSCAN` (`isMultiKey: true`, `isPartial: false`) | 1                   | 1                   | 1           |

The `$elemMatch` filter still runs in the `FETCH` stage, so per-element
semantics are preserved and only the document count changes.

**F3 docblock fix.** `eventSlugsFor`'s `@returns` claimed "`eventIds` order then
row order"; `find({_id: {$in: [...]}})` guarantees no cross-event order, so the
claim is dropped (documentation only, no behaviour change).

**Docs corrected.** Both places that claimed the _partial_ index serves slug
resolution now name the plain lookup index and keep the partial index's real
role: `docs/API Contract.md` §Part 6 preamble and its per-route index table row
for `GET /p/events/{slug}`; `docs/Notification and Database Design.md` §15.1
index list and the §21 index-summary row.

**Gates.** The F1 pin
(`attendee-sessions-slug-lookup-plan.test.ts`) **6 passed (6)** — the two RED
assertions now hold. `attendee-sessions.test.ts` **18 passed (18)**;
`index-bootstrap.test.ts` **8**; `event-create.test.ts` **14**; the U1/U2 index
lint (`apps/web/src/server/db/indexes.test.ts`) **15**;
`attendee-session-token` **9** and `attendee-session-cookie` **6** unit;
`adr-numbering` **54** + `adr-lane-ranges` **17** with
`checkAdrDirectory("docs/adr")` `{ ok: true, issues: [] }`; `tsc -p
apps/web/tsconfig.json --noEmit` exit `0`; ESLint 0 errors; Prettier clean. The
full local suite is green: unit **2618 passed | 3 skipped**, integration **1101
passed (107 files)**, and the coverage run **3719 passed | 3 skipped (269
files)** at **91.99% statements / 80.85% branches / 96.24% functions / 92.19%
lines** — above every configured threshold.

## Review sign-off — round 1 (artifact lens)

The reviewer record for the round-1 review of the F1 GREEN (card `t_297eae5e`, PR #469). Artifact lens: the diff was read cold, before the implementer's handoff narrative. Written by the reviewer profile (`openpic-webapp-reviewer`), which edited no file in the reviewed delivery.

### Verdict

**APPROVED WITH FINDINGS.** Zero reviewer edits: the reviewed diff is the implementer's four files and nothing else. Reviewed head `0702d1a` (PR #469, `OP-129-bug-active-access-link-bind`), squash-merged to `main` as `0b1eaa1`. Two follow-ups were routed (F1 and F2 below); neither of them blocks the delivery.

### Evidence reproduced independently, not taken from the handoff

Measured at review time, and re-measured when this sign-off was written:

- Ancestry: `git merge-base --is-ancestor 0b1eaa1 origin/main` exits `0`, so the reviewed squash is on trunk.
- Bytes: `git diff --stat 0702d1a 0b1eaa1` prints nothing for the PR's four paths, and each path names one and the same blob at both commits. The bytes the review read are the bytes that landed.
- Spec file: one blob, `50b5525`, at the pins commit `1c61a67`, at `0b1eaa1` and at `9219d03` (the trunk tip at review). Nothing in the delivery rewrote a pin.
- `attendee-sessions.test.ts`, integration project, real `MongoMemoryReplSet` with `TMPDIR=/root/tmp-mongo`, at `9219d03`: **18 passed (18)**.
- Full `--project unit` at `9219d03`: 160 files, **2566 passed | 3 skipped (2569)**.
- `tsc -p apps/web/tsconfig.json --noEmit` exits `0` at the reviewed head `0702d1a` and at `9219d03`.
- `prettier --check` is clean on the changed files. PR #469 carries 15 check nodes and none of them is non-pass.
- Diff scope: four files, two routes, one spec, this record.

One measurement moved after the review and is recorded here rather than hidden: today's `origin/main` carries a different blob for `attendee-sessions.test.ts` (`5cc1c69`). Squash `84952e3` added the F2 rate-limit `describe` block and its two imports, and three docblock references were repaired from ADR-0768 to ADR-0780 in the same window. No assertion in the file changed; the reviewed pins are untouched.

### Finding F1 — the slug lookup is a collection scan (Medium, performance)

The route resolves `{accessLinks: {$elemMatch: {slug, active: true}}}`. The only `events` index that carries a slug at `0b1eaa1` is `events_active_slug_unique` (`{accessLinks.slug: 1}`, unique, partial on `{"accessLinks.active": true}`), and the planner's subset check does not accept an `ELEM_MATCH_VALUE` predicate, so the partial index cannot serve the shipped filter. Measured with 500 seeded `events` rows and the route's filter verbatim, without `limit`: plan `COLLSCAN`, `totalDocsExamined` 500, `totalKeysExamined` 0. A throwaway non-partial compound multikey `{accessLinks.slug: 1, accessLinks.active: 1}`, added to `INDEX_SPECS` and removed again, served the same `$elemMatch` with `totalDocsExamined` 1 and `totalKeysExamined` 1 (`IXSCAN` under `FETCH`), and the index file was restored byte-identically. `POST /api/v1/p/attendee-sessions` is public and unauthenticated, so the scan is amplifiable by any caller. No shipped pin could see it: the answer stays right, only the cost is wrong.

Routed at review time to card `t_067135c7` (TEST) and then `t_02dac037` (GREEN), and recorded in this file's two amendment notes above. Those re-measured the plan on 300 seeded rows with the same outcome and added `events_active_slug_lookup` (`{accessLinks.slug: 1}`, non-unique, non-partial). The landed shape is single-key rather than the compound probe shape: the U1 tenant-scope lint forbids a `tenantId`-less compound index on `events`, and a `tenantId`-led compound stayed a `COLLSCAN` for a filter that carries no `tenantId` predicate.

### Finding F2 — the documented rate limit is not enforced (High, security/abuse)

`docs/API Contract.md:601` documents `Auth public · Rate 60 / hour / IP` for `POST /api/v1/p/attendee-sessions`. At `0b1eaa1` the route's `defineRoute` call declares no `rateLimit` stage, `apps/web/src/server/rate-limit/classes.ts` has no `attendee.session` entry (its three `attendee`-scoped rows belong to other attendee routes), and `middleware.ts` carries no limiter for `/p/**`. The contract and the tree disagree, and the route under it mints a session row and a raw token per unauthenticated call. §Decision §4 and §Consequences recorded the gap knowingly as the lane's own; the finding is that a published limit nobody enforces is a shipping divergence, not a documentation defect.

Routed at review time to card `t_553aaea9` (TEST) and then `t_c119dd3d` (GREEN). The limit itself reached trunk through card `t_c2ec1845`, which landed the class and the stage as squash `84952e3` (PR #451); its records are ADR-0787 for the pins and ADR-0786 for the implementation. At that squash `classes.ts:56` carries `"attendee.session": [{ scope: "ip", limit: 60, windowSeconds: 3600 }]` and the create route declares the stage at `route.ts:120`.

### Info

- `eventSlugsFor`'s `@returns` claims "`eventIds` order then row order", and `find({_id: {$in: [...]}})` guarantees no cross-event order. Documentation only, folded into `t_02dac037`.
- The multi-active-link reading, an event row that carries two `active: true` links, stays this record's own open question. The F1 pins do not decide it.

### Honesty audit

The diff carries no fixture literal, no test-environment conditional, no suppression comment, no `@ts-ignore`, no `TODO` and no console output. The two route hunks are a docblock correction and one filter expression, and the spec file was carried byte-identically from the pins commit, so the delivery neither weakened nor re-shaped a pin.

### Nothing above is retracted

No statement in §Context, §Decision §1–§7, §Consequences, §Alternatives considered, §Assumptions, §Evidence, the two amendment notes or the delivery note is retracted by this review. Two statements are superseded in place without being rewritten, and both stay true as facts about the reviewed tree: the "Not enforced here" cell of §Decision §4 and the "no rate limit on this branch" bullet of §Consequences describe `0b1eaa1`, and the limit is enforced from `84952e3` onwards. The follow-ups' own records document what happened next — the amendment notes in this file for F1, ADR-0787 and ADR-0786 for F2 — and this sign-off asserts no identifier of that work beyond the card ids.
