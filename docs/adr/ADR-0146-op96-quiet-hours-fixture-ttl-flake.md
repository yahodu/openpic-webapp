# ADR-0146 — OP-96 follow-up: the quiet-hours release spec's past-dated fixtures were TTL-expired (I11 fan-out flake, F2-2)

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-96 follow-up "diagnose + stabilize the intermittent I11 fan-out flake" (`t_e8e658fd`) · **Parent:** `t_e3369a9e` (the F2 RED pin) · **Evidence source:** round-1 (artifact lens) review of `t_e3369a9e`, finding **F2-2**
- **Branch:** `OP-96-task-quiet-release-flake-red`, merged with `origin/main` `4144983` (originally created from `3f46950`, rebased onto `705467a`) · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t-quiet-i11-flake`
- **ADR number:** `0146` — renumbered from `0144` in review round 1 after `ADR-0144-op101-ci-audit-job-split-review-signoff.md` merged on `main` (PR #224) and `ADR-0145-op96-f1-unrecorded-flush-bound-green.md` landed (PR #220). `0146` is the lowest free number above the high-water across `origin/main` `4144983` and every local/remote ref.
- **Touches:** one existing integration spec (`notification-quiet-hours-release.test.ts`) + this ADR + the ADR index. **No production code, mock, fixture, factory or other spec.**

## Context

Review finding **F2-2** reported a **rare, load-correlated** failure in an otherwise green pin:

```
FAIL |integration| apps/web/src/test/integration/notification-quiet-hours-release.test.ts >
  quiet-hours release is bounded by `limit` (I11) >
  I11: releases exactly `limit` due rows and reports hasMore while a backlog remains
AssertionError: expected 1 to be 3 // Object.is equality
 ❯ apps/web/src/test/integration/notification-quiet-hours-release.test.ts:305:91
```

The assertion is the one immediately after three sequential real fan-outs:

```ts
for (let index = 0; index < 3; index += 1) {
  await fanOutAt(test.db, transport, recipient, actor, INSIDE);
}
expect(await test.db.collection(DISPATCHES).countDocuments({ status: "deferred" })).toBe(3);
```

Three fan-outs produced **one** `deferred` row, and in that run the whole file took **10 624 ms** (CI:
2 473 ms). The card asked for the mechanism and classed the two candidates as **(a) a test-harness
race** or **(b) a product silent-failure path** (a swallowed write/claim error). It also asked for the
reproduction rate and, explicitly, that "not reproducible" recorded honestly is a legitimate outcome.

## Diagnosis

**It is (a) — a harness race, and it is not a swallowed write: no product call is involved at all.**

The spec drives the product with a **fixed clock pinned to `2026-03-01`**, while mongod evaluates its
TTL indexes against the **real** clock. Every row the fan-out persists carries

```
expireAt = instant + retention.dispatchDays      // fan-out.ts:1219, dispatchDays default 180
```

so `INSIDE = 2026-03-01T23:00:00.000Z` yields `expireAt = 2026-08-28T23:00:00.000Z`. On this host the
real clock is `2026-10-20`, so **every fixture row the spec asserts on is already ~53 days
TTL-expired**, and the `notification_dispatches` TTL index deletes it asynchronously:

```
{ key: { expireAt: 1 }, name: "dispatches_expire_at_ttl", expireAfterSeconds: 0 }   // indexes.ts:149–154
```

mongod's TTL monitor runs a deletion pass every `ttlMonitorSleepSecs` (default **60**). A single pass
landing **between two of the three fan-outs** deletes the rows already written and leaves fewer rows
than fan-outs — exactly the reported "three fan-outs produced one `deferred` row". On a loaded host
the test's own wall-clock window widens (the reported run was 4× slower), so the monitor's next pass
is far more likely to land inside it. The product is correct; the fixture simply hands the server
permission to delete what the test is about to count. `expireAt` on the seeded `domain_events` rows
(`occurredAt + 180d`) is expired for the same reason.

This is _not_ a swallowed error: the fan-outs completed, `notification.deferred` was logged for each
row, and no `notification.fan_out_failed` / `dispatch_failed` line was emitted — the rows were written
and then removed by the server.

## Decision

**Anchor the spec's three fixture instants to the real clock** instead of writing them as `2026-03-*`
literals. `notification-quiet-hours-release.test.ts` now derives `INSIDE` / `WINDOW_END` /
`BEFORE_END` from one `new Date().toISOString().slice(0, 10)` anchor day:

- the **scenario is unchanged** — a deferral at `23:00` UTC inside the `22:00–07:00` quiet window, the
  window end at `07:00` UTC the next morning, and `06:00` UTC as the "before the window ends" instant;
- the only change is the calendar date, so `expireAt` lands ~180 days in the **future** and no
  monitor pass can ever delete a fixture row mid-test — at any cadence, on any machine;
- **no assertion is weakened, added or removed.** The I11 contract ("3 fan-outs ⇒ 3 deferred rows; a
  run releases exactly `limit` and reports `hasMore` while a backlog remains") is byte-identical, and
  the file's other four pins (I5 ×3, I12) are untouched.

The alternative — keep the literals and drop the retention TTL index in the throwaway database — was
rejected: it hides a real production index from the spec instead of removing the reason its fixtures
were already expired. Anchoring to the real clock fixes the cause for every test in the file and
keeps the spec running against the production index topology.

### Why not a fixed future literal

A literal such as `2027-03-01` would only push the same bomb ~10 months out (today's `2026-03-01`
literals are precisely that bomb, already detonated). The anchor is derived at module load, so the
fixture rows are future-dated **by construction**, forever.

## Evidence

**Reproduction rate (this host: 4 cores, load average 7–19, i.e. already saturated by neighbouring
lanes):**

- **Control: the pre-change fixture at the default 60 s monitor cadence does not reproduce on demand.**
  A throwaway loop of the pre-change scenario — 40 rounds × 3 fan-outs = **120 fan-outs**, fresh
  database per round — produced **0 anomalies** (`deferred` was `3` every round). The race needs a
  monitor pass to land inside the window between two fan-outs, which at a 60 s cadence is rare — hence
  the reviewer's single failure in ~9 file-runs.
- **The mechanism was therefore forced, not waited for.** `db.adminCommand({ setParameter: 1,
ttlMonitorSleepSecs: 1 })` shortens the monitor's cadence for that mongod so the pass lands inside
  the test deterministically. No committed file ever sets this parameter.
- **One full-suite run of the _pre-change_ tree** (`vitest run --project integration`, 54 files) failed
  **`notification-bounded-sweeps.test.ts`** with `Error: Test timed out in 5000ms` — a _different_
  load artefact of the same saturated host, not the I11 signature; noted under "Findings" below.

**Deterministic RED/GREEN mirror** (throwaway probe, deleted before commit; both cases driven by the
same mongod with `ttlMonitorSleepSecs = 1`, identical 2.5 s waits between the three fan-outs):

```
pre-change fixture  INSIDE = 2026-03-01T23:00:00.000Z   countsAfterEachFanOut: [1, 1, 1]
                                                        deferredAfterThreeFanOuts: 0
                                                        preChangeSpecWouldFail: true
