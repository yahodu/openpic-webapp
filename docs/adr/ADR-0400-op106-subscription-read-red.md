# ADR-0400 — OP-106 RED: the subscription read and status-history view — banner precedence, the `actions` matrix, `daysRemaining` and the 50-row cap

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-106 RED (`t_8f332485`) · **Branch:** `wt/t_8f332485` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_8f332485`
- **Relates to:** [ADR-0360](ADR-0360-op104-entitlements-usage-endpoints-red.md) / [ADR-0361](ADR-0361-op104-entitlements-usage-endpoints-green.md) (the sibling read view this one sits beside), [ADR-0340](ADR-0340-op103-entitlements-red.md) / [ADR-0341](ADR-0341-op103-entitlements-green.md) (the string-`tenantId` convention for `subscriptions` rows), [ADR-0260](ADR-0260-op100-tenant-provisioning-red.md) (the reusable tenant stage), [ADR-0280](ADR-0280-op101-tenant-members-red.md) (the owner-only gate shape), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.2 (subscription), §3.3 (checkout/upgrade/downgrade/cancel — the `owner`-only mutations the `actions` matrix reflects), §0.5 (envelopes), §0.15 (never-return) · **Schema:** §14.3

## Context

OP-106 is the story that lets an organizer **see** their billing state in one
place and be reassured that nothing was deleted. §3.2 names a single endpoint
per concern:

- `GET /api/v1/tenants/{tenantId}/subscription` (`user` + member) — "the single
  source for every billing UI surface", returning the subscription, a computed
  `actions` block and a computed `banner`;
- `GET /api/v1/tenants/{tenantId}/subscription/history` (`user` + role
  `owner`|`admin`) — the `statusHistory[]`, capped at 50.

The card pins only observable behaviour:

- `U1` the banner builder for each status combination, **including
  `active` + `revoked`**;
- `U2` the `actions` matrix by status **and role**;
- `U3` `daysRemaining` rounding;
- `I1` no document → the free body; `I2` a `past_due` document → a critical
  banner **with reassurance**; `I3` a co-organizer with no tenant membership →
  `404`; `I4` history capped at 50 newest.

It does not pin module paths, the banner precedence when two conditions hold at
once, exactly which role may see which action, the rounding rule, or the history
envelope. The sibling GREEN card `t_b08b6d61` narrows some of it (`exists:
false`/`status: "none"` for the free state; `actions` from
`status`/`mandateStatus`/`role`; the five banner kinds; `reassurance` mandatory
on `past_due`/`downgraded`; `daysRemaining` via the `Clock`; the history cap of
50 for `owner`|`admin`; a non-member co-organizer → `404`), and this record
fixes the rest.

## Decision

### Module contract

| Module (specifier)                                           | Exports                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@/app/api/v1/tenants/[tenantId]/subscription/route`         | `GET` — `user` + member; the bare §3.2 body (§0.5 single resource)                                                                                                                                                                                                               |
| `@/app/api/v1/tenants/[tenantId]/subscription/history/route` | `GET` — `user` + `owner`\|`admin`; the §0.5 collection envelope `{ data: statusHistoryEntry[] }`                                                                                                                                                                                 |
| `@/server/services/subscriptions` (barrel over `./view`)     | `daysRemaining`, `REASSURANCE_COPY`, `buildSubscriptionBanner`, `buildSubscriptionActions`, `readSubscriptionView`, `readSubscriptionHistory`; the `subscriptionStatusSchema`/`mandateStatusSchema` and the `SubscriptionFacts`/`SubscriptionBanner`/`SubscriptionActions` types |

Both routes run behind the existing `userAuth` / `tenantStage` plumbing
(`@/server/tenancy/route-scope`), so a non-member is `404 not_found` (never
`403`) and the resolved workspace is echoed in `X-Tenant-Id`, exactly as the
OP-101/OP-104 routes do. Subscription reads are tenant-scoped on the **string**
hex `tenantId` (the OP-103 convention for `subscriptions` rows); a fixture must
therefore seed `tenantId` as `tenantId.toHexString()`, not an `ObjectId`.

The two computed blocks are **pure functions**, so the matrix and the banner
precedence are unit-pinned away from Mongo and from the HTTP pipeline (and so
`apps/web/src/server/services/**` keeps a single, readable place for the branch
coverage its 90% threshold demands).

### 1. The banner is one ordered decision, and `reassurance` is mandatory only where §3.2 says so

`buildSubscriptionBanner(facts)` takes `{status, mandateStatus, cancelAt,
gracePeriodEndsAt, now}` and returns the first matching row, `null` otherwise:

