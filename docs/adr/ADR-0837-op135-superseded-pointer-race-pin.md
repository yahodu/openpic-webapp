# ADR-0837 — OP-135 TEST: the profile pointer decides at write time, not at read

- **Status:** Accepted (RED by design; the pin fails on the trunk and the draft PR must not be
  squash-merged — OP-93/ADR-0306)
- **Lane:** the OP-135 lane block `0829`–`0848` (row `OP-135 worker interface lane`), whose `Next free`
  cell read **`0837`** at this base. The sweep immediately before minting found no `ADR-0837*` file in
  any `.worktrees/*/docs/adr`, and the highest record number on any open PR head was **`0835`** (this
  lane's own GREEN) plus `0849`–`0851` on the OP-136 lane's heads. So this record takes **`0837`** and
  advances **only** that cell to `0838`; both `unallocated (future lanes)` cells stay `0849` and no
  range is re-cut.
- **Consumes:** [ADR-0832](ADR-0832-op135-superseded-selfie-profile-pin.md) §1–§2 (the superseded
  state and the `{applied: 1}` answer), [ADR-0833](ADR-0833-op135-superseded-selfie-profile-guard-green.md)
  §1–§2 (the guard), [ADR-0834](ADR-0834-op135-internal-worker-boundary-pins.md) §4 (the F4a
  `findOne`-spy technique and the write-time lease), [ADR-0835](ADR-0835-op135-internal-worker-boundary-hardening-green.md)
  §3 (the lease rides the write filter), contract §6.4 (the poll the projection feeds), §10.3.2 (the
  report body) and §10.3.3 (the watermark).
- **Findings:** **F-A** (Low) of the OP-135 hardening review `t_b4a1ee9c`, routed on card
  `t_6c7cc100`.

## Context

ADR-0833's guard made a report for a **superseded** selfie stop rewriting the profile, and ADR-0836
pinned the four arms beside it. Both are decided from a profile read that happens **before** the
transaction that writes the profile:

- `report/route.ts` reads `attendeeEventProfiles` (`{status, activeSelfieId}`) for the
  `profile_withdrawn` and `supersededSelfie` guards;
- `withTransaction` opens later and writes the profile with the filter `{ _id: row.profileId }` —
  `activeSelfieId` is **not** a predicate of that write.

So the guard is read-then-write. A confirmation that flips `activeSelfieId` to a newer selfie between
that read and that write still passes the guard (the read answered `supersededSelfie === false`) and
its stale `matchCount` / `lastMatchRunAt` lands on the profile — ADR-0832's and ADR-0833's defect,
raced instead of sequential. F4a closed the same class for the **lease** (`processing.workerId` and
`processing.status` ride the write filter); the pointer half had no observer at all.

## Decision

One case is appended to `apps/web/src/test/integration/internal-worker-endpoints.test.ts`: the frozen
47 cases, every helper, fixture, mock and spec literal are untouched (`driverFindOne`,
`filterTargetId`, `profileRow()`, `selfieRow()`, `submittedSelfie()`, `claimSelfie()` and
`confirmSelfie()` are reused as they ship), and the diff is `+177/−0` in that one file.

### 1. The window is built the way the request experiences it

1. The world is seeded and the selfie is **confirmed** through the real route, so the profile's
   `activeSelfieId` names the very row the worker is about to report and the route's own read answers
   `supersededSelfie === false`. Then the row is claimed by `LEASEHOLDER` (§10.3.1), so the lease is
   not what the case measures.
2. A second, newer selfie row is inserted directly by the driver: same tenant, event, profile and
   subject as the reported row, `processing.status: "done"`, a later `createdAt`. It is the row a
   later submission leaves behind, and the row the pointer is flipped to. The report path never reads
   it, so its shape cannot influence the outcome.
3. `vi.spyOn(Collection.prototype, "findOne")` intercepts **only** the one read the guard makes
   (`collectionName === attendeeEventProfiles` and `_id === profileId`), takes the **real** read, then
   — before resolving — flips the profile with a direct driver write (`activeSelfieId` = the newer
   row, `status: "ready"`, the newer run's `matchCount` and `lastMatchRunAt`), reads the post-flip
   document back, and resolves the held read with the **pre-flip** snapshot. The route therefore
   decides on the old pointer and writes afterwards, exactly as a confirmation racing it produces.
4. The report is POSTed through the real signed `Request` (`signedPost`, `LEASEHOLDER`), and the spy
   is restored in a `finally`.

This is F4a's technique (ADR-0834 §4) applied to the pointer instead of the lease, so the pin needs no
clock seam, no delay and no production seam.

### 2. What the case asserts

- The profile document is **unchanged** by the report: `matchCount`, `lastMatchRunAt` and
  `activeSelfieId` are the newer confirmation's (`toEqual` on the explicit triple, plus `toEqual` on
  the whole post-flip document), so a stale `matchCount` and a rewound watermark both redden it.
  §10.3.3 makes the watermark the incremental search's lower bound (`createdAt > lastMatchRunAt`), so a
  rewind re-scores every already-matched face and §6.4's poll shows a count that fell.
- The answer stays `{applied: 1, leaseLost: 0, rejected: []}` — ADR-0832 §2: only the **profile**
  projection is discarded; the item's row was written and the lease was held, which is what keeps a
  re-delivered report a no-op.
- The reported item's own row still records the verdict (`processing.status: "done"`,
  `lastError: null`).

### 3. The case fails loudly if the window does not open

