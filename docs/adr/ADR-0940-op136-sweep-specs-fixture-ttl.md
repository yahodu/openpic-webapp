# ADR-0940 — OP-136: anchor the `job-sweep-drain` and `job-sweep-failure-windows` fixture clocks (live TTL exposure)

- **Status:** Accepted · **Date:** 2026-11-23
- **Card:** `t_27a1f957` (OP-136 TEST, Medium — finding **F-R1** of the post-merge verification `t_be5ae9d1` of PR [#787](https://github.com/yahodu/openpic-webapp/pull/787) squash `2dfd2cf4`)
- **Branch:** `OP-136-task-anchor-sweep-fixture-clocks` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_4b37e5de`
- **ADR number:** `0940` — the OP-136 jobs lane's own block `0849`–`0868` is fully consumed, so the lane mints from the pool high-water, whose newest recorded state is the OP-136 delivery itself: [ADR-0938](ADR-0938-op136-retention-purge-i11-fixture-ttl.md) advanced **both** cells to `0939` and [ADR-0939](ADR-0939-op136-usage-invitations-fixture-ttl.md) advanced them to `0940`, which the delivery sweep confirms is the value both cells read on `origin/main` `16fc92df`. The sweep read `origin/main` `16fc92df` (highest record `ADR-0939`), every `.worktrees/*/docs/adr` tree (highest `0939`, in this lane's own `t_4b37e5de`; the next highest is `0918` in `t_7da4009d`), the five open PR heads (#794 → `0938`, #780 → `0918`, #755 → `0889`, #743 → `0881`, #272 → `0306`, each read from its own head tree), and `git rev-list --objects --all -- docs/adr`, whose highest resolved number is `0939`. Nothing holds `0940`, so this record takes it; the card bumps the lane cell and the `unallocated (future lanes)` cursor to `0941`. No cell is lowered and no range is re-cut.
- **Touches:** two integration specs (`job-sweep-drain.test.ts`: one import, the `NOW` constant with its doc comment and the now-false `§16.2` comment at the seed; `job-sweep-failure-windows.test.ts`: one import and the `NOW` constant with its doc comment), this ADR, its index row, two `Next free` cells of the reserved-range ledger and one ledger paragraph. **No production code, schema, index, retention setting, mock or factory.** No assertion, case name, seed shape, helper or timeout changes.

## Context

[ADR-0148](ADR-0148-integration-fixture-clock-anchor.md) fixed the class ADR-0146 diagnosed: a spec pins its injected clock to a **literal calendar date**, seeds a row of a **TTL-indexed** collection with `expireAt` derived from that literal, and mongod's TTL monitor then evaluates `expireAt` against the **real** wall clock. [ADR-0938](ADR-0938-op136-retention-purge-i11-fixture-ttl.md) and [ADR-0939](ADR-0939-op136-usage-invitations-fixture-ttl.md) closed two OP-136 jobs specs with the same one-constant fix and each recorded that the class is **offset-blind**: a `NOW + n days` fixture is as fatal as a `NOW − n days` one once the real clock passes it.

The review of `t_be5ae9d1` swept every integration spec and found **two more members of the class, already live** — not latent, not a year out:

| file                                                      | seed                                          | field                     | literal value              | against the real clock at the delivery run |
| --------------------------------------------------------- | --------------------------------------------- | ------------------------- | -------------------------- | ------------------------------------------ |
| `job-sweep-drain.test.ts` (`:171`, seed `:159`)           | `seedSession`'s `expireAt = NOW + 4d`         | `uploadSessions.expireAt` | `2026-11-21T09:00:00.000Z` | **1.908 days (45.8 h) in the past**        |
| `job-sweep-failure-windows.test.ts` (`:144`, seed `:132`) | `seedStaleInvitation`'s `expireAt = NOW + 4d` | `invitations.expireAt`    | `2026-11-21T09:00:00.000Z` | **1.908 days (45.8 h) in the past**        |

Both collections carry the shipped TTL index (`apps/web/src/server/db/indexes.ts`):

```
{ collection: "uploadSessions", name: "upload_sessions_expire_at_ttl",
  keys: [["expireAt", 1]], expireAfterSeconds: 0 }
{ collection: "invitations", name: "invitations_expire_at_ttl",
  keys: [["expireAt", 1]], expireAfterSeconds: 0 }
```

`job-sweep-drain.test.ts` carried the comment _"Inside the §16.2 five-day window, so the TTL monitor cannot race a case."_ — **false at the delivery run**: the literal `NOW` had aged past the real clock, so the row was born TTL-expired and any monitor pass could delete it between the seed and the read. The file then drives four sequential `uploadSessionSweepJob` runs whose assertions read that row back; `job-sweep-failure-windows` asserts on the seeded invitation in the reminder case.

Also in the same aging class and **not yet exposed**: `job-pipeline-sweep.test.ts:152` seeds `selfies.expireAt = NOW + 89d` = `2027-02-14T09:00:00.000Z`, **83 days ahead** of the real clock at this run. Recorded as an Info finding, not edited.

## Diagnosis

Both files pin one clock constant and derive every fixture from it:

```ts
const NOW = new Date("2026-11-17T09:00:00.000Z");
```

At this run's real clock (`2026-11-23T06:47:42.154Z`) the literal anchor is **5.908 days past**, so the `NOW + 4d` seed is 1.908 days past. mongod evaluates the TTL index against the real clock, not the spec's `fixedClock(NOW)`, and the monitor runs one pass per `ttlMonitorSleepSecs` (default 60) **from server start**, so in CI — one replset for the whole `integration` project — every later file inherits a monitor that is already passing. The row's deletion is not a race against the spec's own clock at all; it is a scheduled server-side delete of a row the case still needs.

The two local failure signatures were measured (see §Evidence) and both are the seed row being **gone** when the case reads it:

- `job-sweep-drain` — `run 1 announces the two sessions in its page: expected +0 to be 2`: the three TTL'd sessions were deleted before the first `uploadSessionSweepJob` run, so the job found an empty class and announced nothing;
- `job-sweep-failure-windows` — `the injection must fire exactly once: expected +0 to be 1` (deterministic mirror) and `the reminder must survive the failed write and must not double: expected [] to have a length of 1 but got +0` (authentic, 1/40 at a forced cadence): the invitation was deleted before the invite-expiry run, so the run had no row to remind and the injected outbox write never fired.

**Classification: a fixture/clock problem, not a product defect.** The same rows behave correctly in production: an `upload_sessions` row past its retention window and an invitation past `expiresAt` _should_ disappear. Neither job reads the real clock (`fixedClock(...)` is the only time source the cases pass in), so nothing in `apps/web/src/server` needs to change.

## Evidence

All commands ran in `/root/openpic/openpic-webapp/.worktrees/t_4b37e5de` with `TMPDIR=/root/tmp-mongo`; each single-file invocation boots its own `MongoMemoryReplSet` (`apps/web/src/test/integration/global-setup.ts`) and lives ~5 s.

### Before any change — the production cadence does not reproduce it, by construction

One run of each pre-change spec at the default 60 s cadence:

```
job-sweep-drain.test.ts           Tests 6 passed (6)    3.62 s (5 s wall)
job-sweep-failure-windows.test.ts Tests 7 passed (7)    3.75 s (5 s wall)
```

Each invocation boots its own server, so no monitor pass fires inside a 5 s file. The rate is not reproducible on demand; the mechanism is, and it was measured directly.

### Mechanism, measured — the seed rows are TTL-deleted with no test action

Throwaway probe (`apps/web/probe-ttl-op136b.cjs`, deleted before the commit): its own `MongoMemoryReplSet`, the two shipped index shapes by name, five rows inserted at once — the two pre-change literal seed shapes, their proposed anchored shapes, and a control `real + 23 h`. Polled every 200 ms; **no test code ran**.

Default cadence (60 s), inserted `2026-11-23T06:47:42.937Z`:

```
DELETED  drain-literal       (uploadSessions) at t+59 645 ms
DELETED  inv-literal         (invitations)   at t+59 647 ms
SURVIVED drain-anchored      (uploadSessions) after 75 101 ms
SURVIVED inv-anchored        (invitations)   after 75 101 ms
SURVIVED control-real+23h    (invitations)   after 75 101 ms
```

Forced cadence (`--setParameter ttlMonitorSleepSecs=1`), inserted `2026-11-23T06:49:07.222Z`:

```
DELETED  drain-literal       at t+632 ms
DELETED  inv-literal         at t+634 ms
SURVIVED drain-anchored      (after 20 044 ms)
SURVIVED inv-anchored        (after 20 044 ms)
SURVIVED control-real+23h    (after 20 044 ms)
```

So both seed shapes are deleted by the server alone, one monitor pass after the insert, and the anchored shapes survive the same passes.

### The pre-change specs under a forced monitor cadence — authentic counts

`ttlMonitorSleepSecs = 1` set by a temporary `instanceOpts` line in `global-setup.ts`, reverted before the commit (`git status` shows only the two specs; `global-setup.ts` is byte-identical to `origin/main`).

```
job-sweep-drain.test.ts           40 runs (06:49:57–06:53:09Z)   0 red / 40
job-sweep-failure-windows.test.ts 40 runs (06:53:50–06:57:06Z)   1 red / 40
  run 11 (06:54:36Z)  the invitation reminder survives a failed outbox write
                      AssertionError: the reminder must survive the failed write and must
                      not double: expected [] to have a length of 1 but got +0
```

One authentic red is the same rate class ADR-0938 (2/60) and ADR-0939 (1/40) measured: each case's seed→read window is milliseconds wide, so a 1 s cadence lands inside it rarely. `job-sweep-drain`'s own window is narrower still (its five seeded sessions share a ~100 ms block), so its 40 runs produced no authentic red.

### Deterministic mid-flight mirrors — the exact assertion each file reds

Because the authentic rate is low by construction, the exposure was also localised deterministically: a **temporary 2 500 ms delay** inserted after the seed (and only there) under the 1 s cadence, so a monitor pass necessarily lands inside the window. Reverted before the commit; no committed file widens a wait.

```
pre-change + mirror, 1 s cadence
  job-sweep-drain.test.ts             1 failed | 5 passed (6)
    > the next run reaches the session the first run left behind, …
      AssertionError: run 1 announces the two sessions in its page: expected +0 to be 2
  job-sweep-failure-windows.test.ts   1 failed | 6 passed (7)
    > the invitation reminder survives a failed outbox write
      AssertionError: the injection must fire exactly once: expected +0 to be 1

post-change + the same mirror, 1 s cadence
  job-sweep-drain.test.ts             6 passed (6)
  job-sweep-failure-windows.test.ts   7 passed (7)
```

That pair is the load-bearing proof: with the widened window held constant, the only difference between red and green is the anchored `NOW`.

## Decision

**Anchor each file's single clock constant to the real UTC day, two days ahead, through the shared helper ADR-0148 introduced:**

```ts
import { fixtureInstant } from "../helpers/fixture-clock";
const NOW = new Date(fixtureInstant("09:00:00.000Z", 2));
```

- The anchor is read **once** at module load (`fixture-clock.ts`), so every derived instant is a pure function of one real-clock read: no drift inside a run, no new flakiness, no test-visible nondeterminism beyond the day itself.
- Two days ahead removes the exposure by construction: `NOW + 4 days` lands on the real day + 6 at 09:00Z (6.09 days ahead at this run), and a `NOW − n days` fixture — none exists in these two files today, but the shape is the class's — would sit at real day + 1 at 09:00Z, at least ~9 h in the real future for a run at any hour.
- The scenarios are unchanged: `seedSession` still seeds a session last touched 2–4 days before the injected `NOW` with an `expireAt` four days after it, and `seedStaleInvitation` still seeds an invitation created four days before `NOW` and expiring four days after it, so the reminder is still the only write its case can drive.
- The now-false comment at the drain seed is corrected in place: it still states the §16.2 five-day window, and now states _why_ the row cannot be taken by the monitor.
- **No assertion is weakened, added, removed or skipped, and no TTL index, retry, sleep or timeout is introduced.** `git diff` touches no `it(`, `expect(`, `describe(` or seed-shape line (`+20/−3` and `+16/−2`, imports and doc comments included).

### Why two days, and not one

One day ahead would put a `NOW − 1 day` fixture at 09:00Z of the anchor day itself — already in the real past for any run after 09:00Z, i.e. the same bomb with a shorter fuse. Two days is the smallest whole-day offset that keeps every derived fixture ≥ ~9 h in the real future for every run of the day, and it is the offset ADR-0938 and ADR-0939 established, so the lane's four anchored jobs specs now share one shape.

### Why not the alternatives

- **Drop `upload_sessions_expire_at_ttl` / `invitations_expire_at_ttl` in the throwaway database.** Rejected three times already (ADR-0146, ADR-0148, ADR-0938 §Decision): it removes a real production index from the topology the suite exercises, so a TTL-index regression would go unnoticed. Fix the fixtures, not the server.
- **Push the literal forward (e.g. `2027-11-17`).** Rejected: it re-arms the same bomb a year out, and the 2026-11-17 literal is that bomb already detonated.
- **Retry, sleep, or a longer timeout.** Rejected by the card and by construction: no wait can make an asynchronous server-side delete not happen, and a retry would hide the next fixture of this class.
- **Weaken the pins (`detail(firstRun, "stalled") === 2`, the reminder's `toHaveLength(1)`).** Rejected: the drain's page budget and the reminder's exactly-once delivery are exactly what those cases exist to pin.
- **Treat it as a production defect.** Rejected on the evidence: both jobs take their time from the injected clock only, and a row past its retention window or `expiresAt` being deleted is the contracted behaviour. No RED pin and no GREEN card is warranted.

## Consequences

- The exposure is removed at its cause for both files at **any** monitor cadence: their `expireAt` values are future-dated against the real clock by construction, so no pass can delete one between its seed and a read.
- Both files keep their six and seven cases, their seeds, helpers, timeouts and assertions byte-identically; only the anchor moves.
- Four OP-136 jobs specs (`job-retention-purge`, `job-usage-and-invitations`, `job-sweep-drain`, `job-sweep-failure-windows`) now share one anchored shape; a new jobs spec that pins a literal `NOW` is the remaining way to re-introduce the class.
- The class's mechanical check stays what ADR-0939 stated: if the literal anchor is not derived from the real day, **every** fixture derived from it is a time bomb, whatever the sign of its offset.

## Assumptions & open questions

- **The card carried no `Consumes:` reservation.** `docs/CONVENTIONS.md` §11 has the orchestrator reserve each ADR number in the card body; `t_27a1f957` fixes only the branch, the PR title, the worktree and the prettier binary. The number was therefore drawn from the lane's own ledger state after the sweep above (§ADR number), and it is flagged for the reviewer: if the allocator reserved a different number for this card, this record renumbers before merge and no other cell moves.
- **Both files were anchored by one constant each, not one per fixture family.** Each file pins exactly one clock, and every fixture is derived from it, so one constant is the whole fix; a second constant would be a second source of truth.
- **The authentic rate is recorded as measured, not as hoped.** `job-sweep-drain` produced 0/40 authentic reds at a forced 1 s cadence; the exposure there is proved by the probe (both cadences) and by the deterministic mirror, not by a lucky run.
- **No `NOW − n days` TTL'd seed exists in either file today.** The `~9 h` property of the two-day anchor is stated for the class, not for these two files, whose only TTL'd seeds use positive offsets.

## Out of scope

- No production code, schema, index, retention setting, mock, factory or helper is touched.
- `job-pipeline-sweep.test.ts` is **not** edited: its `selfies.expireAt = NOW + 89d` sits 83 days ahead of the real clock at this run, so it is not exposed. It stays recorded as an Info finding below.
- No test was added, removed or skipped; the files stay at six and seven cases.

## Findings (routed / recorded)

- **F-R1 — closed by this record.** The two live members of the class the ADR-0938 review routed (Medium).
- **F1 — `job-pipeline-sweep.test.ts:152` (Info, no card).** `selfies.expireAt = NOW + 89d` = `2027-02-14T09:00:00.000Z`, **83 days ahead** of the real clock at this run, so the monitor cannot take it. It arms on ~2027-02-14 and is the same class; it is deliberately not edited here.
- **F2 — no product defect found.** Both sweeps read only the injected clock and the deletions are correct in production.
- **F3 — the false comment class (Info, no card).** The drain seed's "so the TTL monitor cannot race a case" was true only while the literal held; a comment that asserts a clock property is a claim that ages. Corrected here; the other three anchored specs carry doc comments that name the helper instead.

## Verification

At the change's head, on the branch, with `TMPDIR=/root/tmp-mongo`:

- the two specs, default 60 s cadence: **30/30 runs green each**, 6 and 7 cases per run;
- the two specs, forced 1 s monitor cadence: **20/20 runs green each** (the cadence that red `job-sweep-failure-windows` once in 40 before the change);
- the deterministic mirror (2 500 ms after the seed) at 1 s: red on the pre-change tree at the two assertions quoted above, green with the anchor;
- `vitest run --project unit`: **191 files / 3210 passed | 3 skipped (3213)**, including the seven `adr-*` guards (green only once this record and the ledger row exist);
- `vitest run --project integration`: **153 files / 1636 passed (1636)**, exit `0`;
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` on both specs `0 errors` (one pre-existing `security/detect-object-injection` warning at `job-sweep-drain.test.ts:275`, present on `origin/main` at the same helper);
- `prettier --check` clean on both specs and on this record;
- the temporary `ttlMonitorSleepSecs=1` line and both mirror delays are **not** in the diff; `global-setup.ts` was restored byte-identically (`git status` shows the two specs, this record and the ledger only).