| #   | Condition                                                        | `kind`            | `severity`      | Extra fields                                                                   |
| --- | ---------------------------------------------------------------- | ----------------- | --------------- | ------------------------------------------------------------------------------ |
| 1   | `status === "past_due"`                                          | `past_due`        | `critical`      | `reassurance`; `daysRemaining` + `downgradeOn` when `gracePeriodEndsAt` is set |
| 2   | `status === "downgraded"`                                        | `downgraded`      | `critical`      | `reassurance`                                                                  |
| 3   | `status === "active"` **and** `mandateStatus === "revoked"`      | `mandate_revoked` | `important`     | —                                                                              |
| 4   | `status === "incomplete"`                                        | `mandate_pending` | `informational` | —                                                                              |
| 5   | `cancelAt` is set                                                | `cancelling`      | `informational` | —                                                                              |
| —   | anything else (`none`, `active` healthy, `cancelled`, `expired`) | —                 | —               | `null`                                                                         |

Three consequences are load-bearing:

- **Only `past_due`/`downgraded` carry `reassurance`.** §3.2 calls the "nothing
  has been deleted" message _the single most important copy in the product_ and
  makes it mandatory exactly there; `reassurance` is therefore absent (never an
  empty string) on the other three kinds, which the pins assert by exact object
  equality. Its prose is pinned only as matching `/nothing has been deleted/i`,
  so the copy can be re-worded without breaking the suite while a banner that
  drops the reassurance entirely cannot pass.
- **`severity` is a function of the kind**, never of the caller: `critical` for
  the money states, `important` for the paid-but-doomed mandate, `informational`
  for the two "please finish / you asked for this" states.
- **The `active` + `revoked` pair is a real banner**, not an error state: per
  schema §14.3 the tenant is paid up and the next renewal will fail, which is
  precisely the advance warning §3.2 says the UI must show. It also outranks a
  scheduled cancellation on the same row (row 3 before row 5); `past_due`
  outranks it in turn (row 1 before row 3).

### 2. `actions` is the §3.3 mutation gate, so only an `owner` ever sees `true`

`buildSubscriptionActions({status, mandateStatus, role})` returns the §3.2
`actions` block. Every billing mutation in §3.3 (`checkout`, `upgrade`,
`downgrade`, `retry-charge`, `cancel`) is `role owner`, while this endpoint is
readable by any member — so `actions` answers "may **this caller** do X", and a
`member` (and an `admin`) sees all five `false`. For an `owner`:

| `status`     | `canUpgrade` | `canDowngrade` | `canCancel` | `canRetryCharge` | `mustCompleteMandate` |
| ------------ | ------------ | -------------- | ----------- | ---------------- | --------------------- |
| `none`       | ✔            | ✘              | ✘           | ✘                | ✘                     |
| `incomplete` | ✘            | ✘              | ✔           | ✘                | ✔                     |
| `active`     | ✔            | ✔              | ✔           | ✘                | ✘                     |
| `past_due`   | ✔            | ✔              | ✔           | ✔                | ✘                     |
| `downgraded` | ✔            | ✘              | ✔           | ✔                | ✘                     |
| `cancelled`  | ✔            | ✘              | ✘           | ✘                | ✘                     |
| `expired`    | ✔            | ✘              | ✘           | ✘                | ✘                     |

- `canUpgrade` is `false` only for `incomplete` (the §3.3 upgrade is
  `409 subscription_already_active` while a live mandate exists) and `true`
  everywhere else, including `cancelled`/`expired`/`none`, where "upgrade" is
  really "start a subscription" and is the one move available.
- `canDowngrade` needs something to downgrade from: the live paid states
  (`active`, `past_due`). It is `false` on the free state, on `downgraded`
  (already on `free`) and after cancellation.
- `canRetryCharge` is the "Pay now" affordance: `past_due`/`downgraded`, **and**
  only while the mandate is chargeable — `mandateStatus ∈ {revoked, expired}`
  forces it `false`, mirroring the §3.3 `409 mandate_not_chargeable` whose
  recovery action is a new checkout. This is the one place `mandateStatus`
  changes the matrix.
- `mustCompleteMandate` is exactly `status === "incomplete"`.
- The free-state row is the §3.2 example verbatim, which is the sharpest
  cross-check that the matrix is not invented.

