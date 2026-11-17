# ADR-0838 — OP-135 GREEN: the profile pointer rides the selfie arm's write filter

- **Status:** Accepted (GREEN; carries ADR-0837's pin forward unchanged)
- **Lane:** the OP-135 lane block `0829`–`0848` (row `OP-135 worker interface lane`), whose `Next free`
  cell read **`0838`** at this branch head (the pin's ADR-0837 advanced it from `0837`). The sweep
  immediately before minting found no `ADR-0838*` file in any `.worktrees/*/docs/adr`
  (`t_ca95e452`, `t_ff089c1c`, `t_535ab5d2`, `t_7e31328b`, `t_b25b384f`), `git rev-list --objects
--all -- docs/adr` returns `0837` as the highest number in this lane (`0849`–`0851` belong to the
  OP-136 range), and no open PR head carries `0838`. So this record takes **`0838`** and advances
  **only** that cell to `0839`; the OP-136 row (`0849`–`0868`, `0852`) and the `unallocated` cell
  (`0869`) are untouched.
- **Carries:** [ADR-0837](ADR-0837-op135-superseded-pointer-race-pin.md) — its case ships in this PR
  byte-for-byte as the pin landed it; the pin's draft PR #628 is closed as superseded.
- **Consumes:** [ADR-0832](ADR-0832-op135-superseded-selfie-profile-pin.md) §1–§2 and §4 (the
  superseded state, the `{applied: 1}` answer, and `null` as "not superseded"),
  [ADR-0833](ADR-0833-op135-superseded-selfie-profile-guard-green.md) §1–§2 (the guard and its warn),
  [ADR-0835](ADR-0835-op135-internal-worker-boundary-hardening-green.md) §3 (the lease riding the
  write filter — the shape this record copies), contract §6.4 (the poll the projection feeds),
  §10.3.2 (the report body) and §10.3.3 (the watermark).
- **Findings:** **F-A** (Low) of the OP-135 hardening review `t_b4a1ee9c`, routed on card
  `t_e69c0e41`.

## Context

ADR-0837 pinned the last read-then-write window in the report's selfie arm: the `supersededSelfie`
flag was decided from a profile read taken **before** `withTransaction`, while the profile write
inside the transaction filtered on `{ _id: row.profileId }` alone. A confirmation that flipped
`activeSelfieId` to a newer selfie inside that window let a superseded report's `matchCount` and
`lastMatchRunAt` land, rewinding §10.3.3's watermark (the incremental search's lower bound) and
showing a count that fell in §6.4's poll.

The card offered two shapes: the pointer as a write predicate, or a re-read of the profile inside the
transaction. F4a had already closed the **lease** half of the same class the first way (ADR-0835 §3:
`{_id, "processing.workerId", "processing.status"}` in the filter, branch on `matchedCount`), so the
predicate is the codebase's existing answer to this question.

## Decision

### 1. The pointer is a predicate of the write

The selfie arm's profile write takes the filter
`{ _id: row.profileId, activeSelfieId: { $in: [row._id, null] } }`, and the arm branches on
`matchedCount`: `0` ⇒ the profile now belongs to another selfie, so the write is discarded and one
`worker.report_discarded` warn is emitted with `reason: "superseded_selfie"`. The item still counts
`applied: 1` — only the profile projection is discarded, the row's own verdict landed and this worker
held the lease (ADR-0832 §2).

`null` is in the predicate because ADR-0832 §4 says a profile with no live pointer has no result to
protect and must still be written; `$in` matches a missing field too, so a profile that never carried
the pointer behaves like a `null` one.

### 2. The read-time flag is gone, not doubled

`supersededSelfie` and the `activeSelfieId` projection fed only that flag, so both are removed: one
authority decides (the write), and the profile read that remains is the `profile_withdrawn` guard,
which must be a read. Keeping the flag beside the predicate would leave two answers to one question,
and the pin exists because the read's answer goes stale.

This also makes the fix **verdict-agnostic** for free: the `failed` arm writes through the same
filter, so the same raced window can no longer stamp `status: "failed"` on a newer selfie's profile.

### 3. What did not change

The wire shapes and status codes, the `withTransaction` boundary (selfie row and profile still commit
or roll back together), the warn's fields (`{event, kind, id, workerId, reason}` — no profile id, no
biometric field), the lease predicate, and every existing test case, helper, fixture and mock. The
diff is `apps/web/src/app/api/v1/internal/worker/report/route.ts` alone (+28/−28).

