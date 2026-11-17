# ADR-0832 — OP-135 TEST: a superseded selfie's report never rewrites the active profile

- **Status:** Accepted (test-only pin; **RED on arrival at this head** — the GREEN card
  `t_c7b043ec` carries it forward in its own PR)
- **Lane:** the OP-135 lane block `0829`–`0848` (row `OP-135 worker interface lane`), which this
  record draws its next free number from: the lane's own cell read `0832` at this base, no
  `.worktrees/*/docs/adr` carries an `ADR-0832*` file, `git rev-list --objects --all -- docs/adr`
  returns `0831` as the highest number on any object (this lane's own last record), and no open PR
  head carries an `ADR-0832*` (the fifteen open PRs add `0282`/`0320`/`0324`/`0340`/`0360`…`0829`,
  none of them this lane's). So this record takes **`0832`** and advances the lane cell to `0833`;
  both `unallocated (future lanes)` cells stay at `0849`, and no range is re-cut.
- **Amends:** [ADR-0830](ADR-0830-op135-internal-worker-endpoints-green.md) §9 and
  [ADR-0829](ADR-0829-op135-internal-worker-endpoints-red.md) §1, which each record the
  superseded-selfie arm as **deliberately unpinned**. Neither text is edited: those records state
  what the GREEN shipped, and this one pins the behaviour it did not.
- **Consumes:** [ADR-0028](ADR-0028-internal-hmac-and-cron-framework.md) (the HMAC credential the case
  drives), [ADR-0829](ADR-0829-op135-internal-worker-endpoints-red.md) §4 (the report's answer
  shape and its lease arm), [ADR-0830](ADR-0830-op135-internal-worker-endpoints-green.md) §4 (the
  selfie arm's writes), contract §10.3.3 (the `lastMatchRunAt` watermark) and §6.4 (the poll that
  projects `status`/`matchCount`).

## Context

Finding **F1 (High)** of the review of the OP-135 GREEN (`t_4a280d94`, PR #616, squash-merged as
`a8856bc2`). `POST /api/v1/internal/worker/report`'s selfie arm writes `status`, `matchCount` and
`lastMatchRunAt` on `attendeeEventProfiles` keyed on `row.profileId` alone
(`apps/web/src/app/api/v1/internal/worker/report/route.ts:213-231`), and the profile read it makes
first projects `{ status: 1 }` only, so the route never learns which selfie the profile currently
points at. The item's own row carries no clue either: `findWorkItemById`
(`apps/web/src/server/repos/cross-tenant.ts:524`) projects `{tenantId, profileId, processing}`.

The consequence is the race ADR-0829 §1 and ADR-0830 §9 name. An attendee submits a selfie, the
worker claims it, the attendee submits a **newer** one, and the older report lands afterwards: its
`matchesCreated` (`0`) becomes the profile's `matchCount` and its `matchRunStartedAt` becomes the
profile's watermark. Measured in a throwaway probe worktree at `9e655d8b` (profile pointed at a
newer `activeSelfieId`, a `done` report for the old selfie):

```
before {"status":"ready","matchCount":7,"lastMatchRunAt":"2026-09-25T12:00:00.000Z"}
after  {"status":"ready","matchCount":0,"lastMatchRunAt":"2026-09-25T09:10:00.000Z"}
```

`matchCount` falls 7 → 0 and the watermark moves ~2h50m **backwards**. Contract §10.3.3 makes
`lastMatchRunAt` the pre-filter of the incremental vector search (`createdAt > lastMatchRunAt`,
`docs/API Contract.md:3378`), so the next `pipeline-sweep` step 4 re-scores faces that are already
matched (duplicate matches), and §6.4's poll shows an attendee a `matchCount` that silently dropped.

## Decision

### 1. One appended case pins the discarded arm on the rows, not on a helper

`apps/web/src/test/integration/internal-worker-endpoints.test.ts` gains exactly one case, in the
existing `describe("when the worker reports a selfie outcome")` block, driven as its siblings are
(imported handler, real `Request`, `signedPost(...)`):

1. `submittedSelfie(...)` (profile `processing`, no worker result yet), then `claimSelfie(...)` with
   `LEASEHOLDER` so the lease check passes for the _superseded_ row;
2. the profile is seeded into the superseded state — `activeSelfieId` a **different** `ObjectId`,
   `status: "ready"`, `matchCount: 7`, `lastMatchRunAt: 2026-09-25T12:00:00.000Z` — and the whole
   document is captured as `profileBefore`;
3. the report carries `{kind: "selfie", id, outcome: "done", matchesCreated: 0,
matchRunStartedAt: "2026-09-25T09:10:00.000Z"}` — the older run's instant;
4. three assertions: the answer, the profile's three live fields **and** the whole row
   (`toEqual(profileBefore)`), and the item's own row (`processing.status: "done"`,
   `processing.lastError: null`).

The window is **seeded, not raced**: it is a state (one superseded row plus one active pointer), not
a timing gap, so the case cannot flake and it fails for the reason it names.

### 2. The discarded arm keeps `applied: 1`

The card allowed either "still `{applied: 1, leaseLost: 0, rejected: []}`" or whatever the GREEN
settles on, and preferred the shape that keeps the report idempotent. The case pins the **first**:
the item is this worker's and its row exists, so it is neither `leaseLost` (the lease is held) nor
`rejected` (`rejected` is the answer for an id the route cannot act on — `unknown_item`,
`profile_withdrawn`); counting the discarded item `applied` is what makes re-delivering the report
answer the same thing every time. The **profile write** is the only thing discarded, and the case
asserts that separately. A GREEN that instead answers `rejected`/`leaseLost` for this arm would have
to change this case, which is why the choice is recorded here rather than left implicit.

