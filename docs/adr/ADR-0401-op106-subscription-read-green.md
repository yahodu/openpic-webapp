# ADR-0401 — OP-106 GREEN: the subscription read and status-history view implemented against ADR-0400

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-106 GREEN (`t_b08b6d61`) · **Branch:** `OP-106-task-subscription-read-red` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_8f332485`
- **Relates to:** [ADR-0400](ADR-0400-op106-subscription-read-red.md) (the RED contract this GREEN implements), [ADR-0360](ADR-0360-op104-entitlements-usage-endpoints-red.md) / [ADR-0361](ADR-0361-op104-entitlements-usage-endpoints-green.md) (the sibling read view and the role-gate shape this reuses), [ADR-0340](ADR-0340-op103-entitlements-red.md) / [ADR-0341](ADR-0341-op103-entitlements-green.md) (the string-`tenantId` convention for `subscriptions` rows), [ADR-0260](ADR-0260-op100-tenant-provisioning-red.md) (the reusable tenant stage), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.2 (subscription), §3.3 (the `owner`-only mutations the `actions` matrix reflects), §0.5 (envelopes), §0.15 (never-return) · **Schema:** §14.3

## Context

The RED card `t_8f332485` delivered the executable contract (ADR-0400) as three
specs — one unit (`subscription-view.test.ts`, 32 tests) and two integration
(`subscription-read.test.ts`, 8; `subscription-history.test.ts`, 7) — with no
production code, so the suite was red as `module-not-found` for four modules.
This card is the gated GREEN: implement exactly that contract, edit no test.

The GREEN card was repointed onto the RED head (`84e87f7`) and the RED branch
`OP-106-task-subscription-read-red` so the pins and the implementation ship in
one PR; the specs are byte-identical to the RED head.

## Decision

### Module layout

| Module                                                          | Contents                                                                                                                                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@/server/services/subscriptions/view.ts`                       | `REASSURANCE_COPY`, `daysRemaining`, `buildSubscriptionBanner`, `buildSubscriptionActions`, `readSubscriptionView`, `readSubscriptionHistory`; the served schemas (`subscriptionViewSchema`, `subscriptionHistorySchema`, …) and the types |
| `@/server/services/subscriptions/index.ts`                      | The barrel (the only specifier the tests import)                                                                                                                                                                                           |
| `@/app/api/v1/tenants/[tenantId]/subscription/route.ts`         | `GET` — `user` + member; the bare §3.2 body                                                                                                                                                                                                |
| `@/app/api/v1/tenants/[tenantId]/subscription/history/route.ts` | `GET` — `user` + member-then-`owner`\|`admin`; the §0.5 `{ data }` envelope                                                                                                                                                                |

Both routes declare the reusable `tenant` stage and `userAuth()`, exactly like
the OP-101/OP-104 routes, so a non-member is `404 not_found` and the resolved
workspace is echoed in `X-Tenant-Id`. Subscription rows are read through
`tenantRepo(tenantId, db)`, which stamps the string hex scope structurally.

### 1. `readSubscriptionView` returns the view **without** `actions`; the route composes the two

`actions` is a function of the caller's role, which the read does not know, so
the read (`readSubscriptionView(db, tenantId, now)`, the signature ADR-0400
fixed) returns every stored-derived field plus the computed `banner`, and the
route merges `buildSubscriptionActions({ status, mandateStatus, role })` from
the stage-published `ctx.tenantRole`. Keeping `actions` out of the read is what
lets the pure matrix stay a pure function and keeps the read role-free.

### 2. The projection declares only served fields — never-return by construction

The stored-row schema (`storedSubscriptionSchema`) declares only the fields the
view serves. `_id`, `externalRefs`, `dunning`, `cancelledAt`/`cancelReason`,
`previousSubscriptionId` and `createdAt` are not declared, so a projection
_cannot_ carry them (§0.15 never-return), rather than relying on a later strip.
Dates are serialized to RFC 3339 strings in the projection; every optional field
is served only when the stored row carries it. The same schemas are the routes'
`response` schemas, so `serializeResponse`'s strict projection re-checks the
body (a leaked field would throw outside production).

### 3. Banner precedence and `reassurance` are ADR-0400 verbatim

`buildSubscriptionBanner` returns the first matching row of the ADR-0400 table:
`past_due` (with `daysRemaining`/`downgradeOn` only while `gracePeriodEndsAt` is
set) → `downgraded` → `active` + `revoked` → `incomplete` → `cancelAt` set →
`null`. `reassurance` is attached **only** on `past_due`/`downgraded` and its
prose is `REASSURANCE_COPY` (matching `/nothing has been deleted/i`). One
consequence of the literal precedence is recorded as an assumption: the
`cancelAt` row is unconditional, so a `cancelled`/`expired` row that still
carries a `cancelAt` would render `cancelling`; no pin seeds that combination,
and it is flagged below rather than guessed at.

