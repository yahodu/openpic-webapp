# ADR-0941 — OP-138: anchor the DSR lapsed-session fixture and its clock (`attendee_sessions` TTL exposure)

- **Status:** Accepted · **Date:** 2026-11-23
- **Card:** `t_57b151e0` (OP-138 TEST, Low — the finding `t_d277cf8b`, the post-merge verification of PR [#793](https://github.com/yahodu/openpic-webapp/pull/793) squash `16fc92df`, routed)
- **Branch:** `OP-138-task-dsr-lapsed-session-fixture-clock` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_4b37e5de`
- **ADR number:** `0941` — this card carries the number explicitly: when it was written both `Next free` cells that read `0941` held it (`OP-136 jobs lane`, `unallocated (future lanes)`) and the highest record was ADR-0940. The delivery re-sweep (below) found nothing holding `0941`, so it is drawn from that pool cursor and **both** cells advance to `0942`; the `OP-138 compliance lane` cell stays at `0908` and no cell is lowered and no range is re-cut.
- **Touches:** one integration spec (`apps/web/src/test/integration/data-subject-requests.test.ts`: one import, the seeded clock constant, the lapsed `expireAt` and the clock the two lapsed reads run under), this ADR, its index row, two `Next free` cells of the reserved-range ledger and one ledger paragraph. **No production code, schema, index, retention setting, mock or factory.** No assertion, case name, seed shape, helper, timeout or TTL index changes.

## Context

[ADR-0939](ADR-0939-op136-usage-invitations-fixture-ttl.md) stabilised `job-usage-and-invitations.test.ts` by anchoring its clock two UTC days ahead of the real day through ADR-0148's `fixtureInstant` helper. The post-merge verification of that PR (`t_d277cf8b`, PR [#793](https://github.com/yahodu/openpic-webapp/pull/793)) swept ADR-0146/0148's TTL/fixture-clock class repo-wide and found one more **exposed** member outside the OP-136 jobs lane:

- `apps/web/src/test/integration/data-subject-requests.test.ts`, case **`I29`** ("a deleted session row leaves the receipt readable, and a stale cookie cannot shadow it"), arm **(b)** at `:1633`–`:1663`. It lapses an attendee session with `{ $set: { expireAt: new Date("2026-01-01T00:00:00.000Z") } }` (`:1640`), reads the receipt with the same cookie (`200`), then reads without the receipt and pins `401 attendee_session_expired` (`:1659`–`:1663`).
- The file calls `ensureIndexes(app.db)` in its `beforeAll` (`:142`), so `attendee_sessions_expire_at_ttl` (`apps/web/src/server/db/indexes.ts:710`–`:715`, `{expireAt: 1}`, `expireAfterSeconds: 0`) is live in that database.
- `findAttendeeSession` (`apps/web/src/server/attendee/session-resolver.ts:88`–`:103`) answers `null` for a **missing** row and throws `attendee_session_expired` (`401`, `details.recreateUrl`) only for a row that is **present and lapsed**. The same test pins `unauthenticated` for a token that names no row in arm **(a)** (`:1627`).

So a monitor pass landing between the `$set` and the second read deletes the row, and the case answers `unauthenticated` where it pins `attendee_session_expired` → RED. That is ADR-0146/0148's class, and the reviewer measured the same rate class as ADR-0939's `I7` (`1/40` at a forced 1 s cadence).

This card's instruction is explicit: reproduce first, fix the fixture (never the assertion), prove the change, record the decision.

## Diagnosis

The exposure is the fixture's, not the product's:

- `attendee_sessions_expire_at_ttl` is evaluated by **mongod** against the **real** clock. The `$set` writes `2026-01-01T00:00:00.000Z`, which is **7 832 hours (326 days) past** the real clock at the delivery run, so the row is deleted by the server's own monitor with no test action. In production that deletion is correct: a session past `expireAt` must not be readable.
- The row the case needs is therefore a **deliberately lapsed** one, and it must stay **present** long enough to be read. Those two requirements cannot both be met by a literal in the real past under a live TTL index.

The card's shape — anchor the file's clock and derive the lapsed `expireAt` as anchored `NOW − 1 day` — is necessary but **not sufficient here**, and the measurement says so: `findAttendeeSession` compares against `options.clock ?? systemClock`, and this route chain passes **no** clock (`_lib/principal.ts` calls `systemClock.now()`), so a row whose `expireAt` sits in the real future is **not** lapsed for the route. A fix that only moves the literal would turn `:1659`'s pin into `200`, i.e. it would red for the opposite reason. The case must therefore run its two lapsed reads under the **same** anchored clock it derives the fixture from. The repository already has that shape: `attendee-sessions.test.ts:689`–`:691` ("the clock decides expiry") uses `vi.useFakeTimers({ toFake: ["Date"] })`, and `systemClock.now()` is `() => new Date()`, so the fake is exactly the seam the route reads.

**Classification: a fixture/clock problem, not a product defect.** No production file is expected or touched.

### Harness pitfall found while forcing the cadence (recorded because it invalidates a "forced" measurement)

`mongodb-memory-server` 10.4.3 reads `instanceOpts` at the **top level** of `MongoMemoryReplSet.create({ … })`; the same key nested inside `replSet` is **silently ignored**. The first pass of this card's reproduction used the nested shape and measured `0/40` — a real datum, but at the **default 60 s** cadence, not a forced one. `getParameter` proved the difference:

```
MongoMemoryReplSet.create({ replSet: { count: 1, instanceOpts: [...] } })
  → { ttlMonitorSleepSecs: 60 }        # requested 1, silently ignored
MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [...] })
  → { ttlMonitorSleepSecs: 1 }