**Assumption flagged for review (admin).** §3.3 marks the mutations `owner`
only, and §3.2 is silent about `admin`. This record reads the conservative way:
`admin` behaves like `member` here. If product wants an admin to drive billing,
that is a change to this table (and to §3.3's auth) — it must land in both
places or the `actions` block will advertise a button the mutation refuses.

### 3. `daysRemaining` rounds a partial day **up** and never goes negative

`daysRemaining(until, now)` is `max(0, ceil((until − now) / 86_400_000))`:

- an exact window is the whole number of days (`14 d → 14`);
- any part of a final day counts as a whole one (`13 d 23 h → 14`,
  `14 d 30 min → 15`), because the user is still inside the day;
- a single millisecond left is `1`, never `0`;
- an instant already reached is `0`, and an elapsed window is clamped to `0`,
  never negative — the grace clock must not print "-3 days" while a missed
  dunning sweep leaves a stale `past_due` row in place.

The rounding is UTC-millisecond arithmetic only (no time-zone offset, no
calendar-month maths), so it is deterministic and independent of the tenant's
`settings.defaultTimeZone`.

### 4. The history read is capped, ordered newest-first, and gated member-then-role

`readSubscriptionHistory` serves `{ data: [...] }` (§0.5: a collection is always
wrapped) with each entry `{from, to, at, reason, actor}` (schema §14.3) as
stored, sorted by `at` descending and cut to **50**. Schema §14.3 caps the
stored array at ~50, so the cap is the endpoint refusing to serve an
over-long list verbatim rather than a truncation in place; the pins seed 60
entries and assert the 50 newest, so a route that serves the first 50 or the
whole 60 both fail.

The gate order matters: the reusable tenant stage runs **first** (a non-member
is `404 not_found`, never an existence oracle), and only then is the role
checked (a plain member is `403 forbidden`, the same `appError("forbidden")`
shape OP-104's `/usage` uses). A workspace with **no** document answers
`{ data: [] }` with `200` — the free state is explicit in every §3.2 surface,
never a `404`.

### 5. The served document is the tenant's most-recent `subscriptions` row; no row is the free state

`schema §14.3`: "`none` is the absence of a document". The read therefore serves
`exists: false`, `status: "none"`, `activePlanKey`/`subscribedPlanKey: "free"`,
`pendingDue: null`, `banner: null` when the tenant has no row at all, and, when
it has one, serves the **most recently updated** row with `exists: true` and its
stored `status` — including `cancelled`/`expired`, so an organizer who just
cancelled still sees the cancellation instead of silently reverting to "free".
`externalRefs` and the driver `_id` are never projected (§0.15 never-return),
which the pins assert on a real body (not on an empty one).

## Consequences

- A banner that appears when it should not (a healthy `active` row), a missing
  `reassurance` on `past_due`/`downgraded`, a `reassurance` leaking onto an
  informational banner, a negative or ceiling-less `daysRemaining`, an `actions`
  matrix that lets a `member` see a button, or a history read that serves 60 rows
  or the oldest 50 now fails the suite loudly, with the expected object in the
  failure message.
- The free state is pinned in three places (`banner: null`, the `actions`
  matrix, `pendingDue: null`), which is what makes "not a 404" and "no document
  is a first-class state" enforceable rather than aspirational.
- The `/usage`-style role split is reused rather than re-invented, so the two
  §3.2/§3.5 reads stay consistent for the shell that renders both.
- **Out of scope, deliberately:** the `POST`/`DELETE` billing mutations (§3.3)
  and their idempotency; `dunning` internals beyond echoing the stored block;
  `scheduledChange` cancellation; multi-document ordering when a tenant holds
  both a live row and cancelled history (the read is pinned only for the
  single-row and no-row cases); and provider/webhook projection (§7/§11), which
  is OP-105/OP-107 territory.
- **Open question (pool cell).** The OP-104 lane holds `0360`–`0379` on its
  **unmerged** branch, where its README edit advances the `unallocated (future
lanes)` pool to `0380`+. On the current `main` the pool already reads `0400`+
  (OP-105's `0380`–`0399` landed first). If OP-104 merges **after** this record,
  its README hunk would set the pool cell _back_ to `0380`+ and must be
  reconciled to `0420`+ (this lane's next free). Flagged to the orchestrator.

## Alternatives considered

- **Derive the banner from `severity` first and pick a kind to fit.** Rejected:
  the kind is the contract's discriminator (`banner.kind` is what the client
  switches on) and the same severity maps to two kinds (`incomplete` and
  `cancelling` are both `informational`), so severity alone cannot express it.
- **Show a banner for `cancelled`/`expired` ("you are on free").** Rejected:
  §3.2 enumerates exactly five kinds and `cancelled`/`expired` are terminal; the
  plan/status fields already say it, and inventing a sixth kind would fail the
  response schema's enum.
- **Let `admin` drive billing actions.** Rejected here — see §2's assumption;
  §3.3 is `owner` only and the two must agree.
- **`daysRemaining` = `floor`.** Rejected: floor prints "0 days left" during the
  final day of the grace window, which is precisely the wrong reassurance.
- **Return the history as a bare array.** Rejected: §0.5 says a collection is
  always wrapped, and OP-104's `/usage` set the in-lane precedent of `{ data }`.
- **`404` for a tenant with no subscription on `/history`.** Rejected: the free
  state is explicit everywhere in §3.2; an empty list is the honest answer.

## ADR number allocation

This lane (`OP-106`) had no reserved range in
[ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §6, so — acting as
the first card of the lane — it draws the next block from the allocator's
`unallocated (future lanes)` pool: **`0400`–`0419`**, consuming `0400` for this
record (the same move OP-102/OP-104 made for their lanes). The README table
gains an `OP-106 subscriptions lane` row with `Next free = 0401`, and the pool
row advances to `0420`+. No number outside the block is touched, and the
frozen pre-policy numbers are left alone.
