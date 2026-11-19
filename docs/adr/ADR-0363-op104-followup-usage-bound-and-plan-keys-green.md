# ADR-0363 — OP-104 follow-up GREEN: the bounded `/usage` page, the required subscription plan keys, and the pinned live-row selection

- **Status:** Accepted (GREEN; the seven ADR-0362 pins pass on this head and the two characterisation pins stayed green)
- **Date:** 2026-11-19
- **Card:** OP-104 IMPL follow-up (`t_010670d6`) · **Branch:** `OP-104-task-usage-bound-subscription-impl` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op104-followup-impl`
- **Relates to:** [ADR-0362](ADR-0362-op104-followup-usage-bound-and-plan-keys-red.md) (the RED pins this turns green), [ADR-0360](ADR-0360-op104-entitlements-usage-endpoints-red.md) / [ADR-0361](ADR-0361-op104-entitlements-usage-endpoints-green.md) (the landed read surface), ADR-0400 (the OP-106 subscription read whose write-side filter this selection mirrors), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §0.5 (envelopes), §0.7 (status codes), §0.8 (pagination), §3.5 (entitlements & usage) · **Schema:** §14.2, §14.3

## Context

The OP-104 review (`t_18f8fece`, PR #279) approved the entitlements/usage read
surface with three implementation findings routed to this card. The Test Author
delivered their RED half ([ADR-0362](ADR-0362-op104-followup-usage-bound-and-plan-keys-red.md)):
nine new cases in `apps/web/src/test/integration/entitlements-endpoints.test.ts`,
seven failing on the shipped head and two characterisation pins green on arrival.
This record is the GREEN: it implements exactly what those pins demand, in two
production files, and changes nothing else.

## Decision

### L2 — `/usage` is a bounded cursor page (§0.8), additively

- The route reads `?periodKey=&cursor=&limit=` and hands `limit`/`cursor` to the
  **existing** `parsePageQuery` (`apps/web/src/server/http/cursor.ts`): default
  **40**, clamped to **100**, an unparseable or foreign cursor `400
invalid_cursor`, a non-integer/zero limit the platform `422 validation_failed`.
  No paginator, codec or dependency was added.
- `readUsageCounters` takes `{ periodKey, limit, cursor }` instead of a bare
  `periodKey` — the only signature change, so the barrel `index.ts` is
  untouched (it re-exports the function, not its parameters).
- The query sorts **`periodKey` descending, then `_id` descending** and reads
  `limit + 1` rows; `buildCursorPage` splits the over-fetch into the page and
  `nextCursor`. The keyset filter for a continued page is
  `{$or: [{periodKey: {$lt: c}}, {periodKey: c, _id: {$lt: ObjectId(i)}}]}`, so
  a page boundary inside one period neither skips nor repeats a row. A cursor
  whose `_id` half is not a 24-hex id is `400 invalid_cursor` (the codec only
  guarantees non-empty strings).
- The body stays `{ data: […] }` and gains `page: { nextCursor, hasMore, limit }`
  (`page.limit` is the effective, clamped limit; `nextCursor` is `null` when
  `hasMore` is `false`). `usageCountersSchema` gains `page` because
  `serializeResponse` validates object schemas strictly — a handler returning
  `page` under the old schema answers `500`. The existing-client shape renders
  unchanged: the rows themselves are the same projection, with no `_id`.

### L3 — both subscription plan keys are required (§14.3)

`storedSubscriptionSchema.activePlanKey` / `subscribedPlanKey` lose their silent
`.default("free")`. A **present** `subscriptions` row missing either field now
fails the parse and the route answers **`500 internal_error`** (§0.7 "Unhandled —
never leak internals"), with no `activePlanKey`/`entitlements` in the body: the
corruption is not laundered into a genuine-looking free tier. The row is
server-side data, not client input, so no `4xx` would be honest. Nothing else
changes: **no** subscription document at all still serves `activePlanKey:
"free"` / `subscribedPlanKey: "free"` / `subscriptionStatus: "none"` (I1,
unchanged), because that default lives in `readEntitlementsView`, not in the
schema.

### L4 — the `$ne: "cancelled"` selection is pinned, not changed

No production change. `findOne({ status: { $ne: "cancelled" } })` stays
identical in `view.ts` and in the write-time enforcement in `service.ts`, so the
§3.2 and §3.5 reads cannot disagree (ADR-0400). The two characterisation pins
hold on this head: an `expired` row is live and resolves its paid plan, and with
several live rows the served plan and `subscriptionStatus` belong to one of the
live rows — never to the cancelled one. If product later decides `expired` must
read as free, the filter changes in `service.ts` and `view.ts` together, in one
commit, and both pins redden in both directions.

## Files

| Path                                                        | Change                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| `apps/web/src/server/services/entitlements/view.ts`         | bounded/sorted/paged `readUsageCounters`, `page` schema, no plan defaults |
| `apps/web/src/app/api/v1/tenants/[tenantId]/usage/route.ts` | reads `parsePageQuery` and passes the page query through                  |

No other production path is touched: not the barrel, not `service.ts`, not
`…/subscription/history/route.ts` (OP-106), not any test, fixture or helper.

## Evidence

Measured on this head (`1e24d867` + the `origin/main` `b6f10412` merge), real
command output:

- **Focused integration spec** (`entitlements-endpoints.test.ts`): **29 passed
  (29)** — the seven ADR-0362 pins are green and the two characterisation pins
  stayed green. Run `npx vitest run --project integration
apps/web/src/test/integration/entitlements-endpoints.test.ts`.
- **Full `unit` + `integration` with coverage** (`vitest run --project unit
--project integration --coverage --coverage.reportOnFailure=true`): **exit 0**
  — **332 files / 4679 passed, 3 skipped**. Global **91.78 % statements / 80.67 %
  branches / 96 % functions / 91.9 % lines**; `server/services/entitlements`
  **98.94 % statements / 98.72 % branches**, with `view.ts` at **98.14 / 97.22 /
  100 / 97.95** (uncovered: line 285, the `invalid_cursor` guard in
  `cursorFilterFor` — a defensive trust-boundary arm no pin seeds).
- **`pnpm typecheck`** exit 0 on all three projects; **`pnpm lint`** 0 errors
  (187 pre-existing warnings, none in the two touched files); **`prettier
--check .`** clean.
- **ADR guards** (`adr-numbering`, `adr-lane-ranges`, `adr-record-links`,
  `adr-consumers`, `adr-source-references`, `adr-inline-code-spans`):
  **6 files / 236 tests passed** with `ADR-0363` and this ledger in place.
- **`pnpm --filter @openpic/web build`** exit 0, with
  `/api/v1/tenants/[tenantId]/usage`, `/entitlements` and
  `/subscription/history` in the route table.

## Consequences

- `/usage` clients that ignore `page` keep working; a client that wants every
  row follows `nextCursor` until it is `null`, and the response can no longer
  grow without bound as `usageCounters` accumulates one row per
  (entitlementKey, periodKey).
- A damaged paid subscription is now a loud, logged `500` instead of a silent
  free tier.
- `readEntitlementsView` still reads the tenant's counters unbounded — it needs
  every period it evaluates `periodKey()` for, so it is not part of this bound.
  A future `/entitlements` payload bound is a separate finding.

## ADR number allocation

The OP-104 lane holds `0360`–`0379` with `Next free = 0363` — `0362` was consumed
by the RED record this PR also lands. `0363` was free on `main`, in every
worktree and on every remote ref at the cut, so this record consumes it and the
cell advances to `0364`. No number outside the lane range is touched.