```

Every forced-cadence figure recorded below was measured **after** that check, with `getParameter` returning `1`. Any earlier "forced 1 s" figure in this lane that used the nested shape should be re-read with that in mind; the ADR-0939/0940 probes report deletion latencies (`t+644`/`t+765` ms) that only a real 1 s cadence produces, so their evidence stands.

## Evidence

All commands ran in `/root/openpic/openpic-webapp/.worktrees/t_4b37e5de` with `TMPDIR=/root/tmp-mongo`; a single-file invocation boots its own `MongoMemoryReplSet` (`apps/web/src/test/integration/global-setup.ts`).

### Baseline at the production cadence — 40/40 green (recorded honestly)

`vitest run --project integration apps/web/src/test/integration/data-subject-requests.test.ts`, 40 consecutive runs of the **pre-change** spec (`origin/main` `8e08f190`, spec byte-identical), default monitor cadence:

```
pre-change, default cadence   40/40 green ("Tests 45 passed (45)"), 0 reds, ~10 s per run
```

This is expected and is not a contradiction: each single-file run boots its own `mongod` and lives ~10 s, while the first TTL pass is ~t+60 s, so **no pass can fire inside a single-file run**. CI runs one replset for the whole `integration` project, so every later file inherits a monitor that is already passing — the rate is not reproducible on demand; the mechanism is.

### Mechanism, measured — the literal lapsed row is TTL-deleted with no test action

Throwaway probe (`cache/scratch/op138-probe-attendee-ttl.mjs`, outside the repo), its own `MongoMemoryReplSet`, the shipped `attendee_sessions_expire_at_ttl` shape (`{expireAt: 1}`, `expireAfterSeconds: 0`), four rows inserted at once: the pre-change literal, the proposed anchored `NOW − 1d`, the anchored `NOW`, and a control `real + 23 h`. Rows were polled every 250 ms; **no test code ran**.

Default cadence (60 s), inserted `2026-11-23T08:33:10.199Z`:

```
DELETED  pre-fix literal 2026-01-01T00:00:00Z      at t+59 733 ms
SURVIVED anchored NOW−1d 2026-11-24T00:00:00.000Z  (15.45 h vs real clock)
SURVIVED anchored NOW    2026-11-25T00:00:00.000Z  (39.45 h vs real clock)
SURVIVED control real+23h 2026-11-24T07:33:10.199Z
```

Forced cadence (`--setParameter ttlMonitorSleepSecs=1`, `getParameter` verified `1`), inserted `2026-11-23T08:37:02.115Z`:

```
DELETED  pre-fix literal 2026-01-01T00:00:00Z      at t+544 ms
SURVIVED anchored NOW−1d                           (25 s, ~25 passes)
SURVIVED anchored NOW                              (25 s, ~25 passes)
SURVIVED control real+23h                          (25 s, ~25 passes)
```

So the literal is deleted by the server alone and the anchored shape survives the same passes the pre-change row cannot.

### The pre-change file under a forced monitor cadence — 0/40 (recorded honestly)

`ttlMonitorSleepSecs = 1` set by a temporary top-level `instanceOpts` in `global-setup.ts` (reverted before commit — no committed file sets it; restored byte-identical and re-hashed against the base). 40 runs of the **pre-change** spec:

```
pre-change, forced 1 s cadence   40/40 green ("Tests 45 passed (45)"), 0 reds
                                 runs at 08:37:40–08:46:05Z, ~12 s each
