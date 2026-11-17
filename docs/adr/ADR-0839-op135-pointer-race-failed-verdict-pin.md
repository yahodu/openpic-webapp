# ADR-0839 — OP-135 TEST: the failed arm of the profile-pointer window

- **Status:** Accepted (characterization pin — green on arrival against the landed GREEN
  `t_e69c0e41`/ADR-0838, so the PR is non-draft and merges)
- **Lane:** the OP-135 lane block `0829`–`0848` (row `OP-135 worker interface lane`), whose `Next free`
  cell read **`0839`** at this base (`062c7366`). The sweep immediately before minting found no
  `ADR-0839*` file in any `.worktrees/*/docs/adr`, `git rev-list --objects --all -- docs/adr`
  returning **`0855`** as the highest number on any object (the OP-136 lane), and none of the
  nineteen open PR heads carrying `0839`. So this record takes **`0839`** and advances **only** that
  cell to `0840`; the OP-136 cell stays `0855` and both `unallocated (future lanes)` cells stay
  `0869`. No range is re-cut.
- **Consumes:** [ADR-0837](ADR-0837-op135-superseded-pointer-race-pin.md) §1–§3 (the held-read window,
  its construction and its guard), [ADR-0838](ADR-0838-op135-superseded-pointer-write-filter-green.md)
  §1 (the predicate `{_id, activeSelfieId: {$in: [row._id, null]}}`, which sits **outside** the
  `done`/`failed` ternary — the fact this pin measures), [ADR-0832](ADR-0832-op135-superseded-selfie-profile-pin.md)
  §2 (the `{applied: 1}` answer) and §4 (a `null` pointer is not superseded),
  [ADR-0833](ADR-0833-op135-superseded-selfie-profile-guard-green.md) §2 (the sequential guard),
  [ADR-0836](ADR-0836-op135-superseded-selfie-arm-pins.md) §3 (P3, the **sequential** failed
  verdict), [ADR-0834](ADR-0834-op135-internal-worker-boundary-pins.md) §4 (the driver `findOne` spy),
  contract §6.4 (the poll the projection feeds), §10.3.2 (the report body) and §10.3.3 (the
  watermark).
