# ADR-0362 — OP-104 follow-up RED: `/usage` bounded by the §0.8 cursor, both subscription plan keys required, and the `$ne: "cancelled"` selection pinned

- **Status:** Accepted (RED; 7 pins fail on `origin/main` `ecfe2fd1`, 22 pass — see Evidence)
- **Date:** 2026-11-18
- **Card:** OP-104 TEST follow-up (`t_c361b6ec`) · **Branch:** `OP-104-task-usage-bound-subscription-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op104-followup-red`
- **Relates to:** [ADR-0360](ADR-0360-op104-entitlements-usage-endpoints-red.md) (the RED contract), [ADR-0361](ADR-0361-op104-entitlements-usage-endpoints-green.md) (the landed view), ADR-0400 (the OP-106 subscription read whose write-side filter this selection mirrors), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §0.5 (envelopes), §0.7 (status codes), §0.8 (pagination), §3.5 (entitlements & usage) · **Schema:** §14.2, §14.3

## Context

PR #279 was approved with findings, and three of them (L2/L3/L4) went to the implementation
card `t_010670d6`. L2 and L3 change observable behaviour and L4 is a pin-only finding, so all
three need a **RED pin first** — and the implementer role may not write tests. This card is that
missing RED half; the impl card is its child and resumes when this one completes.

The three findings, as the review stated them:

- **L2** — `readUsageCounters` does `.find(filter).toArray()` with no cap and no cursor, so the
  response grows with the counter table. §0.5's collection example carries a `page` object.
- **L3** — `storedSubscriptionSchema` declares `activePlanKey: z.string().default("free")` and the
  same for `subscribedPlanKey`, so a partial row is served as the free tier instead of failing
  loudly, despite §14.3 marking both required.
- **L4** — `findOne({ status: { $ne: "cancelled" } })` mirrors the write-time enforcement in
  `service.ts` (deliberate, ADR-0400), but an `expired` row still resolving its paid plan and the
  multi-row arbitrary pick were both unpinned.

## Decision

### L2 — `/usage` is bounded by the platform cursor contract, additively

- Query: `?periodKey=&cursor=&limit=`. `limit`/`cursor` go through the **existing**
  `parsePageQuery` (`apps/web/src/server/http/cursor.ts`): default **40**, clamped to **100**, an
  unparseable or foreign cursor is `400 invalid_cursor` (§0.8).
