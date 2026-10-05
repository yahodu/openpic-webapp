# ADR-0054 — OP-90 RED follow-up review sign-off: the empty-PATCH 422 and pure-attendee pins land

> **Numbering note.** Renumbered from 0047 to 0054 when the OP-90 GREEN branch merged
> `main`. `main` already owns 0044 (OP-89 index/TTL review) and 0047 (OP-90 `/me`
> contract decisions, card `t_44552eee`), so this RED follow-up sign-off takes 0054
> per the orchestrator's binding allocation. The GREEN implementation record is
> ADR-0055.

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-reviewer`
- **Card:** `t_fa8f43f5` (OP-90 RED pin follow-up, parent `t_572f5d3b`) · **Deliverable:** branch `OP-90-task-get-patch-me-red`, commit `6e2fb3e`, draft PR [#164](https://github.com/yahodu/openpic-webapp/pull/164)
- **Contract under review:** `docs/adr/ADR-0052-op90-me-projection-red.md` · API contract §1.2 + Appendix A.2

## Verdict

**APPROVED** (round 1, artifact lens). The follow-up closes both Low coverage findings from
ADR-0053 additively, fails for exactly the right reason, and regresses nothing. Test-only diff
plus a card-directed ADR-0052 amendment; approved specs U1–U3/I1–I6/E1 are untouched. The
honesty audit is clean — no fixture-specific hardcoding, no test-environment conditionals, no
production code.

## Evidence (reproduced by the reviewer at `6e2fb3e`)

- `vitest run --project integration` (`TMPDIR=/root/tmp-mongo`) → **11 failed | 225 passed
  (236)**; the baseline 225 is unaffected. The four new specs fail only on:
  - `I7` (`PATCH /api/v1/me` body `{}`) → `TypeError: PATCH is not a function`;
  - `I8` (pure attendee) / `I9a` (removed membership) / `I9b` (missing tenant) →
    `AssertionError: expected undefined to be null` (`me.primaryTenant`).
- `tsc -p apps/web --noEmit` → exactly the **3 pre-existing** RED errors (missing
  `./capabilities`, `./patch-schema`, no exported `PATCH`) — the new specs add none.
- `git show --name-only 6e2fb3e` → `me-current-user.test.ts` + `ADR-0052` only (126 insertions,
  **0 deletions** in the spec: purely additive). No production file, no approved spec edited.
- Contract §1.2 spot-check: the `PATCH` body table declares "all optional, at least one
  required", and Appendix A.2 maps a request-shape failure to `422 validation_failed` with
  `details.fields: [{ path, code, message }]` — so `I7`'s `validation_failed` (not
  `forbidden_field`, which is reserved for fields that may never be supplied) is contract-correct.
  §1.2's note that `primaryTenant` is `null` for a pure attendee and that `tenants[]` derives from
  `tenantMembers.status == "active"` substantiates `I8`/`I9`.

## Decision — the RED pin PR stays unmerged

Draft PR #164 is the RED pin and is **not** squash-merged: its CI is red by design (the pinned
modules and `PATCH` export do not exist yet), and merging would put failing tests on `main`.
This matches ADR-0053 §Consequences and the pipeline convention — the RED specs ship inside the
gated GREEN PR. The OP-90 GREEN child `t_43a20f13` is released by this card's completion and
will carry these specs to `main` once green.

## Observations (Low, no action required)

1. **ADR-0052 amended rather than superseded.** The card directed "Update ADR-0052 to record the
   new pins", so the implementer appended a follow-up section to an Accepted ADR. `docs/adr/README.md`
   prefers superseding an Accepted ADR. Harmless here (the amendment is additive and clearly
   scoped); flagged only so future pins default to a new ADR file. No rework.
2. **`I7` does not name the offending `path`.** It asserts `details.fields` is a non-empty array
   rather than a specific pseudo-field, because the contract does not name the field for a
   whole-body "at least one required" violation. Deliberately loose; GREEN is free to choose the
   path. Not a gap worth pinning.

## Consequences

- The two ADR-0053 coverage gaps (`empty-patch-http-422-unpinned`,
  `pure-attendee-primary-tenant-unpinned`) are closed.
- No new findings were raised; no follow-up cards were created.
