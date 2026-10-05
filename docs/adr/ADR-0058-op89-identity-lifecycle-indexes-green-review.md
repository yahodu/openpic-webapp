# ADR-0058 — OP-89 indexes/TTLs GREEN review sign-off: device-keyed bounded new-device read

- **Status:** Accepted (review sign-off) · **Date:** 2026-10-06
- **Card:** OP-89 `t_e7d733a0` (GREEN follow-up, reviewed) · **PR:** #169 (against `main`) · **Reviewed head:** `e7035db`
- **Amends:** ADR-0050 (the RED pins this GREEN closes), ADR-0051 (the review that routed the cap-guard finding). Records the review outcome, the acceptance evidence and the routing of the findings.

## Context

The gated GREEN follow-up to the OP-89 RED-pins card (`t_13bcd988`, draft PR
#166) had to make **R1** green for the right reason without dropping the
new-device read cap. The delivered change is confined to the read predicate in
`apps/web/src/server/auth/identity-hooks.ts`: `sessionDevices` is now read with
`{ userId, fingerprintHash: deviceHash, createdAt: { $gt: now − window } }`,
`.sort({ createdAt: -1 })`, `.limit(SESSION_DEVICE_READ_LIMIT)`. The card also
merged `origin/main` (PR #165) and renumbered the OP-89 pins ADRs.

## Review outcome — APPROVED WITH FINDINGS (round 1, artifact lens)

Independently reproduced at the reviewed head `e7035db`:

- `vitest run --project unit` → **1324 passed / 67 files**.
- `TMPDIR=/root/tmp-mongo vitest run --project integration` → **237 passed / 34 files**.
  Focused `identity-hooks.test.ts` → **33 passed**, including **R1, R2, R3** green.
  R1 is green **for the right reason**: the device-keyed read returns the
  in-window matching sighting that the former newest-100 slice dropped.
- `pnpm test:e2e` → **13 passed** against a fresh `next build`; build success.
- `tsc` (root + contracts + web) → clean; ESLint → **0 errors** (20 pre-existing
  warnings); Prettier `--check .` → clean.
- Diff vs `origin/main` is **production (5-line read predicate) + the RED pins
  from PR #166 + ADRs/README**. No other production file diverges from `main`.
- **Honesty audit clean.** No fixture-specific hardcoding, no test-environment
  conditional, no `.only`/`.skip`/`.todo`/`@ts-ignore`/suppression or debug log
  in the added lines. The change is a general predicate, not shaped to any seed.
- PR #169 CI: **all checks pass** (ci, lint, test_coverage, unit_test,
  validate-branch-name, validate-pr-title, env-changes, secret-scan, CodeQL,
  Analyze).

Acceptance mapping:

1. **R1 green for the right reason** — the read is keyed on the incoming
   `fingerprintHash`, so an in-window sighting of the matching device is never
   dropped by the cap. ✓
2. **R2/R3 stay green** — the read stays bounded (`limit ≤ 100`); R3 guards the
   bound for a >100 same-device catalogue. ✓
3. **Contract unchanged** — `auth.signin.new_device` eventKey/payload/`dedupeKey`,
   the index/TTL declarations and the sighting-write shape are untouched; the
   fix is confined to the read predicate. ✓
4. **ADRs renumbered** — pins `ADR-0046 → ADR-0050`, review sign-off
   `ADR-0049 → ADR-0051`, R3 sign-off `ADR-0055 → ADR-0057`, lowest-free-first;
   `docs/adr/README.md` reconciled to one ascending row per number. ✓

## Findings (routed, not reworked here)

1. **Low — the RED pin specs still quote the old `ADR-0046`.** The `describe`
   titles/comments in `apps/web/src/server/db/indexes.test.ts` (lines 193, 209)
   and `apps/web/src/test/integration/identity-hooks.test.ts` (lines 1162, 1184, 1295) cite `ADR-0046`, which after renumbering resolves to PR #165's
   follow-up RED sign-off — a different document. Test files are immutable to the
   Implementer and the Reviewer, so the references are **routed to a Test Author
   follow-up card** (cf. ADR-0034, the stale-test-reference precedent). ADR-0050
   §Numbering records the same.
2. **Low (hotspot) — cross-lane ADR-number collisions remain.** At this lane's
   integration the pins documents took the lowest free numbers on `main`. At that
   point `main` held 0001–0049, so the pins kept `0050` and their review sign-off
   `0051`; the OP-90 `/me` lane (PR #168) then landed `0052`–`0056`, so the two
   OP-89 sign-offs took the next free numbers — R3 sign-off `ADR-0057`, this
   GREEN sign-off `ADR-0058`. Earlier in-flight overlap (`t_ffd7bc07` lane held a
   provisional `0050`) is resolved by the "renumber at integration" convention:
   each later-merging lane re-resolves lowest-free-first against the then-current
   `main`; the central orchestrator allocation (`t_eb61c823`, and the
   reconciliation card `t_93d4774b`) owns that.
3. **Low (observation) — the read predicate is not covered by a matching index.**
   `session_devices_user_created` is `{ userId: 1, createdAt: -1 }`; the new
   `fingerprintHash` equality is filtered in memory after the `userId`-prefixed
   index walk. The read is still bounded by `.limit(100)` matched rows and by the
   7-day TTL, so this is not a defect; a `{ userId, fingerprintHash, createdAt }`
   compound index would fully cover it, but changing index declarations is
   explicitly out of scope for this card (it would need its own pins).

## Numbering

Authored last on this branch, after the pins `ADR-0050`, their review `ADR-0051`
and the R3 sign-off `ADR-0057`. With `main` carrying `0050`–`0056` after the
OP-90 `/me` lane's merge (PR #168) and this branch's `0050`/`0051`, it takes the
next free number, **ADR-0058**. See `docs/adr/README.md`; the cross-lane
allocation is owned by the orchestrator (`t_eb61c823`).

## Consequences

- PR #169 squash-merges to `main` carrying PR #166's pins **and** the GREEN fix.
  **PR #166 stays an unmerged RED draft by design** (merging it would delete the
  R1 RED signal).
- Follow-up cards created: Test Author `t_c9c415e6` (stale `ADR-0046` test
  references in the OP-89 pin specs); Orchestrator `t_93d4774b` (cross-lane ADR
  number reconciliation).
