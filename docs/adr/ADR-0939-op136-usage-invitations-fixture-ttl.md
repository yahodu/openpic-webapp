# ADR-0939 — OP-136: anchor the `job-usage-and-invitations` fixture clock (invitations TTL exposure, ADR-0938 F1)

- **Status:** Accepted · **Date:** 2026-11-23
- **Card:** `t_3e4b1fac` (OP-136 TEST, Low — finding **F1** of `t_be5ae9d1`, the post-merge verification of PR [#787](https://github.com/yahodu/openpic-webapp/pull/787) squash `2dfd2cf4`)
- **Branch:** `OP-136-task-usage-invitations-fixture-clock` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_4b37e5de`
- **ADR number:** `0939` — the OP-136 jobs lane's own block `0849`–`0868` is fully consumed, so the lane mints from the pool high-water. [ADR-0938](ADR-0938-op136-retention-purge-i11-fixture-ttl.md) took `0938` and advanced **both** the `OP-136 jobs lane` cell and the `unallocated (future lanes)` cursor to `0939`, which is the newest recorded state of that cursor. The delivery sweep read `origin/main` `ff1cf74b` (highest record `0938`), every `.worktrees/*/docs/adr` tree (highest `0938` in this lane; `t_7da4009d` holds `0918`), the five open PR heads (#783 → `0907`, #780 → `0918`, #755 → `0889`, #743 → `0881`, #272 → `0306`) and `git rev-list --objects --all -- docs/adr`, which resolves no `ADR-0939` object. Nothing holds `0939`, so this record takes it; the card bumps the lane cell and the `unallocated (future lanes)` cursor to `0940`. No cell is lowered and no range is re-cut.
- **Touches:** one integration spec (`apps/web/src/test/integration/job-usage-and-invitations.test.ts`: one import and the `NOW` constant with its doc comment), this ADR, its index row, two `Next free` cells of the reserved-range ledger and one ledger paragraph. **No production code, schema, index, retention setting, mock or factory.** No assertion, case name, seed shape, helper, timeout or mock handler changes.

## Context

[ADR-0938](ADR-0938-op136-retention-purge-i11-fixture-ttl.md) stabilised `job-retention-purge.test.ts` by anchoring its `NOW` two UTC days ahead of the real day through ADR-0148's `fixtureInstant` helper. While diagnosing that flake it recorded the same latent exposure in one more OP-136 jobs spec and routed it as **F1** (`job-usage-and-invitations.test.ts`, `seedExpiredInvitation`'s `expireAt = NOW − 1 day`), explicitly **not** reproduced: no reproduction attempt was made under that card, so the exposure was classified **Low, latent**.

This card owns that finding: reproduce honestly first, fix the fixture (never the assertion), prove the change, record the decision.

The originating CI failure was an unrelated docs-only diff reddening `job-retention-purge` `I11` once and passing on rerun, i.e. a rate no diff can explain. This card's exposure is the same class, and the card's own instruction is explicit: if it does not reproduce at the production cadence, say so and prove the mechanism instead.

## Diagnosis — the whole file's clock is in the real past, not just the expired seed

The file pinned one clock constant and derived every fixture from it:

```ts
const NOW = new Date("2026-11-17T09:00:00.000Z");
```

Three fixture families in this file write an `invitations` row, and all three are already in the real _past_ against the real wall clock at the delivery run (`2026-11-23T06:06Z`, i.e. 6.05 days after `NOW`):

| case                                                           | fixture                                 | `expireAt` literal                      | verdict at 2026-11-23 |
| -------------------------------------------------------------- | --------------------------------------- | --------------------------------------- | --------------------- |
| `I7: moves a pending invitation past its deadline to expired…` | `seedExpiredInvitation` (`:320`–`:350`) | `2026-11-16T09:00:00.000Z` (`NOW − 1d`) | 7.05 days past        |
| `leaves a pending invitation inside its window alone`          | same seed, then `$set` (`:403`–`:404`)  | `2026-11-18T09:00:00.000Z` (`NOW + 1d`) | 5.05 days past        |
| `reminds a still-pending invitation at most once after T+3d`   | same seed, then `$set` (`:430`–`:431`)  | `2026-11-21T09:00:00.000Z` (`NOW + 4d`) | 2.05 days past        |

`invitations` carries a TTL index (`apps/web/src/server/db/indexes.ts`):

```
{ collection: "invitations", name: "invitations_expire_at_ttl",
  keys: [["expireAt", 1]], expireAfterSeconds: 0 }
```

mongod evaluates that index against the **real** clock, not against the spec's injected `fixedClock(NOW)`. Every row these three cases write is therefore **born expired** by the server's own reckoning, and the monitor (one pass per `ttlMonitorSleepSecs`, default 60) may delete it at any moment after the insert — between the seed and the expiry sweep, or between the sweep and the accept route's lookup.

The finding under-stated the exposure: F1 named only the deliberately-expired seed (`NOW − 1d`). The two cases whose rows are meant to be **inside** their window are exposed too, because `NOW + 1d` and `NOW + 4d` are themselves short of the real day. Anchoring the clock fixes all three, which is why the fix is one constant rather than one seed helper.

### The observed signature, and what it localises

Under a forced monitor cadence the pre-change file red **`I7`** alone with:

```
FAIL integration apps/web/src/test/integration/job-usage-and-invitations.test.ts
  > invitation-expiry > I7: moves a pending invitation past its deadline to expired, and a later accept answers 410
AssertionError: expected 404 to be 410
```

`I7` seeds the row, runs `invitationExpiryJob`, then asserts the row, the `collab.invite.expired` event, `details.expired === 1`, and finally the accept route's `410 invitation_expired`. A `404` on that last step means the row was **gone** when `decideByToken` loaded it — the accept path loads the invitation by id and denies the uniform `not_found` (`apps/web/src/server/collaboration/invitation-decision-request.ts:124`–`:134`) when no row matches the token hash. Both earlier assertions passed, so the sweep had already transitioned the row; the TTL monitor then deleted it before the click. That is the monitor's pass landing exactly in the window the spec leaves open, and it is the only mechanism that produces `404` here.

**Classification: a fixture/clock problem, not a product defect** — the same class as ADR-0146, ADR-0148 and ADR-0938. In production the deletion is correct: an invitation whose `expiresAt` has passed should not be readable, and the expiry job writes the expiry audit trail before the row can disappear. There is no eager cache refresh and no swallowed error: `invitation-expiry.ts` and `usage-threshold-check.ts` read no real clock at all (`grep` for `new Date()` / `Date.now()` returns nothing), so the injected clock is the only time source the jobs consult and nothing in them needs to change.

## Evidence

All commands ran in `/root/openpic/openpic-webapp/.worktrees/t_4b37e5de` with `TMPDIR=/root/tmp-mongo`; each single-file invocation boots its own `MongoMemoryReplSet` (`apps/web/src/test/integration/global-setup.ts`).

### Reproduction attempt before any change — 30 runs, 0 reds (recorded honestly)

`./node_modules/.bin/vitest run --project integration apps/web/src/test/integration/job-usage-and-invitations.test.ts`, 30 consecutive runs on the pre-change tree (`origin/main` `ff1cf74b`, spec byte-identical to the branch base):

```
baseline  30/30 green ("Tests 7 passed (7)"), 0 assertion failures
          runs at 06:07:00–06:09:47Z, ~5 s each
```

That is the expected result and it is not a contradiction. Each single-file run boots its own server and lives ~5 s, while the first TTL pass is ~t+60 s, so **no monitor pass can fire inside a single-file run**. CI runs one replset for the whole `integration` project (7–8 minutes), so every later file inherits a monitor that is already passing — the rate is not reproducible on demand; the mechanism is.

### Mechanism, measured — the fixtures are TTL-deleted with no test action

Throwaway probe (`cache/scratch/op136/probe.cjs`, outside the repo), its own `MongoMemoryReplSet`, the shipped `invitations_expire_at_ttl` index shape, four rows inserted at once: the two pre-change literal fixtures, the proposed anchored `NOW − 1d`, and a control `real + 23 h`. Rows were polled every 250 ms; **no test code ran**.

Default cadence (60 s), inserted `2026-11-23T06:10:53.826Z`:

```
DELETED  pre-change-past    expireAt 2026-11-16T09:00:00.000Z  at t+59 847 ms
DELETED  pre-change-future  expireAt 2026-11-18T09:00:00.000Z  at t+59 859 ms
SURVIVED anchored NOW−1d    expireAt 2026-11-24T09:00:00.000Z  (after 75 246 ms, 1 pass)
SURVIVED control real +23h  expireAt 2026-11-24T05:10:53.196Z  (after 75 246 ms, 1 pass)
```

Forced cadence (`--setParameter ttlMonitorSleepSecs=1`), inserted `2026-11-23T06:10:28.649Z`:

```
DELETED  pre-change-past    at t+765 ms
DELETED  pre-change-future  at t+765 ms
SURVIVED anchored NOW−1d    (after 20 195 ms, ~20 passes)
SURVIVED control real +23h  (after 20 195 ms, ~20 passes)
```

So both literal fixtures are deleted by the server alone, and the anchored shape survives the same passes.

### The pre-change file under a forced monitor cadence — authentic RED

`ttlMonitorSleepSecs = 1` set by a temporary line in `global-setup.ts` (reverted before commit — no committed file sets it; restored byte-identical and re-hashed against the base). 40 runs of the **pre-change** spec, same assertions:

```
runs 1–8, 10–40   green ("Tests 7 passed (7)")
run 9 (06:14:09)  RED  I7: moves a pending invitation past its deadline to expired…
                  AssertionError: expected 404 to be 410
pre-fix reds      1 / 40 runs (2.5 %), all I7
```

One authentic red is enough for the mechanism on this fixture set: `I7`'s window is one row wide (seed → sweep → accept, ~ms), so it needs a pass position that a 1 s cadence hits rarely — the same rate class ADR-0938 measured (2/60) on a wider window.

### After the change

```
post-fix, default cadence  30/30 green ("Tests 7 passed (7)"), 0 reds (06:18:42–06:21:12Z)
post-fix, forced 1 s       20/20 green (06:21:26–06:23:06Z) — the cadence that red the pre-change file
```

### Suites

- `vitest run --project unit`: 191 files, 3209 passed | 3 skipped, plus the `adr-source-references` guard, which reds until this ADR lands (it reported exactly the two dangling `0939` references this spec adds at `:61` and `:70`) and is green after;
- `vitest run --project integration`: full project, see §Verification;
- `tsc -p apps/web/tsconfig.json --noEmit`: clean;
- `eslint` and `prettier --check` on the changed spec: clean.

## Decision

**Anchor the file's single clock constant to the real UTC day, two days ahead, through the shared helper ADR-0148 introduced:**

```ts
import { fixtureInstant } from "../helpers/fixture-clock";
const NOW = new Date(fixtureInstant("09:00:00.000Z", 2));
```

- The anchor is read **once** at module load (`fixture-clock.ts`), so every derived instant is a pure function of one real-clock read: no drift inside a run, no new flakiness, no test-visible nondeterminism beyond the day itself.
- Two days ahead removes the exposure by construction. `NOW` is the real day + 2 at 09:00Z, so `NOW − 1 day` is the real day + 1 at 09:00Z — at least ~9 h in the real future for a run at any hour of the day, while still being one day **before** the injected `NOW`. The same offset puts `NOW + 1 day` and `NOW + 4 days` at +3 and +6 days, so all three fixture families are future-dated against the real clock and keep their position relative to the scenario clock.
- The scenario is unchanged: `I7` still seeds an invitation one day past its deadline, the "inside its window" case still seeds one a day in the future, the reminder case still seeds T+4 days with an 8-day-old `createdAt`, and the usage-threshold cases still key their counters on `periodKey("monthly", NOW)` and the pinned elapsed months `2026-10` / `2026-09`.
- **No assertion is weakened, added, removed or skipped, and no TTL index, retry, sleep or timeout is introduced.** The diff is one import, the constant, and its doc comment (`+15/−2`).

### Why two days, and not one

One day ahead would put `NOW − 1 day` at 09:00Z of the anchor day itself — already in the real past for any run after 09:00Z, i.e. the same bomb with a shorter fuse. Two days is the smallest whole-day offset that keeps every derived fixture at least ~9 h in the real future for every run of the day, and it is the offset ADR-0938 established, so the lane's two anchored specs now share one shape.

### Why not the alternatives

- **Drop `invitations_expire_at_ttl` in the throwaway database.** Rejected twice already (ADR-0146 §Decision, ADR-0148 §Decision): it removes a real production index from the topology the suite exercises, so a TTL-index regression would go unnoticed. Fix the fixtures, not the server.
- **Push the literal forward (e.g. `2027-11-17`).** Rejected: it re-arms the same bomb a year out, and the 2026-11-17 literal is that bomb already detonated (6.05 days past at the delivery run).
- **Retry, sleep, or a longer timeout.** Rejected by the card and by construction: no wait can make an asynchronous server-side delete not happen, and a retry would hide the next fixture of this class.
- **Weaken the pins (`I7`'s `410`, the `status: "pending"` read, `details.reminded`).** Rejected: the expiry sweep's terminal answer and the TTL-in-window behaviour are exactly what these three cases exist to pin.
- **Treat it as a production defect.** Rejected on the evidence: the jobs read only the injected clock, the sweep writes its audit trail before the row can vanish, and a row past `expiresAt` being unreadable is the contracted behaviour. No RED pin and no GREEN card is warranted.

## Consequences

- The exposure is removed at its cause for all three `invitations` fixtures of this file at **any** monitor cadence: their `expireAt` values are future-dated against the real clock by construction, so no pass can delete one between its seed and a read.
- The file's seven cases and their contracts are untouched; the six usage-threshold cases move with the same constant and read only relative offsets.
- One more member of ADR-0148's class is closed, and the worked shape for "a row that must look **expired** to an injected clock" now has two examples in this lane (`job-retention-purge`, `job-usage-and-invitations`): anchor the clock **ahead** of the real day and derive `expiry = clock − n days`.
- A future spec that pins `NOW ± n days` under a TTL'd field has a mechanical check available: if the literal anchor is not derived from the real day, every such fixture is a time bomb, whether the offset is negative **or positive**.

## Assumptions & open questions

- **The card carried no `Consumes:` reservation.** `docs/CONVENTIONS.md` §11 has the orchestrator reserve each ADR number in the card body; `t_3e4b1fac` fixes only the branch, the PR title, the worktree and the prettier binary. The number was therefore drawn from the lane's own ledger state after the sweep above (§ADR number), and it is flagged for the reviewer: if the allocator reserved a different number for this card, this record renumbers before merge and no other cell moves.
- **One red in 40 is the honest reproduction rate at 1 s**, and 0/30 at the production cadence. Both are recorded, not hidden: the mechanism is measured deterministically by probe, the rate is not reproducible on demand — exactly as ADR-0146 recorded for its own instance.
- **The anchor is relative by design.** Fixture dates are now runtime-derived; determinism is preserved because every instant is a pure function of one module-load read and no assertion compares a fixture against the real clock.
- **The two "live" fixtures were not in F1's text.** F1 routed only `seedExpiredInvitation`'s past `expireAt`. The measurement above shows `NOW + 1d` and `NOW + 4d` were equally past the real clock; they are covered by the same constant, so no scope was added — only the record of what the constant touches.
- **The month keys `2026-10` / `2026-09` stay literal.** They are elapsed _period keys_ compared against `periodKey("monthly", NOW)`, not `expireAt` values, and the anchor keeps the current period two months after them for any run in 2026-11. They are not part of the TTL class and were deliberately left alone.

## Out of scope

- No production code, schema, index, retention setting, mock, factory or helper is touched.
- Other specs that pin a literal past clock are not edited here. The known remaining members of the class in this lane were already routed by the ADR-0938 review: `job-sweep-drain.test.ts:171` and `job-sweep-failure-windows.test.ts:144` are card `t_27a1f957` (testcase-writer, `parents=[t_be5ae9d1, t_3e4b1fac]`), which this card releases by completing.
- No test was added, removed or skipped; the file stays at seven cases.

## Findings (routed)

- **F1 — the class generalises to positive offsets (Info).** The exposure rule ADR-0148 states ("persists a TTL'd row and re-reads it after an await") is offset-blind: `expireAt = NOW + n days` is just as fatal under a literal anchor once the real clock passes it. Recorded here; no card, because the lane's remaining members are already routed.
- **F2 — no product defect found.** The expiry sweep's audit-before-delete ordering, the uniform `404 not_found` for an unreadable invitation and the jobs' sole reliance on the injected clock are correct for the production race.

## Verification

At the change's head, on the branch, with `TMPDIR=/root/tmp-mongo`:

- the spec, default cadence: **30/30 runs green**, 7 cases each;
- the spec, forced 1 s monitor cadence: **20/20 runs green** (the cadence that red the pre-change file once in 40);
- `vitest run --project unit`: 191 files, 3210 passed | 3 skipped, `adr-source-references` green once this file and its index row exist (it red on exactly the two dangling `0939` references before they did);
- `vitest run --project integration`: 153 files, 1636 passed, exit 0;
- `tsc -p apps/web/tsconfig.json --noEmit`, `eslint` on the changed spec and `prettier --check` on the changed files: clean;
- the temporary `ttlMonitorSleepSecs=1` line is **not** in the diff: `global-setup.ts` was restored byte-identical (`cmp` against the pre-probe copy).