### 4. The `actions` matrix is owner-only, with `canRetryCharge` mandate-gated

Every §3.3 mutation is `owner`-only while this read is open to any member, so
`member` **and** `admin` see all five `false` (the ADR-0400 §2 assumption,
carried unamended). For an `owner`: `canUpgrade` is `false` only on
`incomplete`; `canDowngrade` on the live paid states; `canCancel` on
`incomplete`/`active`/`past_due`/`downgraded`; `canRetryCharge` needs
`past_due`/`downgraded` **and** a mandate outside `{revoked, expired}`;
`mustCompleteMandate` is exactly `incomplete`.

### 5. `daysRemaining` rounds up, clamps at zero; history is newest-first then capped

`daysRemaining(until, now) = max(0, ceil((until − now) / 86_400_000))` — UTC
milliseconds only, no calendar or time-zone maths. `readSubscriptionHistory`
loads the tenant's most recently updated row, sorts the stored `statusHistory`
by `at` descending, and slices the first 50 (a whole 60-row list or the oldest
50 both fail the pins). A workspace with no document answers `[]` — never a
`404`.

### 6. The free state is the absence of a document

`readSubscriptionView` returns the explicit free body (`exists: false`,
`status: "none"`, `activePlanKey`/`subscribedPlanKey: "free"`, `pendingDue:
null`, `banner: null`) when the tenant has no `subscriptions` row; the route's
free-state `actions` is the §3.2 example (`canUpgrade: true`, the rest `false`).
`pendingDue` is served only when the stored `pendingDueMinor` is positive, so a
zeroed row and the free state both answer `null`.

## Consequences

- The three RED specs are green unedited: unit **32 passed (32)**, integration
  **15 passed (15)** on the two new specs.
- `apps/web/src/server/services/subscriptions/view.ts` is at statements/lines
  **100 %** and branches **91.83 %** (the `services/**` gate is 90 %); the
  uncovered branches are defensive (`updatedAt`/`scheduledChange` absent, a
  `cancelled` row reaching the `cancelAt` row).
- **Open question (assumption) — `cancelAt` on a terminal row.** ADR-0400 §1
  row 5 is unconditional, so this GREEN renders `cancelling` for a
  `cancelled`/`expired` row that still carries a `cancelAt`. No pin seeds it.
  If product wants the banner suppressed on a terminal status, that is a change
  to ADR-0400 row 5 and a new pin — not a silent code guard here.
- **Open question — the `admin` role.** §3.3 is `owner`-only and this GREEN
  keeps `admin` action-less, matching ADR-0400 §2. If billing is meant to be
  admin-drivable, §3.3's auth and this matrix must change together.