- The response stays `{ data: [...] }` and **gains** `page: { nextCursor, hasMore, limit }`
  (§0.5's collection example). `nextCursor` is `null` when `hasMore` is `false`.
- Sort is fixed and documented: **`periodKey` descending, then `_id` descending**. `(periodKey,
_id)` is the keyset, so a page boundary never skips or repeats a row that shares a period.
- At most `limit` rows per page; `page.limit` echoes the **effective** (clamped) limit.
- `?periodKey=` narrows the same page (no change to its already-pinned semantics).

**The response schema must grow with the handler result.** `serializeResponse` validates every
object schema with `.strict()`, so a handler that returns `page` while `usageCountersSchema` stays
`{ data }` answers `500`, not `200`. The near-fix probe below proved both halves are needed.

### L3 — both plan keys are required; a present row missing either is `500 internal_error`

`activePlanKey` and `subscribedPlanKey` lose their silent `"free"` default. A **present**
`subscriptions` document missing either field answers **`500 internal_error`** (§0.7 "Unhandled —
never leak internals"): the row is server-side corruption, not client input, so no `4xx` is
honest. The spec asserts the envelope code and that the body carries neither an `activePlanKey`
nor an `entitlements` array (the corruption is not laundered into a free-tier body).

Unchanged and still pinned by I1: **no** subscription document at all is `200` with
`activePlanKey: "free"` / `subscriptionStatus: "none"`.

### L4 — pin the current `$ne: "cancelled"` selection; change neither layer

- `expired` is a **live** row: it still resolves its paid `activePlanKey`.
- With several live rows the read has no sort, so the pin asserts only what holds for **any**
  pick: the served plan is one of the live rows' plans, the served `subscriptionStatus` belongs
  to that same row, and the **cancelled** row's plan is never served.

## The pins (one spec file, `apps/web/src/test/integration/entitlements-endpoints.test.ts`)

RED set — each fails on the shipped head for the stated reason:

| #   | Pin                                                                                        | Failure on `ecfe2fd1`                                                                                |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 1   | `/usage` serves 40 rows plus a `page` envelope when 41 counters share one period           | `AssertionError: expected [ { …(4) }, { …(4) }, { …(4) }, …(38) ] to have a length of 40 but got 41` |
| 2   | following `nextCursor` returns the one remaining row; the pages neither skip nor duplicate | `AssertionError: expected [ { …(4) }, … ] to have a length of 40 but got 41`                         |
| 3   | rows come back `periodKey` descending, with no client-side sort                            | `AssertionError: expected [ '2026-09', '2026-10' ] to deeply equal [ '2026-10', '2026-09' ]`         |
| 4   | `?limit=` is honoured (`1`) and echoed clamped (`100`) in `page.limit`                     | `AssertionError: expected [ { …(4) }, { …(4) } ] to have a length of 1 but got 2`                    |
| 5   | an unparseable `?cursor=` is a `400 invalid_cursor`                                        | `AssertionError: expected 200 to be 400 // Object.is equality`                                       |
| 6   | a live row missing `activePlanKey` answers `500 internal_error`, never the free tier       | `AssertionError: expected 200 to be 500 // Object.is equality`                                       |
| 7   | a live row missing `subscribedPlanKey` answers `500 internal_error`                        | `AssertionError: expected 200 to be 500 // Object.is equality`                                       |

Characterisation set — **green today and after the GREEN** (asserted in the title):

| #   | Pin                                                                                                | State  |
| --- | -------------------------------------------------------------------------------------------------- | ------ |
| 8   | an `expired` subscription is a live row and resolves its paid plan (+ its plan's entitlement keys) | passes |
| 9   | the `$ne: "cancelled"` read never serves the cancelled row's plan                                  | passes |

## Evidence

- **RED, full file:** `Test Files 1 failed (1)` / `Tests 7 failed | 22 passed (29)` at
  `ecfe2fd1` with only the spec modified. The 22 passing cases are the 20 pre-existing ones plus
  the two characterisation pins; the 2-pin filtered run reported `Tests 2 passed | 27 skipped`.
- **Near-fix probe (satisfiability + load-bearing).** A throwaway near-fix in `view.ts`
  (drop both `.default("free")`, add the keyset filter + `sort({periodKey: -1, _id: -1})` +
  `limit(limit+1)` + `buildCursorPage`) and in the `usage` route (pass `parsePageQuery`, widen
  `usageCountersSchema` with `page`) turned the file **29/29 green**. Both production files were
  then restored and compared byte-for-byte:
  `view.ts` `1e57d9f1…e96564a`, `usage/route.ts` `bd96c15a…74271` — identical before and after, and
  `git status --short` lists only the spec.
- **Type-correct while red:** `pnpm typecheck` (three projects) exit 0, `eslint` on the spec "No
  issues found", `prettier --check` clean.
- Case count measured on disk (`grep -c "  it("` → 29), not quoted from the card.

## Out of scope / handoff to the GREEN (`t_010670d6`)

- `?limit=` **422** (non-integer / `0` / trailing text) is not re-pinned at the route:
  `parsePageQuery`'s bounds are already pinned in `apps/web/src/server/http/cursor.test.ts:96`.
- The `?periodKey=` semantics, the `/entitlements` body shape and
  `…/subscription/history/route.ts` (OP-106) are untouched.
- **Production changes the GREEN owes:** `view.ts` (`storedSubscriptionSchema` loses both
  defaults; `readUsageCounters` bounds/sorts/pages and returns `page`), the `usage` route (read the
  query and pass it through — a signature change in the barrel `index.ts` is acceptable), and
  `usageCountersSchema` widened with `page` (strict serialization otherwise answers `500`).
- **A multi-live-row state does not exist in production.** `subscriptions_active_tenant_unique`
  is a partial unique index on `{tenantId: 1}` where `cancelledAt: null`, so only one live row per
  tenant can exist. This suite never calls `ensureIndexes`, so pin 9 can seed three rows
  (`starter` active, `plus` expired, `pro` cancelled with a real `cancelledAt`) and pin the read's
  arbitrary-pick tolerance. The pin is a test-only state and is recorded as such — it pins that
  **no** implementation change may serve the cancelled plan, not that two live rows are reachable.
- `seedSubscription` was widened **type-only** (status union gains `cancelled`/`expired`; an
  optional `cancelledAt`), and a new `seedSubscriptionMissingPlanKey` helper writes the partial
  rows pins 6–7 need. No existing case, seed value, helper or `usageBodySchema` changed —
  `usageBodySchema` stays `{ data }` as the "existing clients still work" control.

## Consequences

- `/usage` clients that ignore `page` keep working; a client that wants every row must follow
  `nextCursor` until it is `null`.
- A damaged paid subscription is now a loud `500` (logged by the pipeline) instead of a silent
  free tier, so a support read of a corrupt tenant no longer lies.
- The `$ne: "cancelled"` agreement between `service.ts` and `view.ts` stays untouched, and any
  future change to it now breaks two pins loudly in both directions (a free `expired` row, and a
  cancelled row winning the pick).

## ADR number allocation

The OP-104 lane holds `0360`–`0379` with `Next free = 0362`; `0362` was free on `main`, in every
worktree (tracked and untracked) and on every remote `OP-104*` ref at the time of the cut, so this
record consumes `0362` and the cell advances to `0363`. No other lane's row, range or number is
touched.

## Carried unchanged — PR [#703](https://github.com/yahodu/openpic-webapp/pull/703)

This pin record was delivered on branch `OP-104-task-usage-bound-subscription-pins`
as draft PR `#693` (RED by design: 7 fails, 22 passes) and landed **verbatim**
inside the GREEN PR `#703`, whose squash is `8c539a3b`. Nothing in it was
reworded, renumbered or re-pinned on the way in.

- **The card's diff is empty.**
  `git diff 472766ad 9e2ba5f2 -- apps/web/src/test/integration/entitlements-endpoints.test.ts docs/adr/ADR-0362-op104-followup-usage-bound-and-plan-keys-red.md`
  prints nothing.
- **Blob identity is the stronger form.** The spec is `3692388e…` at `472766ad`,
  at `9e2ba5f2` and at the squash, and this record is `ab4ea1c9…` at all three —
  one OID each, three times.
- **What the squash adds relative to its own parent** `b6f10412`: the spec
  `+468 / −2` and this record as a new file (`A`, 136 lines). Those 468 lines are
  this card's pins carried in, not GREEN-side edits, which is why the empty diff
  above is the right reading and not a lucky one.
- **No number and no ledger row are consumed by the sign-off** (`t_621fba28`):
  this note adds none, and `docs/adr/README.md` stays byte-identical to
  `origin/main` in that PR. Draft PR `#693` was closed as superseded at
  `2026-11-19T03:59:02Z`, so `0362` and `0363` were each minted once.
