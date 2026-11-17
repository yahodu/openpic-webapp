# ADR-0641 — OP-119 RED gap closure: the analytics scope enum, the missing `eventId`, the revoked-organizer admission and the empty window

- **Status:** Accepted
- **Date:** 2026-11-11
- **Ticket:** OP-119 (Events epic, phase 3 — Events & Collaboration)
- **Card:** `t_5aa3655c` (test-author follow-up to the OP-119 RED review, round 1)
- **Branch:** `OP-119-task-analytics-scope-pins` (worktree
  `/root/openpic/openpic-webapp/.worktrees/t_20c75ee0`, off the RED tip
  `32a15fb`, `origin/main` `284e098`)
- **Range:** `0640`–`0659` (the OP-119 lane block ADR-0640 drew). This card
  consumes `0641`; the lane's `Next free` cell is left at `0642` for the gated
  GREEN `t_da9cbf64`.
- **Supersedes:** nothing. **Extends:** ADR-0640 §Assumptions (A6/A7) with the
  two refusals it claimed but did not pin.

## Context

The OP-119 RED (`t_20c75ee0`, head `32a15fb`, PR #403) was approved with three
Medium findings, all test-side and all inside the two integration specs it
added:

- **M1** — an unknown `scope` value was never exercised. §20.1 stores
  `analyticsDaily.scope.kind = "tenant" | "event" | "platform"`, while §4.5's
  query is `scope=tenant|event`. A route that forwarded the raw query value into
  its rollup filter would serve **platform-wide** rollups to one tenant `owner`.
- **M2** — ADR-0640 A7 claims `scope=event` without an `eventId` is `422
validation_failed`, but no case pinned it.
- **M3** — `resolveEventActorRole` (`@/server/events/access`) filters
  `revokedAt: null`. A route that queried `event_organizers` itself, without
  that filter, would admit a **removed** worker and hand them the roster (other
  workers' display names and masked contacts).

The review also routed a cheap Low item: A5 pins the reducer's empty case but
nothing pinned the **route** on an empty window.

This card adds four cases and no production code. The existing 40 cases are
untouched.

## Decision

### 1. `scope` is a closed vocabulary; an unknown value is `422 validation_failed`

`scope=platform` (no `eventId`), sent by a tenant `owner`, is `422` with
`error.code === "validation_failed"` and **no `series` key** in the body.

The contract side is decided rather than guessed:

- §4.5's own signature is `?…&scope=tenant|event&eventId=` — `platform` is not
  in the vocabulary the endpoint documents.
- §20.1's `platform` scope belongs to the **admin** dashboard (§9.3), which is a
  different surface; ADR-0640 §Out of scope already recorded that this lane does
  not serve it.
- Silently **coercing** `platform` to `tenant` was considered and rejected: a
  client that asked for platform rollups would receive tenant rollups it cannot
  tell apart from the ones it asked for, and the refusal is what makes the
  closed enum observable. Coercion would also let a future widening of the
  filter leak by changing one line, silently.

To keep the pin non-vacuous the case seeds a real `analyticsDaily` row with
`scope: { kind: "platform", id: null }` and `imagesUploaded: 987654`: a naive
route that forwards the raw value answers `200` **with** that row, so the case
fails on the status (`expected 200 to be 422`), not on an empty result.

### 2. `scope=event` without an `eventId` is `422 validation_failed` naming `eventId`

The refusal carries `details.fields[]` with an entry whose `path` is `eventId`
(the `parseQrQuery` shape, ADR-0620), so a client learns which parameter is
missing. This is ADR-0640 A7 made executable.

### 3. A revoked organizer with no `tenantMembers` row gets the uniform `404`

`event_organizers` carries a `revokedAt` (`null` while the worker is active), so
the route must go through `resolveEventActorRole`, whose `findOne` carries
`revokedAt: null`. A caller whose only row is revoked and who holds no
`tenantMembers` row is therefore not an actor: `404 not_found`, and the body
carries no `data`, so the roster never reaches a removed worker. The case also
asserts the seeded row really exists with a `Date` `revokedAt`, so the `404`
cannot come from a fixture that silently seeded nothing.

### 4. An empty window is `200` with `series: []` and twelve zero totals

No stored rollup row at all → `200`, `series: []`, and `totals` exactly
`makeAnalyticsMetrics()` (the twelve §20.1 metrics, every one `0`). The key set
is asserted too, so a route that omitted `totals` or answered `null` fails.

## Consequences

- The GREEN's `scope` handling must **whitelist** `tenant` (default) and `event`
  and refuse everything else through the same `validation_failed` path the
  missing `from`/`to` already uses; it must not pass the raw query string into
  the filter.
- The GREEN's member admission must stay on `resolveEventActorRole`. The pin
  fails a bespoke `event_organizers` query, which is exactly the regression it
  exists for.
- No new module, route or registry row is owed by this card: the four cases ride
  on the contract ADR-0640 already fixed. This ADR therefore records **no new
  contract** — it upgrades three assumptions into executable pins and closes the
  `platform` question that ADR-0640 had left out of scope.
- The `docs/adr/README.md` ledger is the known hotspot: this card writes the
  `0641` index row and the lane's `Next free` cell (`0642`), and leaves the
  `0660`+ pool cell and every other row byte-identical.

## Alternatives considered

- **Coerce `platform` to `tenant`** — rejected above: it hides a client bug and
  keeps a one-line path to a cross-tenant leak.
- **Pin the refusal only by its status** — rejected: `details.fields[]` naming
  `eventId` is what distinguishes a deliberate refusal from an unrelated `422`
  (e.g. a range failure), so the case asserts both.
- **Seed the revoked row by re-running the existing `addEventMember` helper and
  then `$set`-ing `revokedAt`** — rejected: a dedicated
  `addRevokedEventMember` helper states the fixture's whole shape in one place
  and keeps the shared helper byte-identical (the card forbids touching the
  existing cases, and the helper is used by four of them).
- **Assert `payload.data === []` for the revoked caller** — rejected: a `404`
  envelope is what §0.4 requires; asserting the absence of `data` (rather than
  an empty array) pins that the roster is not served at all.

## Evidence (RED at handoff, head `603ee83` + ADR commit)

Two throwaway probe worktrees, both removed with `git worktree remove --force`;
no stub was ever committed and `git status` in the deliverable shows the two
spec files, this ADR and the README only.

**A. Near-fix stub — the pins are load-bearing.** A near-complete implementation
(the real `date-range` + `totals`, an analytics route that forwards the raw
`scope` and silently falls back to `tenant` when `eventId` is absent, and a
members route whose admission queries `event_organizers` **without**
`revokedAt`) gives, with `tsc -p apps/web/tsconfig.json --noEmit` exit `0`:

- unit `analytics-range` + `analytics-totals`: **18 passed (18)**;
- integration, both specs: **3 failed | 23 passed (26)** — the 22 pre-existing
  cases and the empty-window pin stay green, and exactly the three new
  adversarial cases fail:
  - `answers 404 to a revoked organizer who is not a tenant member` →
    `AssertionError: expected 200 to be 404` (event-members.test.ts:470);
  - `refuses scope=platform with 422 validation_failed and serves no series` →
    `AssertionError: expected 200 to be 422` (tenant-analytics.test.ts:534);
  - `refuses scope=event without an eventId, naming the missing eventId` →
    `AssertionError: expected 200 to be 422` (tenant-analytics.test.ts:552).

**B. No implementation — every case is assertion-level RED.** With the two route
modules replaced by plain `500` stubs (no route pipeline at all), `tsc` is still
exit `0` and the same two specs report **26 failed (26)**, each on its own
assertion: `expected 500 to be 200` (empty window,
tenant-analytics.test.ts:441), `expected 500 to be 422` (platform, :534;
missing `eventId`, :552), `expected 500 to be 404` (revoked organizer,
event-members.test.ts:470), and the same shape for the 22 pre-existing cases.

**C. At the deliverable head** the modules still do not exist, so the honest RED
is the missing-module failure the RED card recorded (`Cannot find package
'@/app/api/v1/tenants/[tenantId]/analytics/route'`), the unit project is
`2 failed | 142 passed` **files** (only this lane's two unit specs), `eslint`
0 errors / 0 warnings and `prettier --check` clean on every file this card
touched.

## Out of scope (deliberately not tested)

- Serving `platform` analytics to a platform admin (§9.3): another surface, with
  its own route and its own authorization story. Only the refusal is pinned
  here.
- What a **revoked** row's `status` field should be in the listing (A14 in
  ADR-0640 already leaves a `removed` member unpinned): this card pins only that
  a revoked caller cannot read the list at all.
- A `scope=event` request whose `eventId` is malformed (not 24-hex). §4.5 does
  not say whether that is `422` or `404`; the nearest existing precedent
  (`eventIdFromRequest`) answers `404`, and ADR-0640 A8 already pins a foreign
  event as `404`. Pinning one of the two here would invent a rule, so the choice
  is left to the GREEN and named in the handoff as an open item.
- Any e2e: the card's `e2e_api_playwright` list is empty and a RED branch cannot
  build a standalone server (OP-93/ADR-0306).
