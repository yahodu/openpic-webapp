# ADR-0854 — OP-136 TEST: the elapsed-period arms of `usage-threshold-check` are pinned

- **Status:** Accepted · **Date:** 2026-11-17
- **Card:** OP-136 TEST follow-up `t_4473eaf5` (Medium; branch
  `OP-136-task-usage-elapsed-period-pins`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_4473eaf5`, cut from `origin/main`
  `7d986972`). Routed by the review of `t_e568306c` (finding **F1**, Medium),
  whose parent GREEN is `t_d18a6e9e`.
- **Implements:** contract §10.2 (the `usage-threshold-check` row), §6.10 (raw
  `usageCounters` rows served "for support and reconciliation"); schema §14.2
  (the counter row's identity `{tenantId, entitlementKey, periodKey}`).
- **Consumes:** [ADR-0849](ADR-0849-op136-jobs-red.md) §3 (the latch is the
  `thresholdsNotified` on the row the run reads for **its own** period),
  [ADR-0850](ADR-0850-op136-jobs-green.md) (the shipped job and this job's one
  spec), [ADR-0851](ADR-0851-op136-usage-latch-scoped-to-period.md) §4 (the
  elapsed-row evidence there is a throwaway probe, not a committed pin).
- **Number allocation:** the lane row `OP-136 jobs lane` read `` `0852` `` on
  this base. The sweep immediately before minting found the two next numbers
  already in flight in this lane — `ADR-0852*` on open PR #631
  (`OP-136-task-indexed-check-matrix-latch-batch-pins`, worktree
  `.worktrees/t_7e31328b`) and `ADR-0853*` on open PR #629
  (`OP-136-task-sweep-failure-windows-pins`, worktree `.worktrees/t_535ab5d2`) —
  so this record takes `0854`, the first number above the highest consumed one,
  and advances **only** that cell to `` `0855` ``. The two
  `unallocated (future lanes)` cells stay `0869`. No number outside
  `0849`–`0868` is consumed.

## Context

`apps/web/src/test/integration/job-usage-and-invitations.test.ts` is the only
spec that drives `usage-threshold-check`
(`grep -rln 'usage-threshold-check' apps/web/src` → the job, its cron route and
this file). Its case "notifies the same threshold again in a new period" seeds
**two** `usageCounters` rows for `events.active` — `2026-10` at `value: 10`,
`thresholdsNotified: [80, 95, 100]`, then the current `periodKey("monthly", NOW)`
at `value: 9` — but asserts only the current month. Its own comment claimed
"the current period's row is warned, the previous one is not" while nothing
read the previous row.

The review of `t_e568306c` measured what that blindness costs, with two probes
on a throwaway worktree at `b04e8a7e`, each restricted to the production job and
restored afterwards (this spec was never edited):

1. **Delete the elapsed row** — `counters.deleteMany({ tenantId,
entitlementKey, periodKey: { $ne: row.periodKey } })` after the latch write,
   i.e. the exact "delete the elapsed row" satisfier ADR-0849 §3 / contract §6.10
   forbid as data loss dressed as a pass → the spec stayed **`6 passed (6)`**.
2. **Drop the elapsed-period guard** — `if (eventKey === undefined ||
verdict.periodKey !== row.periodKey)` → `if (eventKey === undefined)` → the
   spec stayed **`6 passed (6)`**: a job that processes every historical period
   row (over-notifying for an elapsed period whose latch is behind, and inflating
   `details.notified`) was invisible to the whole suite.

The control probe the review also ran (the latch write removed entirely) reddens
the I6 case as `AssertionError: expected undefined to deeply equal [ 80 ]`, so
the file's helper still bites and the missing pins were the only defect.

## Decision

Test-side only. One assertion added to the existing two-period case and one new
case; no production file, no existing assertion or seed relaxed, no `.only`, no
`.skip`, no loosened matcher.

### 1. The elapsed row is read where the case already claims it is untouched

After the current-month latch assertion:

```ts
// The elapsed row keeps its own latch verbatim: an elapsed period is not
// re-announced, and it is not deleted to make that true (ADR-0851 §3).
expect(await latch("events.active", "2026-10")).toEqual([80, 95, 100]);
```

`latch()` (ADR-0851) reads the row by its whole identity and returns
`row?.thresholdsNotified`, so the assertion fails both when the elapsed row is
**deleted** (`undefined`) and when its latch is **overwritten** (a different
array). Reading the latch rather than the raw document is what keeps the pin on
the §14.2 identity the job itself uses.

### 2. A case whose only live row is below the first threshold

```ts
it("leaves an elapsed period's row alone even when its own latch is behind", async () => { … });
```

Fixture arithmetic (the reviewer re-checks this, so it is stated): the plan's
`events.active` limit is `10`, so

- the elapsed `2026-09` row at `value: 9` is **90 %** — it crosses 80 and, with
  no `thresholdsNotified` at all, `usageThresholdsToNotify` answers `[80]`, so a
  job that reads every counter row emits and latches;
- the current `periodKey("monthly", NOW)` row at `value: 1` is **10 %** — below
  the first threshold, so the run legitimately has nothing live to warn about.

That asymmetry is the whole point: the elapsed row is the **only** row that
could produce a delivery, so `details.notified` isolates the guard.

### 3. What the new case asserts

```ts
expect(result.details?.notified).toBe(0);
expect(await thresholdEvents("usage.events.threshold")).toHaveLength(0);
expect(await latch("events.active", "2026-09")).toBeUndefined();
```

Three observables, one behaviour — the elapsed row is inert. `notified` is the
§10.2 field the card names; the outbox read is the delivery itself (the
dedupe-keyed row the sweep would write); and the latch read is the persisted
side effect, which is what separates "skipped" from "warned and latched". None
of the three can pass while the job processes a historical period row.

### 4. Why not extend the existing two-period case instead

The existing case's elapsed row is **fully latched** (`[80, 95, 100]`), so
removing the guard there changes nothing observable: the row is at 100 % and
every threshold is already latched, which is exactly why probe 2 stayed green
against the whole suite. Only a case whose elapsed row is **below its own latch**
can tell the guard from its absence, and mixing that into the "a new period
warns again" case would give one `it` two behaviours.

## Evidence

Measured in this worktree at `1f1b30a` (the pins commit) unless stated.

- Focused spec, on arrival and after every restore:
  `pnpm exec vitest run --project integration apps/web/src/test/integration/job-usage-and-invitations.test.ts`
  → **`7 passed (7)`** (6 pre-existing cases + the new one). Green on arrival is
  correct for a characterization pin.
- **Probe 1 (delete the elapsed row)** in a throwaway worktree at `1f1b30a`
  (detached, `node_modules` symlinked, removed afterwards) →
  `Tests 1 failed | 6 passed (7)`, failing exactly
  `notifies the same threshold again in a new period` with
  `AssertionError: expected undefined to deeply equal [ 80, 95, 100 ]`. The new
  case stayed green, as it must: no row notifies there, so the delete arm never
  runs.
- **Probe 2 (drop the elapsed-period guard)** in the same throwaway worktree →
  `Tests 1 failed | 6 passed (7)`, failing exactly
  `leaves an elapsed period's row alone even when its own latch is behind` with
  `AssertionError: expected 1 to be +0` (`details.notified`). The six
  pre-existing cases stayed green — the blindness this card closes.
- **Control probe (the latch write removed entirely)** → `Tests 2 failed | 5
passed (7)`: `I6` and the two-period case, both
  `AssertionError: expected undefined to deeply equal [ 80 ]`. The file's
  pre-existing pins still bite; the two new pins add the elapsed arms and do not
  replace anything.
- After each probe the job was restored with `git checkout --` and re-hashed:
  `sha256 apps/web/src/server/jobs/usage-threshold-check.ts` =
  `ce786ce6ce94d2232ab3e119f3a3f17b27ff0265e195c5297da757791fccf962` (the same
  hash as the untouched base), `git status --short` clean in the probe worktree.
  The card's worktree diff is the spec (and this record + the ledger note) only.
- `pnpm exec tsc -p apps/web/tsconfig.json --noEmit` → exit `0`
  ("TypeScript: No errors found").
- `prettier --check` on the spec → "All files formatted correctly".
- `pnpm exec vitest run --project unit apps/web/src/test/unit/adr-*.test.ts` →
  green after this record's number is minted.

## Alternatives

- **Assert the elapsed row's whole document** (`value`, `updatedAt`, …) —
  rejected: it pins a shape the job does not own, and `value`/`updatedAt` are
  the counter stage's business. The latch is the only field this job writes on
  that row.
- **Re-use the existing two-period case for the guard probe** — rejected: its
  elapsed row is fully latched, so the mutation is unobservable (§4).
- **Assert `details.skipped`** — rejected: `skipped` also counts a row whose
  limit is unlimited, so it would pass for the wrong reason and would freeze an
  accounting detail the contract does not pin.
- **Change the job to make the probe honest** (e.g. filter elapsed rows in the
  query) — rejected: this is a characterization pin; the shipped guard already
  behaves correctly and the card forbids production changes.
- **Leave the elapsed arm unpinned** (the status quo) — rejected: it is the
  finding, and the "delete the elapsed row" satisfier would look like a legal
  implementation.

## Out of scope

- `setCounterValue(entitlementKey, value)` in the same file still updates by
  `{tenantId, entitlementKey}` (ADR-0851 §5). No pinned behaviour depends on it
  and this card does not touch it.
- `docs/adr/README.md` carries no index rows for `0849`+ records other than
  `0849` itself; this record adds a note and advances the lane cell, and leaves
  the index-row repair to the ledger card `t_d44c4094` (review finding F6).
- Every other OP-136 sweep and its pins; ADR-0850 stays the record of what
  shipped, and ADR-0849/0850/0851 are frozen.

## Review sign-off (round 1, t_4473eaf5)

Reviewed at head `47d799dd` against base `origin/main` `02c53172`: the diff is
three files, +218/−1, and no production file — the spec, this record and the
ledger's lane note.

- **Verdict: APPROVED**, with no change requests. Landed as
  `gh pr merge 632 --squash --admin` → squash
  `d5830902bef1b377374ba884917435286c2900e7`, whose tree
  `a03486df58939cbada8fc46784888fdb3af483d3` equals the reviewed head's tree,
  so the trunk carries the reviewed bytes verbatim.
- CI at the reviewed head, **15/15 green**: the aggregate `ci`,
  `test_coverage`, `unit_test`, `lint`, `audit`, `audit-dev`, `secret-scan`,
  `env-changes`, `CodeQL`, `Analyze (actions)`,
  `Analyze (javascript-typescript)`, `validate-branch-name`,
  `validate-pr-title`, `Assert CI evidence for the pushed head` and
  `notify-discord`.
- The reviewer **re-measured all three mutations itself** in a detached
  throwaway worktree at `47d799dd`, restoring the job with `git checkout --`
  and re-hashing it to
  `ce786ce6ce94d2232ab3e119f3a3f17b27ff0265e195c5297da757791fccf962` (the
  untouched base) after every run:
  1. delete the elapsed row after the latch write → `1 failed | 6 passed (7)`,
     only `notifies the same threshold again in a new period`,
     `expected undefined to deeply equal [ 80, 95, 100 ]`;
  2. drop the `verdict.periodKey !== row.periodKey` guard →
     `1 failed | 6 passed (7)`, only the new case,
     `leaves an elapsed period's row alone even when its own latch is behind`,
     `expected 1 to be +0`;
  3. control, the latch write removed → `2 failed | 5 passed (7)`: `I6` and the
     two-period case, `expected undefined to deeply equal [ 80 ]`.
- Green at the reviewed head: the focused spec `7 passed (7)`;
  `pnpm exec tsc -p apps/web/tsconfig.json --noEmit` exit `0`;
  `pnpm exec prettier --check` clean on all three files; the six ADR guards
  `6 files / 236 passed (236)`.
- No `.only`, no `.skip`, no relaxed matcher, no fixture-shaped hardcoding and
  no production edit. The review wrote nothing but the merge.

### Finding — Info only

The `OP-136 jobs lane` `Next free` cell this branch advances to `0855` is a
snapshot of the ledger. The sibling GREEN card `t_16239628` holds an in-flight
`ADR-0855-<slug>.md` and moves the same cell to `0856`, so the `README.md`
union at that merge must keep the **higher** cell. No duplicate number existed
at merge time: `0854` here, `0852` on PR #631, `0853` on PR #629. No Critical,
High, Medium or Low finding; the index-row repair for the `0849`+ records stays
with `t_d44c4094`, as `## Out of scope` above records.