- **Coverage gap noticed (for the Test Author's next cycle).** Nothing pins the
  tie-break when a tenant holds both a live and a `cancelled` row (the read
  serves the most recently updated row; ordering on equal `updatedAt` is
  unspecified), nor `scheduledChange`/`updatedAt` serialization.
- Out of scope, per ADR-0400: the §3.3 mutations, dunning internals,
  `scheduledChange` cancellation, and provider/webhook projection.

## ADR number allocation

`0400` is consumed by [ADR-0400](ADR-0400-op106-subscription-read-red.md) (the
RED contract), so this record takes `0401`, the lane cell's value re-read on the
RED head (`84e87f7`) immediately before committing, and advances the lane's
`Next free` cell to `0402`. No number outside the lane range `0400`–`0419` is
touched.

## Review sign-off — 2026-10-25 (card `t_b08b6d61`, round 1 · artifact lens)

The round-1 (**artifact-lens**) review of this OP-106 GREEN (`t_b08b6d61`)
returned **APPROVED WITH FINDINGS** — zero changes requested, and **zero
reviewer edits to the deliverable's behaviour**. The reviewer's only change was
the behaviour-preserving refactor commit
[`609e264`](https://github.com/yahodu/openpic-webapp/commit/609e264)
(`refactor(subscriptions): OP-106 derive the banner enums and share the wire
enums`, `view.ts` +32/−13): `SubscriptionBannerKind`/`SubscriptionBannerSeverity`
and the payment-method-kind/billing-cycle enums are derived from single
`as const`/schema sources instead of duplicated literals, so the parsed and
serialized shapes are unchanged.

- **Criterion 1 — `reassurance` is always present for `past_due`/`downgraded`.**
  `buildSubscriptionBanner` attaches `REASSURANCE_COPY` on exactly those two
  kinds and no other, asserted by exact object equality plus
  `/nothing has been deleted/i`; focused unit `subscription-view.test.ts`
  **32 passed (32)** and integration I2 through the real route.
- **Criterion 2 — the free state is not a `404`.** A tenant with no
  `subscriptions` row answers `200` with `exists: false`, `status: "none"`,
  `activePlanKey`/`subscribedPlanKey: "free"`, `pendingDue: null`,
  `banner: null`, and I1 asserts `_id`/`externalRefs` are absent from a real
  non-vacuous body — integration I1.
- **Criterion 3 — `mandateStatus` is independent of `status`.** `mandate_status`
  is projected straight from the stored row and read only by the banner
  (`active` + `revoked` → `mandate_revoked`) and `canRetryCharge`; I2's
  revoked-mandate case pins `status: "active"` with `mandateStatus: "revoked"`
  from a real document.
- **Full suite on the reviewed head `529ed2f`** (after merging `origin/main`
  into the branch): unit `106 files / 1843 passed | 3 skipped`, integration
  `75 files / 536 passed` (`TMPDIR=/root/tmp-mongo`), `pnpm typecheck` clean on
  all three projects, the `adr-numbering` guard **29/29**; no
  test/mock/fixture/factory edited
  (`git diff --name-only 84e87f7 -- apps/web/src/test` is empty).
- **The shared ADR ledger was resolved as a union** when `origin/main` was merged
  into the branch: the OP-105 lane's `Next free` cell keeps the highest value
  `0383`; the OP-106 lane row keeps `0402`; the unallocated-pool cell stays
  `0420`+; the index keeps every row ascending (`0382`, `0400`, `0401`); and both
  lanes' prose note blocks are kept verbatim.
- **Merged, and containment proven.** PR
  [#294](https://github.com/yahodu/openpic-webapp/pull/294) was squash-merged as
  `68f73ff` and `git merge-base --is-ancestor 68f73ff origin/main` holds. At the
  merge, `git diff --name-only 529ed2f 68f73ff` was exactly
  `docs/adr/ADR-0382-…md` (it gained PR #298's unrelated review sign-off) — every
  `apps/`, `packages/` and OP-106 ADR/README byte is identical between the
  reviewed head and the trunk. The trunk has since advanced by the release commit
  `cab62e8` (`CHANGELOG.md`, `package.json`); the application and OP-106 ADR
  bytes are still identical.

### Findings carried out of the review

These findings are **beyond this card's pinned acceptance criteria**: they sit
exactly in the gaps this record's own §Consequences and ADR-0400's scope note
left open. They are **routed, not fixed here**, and are cited by card id and PR
number on purpose — an ADR number belonging to a still-unmerged follow-up is
unstable (`0402`–`0419` may renumber).

- **F1 (Low) — a terminal row that still carries `cancelAt` renders
  `cancelling`.** ADR-0400 §1 row 5 is unconditional, so a `cancelled`/`expired`
  row with a `cancelAt` would render `banner.kind: "cancelling"`; no pin seeded
  it. Routed to card `t_09e53bea`.
- **F2 (Low) — the multi-row tie-break on equal `updatedAt` is unspecified.** The
  read serves the tenant's most-recently-updated row (`findOne` sort
  `updatedAt: -1`); two rows with an equal `updatedAt` have no defined order.
  Routed to card `t_09e53bea`.
- **F3 (Low) — `scheduledChange`/`updatedAt` serialization and a zeroed
  `pendingDue` were unpinned.** Routed to card `t_09e53bea`.
- **F4 (Info) — two OP-107 children pointed at the shared main checkout.** Cards
  `t_98bf1d99` and `t_5f08f665` were repointed to their own worktrees by the
  reviewer, and both cards were commented to record it.
- **F5 (Info, no action) — the §2 strict-serializer claim checks out.**
  `serializeResponse` validates object schemas strictly via `.strict()`
  (`apps/web/src/server/http/serialize-response.ts:50`), so a leaked field throws
  outside production — exactly as §2 asserts.

### Post-review status

- **F1, F2 and F3 have since been pinned** by the OP-106 follow-up TEST card
  `t_09e53bea` (characterisation pins added to
  `apps/web/src/test/integration/subscription-read.test.ts`; branch
  `OP-106-task-subscription-read-followup-pins`, PR
  [#299](https://github.com/yahodu/openpic-webapp/pull/299), since squash-merged
  to `main` as `0f53970`, an ancestor of `origin/main`): the zeroed `pendingDue`
  → `null` case, `scheduledChange.effectiveAt`/
  `updatedAt` as RFC 3339 strings plus the null case, the equal-`updatedAt`
  tie-break tracking insertion order rather than status, and the terminal
  `cancelled` row with `cancelAt` rendering `cancelling`. The pins characterise
  the shipped behaviour; they do not change it.
- **F4 was fixed inside the review** — the cards were repointed and commented.
- **F5 requires no change.**

Nothing in §Context–§Consequences above is retracted: the delivered view and
routes were found correct as pinned, and the sign-off only records that. Anything
F1–F3 imply lands through their own cards, not by editing this record.
