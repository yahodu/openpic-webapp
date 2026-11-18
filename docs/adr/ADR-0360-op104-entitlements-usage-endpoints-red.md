# ADR-0360 — OP-104 RED: the entitlements and usage endpoints — the read model, `resetsAt`, `blockReason` and the role split

- **Status:** Accepted · **Date:** 2026-10-24
- **Card:** OP-104 RED (`t_e7539f55`) · **Branch:** `wt/t_e7539f55` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_e7539f55`
- **Relates to:** [ADR-0340](ADR-0340-op103-entitlements-red.md) / [ADR-0341](ADR-0341-op103-entitlements-green.md) (the generic entitlement check this reads), [ADR-0260](ADR-0260-op100-tenant-provisioning-red.md) (the reusable tenant stage), [ADR-0280](ADR-0280-op101-tenant-members-red.md) (the owner-only gate shape), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.5 (entitlements & usage), §0.5 (envelopes), §0.14 (entitlement enforcement) · **Schema:** §14.1, §14.2, §14.3

## Context

OP-103 (ADR-0340/ADR-0341) shipped the _decision_ surface — `checkEntitlement`,
`consumeEntitlement`, `releaseEntitlement` — plus the atomic counters. OP-104 is
the story that **reads** that data back out so the UI can grey out actions and
show quota bars (the card's user story), and so support can reconcile a tenant
against its raw counters.

The card pins only observable behaviour:

- `U1` `resetsAt` for monthly/yearly/lifetime;
- `U2` `blockReason` derivation;
- `I1` a free tenant with no subscription document → `activePlanKey: "free"`,
  `subscriptionStatus: "none"`;
- `I2` an `entitlementGrants` row reflected in `effectiveLimit` **and** `grants[]`;
- `I3` a `member` GETting `/usage` → `403`.

It does not pin module paths, the exact arithmetic of `resetsAt`, what
`blockReason` treats as a payment block, the `/usage` response envelope, or what
"raw counters" may expose. The sibling GREEN card `t_72aaa13f` narrows the shape
(`entitlements[]` with `limit`/`effectiveLimit`/`used`/`remaining`/`periodKey`/
`resetsAt`/`unlimited`/`grants`/`thresholdCrossed`/`display`; event/attendee keys
**without** `used`; `/usage` raw counters for `owner`|`admin`; parallel reads),
and this record fixes the rest.

## Decision

### Module contract

| Module (specifier)                                   | Exports                                                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@/app/api/v1/tenants/[tenantId]/entitlements/route` | `GET` — `member` auth, advisory, the bare §3.5 body                                                              |
| `@/app/api/v1/tenants/[tenantId]/usage/route`        | `GET` — `owner`\|`admin`, the §0.5 collection envelope `{ data: rawUsageCountersRow[] }`                         |
| `@/server/services/entitlements` (existing barrel)   | re-exports `resetsAtFor(resetPeriod, now): Date \| null` and `blockReasonFor(status, entitlements): BlockReason` |

Both routes run behind the existing `userAuth` / `tenantStage` plumbing
(`@/server/tenancy/route-scope`), so a non-member is `404 not_found` (never
`403`) and the resolved workspace is echoed in `X-Tenant-Id`, exactly as the
OP-101 member routes do (ADR-0260, ADR-0280). The tenant id passed into the
tenant-scoped reads is the **string** hex form ADR-0341 established for
`usageCounters`/`entitlementGrants`/`subscriptions`; the `plans` read is
platform-scoped.

### 1. `resetsAt` is the start of the next **UTC** period

`resetsAtFor(resetPeriod, now)` returns:

- `monthly` → `Date.UTC(y, m + 1, 1)` (e.g. `2026-09-15` → `2026-10-01T00:00:00.000Z`);
- `yearly` → `Date.UTC(y + 1, 0, 1)`;
- `lifetime` / `none` → `null`.

UTC, not the tenant time zone, is deliberate and mirrors the `periodKey` cadence
ADR-0340 §4 already pinned: the quota bar's countdown must line up with the
counter row it is drawn from, and the counter identity already ignores
`settings.defaultTimeZone`.

### 2. `blockReason` mirrors the enforcement reason split, not the banner taxonomy

`blockReasonFor(status, entitlements)` returns, in order:

1. `"payment_downgrade"` when `status === "downgraded"`;
2. `"plan_limit"` when any **`hard`** row is exhausted —
   `effectiveLimit !== null && used !== null && used >= effectiveLimit`;
3. `null` otherwise.

Two consequences are load-bearing:

- **Only `hard` blocks.** `soft`/`policy` limits tolerate the overage (schema
  §14.1) and a `feature` row is a boolean gate — none of them can report
  `plan_limit`. A `null` `effectiveLimit` is unlimited and can never be exhausted.