```

That is the honest rate and it is not a refutation: `I29(b)`'s window is one `$set` → one route read (~1–3 ms), so a 1 s cadence needs a pass position that falls inside a window two orders of magnitude narrower than ADR-0939's `I7` (seed → sweep → accept). 520-odd passes in the 40 runs against a few milliseconds each is an expected count of ~1, and the draw came up empty. The mechanism is therefore proven by the probe above and localised on demand by the mirror below — exactly the pattern ADR-0146/0938/0940 recorded for windows this narrow.

### Deterministic mid-flight mirror

A temporary `await new Promise((resolve) => setTimeout(resolve, 2_500));` after the `$set` (reverted before commit) widens the same window the monitor must hit. With the forced cadence, the pre-change case answers the predicted red:

```
pre-change, mirror only   FAIL  I29: a deleted session row leaves the receipt readable…
                          AssertionError: expected 'unauthenticated' to be 'attendee_session_expired'
                          Tests  1 failed | 44 passed (45)
```

`unauthenticated` is what the route answers when the row is **gone**; `attendee_session_expired` is what it answers when the row is present and lapsed. The mirror therefore localises the deletion to the window between the `$set` and the read, which is the only place the two differ.

With the fix in place, the same widen stays green — the row is no longer a deletion candidate at all:

```
with the fix, mirror only  PASS  Tests  1 passed | 44 skipped (45)   (-t "I29")
```

### After the change

```
post-fix, default cadence   5/5 green ("Tests 45 passed (45)"), 0 reds
post-fix, forced 1 s        20/20 green — the cadence that produced the pre-change 0/40
```

## Decision

Three edits in one spec, no assertion touched:

1. **Anchor the file's seeded clock** — the single `now` constant in `seedEvent` (`:378`):

   ```ts
   import { fixtureInstant } from "../helpers/fixture-clock";
   const now = new Date(fixtureInstant("00:00:00.000Z", 2));
   ```

2. **Derive the lapsed `expireAt` from the same anchor** — anchored `NOW − 1 day` is `fixtureInstant("00:00:00.000Z", 1)`, i.e. the real day + 1 at 00:00Z, at least ~1 minute and up to ~24 h in the **real future**, so no monitor pass can delete the row, while still being one day **before** the anchored `NOW`:

   ```text
   { $set: { expireAt: new Date(fixtureInstant("00:00:00.000Z", 1)) } }
   ```

3. **Run the two lapsed reads under the anchored clock** — the seam the route already reads (`systemClock.now()` → `new Date()`), the same shape `attendee-sessions.test.ts` uses for "the clock decides expiry". The calls sit **around** the unchanged assertion lines rather than in a `try` block, so the diff adds no assertion line; the fake is undone twice so a failed assertion cannot leak it:

   ```ts
   vi.useFakeTimers({ toFake: ["Date"] });
   vi.setSystemTime(new Date(fixtureInstant("00:00:00.000Z", 2)));

   // … the shipped receipt read (200) and the shipped bare read (401), verbatim

   vi.useRealTimers(); // end of the case
   ```

   and in the file's `afterEach`, ahead of the existing restore, for the failure path: `vi.useRealTimers(); vi.restoreAllMocks();`.

- The scenario is unchanged: the session is still filed against by a live credential, lapsed by exactly one day, then read twice with the same cookie; the receipt still wins (`200`) and the credential alone still answers the re-create refusal (`401 attendee_session_expired`).
- The clock anchor is read **once** at module load (`fixture-clock.ts`), so every derived instant is a pure function of one real-clock read: no drift inside a run and no new nondeterminism beyond the day itself.
- **No assertion is weakened, added, removed or skipped, and no TTL index, retry, sleep or timeout is introduced.** The spec's diff adds no test-declaration, assertion or suite line.

### Why the fixture's clock and the route's clock must agree

The TTL monitor runs in `mongod` on the **real** clock; the route runs in-process on `systemClock`. A lapsed fixture is therefore expressible only when those two clocks disagree on purpose: the row must be **future** to `mongod` (so it survives) and **past** to the route (so the refusal is the pinned one). Anchoring the fixture clock to the real day + 2 and faking `Date` to that same instant is the smallest shape that makes the disagreement explicit and stable, and it is exactly what ADR-0148's "a row that must look expired to an injected clock" needs when the reader is not clock-injectable.

### Why not the alternatives

- **Keep the literal `2026-01-01` and widen the assertion (accept `unauthenticated`).** Rejected: the two end-states are different behaviours, and the deleted-row `unauthenticated` answer is already pinned by arm (a) of the same case (`:1627`). Accepting either would delete the precedence pin the case exists for.
- **Drop `attendee_sessions_expire_at_ttl` from the throwaway database.** Rejected twice already (ADR-0146 §Decision, ADR-0148 §Decision): it removes a real production index from the topology the suite exercises, so a TTL-index regression would go unnoticed. Fix the fixtures, not the server.
- **Retry, sleep or a longer timeout.** No wait makes an asynchronous server-side delete not happen, and a retry would hide the next fixture of this class.
- **Clock-inject the route chain.** That is a production change (a `Clock` port through `dsrAuth`) made only to serve a fixture; the spec can express the same intent with the shipped `vi.useFakeTimers` seam. No GREEN card is warranted.
- **Push the literal forward (e.g. `2027-01-01`).** Rejected: it re-arms the same bomb a year out, and the anchor must be runtime-derived (ADR-0148).

## Consequences

- The exposure is removed at its cause for this case at **any** monitor cadence: the lapsed row's `expireAt` is future-dated against the real clock by construction, so no pass can delete it between the `$set` and either read.
- The file's 45 cases (36 case declarations, one of them `I8`'s ten-row table case) are unchanged in behaviour; only the seeded clock constant, one `$set` value and the clock the two lapsed reads run under move.
- A second worked example now exists for a shape ADR-0148 did not cover: **a row that must look expired to a reader that reads the real clock**. The record states the three moves (anchor the fixture clock, derive `expiry = anchor − n`, fake `Date` to the anchor) so the next spec of this shape does not have to rediscover that anchoring alone is not enough.
- The harness pitfall above is recorded so a "forced cadence" claim can be checked (`getParameter`) instead of trusted.

## Assumptions & open questions

- **The number is drawn from the pool, not the lane's own block.** ADR-0300 makes a lane's next number lane-local, and the `OP-138 compliance lane` cell still reads `0908`. The card assigns `0941` explicitly and says not to lower a cell and not to re-cut a range, so `0941` is drawn and both `0941` cells advance to `0942`; `0908` is untouched. If the allocator prefers the lane-local number, this record renumbers to `0908` before merge and no other cell moves.
- **A 0/N at the production cadence is the honest rate**, and so is `0/40` at the forced cadence. Both are recorded as measured; the mechanism is proven by probe and by the deterministic mirror, because the rate is not reproducible on demand — exactly as ADR-0146/0938 recorded.
- **`vi.useFakeTimers({ toFake: ["Date"] })` fakes `Date` only.** Timers stay real, so the `mongodb` driver's socket and server-selection timeouts are unaffected, and the fake is undone at the end of the case and again in `afterEach`, so a failed assertion cannot leak it into a later case.
- **The anchored `NOW` (`real + 2`) is not asserted anywhere.** The `now` constant only stamps `createdAt`/`updatedAt`/`accessLinks[].createdAt` on seeds; no case compares those values against the real clock.

## Out of scope

- No production code, schema, index, retention setting, mock, factory or helper is touched.
- The two verified benign neighbours are **not** edited here:
  - `apps/web/src/test/integration/public-event-resolution.test.ts:886`–`:910` (`I2`) lapses a session the same way, but its assertion is "`200` + anonymous session", which the deleted row also satisfies exactly — the same shape is green either way.
  - `apps/web/src/test/integration/auth-guards.test.ts:742` lapses a session the same way, but its app comes from `startTestApp`, which never calls `ensureIndexes`, so no TTL index exists in that database today. **Fragile if that harness changes** (see Findings).
- `job-pipeline-sweep.test.ts:54`/`:152` (`NOW + 89d` = `2027-02-14`, 83 days ahead) and `job-pipeline-indexed-check.test.ts:72` (literal `NOW` on an `images` row only) stay unedited; they are already recorded as Info in ADR-0940.
- No test was added, removed or skipped; the file stays at 45 cases.

## Findings (routed)

- **F1 — `mongodb-memory-server` ignores a nested `instanceOpts` (Info, harness).** `MongoMemoryReplSet.create({ replSet: { count: 1, instanceOpts: [...] } })` silently runs at the default `ttlMonitorSleepSecs = 60`; only the top-level key applies. Recorded here because a "forced 1 s cadence" measurement is worthless unless `getParameter` confirms it; no card, because it changes no repository artifact.
- **F2 — `auth-guards.test.ts:742` is fragile-if-the-harness-changes (Info).** Its lapsed session is only benign because `startTestApp` does not run `ensureIndexes`; a future harness change that installs the shipping indexes would make it exposed exactly as this case was. Do not edit it here; record it.
- **F3 — `public-event-resolution.test.ts` `I2` is benign for a behavioural reason, not a timing one (Info).** The deleted row and the lapsed row both answer `200` + anonymous session, so no cadence exposes it. No card.
- **F4 — no product defect found.** A lapsed session being refused with `attendee_session_expired` while a deleted one is `unauthenticated`, and a receipt outliving both, is the contracted §8.1/§1.5 behaviour.

## Verification

At the change's head, on the branch, with `TMPDIR=/root/tmp-mongo`:

- the spec, default cadence: **5/5** sequential runs green, 45 cases each;
- the spec, forced 1 s monitor cadence: **20/20** runs green;
- `vitest run --project unit`: 191 files, **3210 passed | 3 skipped** (3213), `adr-source-references` green;
- `vitest run --project integration`: 153 files, **1638 passed**, exit 0;
- `tsc -p apps/web/tsconfig.json --noEmit`: exit 0, no errors;
- `eslint` on the changed spec: 0 issues; `prettier --check` on the spec, this record and the ledger: clean;
- the seven `adr-*` guards: 7 files, **248 passed**;
- the temporary `ttlMonitorSleepSecs=1` line is **not** in the diff: `global-setup.ts` restored byte-identical (`sha256 fa4f4b93…` before and after).

### ADR number sweep

Read at the delivery run: `origin/main` `8e08f190` (highest record `ADR-0940`), every `.worktrees/*/docs/adr` tree (75 files, highest `ADR-0940`), the four open PR heads (#780 `4662ca93` → `0918`; #755 `c90ae3ba`, #743 `40df0afd`, #272 `d5be9af4` → no `09xx`), and `git rev-list --objects --all -- docs/adr` (highest `ADR-0940`). Nothing holds `0941`, so it is free; both `0941` cells advance to `0942` and no cell is lowered.