- **Findings:** **F1** (Low) of the review of the pin card `t_6c7cc100` (PR #628, ADR-0837), routed on
  card `t_ff089c1c`.

## Context

ADR-0837 pinned the pointer race for one verdict only. Its case sends `outcome: "done"`, and the
measured failure is the stale report's `matchCount` and `lastMatchRunAt` landing on the newer selfie's
profile.

The report's profile projection serves **both** verdicts. The predicate ADR-0838 shipped sits on the
write filter, and the `$set` below it branches:

```
{ _id: row.profileId, activeSelfieId: { $in: [row._id, null] } }
  $set: decision.status === "done"
    ? { status: "ready", matchCount, lastMatchRunAt, updatedAt }
    : { status: "failed", updatedAt }
  if (published.matchedCount === 0) → warn worker.report_discarded
```

So the `failed` arm takes the identical write with a different `$set`, and loses the identical race
in an observably **worse** way: it does not move a count, it tells the newer selfie's profile that
its own result failed — the `status` §6.4 renders to the attendee. ADR-0836's P3 pins only the
**sequential** form of that defect (the pointer already names another selfie when the report starts);
nothing measured the raced form, where the pointer moves inside the window.

The reviewed evidence (re-measured here, not re-derived from the card text) is F-A's spec with only
the item body changed to a `failed` verdict at the pre-ADR-0838 trunk: `1 failed | 47 skipped (48)`,
`status: "ready"` → `"failed"` and `updatedAt` `2026-09-25T12:00:00.000Z` → the run instant.

## Decision

One case is appended **inside** ADR-0837's existing `describe` block in
`apps/web/src/test/integration/internal-worker-endpoints.test.ts`, so it shares the block's own
literals (`STALE_RUN_STARTED_AT`, `NEWER_RUN_STARTED_AT`, `NEWER_MATCH_COUNT`, `STALE_MATCH_COUNT`)
instead of restating them. The frozen 48 cases, every helper, fixture, mock and `PointerProfile` are
untouched (`driverFindOne`, `filterTargetId`, `profileRow()`, `selfieRow()`, `submittedSelfie()`,
`claimSelfie()`, `confirmSelfie()` and `signedPost()` are reused as they ship), and the diff is
`+161/−0` in that one file.

### 1. The window is built exactly as F-A builds it

The selfie is **confirmed** through the real route so the profile's `activeSelfieId` names the very
row the worker reports (a write that matched on `_id` alone would land), then claimed by
`LEASEHOLDER` (§10.3.1) so the lease is not what the case measures; a newer selfie row is inserted
directly by the driver; `vi.spyOn(Collection.prototype, "findOne")` intercepts **only** the
`attendeeEventProfiles` read for that `_id`, takes the real read, flips the pointer with its own
`status: "ready"`, `matchCount: 7` and `lastMatchRunAt`, reads the post-flip document back, and
resolves the held read with the **pre-flip** snapshot. Sharing the construction is deliberate: the
only difference between F-A and F-B must be the verdict, or the case would measure the window rather
than the arm.

### 2. What the case asserts

- The profile document is **unchanged** by the failed report: `status` is still `"ready"`, with the
  newer `activeSelfieId`, `matchCount` and `lastMatchRunAt` (`toEqual` on the explicit four-field
  projection, plus `toEqual` on the whole post-flip document, which is what carries `updatedAt`).
- The answer stays `{applied: 1, leaseLost: 0, rejected: []}` — ADR-0832 §2: only the **profile**
  projection is discarded, the item's row was written and the lease was held.
- The reported item's own row still records the verdict it was given:
  `processing.status: "failed"` with `processing.lastError.code: "face_detection_failed"`
  (`toMatchObject`, so the stored `message`/`at`/`retryable` stay the reducer's business).

### 3. The window guard is kept

If no intercepted read happens the case throws
`the route never read the profile, so the pinned window never opened`, and if the flip leaves no
document it throws `the pointer flip left no profile to compare against` — a green reached without
the held read would mean the pin measures nothing. The held state is a typed holder
(`{opened, flipped}`), not a closure-narrowed `let`, so `@typescript-eslint/no-unnecessary-condition`
stays quiet and the guard survives a route that stops reading the profile.

### 4. Deliberately not pinned

- **The discard log on the raced failed arm.** ADR-0838 emits one `worker.report_discarded` warn for
  `matchedCount === 0` whatever the verdict, and ADR-0836 §1 pins the line for the sequential case.
  Requiring it here would force one GREEN shape and forbid another, so the observable is the stored
  document, not the log line (ADR-0837 §4's reasoning, unchanged).
- **The `skipped` arm in the same window.** `decision.status !== "skipped"` means a `skipped` verdict
  writes no profile at all, so there is no window to lose; ADR-0836 §4 pins the sequential form.
- **`liveness_failed` inside the raced window.** It is the same arm with a different `error.code`
  (`TERMINAL_FAILURE_CODES` only removes the retry, and `retryable: false` already does), so a second
  case would duplicate the mechanism. Recorded here rather than pinned.
- **Which mechanism closes the window.** The pin is behavioural: the pointer as a write predicate, a
  re-read inside the transaction, or a conditional update all satisfy it (ADR-0837 §4).

## Consequences

- A **verdict-partial** fix is now caught. Moving the pointer out of the write filter and into the
  `done` branch of the `$set` leaves F-A green and reddens F-B alone (§Evidence, probe P1), which is
  exactly the shape a later refactor would drift into.
- The case is green on arrival because ADR-0838 shipped the correct shape: one predicate for both
  verdicts. This record introduces **no** production change, and unlike ADR-0837 the PR is
  **non-draft** and merges on its own — there is no GREEN sibling to carry the case forward.
- The host file is now 2561 lines / 49 cases. Three OP-135 chain cards and two reviews have already
  appended to it; the decomposition decision the earlier records flagged is due, not deferred again.
- `docs/adr/README.md` is the shared-ledger hotspot: this row, the lane cell and the note below merge
  as a union keeping the highest cells. The card's `≤116 chars` row rule stays **unsatisfiable**
  (neighbouring rows measure 1800–3300 characters and no guard checks width — the same finding the
  review of `t_795ba842` routed as F4); consistency with the ledger wins.

## Alternatives

1. **Pin the sequential failed verdict instead.** Rejected: ADR-0836 §3 (P3) already pins it, and it
   is green for the wrong reason — a read-time `supersededSelfie` flag satisfied it while the raced
   window stayed open.
2. **Extend ADR-0837's F-A case with an `it.each` over both verdicts.** Rejected: it edits a frozen
   case, and the two verdicts assert different profile fields (`status` is only meaningful on the
   `failed` arm).
3. **Assert that the profile `updateOne` matched nothing** (spy on the write result). Rejected: call
   counting is an implementation detail, and ADR-0838's fix legitimately issues an update that
   matches nothing (its recorded cost). The stored document is the observable.
4. **Compare only `updatedAt`.** Rejected: a fix that rewrote `status` but preserved `updatedAt` (or
   the reverse) would pass. Both halves are asserted, on two independent reads of the document.

## Evidence

Base: `origin/main` `062c7366`, cut at run time. The trunk carries ADR-0838's predicate
(`git grep -n 'activeSelfieId' origin/main -- apps/web/src/app/api/v1/internal/worker/report/route.ts`
→ line 242, `{ _id: row.profileId, activeSelfieId: { $in: [row._id, null] } }`), so this pin is
written against the fix, not before it.

Lane spec, before and after the append:

```
baseline  (48 cases):  Test Files  1 passed (1)   Tests  48 passed (48)
delivered (49 cases):  Test Files  1 passed (1)   Tests  49 passed (49)
```

Green on arrival, as the card requires. The case is not vacuous — four probes, each applied alone to
`report/route.ts` in this worktree, run with `-t "F-A|F-B"`, and reverted from a copy:

| Probe | Mutation of `report/route.ts`                                                                    | Result                                                                                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | the write filter becomes `decision.status === "done" ? {…pointer…} : { _id: row.profileId }`     | `1 failed` (**F-B only**, F-A green): `expected { …(4) } to deeply equal { …(4) }` — `"status": "ready"` → `"failed"`, `matchCount` 7 and `lastMatchRunAt` 12:00 untouched. A verdict-partial fix reds this pin and nothing else. |
| P2    | the pointer is removed from the write filter (`{ _id: row.profileId }`, the pre-ADR-0838 trunk)  | `2 failed` — F-A (`matchCount` 7 → 2, watermark 12:00 → 09:30) **and** F-B (`"status"` `"ready"` → `"failed"`).                                                                                                                   |
| P3    | the guard's own read retargeted at `COLLECTIONS.selfies` (so the intercepted read never happens) | `1 failed` — `Error: the route never read the profile, so the pinned window never opened`. The window guard is live.                                                                                                              |
| P4    | the `matchedCount === 0` path still stamps `updatedAt: now` (the live fields stay correct)       | `2 failed` at `expect(profileAfter).toEqual(beforeFlip)`, diff `- "updatedAt": 2026-09-25T12:00:00.000Z` → `+ "updatedAt": <run instant>`. The whole-document half is load-bearing, not decoration.                               |

The route was restored byte-identically after every probe
(`sha256 9e379612246b0bafc5327bc093986951cb9545407827141403b54787f2a27162` before and after — the same
hash ADR-0838 records). `git diff --numstat HEAD~1 HEAD` at this head is the one spec file, `+161/−0`; no
production file, no helper, no fixture and no mock is touched.

Gates: `tsc -p apps/web/tsconfig.json --noEmit` exit `0`, `eslint` 0 issues, `prettier --check` clean
on the spec, the ADR and `docs/adr/README.md`, the six `adr-*` guards green — `236 passed (236)`,
which is how the missing record was caught first (invariant (iv) reddens
`reports the repository's real source tree as reference-clean` the moment the spec cites `ADR-0839`),
full `unit` `184 files / 3077 passed | 3 skipped (3080)`.

Full `integration` is **`8 failed | 1428 passed (1436)`**, and all eight are the harness's 5 s
test-timeout class in five specs this change does not touch — `notification-quiet-hours-release`
(I5 ×2, 5020 ms and 5011 ms), `uploads-single-put` (I9 5159 ms, I5 3712 ms), `auth` I17 5011 ms,
`event-images-management` R1 5105 ms and `domain-events` I1/I2 5015 ms/5002 ms. Each of the five
specs is green when run on its own at this head (`58 passed (58)` for `domain-events` + `auth` +
`event-images-management`, `30 passed (30)` for `notification-quiet-hours-release` +
`uploads-single-put`), which is the same class the review of ADR-0838 measured at `2 failed |
1432 passed (1434)`. The total moved from `1434` to `1436` because this case adds one and the
OP-136 pins PR #632 added another. A test-only append to one spec cannot reach these files; the
lane spec itself is `49 passed (49)` in the same run.