- **Only `downgraded` is a payment block.** Schema §14.2's own pseudo-code is
  `status === "downgraded" ? "payment_downgrade" : "plan_limit"`, and ADR-0341
  implemented exactly that for the `402`/`403` split. A `past_due` tenant with
  room is therefore **not** blocked here; the §3.2 subscription endpoint's
  `banner` (OP-106) carries the past-due warning. Keeping the two consistent is
  what stops the banner and the write-time refusal from disagreeing.

`payment_downgrade` outranks `plan_limit` when both hold.

### 3. `/usage` serves raw counters as the §0.5 collection envelope

The endpoint answers `{ data: [ { entitlementKey, periodKey, value, updatedAt? } ] }`,
filtered by the `?periodKey=` query, and never leaks the driver's `_id` (§0.5:
"never expose `_id` or `ObjectId` wrappers"). "Raw" means unconverted counter
values for support/reconciliation — not the tenant `_id`, which the caller
already knows.

### 4. The role split is the contract's, expressed by the tenant scope

`/entitlements` is `member`-readable (every organizer-side role), while `/usage`
is `owner`|`admin` only. A `member` hitting `/usage` is `403 forbidden` — the
same `appError("forbidden")` shape the owner-only member mutations use
(ADR-0281) — because support/reconciliation data is not something a plain
member's UI needs. Membership itself is still enforced first by the tenant
stage, so a non-member gets `404`, never a role-dependent `403`.

### 5. The advisory view performs no write

`GET /entitlements` must not advance, create or mutate any `usageCounters` row
(§0.14 "advisory"; the server re-checks at write time). The suite pins this
observably: two reads leave every stored counter value and row count unchanged.

## Consequences

- A wrong `resetsAt` boundary, a `plan_limit` reported for a `soft`/`policy`
  row, a `past_due` mistaken for a payment block, an ignored grant, a leaked
  `_id`, or a `member` reaching `/usage` now fails the suite loudly.
- The event/attendee scopes are **partially** pinned: the endpoint lists them
  with their plan limits and no `used`/`remaining` (§3.5), which is the slice the
  quota bars need. The eventual per-event consumption read is §4.1
  (`GET /events/{eventId}`) and belongs to the event story.
- `thresholdCrossed` is asserted only as `null` when no counter metadata
  records a crossing: the latch itself (`usage.storage.threshold` /
  `usage.events.threshold`, notification §4.4) is not implemented yet, so the
  specs seed no latch metadata and pin only that the field is present and
  correctly empty. The counter `metadata` shape that will carry the latch is
  left to the story that implements threshold latching.
- **Open question / assumption (display copy).** `display` is pinned only as a
  non-empty string; the OP-102 generic formatter (`formatEntitlementDisplay` /
  `formatBytes`, ADR-0320) is the obvious reuse, but the exact prose for the
  metered rows (`"5 of 7 active events"`) is product copy and is not asserted.
- **Open question / assumption (`blockReason` for `past_due`).** If product
  later wants a past-due tenant's global banner to read as a payment block, that
  is a follow-up that changes decision 2 — it must also change the enforcement
  split to stay consistent, which is why it is not guessed here.
- The `submit` of the endpoint response schema (`Entitlements` / `EntitlementState`)
  is the GREEN's to declare; the specs validate the body with their own schema so
  a field the route forgets to project still fails.

## Alternatives considered

- **Derive `blockReason` from both `downgraded` and `past_due`.** Rejected: it
  would make the advisory banner claim a block the write path does not enforce
  (`checkEntitlement` maps only `downgraded` to `payment_downgrade`).
- **Treat `soft`/`policy` rows at their limit as `plan_limit`.** Rejected:
  schema §14.1 defines those enforcements as allow-with-notify /
  background-enforced, so reporting `plan_limit` would grey out a button the
  server would happily accept.
- **`/usage` returns the bare `usageCounters` documents.** Rejected: §0.5
  forbids exposing `_id`, and "raw rows" is about value fidelity, not leaking
  storage identifiers.
- **A single `owner`-only gate on both endpoints.** Rejected: the entitlements
  view powers the organizer shell for every member; §3.5 gives it `member` auth.
- **Pinning `resetsAt` on event/attendee rows too.** Rejected: §3.5's own
  feature-row example omits `resetPeriod`/`resetsAt`, so their presence there is
  ambiguous and is left unpinned rather than guessed.

## ADR number allocation

This lane (`OP-104`) had no reserved range in
[ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §6, so — acting as
the first card of the lane — it draws the next block from the allocator's
`unallocated (future lanes)` pool: `0360`–`0379`, and consumes `0360` for this
record ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §1–§3, the
same move OP-102's first card made for `0320`–`0339`). The README table gains an
`OP-104 entitlements & usage endpoints lane` row with `Next free = 0361`, and
the unallocated pool advances to `0380`+. No number outside the block is touched.
