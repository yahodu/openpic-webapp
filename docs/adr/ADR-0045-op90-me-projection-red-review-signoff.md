# ADR-0045 — OP-90 RED review sign-off: the §1.2 `/me` pins ship; two contract decisions and two coverage gaps routed

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-reviewer`
- **Card:** `t_572f5d3b` (OP-90 `GET`/`PATCH /me`, RED) · **Deliverable:** branch `OP-90-task-get-patch-me-red`, commit `588b4b3`, draft PR [#164](https://github.com/yahodu/openpic-webapp/pull/164)
- **Contract under review:** `docs/adr/ADR-0044-op90-me-projection-red.md` · API contract §1.2

## Verdict

**APPROVED WITH FINDINGS** (round 1, artifact lens). The RED delivery is test-only and
correct: it pins every behaviour its own card enumerates (U1–U3, I1–I6, E1), fails for
exactly the right reason (the two pinned modules and the route's `PATCH` export do not
exist yet), and regresses nothing. No production code was written, no existing test was
modified, and the honesty audit is clean. The findings are contract ambiguities and
coverage gaps — not defects in this card's compliance with its own spec.

## Evidence (reproduced by the reviewer, artifact lens)

- `vitest run --project unit src/server/me/*` → **2 failed suites** (the two new files),
  both solely `Cannot find module './capabilities'` / `'./patch-schema'`.
- `vitest run --project integration src/test/integration/me-current-user.test.ts`
  (`TMPDIR=/root/tmp-mongo`) → **7/7 fail**: I1/I2/pending `expected undefined to be <id>/3/2`;
  I3–I6 `TypeError: PATCH is not a function`.
- `tsc -p apps/web` → exactly 3 expected errors (the two missing modules + no exported `PATCH`).
- `eslint` exit 0 and `prettier --check` clean on all four spec files and ADR-0044.
- `git show --stat 588b4b3` is exactly four spec files + ADR-0044 + its index row — **no
  production file touched**.
- Contract §1.2 spot-check: the pinned body, the `{id,slug,name,role,status}` tenant shape,
  the active-only `tenants[]` rule and the `PATCH` field table match the contract; I1 asserts
  `contactCapabilities` exactly, so `pushTokens` cannot leak (§0.15).

## Findings routed

1. **Medium → `t_daff2bfa` (openpic-orchestrator, decision owner).** Two contract ambiguities
   left unpinned by the RED and documented as unilateral assumptions in ADR-0044:
   (a) the `phoneNumber` representation for the caller's own `/me` (§1.2 masks the example
   number while §0.13 defines E.164 plus a separate masked form); (b) the error code for a
   foreign-tenant `avatarAssetId`, pinned as `validation_failed` by assumption.
2. **Low → `t_fa8f43f5` (openpic-webapp-testcase-writer).** Two coverage gaps: the
   "empty PATCH → 422" criterion is pinned only at the schema level (U2), and the
   pure-attendee `primaryTenant: null` projection is not pinned at the integration level.

Both cards are linked as parents of the OP-90 GREEN child `t_43a20f13`, so GREEN waits for
the decision and the extra pins before implementing — no drift.

## Consequences

- The RED specs ship inside the gated GREEN PR (`t_43a20f13`); this draft RED PR (#164) is
  the pin and is not merged (red CI by design).
- GREEN must not bake in either ambiguous behaviour until `t_daff2bfa` resolves it.
