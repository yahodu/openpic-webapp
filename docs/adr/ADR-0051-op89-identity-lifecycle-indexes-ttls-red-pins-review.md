# ADR-0051 — OP-89 follow-up RED pins review sign-off: identity-lifecycle index/TTL shapes and the bounded new-device read

- **Status:** Accepted (review sign-off) · **Date:** 2026-10-06
- **Card:** OP-89 `t_13bcd988` (reviewed) · **PR:** #166 (draft, unmerged by design) · **Reviewed head:** `24803ce`
- **Amends:** ADR-0050 (the RED pins under review) — records the review outcome, the acceptance evidence and the routing of the findings.
- **Renumbered:** authored as ADR-0049; renumbered to **ADR-0051** at GREEN integration (card `t_e7d733a0`, see ADR-0050's Numbering note).

## Context

ADR-0050 delivered the OP-89 follow-up RED pins for two coverage gaps raised by the
indexes/TTLs review (ADR-0044 findings 1–2): the five identity-lifecycle
`INDEX_SPECS` entries and the bounded new-device read. This sign-off records the
independent review of that delivery.

## Review outcome — APPROVED WITH FINDINGS (round 1, artifact lens)

Independently reproduced at the reviewed head `24803ce`:

- `vitest run --project unit` → **1324 passed / 67 files** (baseline 1319 + 5 new pins).
- `TMPDIR=/root/tmp-mongo vitest run --project integration` → **226 passed | 1 failed / 34 files**;
  the sole failure is **R1**, failing for the intended reason only:
  `expected [ 'auth.signin.new_device' ] to not include 'auth.signin.new_device'`.
- `tsc` across the three projects → clean; ESLint on the two changed test files → clean.
- Diff is **test-only + ADR/README**: the two spec files, ADR-0050 and the README row.
  No production file is touched; the single deletion in the diff is the widened
  `mongodb` import (`ObjectId` → `ObjectId, type Db, type Document`). No `.only`,
  `.skip`, `.todo`, `@ts-ignore`, suppression or debug log was added. Honesty audit clean.

Acceptance mapping:

1. **Finding 1 (unpinned index/TTL declarations).** All five asserted entries match
   `INDEX_SPECS` exactly (name, collection, keys, `unique`, `partialFilterExpression`,
   `expireAfterSeconds`). They **pass** against `main` because PR #162 already declares
   them; they are **red-capable** (a deleted/renamed/re-shaped entry fails the pin — the
   `expect(spec, …)` message names the missing declaration). The card's literal "genuinely
   RED" is physically unattainable for this half once #162 merged; the substantive goal
   ("a regression fails nothing") is met.
2. **Finding 2 (read cap can drop an in-window match).** R1 is RED for the right reason
   (the newest-100 slice drops the matching sighting). R2 measures the terminal `toArray()`
   length and asserts it never exceeds the 100-sighting cap. The chosen semantics — an
   in-window sighting always suppresses `auth.signin.new_device`, and the read stays
   bounded — are recorded in ADR-0050.

## Findings (routed, not reworked here)

1. **Low — R2's cap guard is vacuous under ADR-0050's own recommended GREEN fix.** The
   recommended fix keys the `find` on the incoming `fingerprintHash`, so R2's seed of 150
   _distinct-device_ sightings returns 0 rows and `max ≤ 100` holds even if `.limit(100)`
   is removed. After the GREEN fix, R1 + R2 no longer protect the cap for a >100
   same-device catalogue. **Route:** Test Author card `t_a6da1734` (strengthen with a
   > 100 same-device pin that fails if the limit is dropped) — landed as **R3** and
   > signed off in ADR-0052.
2. **Low — ADR numbering collision (resolved at GREEN integration).** This branch's
   pins ADR (`ADR-0046`) collided with PR #165's merged `ADR-0046`, and the sign-off's
   provisional `ADR-0049` collided with PR #165's merged `ADR-0049`. **Resolved:** this
   GREEN card (`t_e7d733a0`) merged `origin/main` (which now holds 0045–0049) and
   renumbered the pins ADR → **ADR-0050**, this sign-off → **ADR-0051**, and the R3
   sign-off → **ADR-0052**; `docs/adr/README.md` is reconciled to one ascending row per
   number.

## Numbering (hotspot — resolved)

At review time `0043`–`0049` were claimed by in-flight lanes (PR #165 held 0045/0046/0048/0049,
PR #164 held 0044/0045/0047, PR #167/`t_44552eee` held 0046/0047), so this sign-off was
recorded **provisionally 0049**. After `origin/main` merged (occupying 0045–0049), the OP-89
pins documents take the next free consecutive numbers — pins **ADR-0050**, this sign-off
**ADR-0051**, R3 sign-off **ADR-0052** — per the orchestrator's binding allocation
(`t_eb61c823`, lowest-free-first). Concurrent lanes must not allocate ADR numbers
independently; see the orchestrator card.

## Consequences

- **PR #166 stays a draft and is NOT merged** (RED CI is red by design; the pins ship in
  the gated GREEN PR), matching the OP-89/OP-90 lane convention.
- Follow-on cards created: Test Author `t_a6da1734` (stronger same-device cap pin), GREEN
  `t_e7d733a0` (device-keyed bounded read + ADR renumber), orchestrator `t_eb61c823`
  (central ADR-number allocation).
