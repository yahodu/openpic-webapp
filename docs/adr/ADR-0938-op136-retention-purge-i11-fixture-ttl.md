# ADR-0938 — OP-136: anchor the `job-retention-purge` fixture clock (I11's empty `expiredSelfies` line)

- **Status:** Accepted · **Date:** 2026-11-22
- **Card:** `t_be5ae9d1` (OP-136 TEST, Low — stabilise the flaky `job-retention-purge` I11) · **Parent:** `t_0a2afec0` (OP-138 DOCS sign-off, PR [#785](https://github.com/yahodu/openpic-webapp/pull/785), where the flake was found)
- **Branch:** `OP-136-task-stabilize-retention-purge-i11` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_4b37e5de`
- **ADR number:** `0938` — the OP-136 jobs lane holds `0849`–`0868`; that range is fully consumed, so the lane draws from the pool high-water, and the newest ledger state of that cursor is `0938` (the in-flight OP-139 cut of `0918`–`0937`, PR [#780](https://github.com/yahodu/openpic-webapp/pull/780), advanced both the `OP-136 jobs lane` cell and the `unallocated (future lanes)` cursor to `0938`). The sweep read `origin/main` `9423ead3` (highest record `0903`), every `.worktrees/*/docs/adr` tree (only `t_7da4009d` holds a `09xx` above `0905` — `ADR-0918-op139-analytics-rollup-jobs-red.md`), the open PR heads (#786, #783, #780, #755, #743, #272) and `git rev-list --objects --all -- docs/adr`, which resolves no `ADR-09[3-5]` object. Nothing holds `0938`, so this record takes it; the card bumps the lane cell to `0939` and the `unallocated (future lanes)` cursor to `0939` as well, so no lane can mint the number this ADR consumes. No cell is lowered and no range is re-cut.
- **Touches:** one integration spec (`apps/web/src/test/integration/job-retention-purge.test.ts`: one import, the `NOW` constant and its comment), this ADR, the ADR index row, two `Next free` cells of the reserved-range ledger. **No production code, schema, index, retention setting, mock or factory.** No assertion, case name, helper, timeout or seed shape changes.

## Context

PR [#785](https://github.com/yahodu/openpic-webapp/pull/785) was docs-only (`+50/−0`, one ADR file) yet its
first `ci` attempt on head `cbb9344` (run `45005278145`) failed the `integration` job on a test the diff
cannot affect:

```
FAIL integration apps/web/src/test/integration/job-retention-purge.test.ts
  > retention-purge: expired selfies and anonymous sessions
  > I11: erases an unconfirmed selfie past its TTL with its embedding, provisional matches and counts
AssertionError: expected undefined to be defined
 ❯ apps/web/src/test/integration/job-retention-purge.test.ts:651:17
Test Files  1 failed | 152 passed (153)   Tests  1 failed | 1631 passed (1632)
```

`gh run rerun --failed` passed the same job on the same head (`7m50s`, PR 14/14), so the failure is
intermittent and pre-existing. The card asked for: reproduce first, find the ordering/state dependency,
stabilise **without** weakening the DSR-evidence assertion, and prove it.

The pin at `:650`–`:652` is the evidence line of the `expiredSelfies` leg:

```ts
const leg = eraseSteps(logger).find((fields) => fields.step === "expiredSelfies");
expect(leg).toBeDefined();
expect(leg?.counts).toEqual({ selfies: 1, embeddings: 1, matches: 1 });
```

`retentionPurge` (`apps/web/src/server/jobs/retention-purge.ts:432`–`439`) writes that line **only when
`expired.erased > 0`**, and `purgeExpiredSelfies` (`:300`–`343`) counts `erased` from
`selfies.deleteOne({ _id }).deletedCount`. So an empty `leg` means the scan found nothing due, or the
row was already gone when the loop's `deleteOne` ran.

## Diagnosis — the fixture is TTL-expired against the real clock

The file pinned `const NOW = new Date("2026-11-17T09:00:00.000Z")` and `I11` seeds the one row the leg
must find with `isActive: false, expireAt: NOW − 1 day` (`:615`–`:618`). That is exactly the pair the
`selfies_expire_at_ttl` index selects:

```
{ collection: selfies, name: "selfies_expire_at_ttl", keys: [["expireAt", 1]], expireAfterSeconds: 0 }
```

mongod evaluates a TTL index against the **real** wall clock, not against the spec's injected
`fixedClock(NOW)`. On 2026-11-22 the real clock is five days past the literal `NOW`, so `I11`'s
`expireAt = 2026-11-16T09:00:00Z` is already nine days past: the fixture is **born expired**, and the
TTL monitor (one pass every `ttlMonitorSleepSecs`, default 60) may delete it at any moment after the
insert. The same holds for `I13`'s anonymous session (`expireAt = NOW − 1 day` against
`attendee_sessions_expire_at_ttl`).

The observed failure text pins _which_ interleaving happened. `I11` asserts the row, the matches, the
asset and the stored object first (`:636`–`:647`) and the log line last (`:650`). All four passed, so the
row, its vector, its matches and its bytes were gone — but no evidence line was written, i.e.
`erased === 0`. That is exactly what `purgeExpiredSelfies` produces when the monitor deletes the row
**after** the job's `find` returned it and **before** the loop's `deleteOne` reaches it: the loop still
deletes the storage object, the `mediaAssets` row and the `faceMatches` rows, then `deleteOne` matches
zero documents, `erased` stays `0`, and the `retention.purge.step` line is never emitted. A monitor pass
landing a few milliseconds earlier (before the `find`) would instead fail the `faceMatches` assertion —
a different signature, and not the one CI recorded.

The classification is the one ADR-0146 and ADR-0148 already established: **a fixture/clock problem, not
a product defect.** In production the ordering is benign — if the TTL already erased the row, the job
has nothing to erase and nothing to log. Nothing in `retention-purge.ts` needs to change.

## Evidence

All commands ran in `/root/openpic/openpic-webapp/.worktrees/t_4b37e5de` with `TMPDIR=/root/tmp-mongo`,
one shared `MongoMemoryReplSet` per invocation (`apps/web/src/test/integration/global-setup.ts`).

### Reproduction attempt before any change — 30 runs, 0 reds (recorded honestly)

`vitest run --project integration apps/web/src/test/integration/job-retention-purge.test.ts`, 30
consecutive runs on the pre-change tree at the production monitor cadence:

```
baseline  30/30 green ("Tests 10 passed (10)"), 0 I11 reds, 0 assertion failures
```

That is the expected result and it is not a contradiction: each single-file invocation starts its own
`MongoMemoryReplSet`, so the server lives ~6 s and **the first TTL pass (~t+60 s) never happens**. The CI
failure came from a full run, where one replset lives for the whole 7–8 minutes and every file inherits
a monitor that is already passing. As ADR-0146 recorded, the rate is not reproducible on demand; the
mechanism is.

### Mechanism, forced — the fixture is deleted with no test action

Throwaway probe (`zz-op136-i11-probe.test.ts`, deleted before commit), the exact `I11` fixture shape
(event, profile, selfie `isActive:false expireAt:NOW−1d`, match, asset, stored object):

```
A1  index                { name: "selfies_expire_at_ttl", key: { expireAt: 1 }, expireAfterSeconds: 0 }
    realNow              2026-11-22T09:29:49.318Z
    fixtureExpireAt      2026-11-16T09:00:00.000Z        (past)
    deletedAfterMs       55 926                          (one monitor pass, default 60 s cadence)
A2  fixtureExpireAt      2026-11-23T09:00:00.000Z        (+23.5 h, the proposed anchor)
    rowsAfter70s         1                               (a pass landed; the row survived)
```

### The interleaving, deterministic — this reproduces the CI text

Same probe, `B1`: the job's due-scan is wrapped so that the row it returned is deleted **before** the
loop's `deleteOne` runs — the monitor's pass landing inside the erase window, with no timing luck:

```
B1  gone        { selfie: "gone", matches: 0, asset: "gone", object: "gone" }
    leg         null
    result      { events: 0, expiredSelfies: 0, anonymousSessions: 0 }
    failure     "AssertionError: expected undefined to be defined"
```

That is byte-identical to the CI `AssertionError`, with `I11`'s four database assertions green — the
signature only this mechanism produces.

### The pre-change file under a 60× monitor (forced cadence)

`ttlMonitorSleepSecs = 1` set by a temporary hook in `global-setup.ts` (reverted before commit; no
committed file sets it). 60 runs of the **pre-change** spec, same assertions:

```
runs 1–13, 15–16, 18–20   green ("Tests 10 passed (10)")
run 14                    RED  I13: erases an expired anonymous session's profiles and selfies
                          AssertionError: expected { …(9) } to be null   (the profile row survived)
run 17                    RED  I13  (same assertion)
pre-fix reds over 60 runs 2 (both I13); I11 0/60 — its window is one row wide, so it needs a rarer
                          pass position, which is why CI saw it once and not more
```

Two authentic reds, same root cause, on the second TTL-exposed fixture of the same file: the exposure is
a class, and `I13` reds 60× more often than `I11` because its window also spans the session scan.

### After the change

```
post-fix, default cadence   30/30 green ("Tests 10 passed (10)"), 0 reds
post-fix, cadence 1 s       10/10 green, 60× the production pass rate
B2 probe, anchored clock    20/20 rounds: leg defined, counts {1,1,1}, row erased
```

The full `unit` + `integration` projects, `tsc`, `eslint` and `prettier` results are in §Verification.

## Decision

**Anchor the file's single clock constant to the real UTC day, two days ahead, through the shared helper
ADR-0148 introduced:**

```ts
import { fixtureInstant } from "../helpers/fixture-clock";
const NOW = new Date(fixtureInstant("09:00:00.000Z", 2));
```

- The anchor is read **once** at module load (`fixture-clock.ts`), so every derived instant in a run is a
  pure function of one real-clock read — no clock drift inside a file and no new flakiness.
- Two days ahead makes the shape of the fixture problem go away by construction. `NOW` is between 33 h and
  57 h after the anchor day's start, so every instant this file derives as `NOW − n days` sits **at least
  ~9 h ahead of the real clock**, while still being in the past of the injected `NOW` — which is what
  `I11` (selfie `expireAt = NOW − 1d`) and `I13` (session `expireAt = NOW − 1d`) must seed.
- The scenario is unchanged: `I11` still seeds an unconfirmed selfie one day past its TTL, `I13` still
  seeds a session one day past its expiry, the event-erase cases still seed `retentionExpiresAt = NOW − 1d`,
  `NOW + 30d` still means "inside the retention window", and the bounded-invocation case still sees three
  due events.
- **No assertion is weakened, added, removed or skipped.** `expect(leg).toBeDefined()` and
  `expect(leg?.counts).toEqual({ selfies: 1, embeddings: 1, matches: 1 })` are byte-identical; the diff
  touches no `it`, no expectation, no timeout and no seed helper.

### Why two days, and not one

One day ahead would leave `NOW − 1 day` at 09:00Z of the anchor day — in the real _past_ for any run after
09:00Z, i.e. the same bomb. Two days is the smallest whole-day offset that keeps the derived "expired"
instants at least ~9 h in the real future for every run of the day.

### Why not the alternatives

- **Drop `selfies_expire_at_ttl` / `attendee_sessions_expire_at_ttl` in the throwaway database.** Rejected
  twice already (ADR-0146 §Decision, ADR-0148 §Decision): it removes a real production index from the
  topology the suite exercises, so a TTL-index regression would go unnoticed. Fix the fixtures, not the
  server.
- **Push the literal forward (e.g. `2027-11-17`).** Rejected: it re-arms the same bomb, and the 2026-11-17
  literal is that bomb already detonated.
- **Retry, sleep, or a longer timeout.** Rejected by the card and by construction: no wait can make an
  asynchronous server-side delete not happen, and a retry would hide the next fixture of this class.
- **Weaken the pin (`toBeDefined()` optional / drop the counts).** Rejected: the logged counts are the DSR
  evidence this spec exists to pin.
- **Treat it as a production defect.** Rejected on the evidence: the job's behaviour when the TTL already
  erased the row is correct (nothing to erase, nothing to log). No RED pin and no GREEN card is warranted.

## Consequences

- The race is removed at its cause for both exposed fixtures of this file: their `expireAt` values are
  future-dated against the real clock by construction, so no monitor pass at any cadence can delete a
  fixture between its seed and the job's scan.
- The change is one import and one constant in one spec; the file's ten cases and their contracts are
  untouched.
- A future spec that must seed a row _expired for its injected clock_ now has a worked example: anchor the
  clock **ahead** of the real day and derive `expiry = clock − n days`, instead of pinning a literal past
  date (ADR-0148's "use `fixtureInstant(time, -1)`" advice covers rows the real clock must also see as
  live; it does not cover rows that must look expired to an injected clock).

## Assumptions & open questions

- **The TTL monitor is the only deleter considered**, as in ADR-0146/ADR-0148. The evidence (the exact
  index shape, a row deleted 55.9 s after insert with no test action, a same-shape anchored row surviving
  a pass, and the deterministic mid-flight mirror reproducing the CI text) is sufficient; no other
  mechanism is needed to explain the observation.
- **The anchor is relative by design.** Fixture dates are now runtime-derived. Determinism is preserved
  because every instant is a pure function of one module-load read and no assertion compares a fixture
  against the real clock.
- **`I11`'s own reproduction rate stays low at the production cadence** (0/30 single-file runs, 0/60 under
  the forced 60× cadence). That is recorded, not hidden: the mechanism is proven, the rate is not
  reproducible on demand, exactly as ADR-0146 recorded for its own instance.

## Out of scope

- No production code, schema, index, retention setting, mock or factory is touched.
- Other specs that pin a literal past clock are not edited here; the one in this lane that carries the same
  exposure is routed as a finding below.
- No test was added, removed or skipped; the file stays at 10 cases.

## Findings (routed)

- **F1 — `job-usage-and-invitations.test.ts` carries the same exposure (Low, latent).** Its
  `seedExpiredInvitation` writes an `invitations` row with `expireAt = NOW − 1 day` against the
  `invitations_expire_at_ttl` index (`{expireAt:1}`, `expireAfterSeconds: 0`) while `NOW` is the literal
  `2026-11-17` — already in the real past. The invitation-expiry cases then read that row back after the
  sweep. Same class, same fix shape (`fixtureInstant` with a future anchor). Routed as a card for
  `openpic-webapp-testcase-writer` (`parents=[t_be5ae9d1]`), not fixed here.
- **F2 — no product defect found.** `purgeExpiredSelfies`'s zero-erase path and its "no line when nothing
  was due" rule are correct for the production race.

## Verification

See the card handoff for the command log. Summary at the change's head:

- the spec, default cadence: **30/30 runs green**, 10 cases each;
- the spec, forced 1 s monitor cadence: **10/10 runs green**;
- `vitest run --project unit` and `--project integration` on the branch: both green;
- `tsc -p tsconfig.json --noEmit`, `tsc -p apps/web/tsconfig.json --noEmit`, `eslint` on the changed
  files, and `prettier --check` on the changed files: clean.
