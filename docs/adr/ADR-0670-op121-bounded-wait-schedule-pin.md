# ADR-0670 — OP-121 TEST: the bounded wait's schedule is pinned — 41 polls, the last check at the `1 000 ms` ceiling

- **Status:** Accepted (characterization pin — green on arrival, no GREEN sibling)
- **Consumers:**
  `apps/web/src/test/unit/retry-wait.test.ts` — the whole new spec: the
  constants case, the two never-settled cases (`takes 41 reads, the last one at
the ceiling`, `answers false inside the ceiling and leaves no poll timer
pending`), the settle-on-the-41st-poll case and the already-settled case.
- **Lane:** the **OP-120 invitations lane** block `0660`–`0679`, the block the
  OP-121 records and pins draw from
  ([ADR-0664](ADR-0664-op121-invitation-decisions-green.md),
  [ADR-0665](ADR-0665-op121-invitation-decisions-red.md),
  [ADR-0666](ADR-0666-op121-invitation-accept-race-pin.md),
  [ADR-0667](ADR-0667-op121-invitation-accept-settled-reread.md),
  [ADR-0668](ADR-0668-op121-accept-expiry-arm-pin.md),
  [ADR-0669](ADR-0669-op121-bounded-wait-extracted.md)). At this head the lane's
  `Next free` cell read **`0670`**, so this record draws **`0670`** and the cell
  advances to `0671`. Both `unallocated (future lanes)` cells stay at `0829`:
  the lane still holds a reserved range, so nothing is drawn from the pool
  ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §2). The sweep
  behind that reading is in §Verification.
- **Relates to:** [ADR-0669](ADR-0669-op121-bounded-wait-extracted.md) — the
  behaviour-preserving refactor whose exact ceiling this spec pins, and the
  record whose §Consequences' "the documented ceiling is the measured one" is
  the claim under test. [ADR-0668](ADR-0668-op121-accept-expiry-arm-pin.md)
  pins the wait's **expiry arm** on the integration spec; this pin is the
  schedule underneath it. No accepted record is edited.