## Consequences

- The pin (ADR-0837) is green and every frozen case stays green: the lane spec is `48 passed (48)`.
- A profile whose pointer moved to another selfie now costs one update that matches nothing, inside
  the existing transaction — no extra read, no extra round trip, no new seam.
- The discard is observable in the same way as before, so ADR-0836's P1/P3 log pins keep their
  meaning without any test change.
- Reverting the whole fix reddens **only** the pin (`1 failed | 47 passed (48)`); dropping just the
  pointer from the filter reddens the pin **and** the three sequential superseded cases (`4 failed |
44 passed (48)`), because they now ride the same predicate instead of the read-time flag.

## Alternatives

1. **Re-read the profile inside the transaction with `{ session }` and decide there.** Rejected: a
   second read is a second decision point, and the filter already carries the truth atomically. It
   would also leave the profile write unconditional, so the transaction would still issue a write for
   a result it discards.
2. **Keep the read-time flag as a fast path and add the predicate.** Rejected: two answers to one
   question; the flag's answer is exactly what the pin shows going stale.
3. **`activeSelfieId: row._id` (no `null`).** Rejected: it greens the pin but reds ADR-0836's
   `P2: writes the profile when it has no active selfie pointer`, which ADR-0832 §4 requires.
4. **Discard every selfie profile write.** Rejected by measurement: an always-discard shape reddens
   five cases (`makes a late result visible on the poll`, `I6`, P1's allowed direction, P2 and F4).

## Evidence

Base: the pin's branch head `a1f2a5a1`, merged with `origin/main` `7d986972` (README resolved as the
union; `ADR-0837` untouched). Lane spec, `TMPDIR=/root/tmp-mongo`:

```
Test Files  1 passed (1)
     Tests  48 passed (48)
```

**Revert probe** — the whole production change reverted (`git checkout -- report/route.ts`), the pin
red alone:

```
 × F-A: keeps the newer selfie's count and watermark and still applies the item
AssertionError: expected { …(3) } to deeply equal { …(3) }
-   "lastMatchRunAt": 2026-09-25T12:00:00.000Z,
-   "matchCount": 7,
+   "lastMatchRunAt": 2026-09-25T09:30:00.000Z,
+   "matchCount": 2,
     Tests  1 failed | 47 passed (48)
```

**Second probe** — only the pointer removed from the write filter
(`{ _id: row.profileId }`, the rest of the fix intact): `4 failed | 44 passed (48)` — the pin plus
`discards a superseded selfie's result…`, `P1: logs one warn…` and `P3: discards a failed verdict…`.

The route was restored byte-identically after each probe
(`sha256 9e379612246b0bafc5327bc093986951cb9545407827141403b54787f2a27162`). Gates: full `unit`
`184 files / 3077 passed | 3 skipped`, full `integration` green **in CI** (PR #630 `ci`; `main` CI on
the squash), `tsc` exit `0`, `eslint` 0 issues, `prettier --check` clean, the `adr-*` guards green.
The local full `integration` run was `2 failed | 1432 passed (1434)` — two 5 s timeouts in specs
unrelated to this change (`auth.test.ts` `I13: disabling 2FA requires a fresh SMS OTP…` and
`event-images-management.test.ts` `R2: deleting one event's reference…`), both green isolated
(`48 passed (48)`).
