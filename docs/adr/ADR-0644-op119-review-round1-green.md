# ADR-0644 — OP-119 review round 1 GREEN: the member route extends the tenant stage, and its projection is total

- **Status:** Accepted
- **Date:** 2026-11-11
- **Ticket:** OP-119 (Events epic, phase 3 — Events & Collaboration)
- **Card:** `t_76818e4b` (OP-119 review round 1, artifact lens — GREEN follow-up
  to findings **F1** and **F2** of `t_da9cbf64`, plus the behaviour-preserving
  F3 cleanup)
- **Branch:** `OP-119-bug-members-alias-total` (PR #408, squash-merged as
  `ea36f33`; worktree `/root/openpic/openpic-webapp/.worktrees/t_da9cbf64`,
  based on the pin card's tip `fffdc92`, which is itself one commit on
  `origin/main` `eab1291`)
- **Range:** `0640`–`0659` (the OP-119 lane block ADR-0640 drew). `0640`,
  `0641`, `0642` and `0643` are consumed by the lane's RED, pin, GREEN and
  round-1 pin records, so this record takes `0644` and advances the lane's
  `Next free` cell to `0645`.
- **Extends:** ADR-0642 §Decision (the member route's `userAuth()`-only posture
  and the projection) and ADR-0643 §1/§2 (the pins this card turns green).
  **Consumes:** ADR-0643 (pins P1/P2/P3).

## Context

