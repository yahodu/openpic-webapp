# ADR-0833 — OP-135 GREEN: a superseded selfie's report keeps its hands off the active profile

- **Status:** Accepted (implementation record; the pin it turns green is
  [ADR-0832](ADR-0832-op135-superseded-selfie-profile-pin.md), carried forward unchanged)
- **Lane:** the OP-135 lane block `0829`–`0848` (row `OP-135 worker interface lane`), which this
  record draws its next free number from: the lane's own cell read `0833` at this base, no
  `.worktrees/*/docs/adr` carries an `ADR-0833*` file, `git rev-list --objects --all -- docs/adr`
  (with every open PR head fetched into `refs/remotes/pr/*`) returns `0832` as the highest number on
  any object (this lane's own pin), and the sixteen open PRs add none. So this record takes
  **`0833`** and advances the lane cell to `0834`; both `unallocated (future lanes)` cells stay at
  `0849`, and no range is re-cut.
- **Turns green:** [ADR-0832](ADR-0832-op135-superseded-selfie-profile-pin.md) §1–§4, finding
  **F1 (High)** of the review of the OP-135 GREEN (`t_4a280d94`).
- **Consumes:** [ADR-0829](ADR-0829-op135-internal-worker-endpoints-red.md) §4 (the report's
  answer shape and lease arm), [ADR-0830](ADR-0830-op135-internal-worker-endpoints-green.md) §4
  (the selfie arm's writes), contract §10.3.3 (the `lastMatchRunAt` watermark) and §6.4 (the poll
  that projects `status`/`matchCount`).

## Context

ADR-0832 writes the pin: `POST /api/v1/internal/worker/report`'s selfie arm writes `status`,
`matchCount` and `lastMatchRunAt` on `attendeeEventProfiles` keyed on `row.profileId` alone, so a
late `done` report for a selfie the attendee has since replaced stores its own `matchesCreated` and
its own `matchRunStartedAt` on a profile whose live result belongs to the newer row. The measured
effect is a `matchCount` that falls (7 → 0) and a watermark that rewinds ~2h50m — and §10.3.3 makes
that watermark the incremental search's lower bound, so the next run re-scores faces that are
already matched.

The route already reads the profile once per selfie item, for the `withdrawn` guard, with the
projection `{ status: 1 }`. Nothing in that read says which selfie the profile points at.

## Decision

### 1. The guard is one projection field and one id comparison

`report/route.ts`'s `ProfileStatusRow` gains `activeSelfieId?: ObjectId | null`, the existing read's
projection becomes `{ status: 1, activeSelfieId: 1 }`, and the same statement that returns the
profile sets a loop-local flag:

```ts
supersededSelfie = profile?.activeSelfieId != null && !profile.activeSelfieId.equals(row._id);
```

`row._id` is the row `findWorkItemById` returned for this item — already an `ObjectId`, so the
comparison is an **id** comparison (`.equals`), not a string rebuild of `item.id`, and a pointer at a
row that has since been purged is still superseded. `null`/absent `activeSelfieId` is **not**
superseded (ADR-0832 §4): such a profile has no live result to protect and this report is its first
one.

Chosen over the other option the card allowed (a second id-only cross-tenant read through
`findAttendeeProfilesByWorkItem`-style plumbing): the profile row is already read in the **same
pass**, one field later costs no read, and no new cross-tenant surface is opened. Residual window:
the pointer can move between this read and the profile write — that is the lease/two-write
non-transactionality of the same arm, finding **F4**, and it belongs to the hardening card later in
this chain, not here.

### 2. Only the profile projection is discarded; the item's own row and `applied` stay truthful

The item's `selfies` row is still written (`processing.*`, `quality.*`, `liveness.*`) and
`applied` still counts it: the work really was done for that item, the lease is this worker's, and
the row exists — so the answer is neither `leaseLost` nor `rejected`. ADR-0832 §2 pins exactly that
(`{applied: 1, leaseLost: 0, rejected: []}`), and it is what keeps a re-delivered report a no-op.

The profile write is the only thing skipped, and it is skipped as a whole: `status`, `matchCount`,
`lastMatchRunAt` and `updatedAt` all stay as the newer selfie's run left them (the pin asserts the
whole document is `toEqual(profileBefore)`). A `skipped` verdict is unchanged — it never wrote the
profile in the first place.

### 3. The discard is observable

The arm emits `worker.report_discarded` at **warn**, shaped like the adjacent `worker.lease_lost`:

```ts
getLogger().warn("worker.report_discarded", {
  event: "worker.report_discarded",
  kind: item.kind,
  id: item.id,
  workerId,
  reason: "superseded_selfie",
});
```

`kind`, `id` and `workerId` are the same three non-PII fields `worker.lease_lost` carries — no
profile id, no attendee subject, no match data. It is emitted only when a profile write was actually
withheld (non-`skipped`), so a re-delivered report logs once per pass rather than per item shape.

### 4. The pin is load-bearing — a probe that reverts only the guard

The guarded file was copied aside, the gate condition alone was replaced with `if (false) {` (the
projection and the flag computation left intact), and the lane spec was re-run:

```
 FAIL  |integration| … internal-worker-endpoints.test.ts > when the worker reports a selfie outcome >
       discards a superseded selfie's result: the active profile keeps its own count and watermark
AssertionError: expected { status: 'ready', …(2) } to deeply equal { Object (status, matchCount, ...) }

-   "lastMatchRunAt": 2026-09-25T12:00:00.000Z,
-   "matchCount": 7,
+   "lastMatchRunAt": 2026-09-25T09:10:00.000Z,
+   "matchCount": 0,
    "status": "ready",
```

`Tests  1 failed | 30 passed (31)`. The file was then restored from the copy and re-run green
(`31 passed (31)`).

## Consequences

- `apps/web/src/app/api/v1/internal/worker/report/route.ts` is the only production file touched
  (+18/−4): one import, one interface field, one projection field, one flag, one branch. No test,
  fixture, helper or mock was edited, and `findWorkItemById`'s projection is unchanged.
- The selfie arm is now pinned on four facts — the live result being visible (§6.4), a failure
  reaching `status: "failed"` (`I6`), a withdrawn profile's late result being rejected (`I8`), and a
  superseded report moving nothing (ADR-0832) — so the arm may be reorganised freely but cannot drop
  any of the four.
- `docs/adr/README.md` is the shared-ledger hotspot: this row, this note and the lane cell merge as
  a union keeping the higher cell (`0834`); the pool cells stay `0849`.
- The pin's draft PR #621 is **superseded** by this branch's PR and is left closed, not merged
  (OP-93/ADR-0306: a merged RED would leave `main` red).

## Not decided here

- **F4** — the concurrent double-report, the lease/transaction hardening of this arm, and the
  read-then-write window §1 names. **F3** (unbounded `items`) and **F5** (`events.counters`) too.
  All are sibling cards later in this chain.
- **What a discarded report does about face matches or domain events.** It creates none, so there is
  nothing to publish; publication is ADR-0808's subject, not this arm's.
