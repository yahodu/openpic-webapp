# ADR-0643 — OP-119 review round 1 pins: the `current` tenant alias on the member list and the malformed member row

- **Status:** Accepted
- **Date:** 2026-11-11
- **Ticket:** OP-119 (Events epic, phase 3 — Events & Collaboration)
- **Card:** `t_b4ec0827` (test-author follow-up to the OP-119 GREEN review,
  round 1, artifact lens — findings **F1** and **F2**)
- **Branch:** `OP-119-task-members-alias-pins` (worktree
  `/root/openpic/openpic-webapp/.worktrees/t_da9cbf64`, off `origin/main`
  `eab1291`, the OP-119 GREEN squash `97f00b1` + its release commit)
- **Range:** `0640`–`0659` (the OP-119 lane block ADR-0640 drew). `0640`,
  `0641` and `0642` are consumed by the lane's RED, pin and GREEN records, so
  this record takes `0643` and advances the lane's `Next free` cell to `0644`.
- **Supersedes:** nothing. **Extends:** ADR-0642 §Coverage gaps (the `current`
  alias on the member route and the malformed member rows), and pins the
  malformed-`eventId` reading that ADR-0642 §Decision chose and ADR-0641 left
  open.

## Context

The OP-119 GREEN landed on the trunk as `97f00b1` (PR #405). Round-1 review
(`t_da9cbf64`, artifact lens) approved the two pinned acceptance criteria and
routed two real defects in the merged code that the lane's 44 specs do not pin:

- **F1 (High)** — `GET /api/v1/tenants/current/events/{eventId}/members`
  answers `404 not_found` for the event's own organizer, whose
  `userProfiles.primaryTenantId` already names that tenant. The sibling
  `GET /tenants/current/analytics` answers `200` with the resolved id because it
  declares `tenant: tenantStage()`; the member route reimplements tenancy
  resolution with a bare 24-hex test on the segment
  (`apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/members/route.ts:47-50`),
  so the alias can never resolve.
- **F2 (Medium)** — one `event_organizers` row with neither `createdAt` nor
  `addedAt` makes the whole listing answer `500 internal_error`:
  `new Date(undefined).toISOString()` throws `RangeError: Invalid time value` in
  `toAddedAt` (`apps/web/src/server/events/members.ts:70`). A row whose `userId`
  is not an id is the **same defect class** through the other field:
  `String(undefined)` reaches the wire as `"undefined"`, `idSchema` refuses it
  and `serializeResponse` answers `500` (`members.ts:87`).

The review also asked for one **characterization** case so that a decision the
GREEN already made is load-bearing rather than prose: ADR-0642 §Decision chose
`422 validation_failed` (never `404`) for a malformed `eventId` under
`scope=event`, and ADR-0641 §Out of scope had explicitly left that choice open.

This card adds four integration cases and no production code. The 26 existing
integration cases are byte-identical (`git diff` is 191 insertions, 0
deletions).

## Decision

### 1. The member list resolves the `current` alias, and echoes the resolved id (P1)

`GET /api/v1/tenants/current/events/{eventId}/members` by the event's organizer,
with `userProfiles.primaryTenantId` set to that tenant, is `200`; the response
carries `X-Tenant-Id: <resolved tenant hex>`; and the `data` array names both
workers by `userId`.

The assertion is deliberately **not** the whole body: the fix is free in its
internals (which helper resolves the alias, whether the alias resolution is
folded into `tenantStage()` or into a shared tenancy helper), and only the two
observable facts §0.4 owns are pinned — the status and the echoed id.

**Constraint the fix inherits (stated, not pinned again).** The member route
admits a co-organizer who holds **no** `tenantMembers` row (contract §4.3); that
admission is pinned by the pre-existing case _"admits a co-organizer who is not
a tenant member"_ and by four more cases in the same file. A fix that reaches
for `tenant: tenantStage()` unconditionally would refuse that caller with the
uniform `404` and turn those cases red. The GREEN must therefore either extend
the stage (a documented option that admits an event actor, the ADR-0260
"extend, never reimplement" route) or resolve the alias through a shared helper
— and it must leave all nine pre-existing member cases green. This is the same
reading ADR-0642 recorded for the route's `userAuth()`-only posture.

### 2. A malformed member row must not fail the listing (P2)

Two cases, one defect class:

- **A15 — no join instant.** The two workers plus one `event_organizers` row
  with a real `userId`, `role: "co_organizer"`, `revokedAt: null`,
  `uploadedImageCount: 4` and **neither** `createdAt` **nor** `addedAt`: the
  listing is `200` and still serves both well-formed workers, with their
  `uploadedImageCount` (`3200`/`920`) intact.
- **A16 — no user id.** The same fixture with one row that carries **no
  `userId` key at all**: the listing is `200` and still serves both well-formed
  workers.

**Readings this ADR allows** (the pin must not choose for the GREEN):

- the malformed row may be **skipped** (not projected at all), or
- it may be **served with a documented fallback** (for A15, a defined instant
  such as the epoch; for A16 that is not available — a member row that names no
  user cannot satisfy `idSchema`, so skipping is the only shape that keeps the
  response valid, and a fallback must still be a 24-hex id the row does not
  have).

Either reading passes: the assertions are the `200`, the two well-formed
workers and their counters. A fix that silently drops **all** rows fails, and so
does a fix that drops the two well-formed ones.

Why the second case rides with the first: the card allows it "only if it costs
one assertion", and it costs exactly the same two. Both failure arms are real
(the `:70` `RangeError` and the `:87` `"undefined"` schema refusal), both are
reachable from stored data alone, and a GREEN that guards only the timestamp
would leave the sibling `500` in place. One row-projection guard satisfies
both, which is the point of pinning them together.

### 3. A malformed `eventId` under `scope=event` is `422`, not `404` (P3)

`GET /tenants/{tenantId}/analytics?scope=event&eventId=not-a-24-hex-id` by an
owner answers `422 validation_failed`, the body carries **no `series`**, and
`details.fields[]` contains an entry whose `path` is `eventId`.

This is a **characterization** pin: it passes on the trunk today (P3 of the
run below) and it makes ADR-0642 §Decision load-bearing. The distinction it
locks is the one §0.4 draws: a malformed **path** segment is `404` (a route must
never be an existence oracle), while a malformed **filter value** is a
request-shape refusal, and the caller is already an authorised tenant
`owner`|`admin`, so naming the bad parameter discloses nothing.

## Consequences

- The member route owes alias resolution, and owes it **without** losing the
  co-organizer admission (see §1). The two implementations are both acceptable;
  a bespoke re-resolution that forgets the alias again fails P1, and a
  `tenantStage()` that forgets the co-organizer fails the five pre-existing
  admission cases.
- `listEventMembers` owes one row-projection guard: either skip rows whose
  `userId` is not an id (and, for the timestamp arm, whose join instant is
  absent) or project a documented fallback. The guard belongs at the projection
  boundary, not in the route, because the route never sees a row.
- No new module, route, registry row or contract text is owed: §0.4 already
  requires the alias and the `X-Tenant-Id` echo, §4.3 already requires the
  listing to serve the event's workers, and ADR-0642 already chose `422` for the
  malformed query value. This ADR therefore records **no new contract** — it
  upgrades three documented-but-unpinned behaviours into executable pins.
- `docs/adr/README.md` is the shared-ledger hotspot: this card writes the
  `0643` index row and the lane's `Next free` cell (`0644`), and leaves the
  `0660`+ pool cell and every other row byte-identical (union rule: keep the
  highest cell).
- P1 and P2 are RED-by-design and fold into the GREEN follow-up `t_76818e4b`,
  which must base its branch on this card's tip, not on bare `origin/main`.

## Alternatives considered

- **Assert the whole member body for P1** — rejected: it would fail a fix that
  legitimately changes ordering, and ordering is already pinned by the
  pre-existing cases. Status + header + the two `userId`s is what §0.4 owns.
- **Assert the malformed row is absent (or present) for P2** — rejected: the
  card leaves that open on purpose. Pinning it would invent a rule (§4.3 says
  nothing about a row with no join instant) and would fail a defensible fix.
- **Fold the no-`userId` row into the A15 case** — rejected: one case would then
  fail for whichever defect is touched first, and the GREEN would fix one and
  re-run blind. Two named cases cost two assertions each and diagnose
  themselves.
- **Pin `404` for a malformed `eventId`** — rejected: ADR-0642 §Decision chose
  `422`, `parseAnalyticsQuery` implements it, and a `404` here would blur the
  path-segment/filter-value distinction §0.4 relies on.
- **Re-assert the analytics `platform`/missing-`eventId` refusals here** —
  rejected: ADR-0641 already pins them; duplicating them would only enlarge the
  diff.

## Evidence

Verified in the lane worktree
`/root/openpic/openpic-webapp/.worktrees/t_da9cbf64` on branch
`OP-119-task-members-alias-pins`, off `origin/main` `eab1291`.

**A. The pins are RED on the trunk, assertion-level.** With
`TMPDIR=/root/tmp-mongo`, the two integration specs give
**3 failed | 27 passed (30)**, and the three failures are exactly the new cases:

- "resolves `current` to the organizer's primary tenant and echoes it in
  X-Tenant-Id" → `AssertionError: expected 404 to be 200`
  (`event-members.test.ts:556`);
- "still serves the two workers when one member row carries no join instant" →
  `AssertionError: expected 500 to be 200` (`event-members.test.ts:589`), with
  the structured log carrying `RangeError: Invalid time value` at
  `apps/web/src/server/events/members.ts:70` (`toAddedAt`) through
  `projectEventMember` (`:92`) and `listEventMembers` (`:141`);
- "still serves the two workers when one member row names no user" →
  `AssertionError: expected 500 to be 200` (`event-members.test.ts:624`), with
  `Response for /api/v1/tenants/:tenantId/events/:eventId/members did not match
its schema: data.2.userId: Must be a 24-character lowercase hex id.` from
  `serializeResponse`.

The 26 pre-existing cases and the P3 case pass in the same run; `tsc -p
apps/web/tsconfig.json --noEmit` exits `0`, so the RED is not an import or type
failure.

**B. The pins are load-bearing — a near-fix turns them green.** A throwaway
near-fix (never committed) resolved `current` from
`userProfiles.primaryTenantId` in the route, returned a defined instant for a
row with no join instant, and filtered out rows whose `userId` is not an id:
`tsc` exit `0` and `event-members.test.ts` **12 passed (12)** — the three new
cases green **and** the nine pre-existing ones still green. Both production
files were then restored with `git checkout --`; `git status` shows the two
spec files only.

**C. Deliverable shape.** `git diff --stat` against `origin/main`:
2 files changed, **191 insertions(+), 0 deletions(-)** — the 26 pre-existing
cases are byte-identical. `eslint` exit `0` (0 errors, 0 warnings) and
`prettier --check` clean on both touched files.

## Out of scope (deliberately not tested)

- **The alias on the co-organizer path.** P1 pins the organizer (whose
  `primaryTenantId` names the tenant) because that is the actor the alias is
  defined for. What a co-organizer with no `primaryTenantId` should get from
  `/tenants/current/…` is undecided by §0.4 and is left to the GREEN; the
  pre-existing hex-segment admission case pins the part that is decided.
- **The denial log.** F1 also notes the reimplementation loses the
  `tenancy.access_denied` warn line. Logs are not a contract surface here and
  asserting on them would pin an implementation detail; the `404` itself is
  what the client sees, and the pre-existing cases already pin it.
- **Whether a `removed` member row is served** (ADR-0640 §A13) and **the
  optional `invitationId`** (§A12): unchanged, still open.
- **The `uploadedImageCount` `$inc` on upload-complete** (ADR-0640 §A13):
  another surface; this card seeds the cached counter only.
- **Any e2e.** A RED branch cannot produce a standalone server (OP-93/
  ADR-0306), and the card's `e2e_api_playwright` list is empty.
