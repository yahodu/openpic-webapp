# ADR-0864 — OP-136 follow-up: pins for the sweep's enqueue warn (both call sites) and the per-run entitlement cache

- **Status:** Accepted (TEST) · **Date:** 2026-11-17
- **Card:** OP-136 follow-up (Low) `t_8bd36a07` (finding **F1** of the review of
  `t_bc01c854`; PR #663 squash-merged as `7b97a584`; branch
  `OP-136-task-sweep-observability-pins`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_bc01c854`, cut from `origin/main`
  `4a295db5`, the trunk that contains `7b97a584`).
- **Implements:** contract §10.2 (`pipeline-sweep`, `usage-threshold-check`),
  §18.1; schema §18.1/§18.2. Test-only: no production file is in the diff.
- **Consumes:** [ADR-0863](ADR-0863-op136-sweep-ack-grace-and-entitlement-cache.md)
  (the shipped behaviour both halves of this pin set characterize),
  [ADR-0849](ADR-0849-op136-jobs-red.md) §5,
  [ADR-0850](ADR-0850-op136-jobs-green.md) (the shipped jobs).
- **Consumers:** `apps/web/src/test/integration/job-sweep-observability-pins.test.ts`
  (the four pins), and the two modules they constrain,
  `apps/web/src/server/jobs/pipeline-sweep.ts` and
  `apps/web/src/server/jobs/usage-threshold-check.ts`.
- **Number allocation:** the `OP-136 jobs lane` row's `Next free` cell read
  `` `0864` `` at this head (`4a295db5`), and the sweep immediately before
  minting found no `ADR-0864*` file on the trunk, in any
  `.worktrees/*/docs/adr` tree, in `git rev-list --objects --all -- docs/adr`
  or on any of the twenty open PR heads (`0849`–`0863` are the highest records
  anywhere). This record takes `0864` and advances **only** that cell to
  `0865`; both `unallocated (future lanes)` cells stay `0869`. No number
  outside `0849`–`0868` is consumed. No frozen record is edited.

## Context

PR #663 made two correct changes and the suite saw neither. Measured by the
reviewer at the squash, then reproduced here with throwaway probes:

- **The warn.** `pipeline-sweep` forwards the run's `logger` to both
  `enqueueWork` calls — the shared `reenqueue` helper (steps 1 and 2) and the
  step-4 `match_incremental` call — so a broker refusal prints the §18.1
  `queue.enqueue_failed` warn that `enqueue-work.ts` writes through
  `options.logger?.warn`. Dropping `logger,` at **both** sites left
  `job-pipeline-sweep.test.ts` and `job-usage-and-invitations.test.ts` at
  `11 passed (11)`: nothing pinned the warn.
- **The cache.** `usage-threshold-check` resolves `checkEntitlement` once per
  `(tenantId, entitlementKey)` per run through `verdictFor`, instead of once per
  counter row (up to `limit` = 4000 rows hourly). Three `usageCounters` rows of
  one key read `COLLECTIONS.plans` **1** time with the cache and **3** times
  without it, while `job-usage-and-invitations.test.ts` stayed `7 passed (7)`
  either way: nothing pinned the collapse.

An unpinned correctness property is one refactor away from being removed
silently. This record adds the pins, and nothing else.

## Decision

### 1. One integration spec pins the observable, both ways

`apps/web/src/test/integration/job-sweep-observability-pins.test.ts` (new; the
two OP-136 specs, every fixture and every helper stay byte-identically
untouched) carries four characterization pins:

- **P1 — step 2 warns.** An `event_images` row `queued` at `now − 10 min` with
  `queueRef: null`, a broker whose `enqueue` rejects, and one run: exactly one
  `queue.enqueue_failed` entry at `warn` with `fields.kind === "event_image"`
  and `fields.queueKey === "q:image"`; the row still `queued` with
  `queueRef: null` (§18.1's durable state) and `details.requeued: 0`.
- **P2 — step 4 warns.** A `ready` profile with a non-null `activeSelfieId`,
  `lastMatchRunAt = now − 2 h` and an `imageFaces` row newer than that instant:
  exactly one `queue.enqueue_failed` with
  `fields.kind === "match_incremental"`, and `lastMatchRunAt` handed back to
  `now − 2 h` (the watermark rollback at `pipeline-sweep.ts:327-334`);
  `details.incremental: 0`.
- **P3 — the control.** P1's own seed on a healthy broker: no
  `queue.enqueue_failed` entry at all, **and** `details.requeued: 1` with one
  message in the outbox. The second half proves the seed really was a step-2
  candidate: a zero-warn arm over an ineligible seed would be vacuous.
- **P4 — the cache.** A monthly, tenant-scoped `events.active` plan, an active
  subscription, and three `usageCounters` rows of one key (two elapsed periods
  and the live one). The pin wraps `Collection.prototype.findOne` once, counts
  the calls whose `this.collectionName === COLLECTIONS.plans`, and asserts
  `reads === 1` with `scanned === 3` and `details.notified === 1`.

The broker is the memoised `getWorkQueue()` memory adapter: a case replaces its
`enqueue` with one that rejects and restores it in a `finally`
(`.finally(restore)`), so no case depends on the order they run in. P4 restores
the driver method in a `finally` as well.

### 2. Every pin is proven load-bearing by removing its subject

Probes on throwaway mutations of the two production modules, each restored
byte-identically afterwards:

| Mutation                                                              | Result                                                                                                           | Unpinned evidence                                                                           |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `logger,` dropped at **both** `enqueueWork` call sites                | `2 failed \| 2 passed (4)` — P1 and P2 read `expected [] to have a length of 1 but got +0`; P3 and P4 stay green | `job-pipeline-sweep.test.ts` and `job-usage-and-invitations.test.ts` still `11 passed (11)` |
| `checkEntitlement(...)` called directly per row (the pre-cache shape) | `1 failed \| 3 passed (4)` — P4 reads `expected 3 to be 1`                                                       | the other three pins stay green                                                             |

`pipeline-sweep.ts` (`sha256 c74f78c7…5dba089`) and
`usage-threshold-check.ts` (`sha256 b13124d8…c37445cd64`) hashed back to their
committed bytes, and `git status --porcelain` shows the new spec only.

## Evidence

- The four pins are **green on the first run** (`Tests 4 passed (4)`), as a
  characterization pin set must be; together with the two untouched OP-136
  specs: `Test Files 3 passed (3)` / `Tests 15 passed (15)`.
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` 0 issues on the
  new file; `prettier --check` clean on the new file, this record and
  `docs/adr/README.md`.
- The six `adr-*` guard specs: `Test Files 6 passed (6)` / `Tests 236 passed
(236)` — numbering, lane range, consumers, record links, inline code spans
  and source references included.
- Coverage: the new spec drives `pipeline-sweep.ts`'s two `enqueueWork` call
  sites (the `enqueued: false` branches) and `usage-threshold-check.ts`'s cache
  hit and miss arms, so both touched modules' branch coverage rises.

## Consequences and known limits

- **The warn is pinned at the call sites, not in `enqueue-work.ts`.** A future
  chain that passes a _different_ logger (a request-scoped one, say) keeps the
  pins green only if that logger still sees the refusal. That is the intent: the
  pin is "the run's own logger learns of the refusal".
- **P4 pins the read count, not the cache's implementation.** A future mechanism
  with the same effect (a per-run loader, a batched resolve) satisfies it; a
  cache that doubles the read does not.
- **P3 cannot by itself distinguish "never warns" from "never runs the step".**
  Its `details.requeued: 1` and outbox assertions are the guard against that,
  and they are why the control arm is not a one-line test.
- **Out of scope, unpinned:** the same blind `enqueueWork` in
  `apps/web/src/server/images/requeue.ts` (routed as its own card), and the
  volume of the warn under a persistent outage (bounded by the job's `limit`).
