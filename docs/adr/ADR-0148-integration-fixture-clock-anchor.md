# ADR-0148 — OP-96 follow-up: anchor the integration fixture clock to the real day (class-wide TTL-deletion flake, F1)

- **Status:** Accepted · **Date:** 2026-10-22
- **Card:** OP-96 follow-up finding **F1** — "future-date the fixture clock across the integration specs pinning a `2026-03-*` T0" (`t_ad8bdf4f`) · **Parent:** `t_e8e658fd` (the I11 quiet-hours fix, ADR-0146)
- **Branch:** `OP-96-task-fixture-clock-future` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_ad8bdf4f`
- **ADR number:** `0148` — the OP-96 reserved range is `0146`–`0179` ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md), merged `23c236d`). `0146` was consumed by ADR-0146 (PR #225, merged `6cc0613`) and `0147` is held by the still-open sibling lane `OP-96-task-flush-claim-lease-pins` (PR #235), so `0148` is the lowest free number in the range. Verified against a fresh `origin/main` (`6cc0613`) and every `origin` ref immediately before committing; per ADR-0300 the number is drawn from the lane's own range, never from `origin/main`'s high-water mark or the tail of the index.
- **Touches:** one new test helper (`apps/web/src/test/helpers/fixture-clock.ts`), 16 existing integration specs, this ADR and the ADR index. **No production code, schema, index, retention setting, or non-exposed spec.**

## Context

[ADR-0146](ADR-0146-op96-quiet-hours-fixture-ttl-flake.md) diagnosed the intermittent I11 fan-out flake
in `notification-quiet-hours-release.test.ts` and fixed it by anchoring that one spec's fixture instants
to the real clock. Its §Consequences records the mechanism as **class-wide**, not local:

> An integration spec that pins a **literal past** fixture clock while mongod evaluates TTL indexes
> against the **real** clock persists rows that are _already_ TTL-expired, and the monitor deletes them
> asynchronously — on a loaded host a pass lands between the write and the assertion.

Every row such a spec persists carries `expireAt = now + retentionDays`:

- `notification_dispatches` — `expireAt = addDays(now, settings.retention.dispatchDays)` at
  `apps/web/src/server/notifications/fan-out.ts:1591` (the fan-out time writing path) and the deferred
  path takes it from `ctx.dispatchExpireAt` (built at `:1219`); the digest-redelivery path writes the
  same shape at `apps/web/src/server/notifications/digest.ts:403`.
- `domain_events` — `expireAt = addDays(occurredAt, settings.retention.domainEventDays)` at
  `apps/web/src/server/domain/domain-events.ts:311`.
- `notificationDigests` — same `addDays(now, …)` shape.
- `sessionDevices` / `contactChangeFanouts` — `expireAt = addMillis(now, TTL)` at
  `apps/web/src/server/auth/identity-hooks.ts:583` / `:684`.

Each TTL index is `{ expireAt: 1 }` with `expireAfterSeconds: 0`
(`apps/web/src/server/db/indexes.ts:149–154` for `dispatches_expire_at_ttl`, `:312` for
`domain_events_expire_at_ttl`, `:197` for `notification_digests_expire_at_ttl`). mongod runs its deletion
pass every `ttlMonitorSleepSecs` (default 60); on a saturated host the spec's own wall-clock window
widens and a pass is far more likely to land inside it. The product is correct — this is a fixture/clock
problem, exactly as ADR-0146 concluded.

At the time of this card the real clock is `2026-10-22`, and 23 integration specs still pinned a
`2026-*` literal:

```
grep -rn '"2026-' apps/web/src/test/integration/*.test.ts   # 23 files
```

## Diagnosis — the exposure rule, and the confirmed set

A spec carries the race **iff both** hold:

- **(a)** it persists a document into a TTL-indexed collection whose `expireAt` derives from the pinned
  past clock, **and**
- **(b)** it counts or re-reads that document back after any `await`.

Only (a)+(b) is exposed. This is the rule ADR-0146 and the round-2 review of PR #225 both landed on, and
the probe in §Evidence confirms it. Applying it to the 23 candidates:

### Exposed (16) — fixed by this card

All 16 persist TTL'd rows from a past fixture clock and then count/re-read them:

- **`domain-events.test.ts`** — emits `domain_events` with `clock: fixedClock(T0)` (`T0 = 2026-03-01`),
  so `expireAt = 2026-08-28` (past); then `events.find({}).toArray()` / `findOne` / `countDocuments`
  after every claim and completion.
- **`identity-hooks.test.ts`** — `T0 = 2026-03-01` drives the outbox (`domain_events`), the
  `contactChangeFanouts` row (`now + 7d`, past) and the seeded `newDeviceSightings`-shaped rows
  (`now + 6d`, past); the spec re-reads them via `eventsByKey(...).toArray()` and `findOne`.
- **`notification-bounded-sweeps.test.ts`** — `T0`/`INSIDE`/`WINDOW_END` pinned to `2026-03-*`;
  `countDocuments({ status: "failed" | "deferred" })` and the digest-bucket count after sweeps.
- **`notification-digest.test.ts`** — `T0 = 2026-03-01` plus two inline `19:00Z`/`19:30Z` literals;
  the spec reads `notificationDigests.find({}).toArray()` and `notification_dispatches.find({})`.
- **`notification-digest-flush-daily-cap.test.ts`**, **`…-daily-cap-redelivery.test.ts`**,
  **`…-failure.test.ts`**, **`…-non-retryable.test.ts`**, **`…-non-retryable-bound.test.ts`**,
  **`…-overlap-single-send.test.ts`**, **`…-unrecorded-bound.test.ts`** — each pins `T0 = 2026-03-01`,
  drives the flush through a past clock and counts the stored bucket / dispatch rows.
- **`notification-dispatch-retry.test.ts`** and **`…-cap.test.ts`** — `T0 = 2026-03-01` with inline
  `10:02/10:05/10:10/10:20Z` clocks; `find({ typeKey }).toArray()` and
  `countDocuments({ status: "failed" })` after each sweep.
- **`notification-fan-out.test.ts`** — `T0 = 2026-03-01`; reads the `notifications` and
  `notification_dispatches` rows it persisted.
- **`notification-fanout-cron-route.test.ts`** — `insertPendingEvent` writes a `domain_events` row with
  `expireAt = 2026-08-28` (past) and the route then claims/processes it; `countByNotifications(...)`
  counts it.
- **`notification-redelivery-body-retention.test.ts`** — `T0 = 2026-03-01` with inline `10:02/10:10Z`
  clocks; reads the dispatch row.

### Not exposed (7) — deliberately left alone

- **`admin-two-factor-signin.test.ts`**, **`auth-guards.test.ts`**, **`me-ban-exemption.test.ts`**,
  **`me-current-user.test.ts`** — the only pinned instant is `COMPLETED_AT = 2026-01-01`
  (`me-ban-exemption` also `NEVER = 2099-01-01`), written to `userProfiles.accountCompletedAt` /
  `banExpires`, which have **no TTL index**. The auth flows that _do_ write TTL'd rows
  (`sessionDevices`, `domain_events`) run on the process clock, so their `expireAt` is in the future.
  `me-current-user` additionally inserts `notifications` and `invitations` rows that deliberately omit
  `expireAt`; a TTL index skips a document that lacks the indexed field.
- **`cross-tenant-read.test.ts`** — the literals are `attendeeEventProfiles.updatedAt`, no TTL index.
- **`index-bootstrap.test.ts`** — the literals are `revokedAt` / `cancelledAt` (no TTL index); the
  `notification_dispatches` rows it inserts carry **no `expireAt` field at all**, so
  `dispatches_expire_at_ttl` never selects them.
- **`internal-hmac.test.ts`** — `NOW` is an HMAC signed-timestamp for an HTTP route; the suite never
  touches MongoDB and persists no row.

## Decision

**Option A, made shared: anchor each exposed spec's fixture instants to the real UTC calendar day via a
small test helper.** `apps/web/src/test/helpers/fixture-clock.ts` exports:

```ts
fixtureDay(offsetDays = 0): string          // "YYYY-MM-DD", derived once at module load
fixtureInstant(timeOfDay: string, offsetDays = 0): string
```

`fixtureInstant("10:00:00.000Z")` is a drop-in replacement for the former
`"2026-03-01T10:00:00.000Z"` literal: same UTC time-of-day, anchored day. The anchor day is read **once**
(`new Date().toISOString().slice(0, 10)` at module load) so every instant a run derives sits on one day
even if the wall clock crosses UTC midnight between fixtures.

Each exposed spec therefore drops its literal dates and derives them:

- the **scenario is unchanged** — time-of-day, ordering, relative offsets, the quiet 22:00–07:00 window,
  the 19:30Z IST rollover, the 5-minute claim-staleness window, the retry backoff arithmetic;
- the anchor is `today` UTC, so every derived `expireAt` lands ~180 days in the **future** and no
  monitor pass can delete a fixture row mid-test at any cadence on any machine;
- **no assertion is weakened, added or removed** — no `.skip`, no widened timeout, no loosened matcher.
  One comment in `notification-digest.test.ts` and one in `domain-events.test.ts` were reworded because
  they named the old literal dates; the `domain-events` `claimedAt` fixture became `new Date(T0)`
  (it is an arbitrary claim instant — only the 5-minute staleness window around it is under test).

### Why a shared helper rather than the literal ADR-0146 shape per file

ADR-0146 inlined an `ANCHOR_DAY` + a local `nextUtcDay` in one file. Repeating that across 16 files
duplicates the one subtle piece (the day arithmetic) 16 times and leaves 16 places to get wrong; the
helper makes the anchor a single reviewed artefact that a reviewer can point at. This is Option A in
spirit (fixture instants anchored to the real clock, production index topology untouched) with the
duplication removed.

### Why not the alternatives

- **Option B — neutralise the retention TTLs in `createTestDb`/`ensureIndexes`.** Rejected: it removes a
  real production index from the topology the specs exercise, so a future TTL-index regression would go
  unnoticed. Fix the fixtures, not the server. (ADR-0146 rejected the same shape for the same reason.)
- **Push the literal forward (e.g. `2027-03-01`).** Rejected: it re-arms the same bomb ~10 months out.
  Today's `2026-03-01` literals _are_ that bomb, already detonated.
- **Raise the per-test timeout / assert before the monitor can fire.** Rejected: a timeout cannot stop an
  asynchronous server-side delete, and it would weaken nothing into a lie.

## Evidence

All commands run in `/root/openpic/openpic-webapp/.worktrees/t_ad8bdf4f` with `TMPDIR=/root/tmp-mongo`,
on the loaded shared host (4 cores; artificial CPU burners raised load average into the 11–16 band the
card calls "the interesting condition").

**Mechanism, confirmed on the production index shape** (throwaway probe, deleted before commit; no
product call between insert and count; `db.adminCommand({ setParameter: 1, ttlMonitorSleepSecs: 1 })`
forces the cadence). Three rows inserted 2.5 s apart, each counted right after its insert:

```
realNow     2026-10-22T06:31:50.394Z
oldExpire   2026-08-28T23:00:00.000Z   (INSIDE="2026-03-01T23:00Z" + 180d → 54 days PAST)
newExpire   2027-04-20T23:00:00.000Z   (fixtureInstant("23:00:00.000Z") + 180d → 180 days FUTURE)
oldCounts   [0, 0, 0]     -- every past-dated row deleted before it could be counted
newCounts   [1, 2, 3]     -- every anchored row retained
```

This reproduces the reviewer's PR #225 probe independently and confirms the (a)+(b) exposure rule.

**Per-spec load runs.** The 16 touched specs were run as one 16-file batch, **10 consecutive times**
under artificial load; **10/10 green (16 files / 90 tests each run, 900 test executions, 0 failures)**,
load average `11.25`–`16.17` at each run:

```
L1  exit 0  load 12.68   16 passed (16) / 90 passed (90)
L2  exit 0  load 14.51   16 passed (16) / 90 passed (90)
L3  exit 0  load 16.17   16 passed (16) / 90 passed (90)
L4  exit 0  load 15.01   16 passed (16) / 90 passed (90)
L5  exit 0  load 14.36   16 passed (16) / 90 passed (90)
L6  exit 0  load 12.16   16 passed (16) / 90 passed (90)
L7  exit 0  load 13.89   16 passed (16) / 90 passed (90)
L8  exit 0  load 12.63   16 passed (16) / 90 passed (90)
L9  exit 0  load 11.25   16 passed (16) / 90 passed (90)
L10 exit 0  load 11.75   16 passed (16) / 90 passed (90)
```

**Non-green run, reported honestly.** Three initial iterations were run while the host was at load
average **25** — _above_ the card's 13–20 band, self-inflicted by an over-large set of CPU burners. They
produced the _other_ known saturated-host symptom ADR-0146 recorded, and no fixture/TTL signature:

```
iter 1  notification-bounded-sweeps.test.ts > F3 …            Error: Test timed out in 5000ms.
iter 1  notification-digest-flush-daily-cap-redelivery … F1c-r2  Error: Test timed out in 5000ms.
iter 2  notification-digest.test.ts > I8 …                     Error: Test timed out in 5000ms.
```

Those are Vitest's default 5000 ms per-test budget being exceeded by CPU starvation (load 25 on 4
cores), not a deleted row: the failure is a timeout, never the `expected 1 to be 3`-class assertion, and
they disappear entirely once the load is inside the card's band (L1–L10 above). Per the card, a timeout
is not a fixable-by-this-card defect and no timeout was widened. The remaining 6 load-run failures were
retried into the L1–L10 series; there were no others.

**Full integration suite (band load):** `pnpm test:int` → **57 passed (57) files, 361 passed (361)
tests**, matching the parent baseline exactly — this card adds, removes and skips no test.

**Unit suite:** `pnpm test:unit` → **86 passed (86) files, 1514 passed (1514) tests** (includes the
`docs/adr` number guard, which now sees `ADR-0148`). `pnpm typecheck` → exit 0 (root, contracts, web);
`eslint` on every touched file → exit 0; `prettier --check` → clean.

## Consequences

- The class-wide race is removed at its cause for all 16 exposed specs: their fixtures are future-dated
  by construction, so the TTL monitor cannot race their assertions at any cadence or machine load.
- The change is confined to test files plus one test helper; no production behaviour, index, or
  retention setting moves.
- The fix shape is now shared and documented; a new integration spec that drives the product with an
  injected clock should derive its instants from `fixtureInstant(...)` rather than pin a calendar date.
- The 7 non-exposed `2026-*` spec files are deliberately untouched (they carry no TTL'd row that is
  re-read); anchoring them would be a no-op churn.

## Alternatives considered

See §Decision. In summary: shared Option A (chosen) vs. per-file ADR-0146 shape (duplication), Option B
harness TTL neutralisation (hides a production index), a future literal (re-arms the bomb), and a
timeout/ordering hack (cannot prevent a server-side delete).

## Assumptions & open questions

- **`today` UTC is the anchor, not `yesterday`.** No exposed spec compares a fixture instant against the
  real clock — every product call takes an explicit `fixedClock(...)`, and the only real-clock reads in
  the set (`notification-fanout-cron-route.test.ts`'s HMAC timestamp headers; `identity-hooks.test.ts`'s
  unique-suffix/IP helpers) are unrelated to the fixtures. `today` mirrors ADR-0146 and keeps the
  scenario's time-of-day exactly as written. If a future spec _does_ need "the fixture instant is in the
  past", it should use `fixtureInstant(time, -1)`.
- **The TTL monitor is the only deleter considered**, as in ADR-0146; the probe (a past `expireAt`, the
  exact index shape, the count falling with no test action) is sufficient to explain the observation.
- **No product defect found.** The 16 specs' contracts are byte-identical; if one had failed for a
  product reason, the card requires a RED pin + a separate GREEN card, which did not arise.

## Out of scope

- No production code, schema, index, retention setting, mock, or factory is touched.
- The 7 non-exposed specs are not edited; §Diagnosis says why.
- The `5000 ms` timeout seen on an over-saturated host (load 25) is a performance matter, not this
  fixture race, and is not addressed here (and no timeout was widened).
