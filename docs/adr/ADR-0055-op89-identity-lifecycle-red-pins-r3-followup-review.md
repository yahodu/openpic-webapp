# ADR-0055 — OP-89 RED-pins R3 follow-up review sign-off: same-device >100 read-cap pin

- **Status:** Accepted (review sign-off) · **Date:** 2026-10-06
- **Card:** OP-89 `t_a6da1734` (reviewed) · **PR:** #166 (draft, unmerged by design) · **Reviewed head:** `c7e3e58`
- **Amends:** ADR-0046 (the RED pins whose cap guard R3 strengthens) and ADR-0049 (the review that routed this pin).

## Context

ADR-0049 finding 1 (severity Low) observed that R2's cap guard is **vacuous under
ADR-0046's own recommended GREEN fix**: R2 seeds 150 _distinct-device_ sightings,
so once the read is keyed on the incoming `fingerprintHash` it returns 0 rows and
`max ≤ 100` holds even if `.limit(100)` is removed. Card `t_a6da1734` adds **R3** —
150 in-window sightings that are **all the incoming device** — to restore the guard.
This sign-off records the independent review of that delivery.

## Review outcome — APPROVED (round 1, artifact lens)

Independently reproduced at the reviewed head `c7e3e58`:

- `vitest run --project unit` → **1324 passed / 67 files**.
- `TMPDIR=/root/tmp-mongo vitest run --project integration apps/web/src/test/integration/identity-hooks.test.ts`
  → **24 tests, 23 passed | 1 failed**; the sole failure is **R1**, for the intended
  reason only: `expected [ 'auth.signin.new_device' ] to not include 'auth.signin.new_device'`.
  **R3 is green today.**
- **Red-capability reproduced independently.** Temporarily applying the recommended
  device-keyed read shape (`find({ userId, fingerprintHash: deviceHash, … })`) **with
  `.limit(SESSION_DEVICE_READ_LIMIT)` removed** to `apps/web/src/server/auth/identity-hooks.ts`
  made R3 fail exactly `expected 150 to be less than or equal to 100`; restoring the
  limit made the same device-keyed shape pass R3. The production file was reverted via
  `git checkout` — **nothing was shipped**, `git status` clean.
- `tsc -p apps/web/tsconfig.json --noEmit` → clean; Prettier and ESLint on the changed
  test file and ADR → clean.
- Diff is **test + ADR only**: `identity-hooks.test.ts` (R3 + the new
  `seedSameDeviceSightings` helper) and ADR-0046. R1/R2 and every existing assertion
  are untouched. No `.only`, `.skip`, `.todo`, `@ts-ignore`, suppression or debug log.
  Honesty audit clean — the seed uses the real `hashFingerprint`/salt and the
  assertions are behavioural, with no fixture-specific hardcoding.

Acceptance mapping:

1. **R3 added** — appended after R2, reusing the R1/R2 `trackSessionDeviceReads`
   wrapper, `recordingEmit` and `fixedClock` seams. ✓
2. **Green today and red-capable against a dropped cap** — both verified above. ✓
3. **R1 unchanged RED** — the sole failing spec in the file. ✓
4. **PR #166 extended** — head is `c7e3e58` (draft). ✓
5. **ADR-0046 records R3**, why R2 is vacuous, and the red-capability evidence. ✓

## Findings (routed)

- **No finding at Medium or higher severity.** The pin closes ADR-0049 finding 1.
- **Low (non-blocking, no action required):** `seedSameDeviceSightings` duplicates the
  row-shape of the existing `seedInWindowSightings` (differs only in the hashed device).
  This is acceptable, readable test-helper duplication; collapsing it would touch the
  R1/R2 helper and is out of scope for an additive test-only follow-up.
- **Low — ADR-numbering collision (still live).** `docs/adr/README.md` remains a
  cross-lane hotspot; observed claims now extend to `0054` (OP-90 lane `t_43a20f13`).
  This sign-off takes `0055` — above every observed claim — pending central allocation
  at GREEN. Reconciled via GREEN card `t_e7d733a0` + orchestrator card `t_eb61c823`.

## Consequences

- **PR #166 stays a draft and is NOT merged** (RED CI is red by design; the pins ship
  in the gated GREEN PR), matching the OP-89/OP-90 lane convention. Merging here would
  delete the R1 RED signal before the GREEN fix.
- This card's completion releases the GREEN card `t_e7d733a0` (device-keyed bounded read
  - ADR renumber), which waits on the R3 pin.
