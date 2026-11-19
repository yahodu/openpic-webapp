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

## Review and landing — PR [#703](https://github.com/yahodu/openpic-webapp/pull/703)

Reviewed head `9e2ba5f2`; docs sign-off `t_621fba28`. **Verdict: APPROVED WITH
FINDINGS (Low only)** — no blocking finding. Squash-merged as `8c539a3b` onto
`origin/main` `b6f10412`, followed by the release commit `6c4fb8b3`; PR `#703`
is `MERGED` at `2026-11-19T04:08:15Z`.

### Landing proof

- **Tree identity.** `git rev-parse 9e2ba5f2^{tree} 8c539a3b^{tree}` prints
  `2340a5a9…` twice and `git diff --stat 9e2ba5f2 8c539a3b` is empty, so the
  reviewed bytes are the trunk bytes; the squash is an ancestor of
  `origin/main` (`git merge-base --is-ancestor 8c539a3b origin/main` exits `0`).
- **Scope, measured.** `git diff --stat 8c539a3b^ 8c539a3b` is **6 files,
  +827 / −27**: the `usage` route (+24), `view.ts` (+94), the RED spec
  (+468 / −2), this record (`A`, 122 lines), the [ADR-0362](ADR-0362-op104-followup-usage-bound-and-plan-keys-red.md)
  record (`A`, 136 lines) and the ledger (8 lines — the `0362`/`0363` index rows
  plus the cell `0362` → `0364`). No other path is touched.
- **The RED half travelled in this PR.** The 468 added spec lines are
  `t_c361b6ec`'s pins carried in, not GREEN-side test edits: the spec blob is
  `3692388e…` at `472766ad`, at `9e2ba5f2` and after the squash, and draft PR
  `#693` (`OP-104-task-usage-bound-subscription-pins`, RED by design) was closed
  as superseded at `2026-11-19T03:59:02Z` — one delivery, one number, one row.

### Checks re-run by the review at `9e2ba5f2`

- **Focused integration** (`entitlements-endpoints.test.ts`): **29 passed (29)** —
  the seven ADR-0362 pins green, the two characterisation pins still green.
- **Full `unit` + `integration` with coverage**: **exit 0** — **332 files / 4679
  passed, 3 skipped**; global **91.78 % statements / 80.67 % branches**;
  `server/services/entitlements` **98.72 % branches**; `view.ts`
  **98.14 / 97.22 / 100 / 97.95**, the single uncovered line being the non-hex
  `_id` guard in `cursorFilterFor` — an arm no pin seeded at the time, routed to
  the pin card below.
- **`pnpm typecheck`** exit `0` on all three projects; **`prettier --check`**
  clean on every touched file; **`adr-numbering`** **29 passed (29)**.
- **Remote checks** **14/14** at the head, none of them a rerun. Measured on the
  merged PR the rollup is 15 rows, all `SUCCESS`, and the fifteenth is the
  `notify-discord` close side-effect run, not a gate.

### The two cursor probes, as measured

Run in a throwaway probe worktree at `9e2ba5f2` (recorded as observations, not
deductions):

| Request                                                                        | Answer                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| a decodable cursor whose `_id` half is not 24-hex (`{"c":"2026-09","i":"zz"}`) | `400 invalid_cursor`                                                           |
| a cursor older than every row                                                  | `200` with `{"data":[],"page":{"nextCursor":null,"hasMore":false,"limit":40}}` |

Both arms sit in `cursorFilterFor` and the keyset filter, which the merged trunk
still carries unchanged: `git diff 9e2ba5f2 origin/main -- view.ts` has no hunk
past line 259 (the later counter-read bound is confined to `readEntitlementsView`),
and the `usage` route blob is `d44d3a4b…` at both commits.

### Ledger and no-collision proof

- `origin/main` holds exactly one `ADR-0362` path and one `ADR-0363` path, and
  `git rev-list --objects --all -- docs/adr` counts **1** for each number.
- No open PR head adds either number: `git diff --name-only origin/main...origin/<head> -- docs/adr`
  lists no `ADR-0362`/`ADR-0363` for any of the four open heads at the time of
  this note, and no `.worktrees/*` tree holds a second copy.
- The `adr-numbering` guard (which runs `checkAdrDirectory`) is green at
  **29 passed (29)** on this sign-off's base `84378fa0`, and the OP-104 lane cell
  there reads **`0366`** — the card that commissioned this note predicted
  `0364`, which `t_a31130d4` (`0364`) and `t_8ac61afe` (`0365`) had already
  consumed by the time it ran.
- **This section consumes no ADR number and no index row.** `docs/adr/README.md`
  is byte-identical to `origin/main` in the sign-off PR
  (`git diff --name-only origin/main...HEAD` does not list it).

### Findings routing

- **F1 — routed to `t_a31130d4`** (pin the decodable-but-non-hex cursor arm and
  the keyset page edge). Landed as PR `#704`, squash `5e1a05de`, which is what
  moved `view.ts`'s focused coverage to 100 %.
- **F2 — routed to `t_8ac61afe`** (bound the entitlements view's counter read and
  add the `/usage` keyset index). Landed as PR `#705`, squash `c2f079da`.
- Both are cited by card id and PR number; their own records are `0364` and
  `0365` on the trunk. F3–F6 were recording-only notes with no card.

**No decision in §L2, §L3 or §L4 is retracted.** One consequence has been
discharged rather than withdrawn: §Consequences recorded that
`readEntitlementsView` still reads this tenant's counters unbounded, and
`t_8ac61afe` now bounds that read to the keys' current periods. The
`entitlementGrants` read in the same function is still unbounded and is open in
`t_6fdc277b`. Nothing here retracts §Context, §Decision, §Files, §Evidence or the
number allocation — this section only adds what review measured afterwards.