post-change fixture INSIDE = 2026-10-20T23:00:00.000Z   countsAfterEachFanOut: [1, 2, 3]
                                                        deferredAfterThreeFanOuts: 3
```

**Expiry, captured from the stored rows** (throwaway probe):

```
realNow    2026-10-20T15:48:39.540Z
rows       3 × { status: "deferred", until: "2026-03-02T07:00:00.000Z",
                 expireAt: "2026-08-28T23:00:00.000Z" }      <- 53 days in the past
ttlIndex   { key: { expireAt: 1 }, name: "dispatches_expire_at_ttl", expireAfterSeconds: 0 }
```

…and the deletion observed with **no product call** between the fan-outs and the count: the deferred
count fell from `3` to `0` within ~64 s while the test only slept (the monitor's own pass).

**Post-fix runs:** see §"Post-fix verification" below.

## Consequences

- The flake is removed at its cause: the spec's fixtures are future-dated by construction, so the TTL
  monitor cannot race the assertions regardless of machine load or monitor cadence.
- The change is confined to one spec file; no production behaviour, index, or retention setting moves.
- **Class-wide exposure (routed, not fixed here by scope).** 23 integration specs pin a `2026-03-*`
  `T0`/`INSIDE` and likewise persist rows that are already TTL-expired against the real clock
  (`notification-digest*.test.ts`, `notification-dispatch-retry*.test.ts`,
  `notification-bounded-sweeps.test.ts`, `domain-events.test.ts`, `identity-hooks.test.ts`, …). Any of
  them that **counts or re-reads stored rows** after a delay carries the same latent race. The card
  explicitly restricts this lane to the quiet-hours spec ("do not edit any other spec"), so the
  class-wide fix is routed as a follow-up rather than applied here.

## Alternatives considered

- **Drop `dispatches_expire_at_ttl` in the throwaway database.** Rejected (above): it removes a real
  production index from the exercised topology instead of removing the already-expired fixtures.
- **A literal future date (`2027-03-01`).** Rejected: it re-arms the same time bomb.
- **Assert before the TTL monitor can fire / raise the test timeout.** Rejected: a timeout cannot make
  an asynchronous server-side delete not happen, and it weakens nothing into a lie.
- **Treat it as a product defect (card's class b) and open a RED pin + GREEN card.** Rejected on the
  evidence: no fan-out failed, no error was swallowed, and the rows demonstrably existed before the
  server deleted them. Nothing in `fan-out.ts` needs to change.
- **Change the shared harness (`helpers/db.ts`) to neutralise retention TTLs for throwaway dbs.**
  Rejected _for this card_: it changes behaviour for all 23 exposed specs at once, well beyond the
  lane's scope. It is the natural shape of the routed follow-up.

## Assumptions & open questions

- **The TTL monitor is the only deleter considered.** The evidence (rows with past `expireAt`, index
  `expireAfterSeconds: 0`, count falling to 0 with no test action) is sufficient; no other mechanism
  was needed to explain the observation.
- **Anchoring to the real clock is the accepted cost.** The fixture dates are now runtime-derived
  rather than literal. The behaviour under test, the assertions and the ordering are unchanged; the
  spec remains deterministic because every derived instant is a pure function of one anchor read at
  module load.
- **`ttlMonitorSleepSecs=1` was used only to force the demonstration**, never in a committed file.

## Out of scope

- No production code, index, retention setting, mock, factory or other spec is touched.
- The class-wide `2026-03-*` fixture exposure (23 specs) is **routed**, not fixed here.
- The separate full-suite `Test timed out in 5000ms` seen in `notification-bounded-sweeps.test.ts`
  on a saturated host is a different (performance) matter and is not addressed by this card.

## Post-fix verification

All commands run in `/root/openpic/openpic-webapp/.worktrees/t-quiet-i11-flake` with
`TMPDIR=/root/tmp-mongo`, on the loaded host described above. The branch was rebased onto
`origin/main` `705467a` (which brought in the F1c-r2 lane's new integration spec) before the final
runs; the numbers below are from the rebased tree.

- **The spec file, 22 consecutive runs under load, post-fix** — **22/22 green, `5 passed (5)` each
  (110 test executions, 0 failures)**: 12 runs on the pre-rebase tree (load average 7–9 during the
  loop) and 10 runs on the rebased tree. No failure in any run.
- **Full integration suite, post-fix:** `vitest run --project integration` on the rebased tree →
  **55 passed (55) files, 358 passed (358) tests**, 67 s, load average 7.5. (The pre-change baseline
  on this branch's original base `3f46950` was 54 files / 357 tests; `origin/main` `705467a` adds one
  integration spec from the F1c-r2 lane, hence 55/358.) No test was added, removed or skipped by this
  card — the file test count is unchanged at `5 passed (5)`.
- **The I11 contract is unchanged.** The diff touches only the three fixture constants and adds a pure
  `nextUtcDay` helper; no assertion, `describe`/`it` name, `expect` expression or timeout changed.
- `tsc -p tsconfig.json --noEmit` and `tsc -p apps/web/tsconfig.json --noEmit` → clean;
  `eslint` on the spec → clean; `prettier --check` on the spec, the ADR and the ADR index → clean.
- **PR:** #225 — https://github.com/yahodu/openpic-webapp/pull/225

## Findings (routed)

- **F1 — class-wide `2026-03-*` fixture exposure (Medium, latent flake in ~23 integration specs).**
  Every integration spec that pins a `2026-03-*` `T0`/`INSIDE` persisting rows with
  `expireAt = instant + retention` is handing the server permission to delete its fixtures before the
  assertions run. `notification-bounded-sweeps.test.ts` (F3, `INSIDE = 2026-03-01T23:00Z`) is the
  closest sibling and the one that actually failed on this host during verification (a 5 s test
  timeout under load, not a TTL deletion). Routed as a follow-up card rather than fixed here, because
  the card restricts this lane to the quiet-hours spec. The natural shape of the fix is a shared
  harness helper (future-date the fixture clock, or neutralise the retention TTLs on the throwaway
  database) applied across the exposed specs.
- **F2 — no product defect found.** The card's other candidate class (b), a swallowed write/claim
  error in `fan-out.ts`, was investigated (the `catch` blocks at `fan-out.ts:1229`, `writeDeferred`'s
  render `catch`, the `notification.catalogue_fallback` path, and the claim/lease filter in
  `domain-events.ts:385`) and is **not** implicated: no fan-out failed, no `notification.fan_out_failed`
  / `dispatch_failed` line was emitted, and the rows demonstrably existed before the server deleted
  them. No RED pin or GREEN card is warranted.
- **F3 — the pre-change spec still passes most runs, so the failure is genuinely intermittent.**
  120 pre-change fan-outs at the default cadence produced no failure. That is recorded honestly here
  rather than presented as a reproduction: the _mechanism_ is proven, the _rate_ is not reproducible
  on demand.