### 3. The pin is load-bearing — three probes, each restored byte-identically

`apps/web/src/app/api/v1/internal/worker/report/route.ts` was restored to its trunk content after
every probe (`sha256 d53afcb0784fb17fae3bcde46b5be1ebc96fa2c406e82c7cdfb088b0719e97c3`, `git status`
clean for every file but the spec).

| probe                                                                                                                                                           | result                       | what it shows                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 — the trunk, no guard                                                                                                                                        | `1 failed \| 30 passed (31)` | the new case reddens for the named reason (`matchCount` 0 vs 7, watermark rewound), the 30 existing cases stay green                                                                                                                  |
| P2 — the guard the GREEN is expected to write: re-read the profile's `activeSelfieId` at the write site and skip the profile write when it names another selfie | `31 passed (31)`             | the pin is _satisfiable_ by the intended fix, and the fix breaks no sibling (including `I6`'s `status: "failed"` write, whose own confirmation stamps `activeSelfieId` to the reported row)                                           |
| P3 — P2 with the comparison inverted (`===` for `!==`)                                                                                                          | `3 failed \| 28 passed (31)` | the pin measures the **direction** of the comparison, not merely the presence of a guard: it reddens the new case and the two cases that must still write the profile (`makes a late result visible on the poll`, `I6`), nothing else |

P1's verbatim assertion output:

```
 FAIL  |integration| apps/web/src/test/integration/internal-worker-endpoints.test.ts > when the worker reports a selfie outcome > discards a superseded selfie's result: the active profile keeps its own count and watermark
AssertionError: expected { status: 'ready', …(2) } to deeply equal { Object (status, matchCount, ...) }

- Expected
+ Received

  {
-   "lastMatchRunAt": 2026-09-25T12:00:00.000Z,
-   "matchCount": 7,
+   "lastMatchRunAt": 2026-09-25T09:10:00.000Z,
+   "matchCount": 0,
    "status": "ready",
  }
```

### 4. What the GREEN owes

- The profile write is decided by the **profile's** `activeSelfieId` against the reported row's
  `_id`. Pointing the pointer at a row that no longer exists is a legitimate superseded state, so
  the rule is an **id comparison**, not an existence check on the newer selfie.
- Read at the **write site** (or before it in the same pass), not from a value captured before the
  selfie row's own update: F4 routes the lease/transaction hardening separately, and this pin must
  not be satisfied by a guard that a concurrent supersession can still slip past.
- A profile whose `activeSelfieId` is unset (`null`) is _not_ superseded — a profile that was never
  confirmed has no live result to protect, and the report is its first one.

## Consequences

- The lane spec is `31` cases: `30 passed` plus this one RED at this head, measured with
  `pnpm exec vitest run --project integration apps/web/src/test/integration/internal-worker-endpoints.test.ts`.
- `pnpm exec tsc -p apps/web/tsconfig.json --noEmit` exits `0` on this branch and the full `unit`
  project is unchanged (`183 files / 3001 passed / 3 skipped`), because the case adds no import and
  touches no helper.
- **The PR is a draft and must not be squash-merged.** This is the OP-93/ADR-0306 RED-by-design
  rule: the deliverable is a failing pin, and the GREEN card carries the case forward in its own PR
  unchanged. A merged RED would leave `main` red.
- The selfie arm is now pinned on **three** distinct facts — the live result being visible (§6.4),
  a failure reaching `status: "failed"` (`I6`), and a superseded report moving nothing — so a
  refactor may reorganise the arm freely but cannot drop any of the three.
- `docs/adr/README.md` is the shared-ledger hotspot: this row, this note and the `OP-135` cell merge
  as a union keeping the higher cell (`0833`); the pool cells stay `0849`.

## Alternatives

1. **Assert the attendee's §6.4 poll instead of the stored row.** Rejected: the poll is a projection
   of the same three fields, so it adds a reader (and its own `activeSelfieId` lookup) without adding
   an observable; the stored document is what both the poll and the incremental run read.
2. **Submit a real second selfie and let the confirmation stamp `activeSelfieId`.** Rejected: the
   extra submission drags attempt accounting and the confirmation transaction into a case about the
   report arm, and the confirmation's own state machine would then be able to redden this pin for a
   reason unrelated to the report. The superseded pointer is the whole precondition, so the case
   seeds it.
3. **Assert only `applied + leaseLost + rejected.length === 1`.** Rejected: it would accept a GREEN
   that answers `leaseLost: 1` for a lease it holds or `rejected` for a row that exists, which are
   the two wrong arms this contract already distinguishes (`I2`, `I8`).
4. **Compare `lastMatchRunAt` with a lower bound (`>=` the newer instant) instead of equality.**
   Rejected: a rewind is the defect, and a bound would accept the profile being moved _forward_ by a
   superseded run, which is the same wrong attribution with a smaller diff.
5. **Pin this on `findWorkItemById`'s projection instead** (assert the read returns
   `activeSelfieId`). Rejected: that is implementation, not behaviour — a GREEN that reads the
   profile at the write site instead satisfies the contract without touching the projection.

## Not pinned here

- **The lease/transaction hardening of the same arm (F4)** and the **unbounded `items` array (F3)**
  — sibling cards `t_1ef602ae` → `t_b4a1ee9c`.
- **`events.counters.processedImageCount` (F5)** — a product decision on `t_949d96c2`.
- **`signedPost`'s bearer defaulting to the signing secret (ADR-0830 §8.1's D1)** — still open, a
  one-line test-side fix owned by its own card, untouched here.
- **What the discarded report does about face matches or domain events.** The case asserts the
  profile and the item's own row only; a report that creates no matches has nothing to publish, and
  the publication path is ADR-0808's subject, not this arm's.
