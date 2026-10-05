# ADR-0056 — OP-90 GREEN review sign-off: the full `GET`/`PATCH /me` §1.2 projection ships; the `tenantMembers`/`invitations` index gap routed

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-reviewer`
- **Card:** `t_43a20f13` (OP-90 `GET`/`PATCH /me`, GREEN) · **Deliverable:** branch `OP-90-task-get-patch-me-green`, head `7826628`, PR [#168](https://github.com/yahodu/openpic-webapp/pull/168)
- **Contract under review:** `docs/adr/ADR-0055-op90-me-projection-green.md` · API contract §1.2, §0.13–§0.15, Appendix A.2 · schema §13.1–§13.6, §16.1, §19.4

## Verdict

**APPROVED WITH FINDINGS** (round 1, artifact lens). The delivery completes the §1.2
projection on the OP-89 read slice and satisfies every acceptance criterion:

- the response matches the `Me` schema and is enforced strictly by `serializeResponse`;
- a pure attendee gets `primaryTenant: null`, `tenants: []` and all-false capabilities;
- an empty `PATCH` is `422 validation_failed`.

The suite is green (independently reproduced), CI is green, the honesty audit is clean
(no fixture-shaped hardcoding, no test-environment conditionals), no test was edited by
the implementer, and the RED ADRs were renumbered to the orchestrator's allocation
(0052/0053/0054) with the GREEN record at ADR-0055.

## Evidence (reproduced by the reviewer, artifact lens)

- `vitest run --project unit` → **69 files / 1337 passed**.
- `vitest run --project integration` (`TMPDIR=/root/tmp-mongo`) → **35 files / 245 passed**.
- `tsc -p apps/web` → clean; `eslint .` → 0 errors (21 pre-existing warnings, none in the touched files).
- `prettier --check` clean on `src/server/me/**`, `app/api/v1/me/**`, `catalog.ts`, `errors.ts`.
- PR #168 PR Checks: `ci`, `unit_test`, `test_coverage`, `lint`, `env-changes`, `secret-scan`,
  `validate-branch-name`, `validate-pr-title`, CodeQL — all **green**.
- Diff-vs-`main` inspection: the projection reads only caller-scoped filters, the
  `avatarAssetId` ownership check is tenant-scoped and returns the same error for a
  malformed / foreign / non-existent id (no existence oracle), and no `pushTokens` /
  storage keys / other user's contact reach the body (§0.15). PATCH's `$set` keys are
  literals drawn from a fixed editable set, so an operator-shaped key is rejected as
  `forbidden_field` before it can reach the update document.

## Findings routed

1. **Medium → follow-up `openpic-webapp-backend-coder` card (created during this review).**
   `GET /me` reads
   `tenantMembers` (`{userId, status:"active"}`) and `invitations`
   (`{"invitee.userId", status:"pending"}`) on every bootstrap call, but
   `apps/web/src/server/db/indexes.ts` declares **no** non-TTL index for either
   collection. Schema §13.4 mandates `{tenantId:1,userId:1}` unique · `{userId:1,status:1}`
   and §13.6 mandates `{"invitee.userId":1,status:1,createdAt:-1}`; Appendix C's own rule is
   "every read path must be served by an existing index". Today the collections are tiny, so
   impact is low, but the bootstrap path is the one that must never degrade. Routed with the
   Appendix C `GET /me` row correction (it omits `invitations` although §1.2 requires the count).

2. **Low → orchestrator decision.** `projection.ts` returns `email: asString(user?.email, "")`
   — a phone-only (no-email) Better Auth account yields `email: ""` rather than `null`, and
   nothing pins the phone-only shape. This is a contract question (§1.2 declares `email` a
   string), not a defect in this card; recorded for a decision + pin in a later cycle.

## Consequences

- The `/me` bootstrap body and `PATCH /me` now match §1.2 end to end; the RED specs ship
  inside this gated GREEN PR (draft RED PR #164 stays unmerged by design).
- The `REQUEST_SHAPE_ERROR_TRANSPORT` split (ADR-0055 §4) keeps the pinned base
  `ERROR_CATALOG` exact while transporting `forbidden_field`/`unknown_timezone` as `422`.
- Two follow-ups: the index/Appendix C gap (Medium) and the phone-only `email` decision (Low).
- No refactor was applied: the new modules are small, single-purpose and already aligned
  with the established `@/server/<domain>` layout; a defensible change would have been
  speculative.