- **Satisfies:** review finding **F-1 (Low)** of `t_b4750d70` (OP-121 refactor,
  PR #611, squash `da0310f` on `main`) — "the exact-ceiling property is
  unpinned" — which is card `t_ad71f8b2`.
- **Consumes:** `0670`.
- **Schema:** n/a · **Contract:** §2.3 (a decision is final and idempotent) and
  §0.7 (an already-terminal transition is success) — both unchanged; this
  record pins an implementation schedule, not a contract clause.

## Context

[ADR-0669](ADR-0669-op121-bounded-wait-extracted.md) made the bounded wait one
module — `@/server/db/retry-wait` — and deleted the trailing `sleep`, so the
last check lands **at** `RIVAL_COMMIT_TIMEOUT_MS` (`1 000 ms`) instead of one
interval past it. The property it created is real and measured:

- a read that never settles → `{settled: false, reads: 41, elapsedMs: 1 011}`;
- a read that settles on its 41st poll → `{settled: true, reads: 41, elapsedMs: 1 010}`;
- a read that settles immediately → `{reads: 1, elapsedMs: 0}`.

Nothing measured it, though. The two integration call sites that reach the
helper (`E1`, `I5`, `R2`) pin its **arms** (`true` / `false`) and not its
**schedule**, and `grep -rn 'retry-wait|waitForCommitted|RIVAL_COMMIT'
--include=*.test.ts apps/web/src` returned no hits: no spec named the helper.
The mutation evidence is what made this a finding rather than an observation —
re-inserting the trailing `sleep` (the pre-refactor loop) leaves the focused
integration spec
`apps/web/src/test/integration/event-invitation-decisions.test.ts` **fully green
at 51 passed (51)** while the wait climbs from `1 011 ms` to `1 034 ms`. The F3
fix could therefore be reverted with no test blinking, and ADR-0669's documented
bound would silently become false.

The schedule is testable in the `unit` project because the helper touches no
database: it takes `read` and `isSettled` as arguments, so a spec can hand it a
fake reader and drive its sleeps with fake timers.

## Decision

1. **One new unit spec, and no existing file is touched.**
   `apps/web/src/test/unit/retry-wait.test.ts` is a new file against
   `@/server/db/retry-wait`; the integration pin, every helper, fixture and mock
   are unedited, and the production module is unchanged (the branch's diff is
   the spec, this record and the two ledger edits).
2. **The schedule is driven by fake timers, never by the wall clock.** The spec
   installs `vi.useFakeTimers()`, starts the promise, advances the clock with
   `await vi.advanceTimersByTimeAsync(...)` and restores real timers in
   `afterEach`. The assertions are the **read count** and the **resolution
   inside the ceiling**, never elapsed milliseconds, so the pin cannot flake on
   host load and cannot be satisfied by a loop that merely answers quickly
   enough. This mirrors the repo's existing precedent for a polling helper,
   `apps/web/src/test/helpers/poll-ready.test.ts`.
3. **The discriminating assertion is the resolution at the ceiling.** After
   advancing exactly `RIVAL_COMMIT_TIMEOUT_MS` with a read that never settles,
   the spec requires **no pending poll timer** (`vi.getTimerCount()` is `0`) and
   the promise already carrying `false`. Under the old trailing-sleep loop a
   41st timer is still pending at `1 000 ms` and the await cannot settle, so
   this half is what separates the shipped loop from the pre-refactor one; the
   read-count half alone would not (both loops take 41 reads).
4. **The constants are pinned where they are exported.** One case asserts
   `RIVAL_COMMIT_TIMEOUT_MS === 1_000`, `RIVAL_COMMIT_POLL_MS === 25` and
   `RIVAL_COMMIT_TIMEOUT_MS / RIVAL_COMMIT_POLL_MS + 1 === 41`, and the expected
   read count is derived from the two constants rather than typed out. A change
   to either constant therefore reddens the constants case instead of silently
   re-scaling the schedule the other cases assert.
5. **It is a pin, not a repair.** The behaviour ships at `da0310f`, so the spec
   is green on its first run; no GREEN sibling is created and the PR is a normal
   non-draft test PR.

## Consequences

- **The exact ceiling is now enforced by a test.** Two mutation probes against
  the merged module, each reverted afterwards:
  - re-inserting the trailing `sleep` (the pre-refactor loop) reddens
    `answers false inside the ceiling and leaves no poll timer pending` with
    `AssertionError: expected 1 to be +0` in `6 ms` — the 41st sleep is the
    timer left pending at the ceiling;
  - tightening the loop bound from `waited <= RIVAL_COMMIT_TIMEOUT_MS` to
    `waited < RIVAL_COMMIT_TIMEOUT_MS` (a 40-read schedule) reddens both
    `takes 41 reads, the last one at the ceiling` and `returns true from the
41st read, without waiting past the ceiling` with `AssertionError: expected
"vi.fn()" to be called 41 times, but got 40 times`.
    The production file was restored byte-identically after each probe
    (`sha256 352a0dd40cbe5820f632e3d77ce270ed6429c8c676d3a8fb1aa08188680da633`),
    and the spec is green again on the restored module.
- **The pin is clock-free and cheap.** Six cases, about `0.3 s`, no Mongo, no
  network: the `unit` project rather than `integration`, so the property is
  checked on every unit run rather than only where a replica set is available.
- **What it does not pin.** The wall-clock latency (a faked clock has no read
  cost, so the `1 009`/`1 011 ms` measurements of ADR-0669 stay observations,
  not assertions); the **linear** choice over a backoff (ADR-0669 §Decision 3
  argues it, and a backoff would keep the same read count only by accident);
  whether the two call sites still delegate to this helper (that is `E1`, `I5`
  and `R2`'s job, and the module is their only definition); and the constant's
  export surface, which is [ADR-0669](ADR-0669-op121-bounded-wait-extracted.md)
  §Decision 1's business.
- **A change to the constants is a deliberate red, not a refactor.** Because the
  expected read count is derived from them, widening the ceiling or narrowing
  the poll keeps the cases arithmetically consistent only if the constants case
  is updated with it — which is the point: the `41` in ADR-0669
  §Consequences is a documented cost, so re-scaling it must be a decision
  someone records.

## Verification

- **The pin is green on arrival:** `npx vitest run --project unit
apps/web/src/test/unit/retry-wait.test.ts` → `1 passed (1)`, `6 passed (6)`,
  `~0.3 s`.
- **Mutation probe 1 (trailing sleep restored):** `1 failed | 5 passed (6)`,
  `AssertionError: expected 1 to be +0` at the `vi.getTimerCount()` assertion,
  `6 ms`.
- **Mutation probe 2 (`waited <=` → `waited <`):** `2 failed | 4 passed (6)`,
  `AssertionError: expected "vi.fn()" to be called 41 times, but got 40 times`
  in both 41-read cases.
- **Production file untouched:** `sha256 352a0dd4…da633` before and after every
  probe; `git status` shows the new spec only (plus this record and the ledger).
- **Suites:** full `unit` **181 files / 2 987 passed | 3 skipped (2 990)**. The
  baseline at `da0310f` was `179 files / 2 965 passed | 3 skipped`; the delta is
  this spec plus the OP-134 pin spec that landed on `main` as `3d06438b`. The
  full `integration` project is not touched by this card and is not run.
- **Static gates:** `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; ESLint
  and `prettier --check` clean on the new spec; the five `adr-*` guard files
  **5 files / 218 passed (218)** — `adr-consumers` is the one that bites here: a
  source file may cite only a record that declares it under `Consumers:`, so the
  spec cites this record rather than the frozen
  [ADR-0669](ADR-0669-op121-bounded-wait-extracted.md), which is not edited.
- **Number sweep for `0670`:** the lane cell read `0670` on `origin/main`
  `3d06438b`; `git rev-list --objects --all -- docs/adr` carries no
  `ADR-0670`–`ADR-0679` name on any ref; no `.worktrees/*/docs/adr` carries one;
  and all fifteen open PR heads (`#613`, `#575`, `#573`, `#570`, `#545`, `#539`,
  `#373`, `#369`, `#361`, `#336`, `#279`, `#278`, `#276`, `#272`, `#270`) carry
  none. `0667`, `0668` and `0669` are not taken again.

## Alternatives

- **Assert elapsed milliseconds with real timers.** Rejected: it makes the pin
  a tolerance test, so a loaded CI host reddens it for the wrong reason and a
  1 034 ms mutant can slip under a generous bound. The read count and the
  pending-timer count are exact facts.
- **Pin the schedule through `E1` on the integration spec.** Rejected: that spec
  is a frozen pin this card may not edit, and it would need a Mongo replica set
  to prove a property of a pure loop — the most expensive possible home for it.
- **Assert the loop's shape by reading the source.** Rejected: a source-text
  assertion breaks on a legitimate refactor that preserves the schedule and
  passes on a rewrite that breaks it.
- **Pin only the read count.** Rejected: both loops take 41 reads, so the count
  alone leaves the F3 regression green — the resolution-inside-the-ceiling
  assertion is the finding.