The OP-119 GREEN landed on the trunk as `97f00b1` (PR #405). Round-1 review
(`t_da9cbf64`) found three defects that the lane's 44 specs did not pin; the
TEST card `t_b4ec0827` turned the first two into RED integration cases
(ADR-0643) and left the third as an optional, behaviour-preserving cleanup:

- **F1 (High)** — `GET /api/v1/tenants/current/events/{eventId}/members`
  answered `404`: the route reimplemented tenancy resolution with a bare 24-hex
  test on the segment, so the contract §0.4 alias could never resolve, even
  though the sibling analytics route resolves it through `tenantStage()`.
- **F2 (Medium)** — one malformed `event_organizers` row 500'd the whole
  listing for every caller: `new Date(undefined).toISOString()` threw
  `RangeError: Invalid time value` for a row with neither `addedAt` nor
  `createdAt`, and `String(undefined)` reached the wire as `"undefined"`, which
  `idSchema` refused (a second `500`) for a row with no `userId`.
- **F3 (Low)** — `resolveScopeTarget` carried an unreachable
  `query.eventId === null` arm that would serve the **tenant** aggregate to an
  `scope=event` caller if it ever became reachable.

The pins assert only the observable contract: P1 is `200` plus
`X-Tenant-Id: <resolved hex>` plus the two workers; P2 is "no `500`, the two
well-formed workers still listed". The shape of each fix was left to this card.

## Decision

### 1. `current` is resolved by the shared stage, with an event-scoped admission seam (F1)

`tenantStage` gains one option, `admission?: TenantAdmission` — a seam that
**replaces** the `tenantMembers` check on a route whose contract grants access
through another relationship (contract §0.4, §4.3). The stage still owns, once:

1. `current` → `userProfiles.primaryTenantId` (never a `tenants` read by the
   literal string), and the 24-hex shape of an explicit segment;
2. the `X-Tenant-Id` echo of the resolved id;
3. the single `tenancy.access_denied` `warn` (plus `tenancy.resolved` `debug`);
4. the uniform, non-oracle `404` for every denial.

The member route passes `admission: admitEventActor`, a new export of
`@/server/events/access` (`admitEventActor`). It reads the event tenant-scoped
(the workspace check and the existence check in one read — another workspace's
event is "not found"), then reuses `resolveEventActorRole`, whose
`revokedAt: null` filter refuses a removed worker. This is the ADR-0260
"extend, never reimplement" shape the module docblock already asked for.

**Why the seam and not a boolean inside the stage.** The stage must not import
the events domain (`admitEventActor` needs the route's `{eventId}` segment
position and the event-actor resolver), and the route must not reimplement
resolution. The callback keeps the dependency pointing one way: the route wires
the stage and the seam; the stage knows nothing about events. It also keeps the
denial log in the stage, which the bespoke route never emitted.

**Why `ctx.tenantRole` is not published on this path.** The admission is the
event relationship, not a workspace role, and a co-organizer commonly holds no
`tenantMembers` row (§4.3). Publishing an invented role would be a lie; the
member handler needs only the resolved `tenantId`, which the stage sets.
`requireTenantScope` is therefore not used by this route.

**No regression, by construction:** the five pre-existing co-organizer
admission cases stay green because `resolveEventActorRole` still admits a
co-organizer with no `tenantMembers` row; a stranger, a foreign event, an
unknown event and a revoked-only caller still take `deny` → `404`; a malformed
tenant segment is denied by the stage's own shape check (never a `500`); the
successful response still carries the resolved `X-Tenant-Id`. The response body
is untouched.

### 2. The member projection is total (F2)

`listEventMembers` now builds its rows through two total helpers before any
join:

- `toObjectId(row.userId)` — the existing id reader — proves the row can **name**
  a user. A row without a usable `userId` is **skipped**: no fallback exists
  that would satisfy `idSchema`, so skipping is the only valid shape (ADR-0643
  §A16).
- `joinInstantMillis(row)` proves the row can be **dated**. It reads
  `addedAt ?? createdAt` as `Date`s (schema §15.2 types both as dates; this
  codebase's event-create write stores `createdAt`, ADR-0642). A row carrying
  neither falls back to `_id.getTimestamp()` — the insertion instant the row
  already encodes — so the worker stays attributed instead of failing the
  listing. A `Date` that is invalid, or a row whose `_id` is not an `ObjectId`,
  is undatable and is skipped.

The fallback is deliberate: for the timestamp arm the row names a real user, so
dropping it would silently lose a worker from the attribution the endpoint
exists to provide; `_id.getTimestamp()` is a documented, honest approximation,
not an invented value. For the user arm there is nothing to approximate.

`maskEmail`, the §4.3 DTO field set, the cached `uploadedImageCount` projection
and the ordering (`addedAt`, then `userId`) are unchanged. The sort still runs
on the projected ISO strings.

### 3. The unreachable tenant fallback is removed by type (F3)

`AnalyticsQuery` became a discriminated union: the `kind: "tenant"` arm has
`eventId: null`, and the `kind: "event"` arm has `eventId: string`.
`resolveScopeTarget` now narrows on `query.kind === "tenant"` only, and the id it
dereferences is statically non-null.

**Why no response changes.** `parseAnalyticsQuery` already returned
`kind: "event"` only after the `eventId` parameter passed the non-empty and
24-hex checks, and returned `kind: "tenant"` with `eventId: null` otherwise, so
the old `|| query.eventId === null` half could never be true for a `tenant`
query and never false for an `event` one. The change is a type-level narrowing
of the same truth table: every accepted request maps to the same target, status
and body. The 17 pre-existing analytics cases and the P3 characterization stay
green.

## Consequences

- Future nested tenant routes that admit through event membership have a shared,
  documented seam; no route repeats alias parsing or denial logging.
- A malformed `event_organizers` row degrades one entry, never the endpoint: the
  listing answers `200` with the rows it can project.
- `AnalyticsQuery`'s union makes "event scope without an id" unrepresentable, so
  the widening bug F3 described cannot be reintroduced without a type error.
- The stage's `admission` option skips the workspace-membership read on the
  routes that use it (one fewer round trip than "member or event actor").

## Alternatives considered

- **Call `tenant: tenantStage()` on the member route and drop the actor
  resolver** — rejected: it refuses a co-organizer with no `tenantMembers` row,
  turning five pre-existing cases red and breaking §4.3.
- **A boolean `admitEventMember` inside `route-stage.ts`** — rejected: it would
  force the tenancy module to import the events domain and to hard-code the
  `{eventId}` segment position.
- **Reimplement alias resolution in the member route** — rejected: it is exactly
  the defect F1 found; the header, the log and the denial shape would drift
  again.
- **Serve a fallback `userId` for a userless row** — impossible: any stand-in
  string fails `idSchema`; only skipping is honest.
- **Skip a row with no join instant** — allowed by ADR-0643 §A15, but rejected in
  favour of the `_id` fallback because the row names a real worker and
  attribution is the endpoint's purpose.

## Evidence (GREEN at handoff)

- RED before the change, at the pins tip `fffdc92`: focused integration
  **3 failed | 27 passed (30)** — P1 `expected 404 to be 200`, P2a
  `expected 500 to be 200` with the `RangeError` at `members.ts:70`, P2b
  `expected 500 to be 200` with `data.2.userId` refused by `idSchema`.
- GREEN at the head: `event-members.test.ts` + `tenant-analytics.test.ts`
  **30 passed (30)** (12 member cases, 18 analytics cases).
- Full suite: unit project **144 files / 2305 passed | 3 skipped**; integration
  project **95 files / 844 passed** (the four cases this lane's round-1 pins
  added since ADR-0642's 840).
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; ESLint 0 errors / 0
  warnings on every touched file; `prettier --check` clean; the ADR-numbering
  guard green; the coverage thresholds met.
- No test, mock, fixture or factory is edited: the diff against the pins tip is
  production code, this ADR and the ledger.

## Coverage gaps handed to the Test Author

- The member route's **malformed tenant segment** is unpinned (`404` through the
  stage's shape check); only the analytics and workspace routes pin it.
- The exact `addedAt` value of an undated row is unpinned: P2a asserts only
  "no `500`" and the two well-formed workers, so the `_id`-timestamp fallback is
  recorded here rather than pinned.
- A row whose stored `addedAt` is an **invalid `Date`** (rather than absent) is
  unpinned; the implementation treats it as absent and falls back.
- `admitEventActor`'s two denial reasons (`event_not_found`,
  `not_an_event_actor`) are indistinguishable on the wire by design (both
  `404`), and no case asserts the log's `reason` value.
- The removal of the unreachable tenant fallback (F3) is unpinned as such: it is
  behaviour-preserving and covered by the 18 existing analytics cases.