If no intercepted read happens, the case throws
`the route never read the profile, so the pinned window never opened` instead of passing quietly: a
green that way would mean the pin measures nothing. The held state is a typed holder
(`{opened, flipped}`), never a closure-narrowed `let`, so the guard is also live for a future route
that stops reading the profile.

### 4. Deliberately not pinned

- **The discard log on the raced arm.** ADR-0833 §2's `worker.report_discarded` warn is pinned for the
  sequential case (ADR-0836 §1). Requiring the same line when the guard loses the race would force one
  particular GREEN shape (detect the zero-match write and log) and forbid another (re-read the pointer
  inside the transaction and skip the write), so it is left to the GREEN to decide.
- **Which mechanism closes the window.** The pin is behavioural: the pointer as a write predicate
  (`activeSelfieId` in the filter), a re-read inside the transaction, or a conditional update all
  satisfy it. The case measures the observable, not the technique.
- **`updatedAt`.** It is covered as part of the whole-document equality, never asserted on its own.

## Consequences

- The pointer half of the read-then-write class is now measured. Removing the pointer from the write
  predicate reddens this case and nothing else; a GREEN that keeps the write unconditional cannot ship.
- The pin constrains a real design choice: a filter of `{_id, activeSelfieId: row._id}` is **not**
  enough, because ADR-0832 §4 says a `null` pointer is not superseded and P2 pins that the write
  happens. The satisfiability probe used `activeSelfieId: { $in: [null, row._id] }`, which keeps both
  green (§Evidence). The GREEN owes a predicate that admits `null`.
- This record introduces no production change. It is RED on arrival by construction, so the PR is a
  **draft** and must not be squash-merged; the GREEN chained behind it (`t_e69c0e41`) carries the case
  forward unchanged and closes the draft as superseded.
- The ledger row below is written in the table's existing shape. The card's `≤116 chars` instruction is
  **unsatisfiable** against this file — the neighbouring rows measure 1873–3253 characters and no guard
  checks row width (the same finding the review of `t_795ba842` routed as F4). Consistency with the
  ledger wins; flagged in the handoff.
- The host file is now 2401 lines / 48 cases with five more chain cards queued behind it: the
  decomposition decision already flagged by the review of `t_795ba842` is due.

## Alternatives

1. **Seed the superseded state instead of racing it.** Rejected: that is ADR-0832's case and it is
   green — a seeded pointer only proves the guard is **read**, never that it is **decided at write
   time**.
2. **Fake the clock or add a delay between the read and the write.** Rejected: `vi.setSystemTime`
   cannot interleave a request, and a sleep is a flake generator. The spy holds the read open
   deterministically.
3. **Spy on `withTransaction`** and flip the pointer inside the transaction callback. Rejected as
   coupling to an internal collaborator: the transaction module is application code, and the case would
   break under a legitimate refactor that inlines it. The driver prototype is the external boundary.
4. **Assert that no profile `updateOne` was issued** (spy on the write). Rejected: call counting is an
   implementation detail, and a GREEN that writes a conditional update legitimately issues one. The
   stored document is the observable.

## Evidence

Base `origin/main` `9db78584` (PR #627 merged; the guard is in the base — the read of
`{status, activeSelfieId}` and the `{ _id: row.profileId }` write filter both ship). Lane spec at the
delivered tree, unmodified route:

```
Test Files  1 failed (1)
     Tests  1 failed | 47 passed (48)
```

The one failure is the new case, at assertion level and for the reason the card names — the stale
report overwrote the newer watermark:

```
AssertionError: expected { …(3) } to deeply equal { …(3) }

  {
    "activeSelfieId": "6afc200a7dd9e46dbd147a41",
-   "lastMatchRunAt": 2026-09-25T12:00:00.000Z,
-   "matchCount": 7,
+   "lastMatchRunAt": 2026-09-25T09:30:00.000Z,
+   "matchCount": 2,
  }
```

The three assertions after it (whole-document equality, the `{applied: 1, leaseLost: 0, rejected: []}`
answer and the item's own `done` row) are not reached on the trunk, so they were proved green by the
satisfiability probe below.

Probes, each applied alone to the route in this worktree and reverted with `git checkout --`:

| Probe | Mutation of `report/route.ts`                                             | Result                                                                                                                                                                                                                             |
| ----- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —     | none (baseline: the trunk)                                                | `1 failed \| 47 passed (48)` — the new case, as quoted above.                                                                                                                                                                      |
| M1    | the profile write filter gains `activeSelfieId: row._id`                  | `1 failed \| 47 passed (48)` — the new case passes, `P2: writes the profile when it has no active selfie pointer` reds (`matchCount` 0 vs 4, `status` `processing` vs `ready`), so the pin does not weaken the `null`-pointer arm. |
| M2    | the profile write filter gains `activeSelfieId: { $in: [null, row._id] }` | `48 passed (48)` — the case is satisfiable, the whole-document equality included, and every frozen pin stays green.                                                                                                                |
| M3    | the guard's profile read replaced with `const profile = null` (no read)   | the new case throws `the route never read the profile, so the pinned window never opened` — the window guard is live, so a green cannot be reached without the held read.                                                          |

The route was restored byte-identically after every probe
(`sha256 80e14b9164ef97bb2829045001b0d767bda31d11d729630821a6dea01432a0e3` — the same hash ADR-0836's
evidence records for the trunk file). `git diff --stat` at this head is the one spec file, `+177/−0`.
Gates: `tsc -p apps/web/tsconfig.json --noEmit` exit `0`, `eslint` 0 issues, `prettier --check` clean.
