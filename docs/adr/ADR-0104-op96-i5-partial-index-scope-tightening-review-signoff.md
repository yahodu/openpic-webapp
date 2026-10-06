# ADR-0104 — OP-96 follow-up: I5 partial-index scope tightening review sign-off

- **Status:** Accepted · **Date:** 2026-10-06
- **Card:** OP-96 follow-up TEST (`t_8113a184`, reviewer `openpic-webapp-reviewer`)
- **Reviewed artifact:** branch `OP-96-task-digest-retry-quiet-hours-crons-red`, head `01f3c08`, base `origin/main` `d261297` (draft PR #200 holds the review)
- **Contract:** ADR-0100 (§5 / contract §10.2 `quiet-hours-release`) · ADR-0102 (finding F2) · ADR-0103 (tightening decision)
- **Verdict:** APPROVED (no Critical/High/Medium findings; no changes requested)

## Context

ADR-0102 finding F2 observed that the I5 pin required only a **non-null**
`partialFilterExpression` on the `{status, until}` index, so any partial filter
— including one scoped to the wrong status — would pass while the release sweep
silently lost its index support. This card (a parent of the GREEN card
`t_609968cf`) replaced that weak assertion with a structural predicate that
requires the filter to scope `status` to `"deferred"`. This ADR records the
independent review of that change.

## Decision

Accept the tightening. The pinned predicate is sound, does not over-fit
MongoDB's encoding of the filter, and still passes every legitimate form of a
`deferred`-scoped filter the GREEN implementation might produce. No production
file is touched.

Per `AGENTS.md` §3.3 the reviewer made **no test or implementation edits** — the
only change to this branch is this sign-off ADR and its README row. A test-only
RED branch has no reviewer refactor scope: every file it touches is contract.

## What was independently verified (head `01f3c08`)

- **The predicate is correct.** Extracted `scopesStatusToDeferred` verbatim and
  evaluated a 20-case truth table in isolation (`node`, no Mongo): **20/20**
  matched expectation. It accepts the literal `{status: "deferred"}`,
  the normalised `{status: {$eq: "deferred"}}`, the set form
  `{status: {$in: ["deferred", …]}}`, and recurses through `$and`/`$or` and
  arrays; it rejects `{status: "sent"}`, `{status: {$eq: "sent"}}`,
  `{status: {$in: ["sent"]}}`, the wrong-status-but-mentions case
  `{status: {$in: ["sent"]}, note: "deferred"}`, `{}`, `undefined`, `null`,
  a bare string and `[]`.
- **RED is genuine and precise.** `vitest run --project integration` on the
  touched spec fails only via module-not-found (`@/server/notifications/quiet-hours-release`,
  import line 12); the full integration project is `4 failed | 40 passed`, 297
  tests passed — unchanged. `vitest run --project unit` is `2 failed | 79
passed`, 1444 passed — unchanged. `tsc -p apps/web/tsconfig.json --noEmit`
  reports exactly **8 `TS2307`** and no other error. `prettier --check` and
  `eslint` are clean on the touched spec.
- **No over-fitting risk for GREEN.** The existing `indexes.ts` uses literal
  filters; the predicate accepts literals, `$eq` and `$in`, so any plausible
  `deferred`-scoped `partialFilterExpression` satisfies it. The documented
  rejected encodings (exact-literal-only, `$eq`-only, raw string search) were
  each genuinely worse.
- **Scope discipline.** The commit touches only the I5 block (plus the new
  predicate), ADR-0103 and its README row; no other spec, fixture or source
  file changed.
- **No honesty issues.** No fixture-shaped hardcoding, no environment/test
  conditionals, no `@ts-ignore`/lint suppressions, no skips or timeouts.

## Findings

None of Critical/High/Medium severity. Two informational notes, neither
blocking and neither requiring a card:

1. **Info — recursion is broader than the documented wrappers.** The fallback
   `Object.values(record).some(scopesStatusToDeferred)` searches every value,
   not only `$and`/`$or`, so a filter that merely nests `status: "deferred"`
   under an unrelated key would also pass. For a real `partialFilterExpression`
   this is unreachable in practice and is the intended "structural, not
   literal" tolerance; noted only for completeness.
2. **Info — the index finder is pre-existing.** The I5 spec selects the first
   `listIndexes()` entry whose key contains both `status` and `until`. If the
   GREEN implementation ever added a second such index (one partial, one not),
   creation order could make the pin inspect the wrong one. Pre-existing and
   outside this card; no action.

## Consequences

- ADR-0102 finding F2 is closed: a plain compound index, or a partial index
  scoped to any status other than `"deferred"`, now fails I5 loudly.
- `t_609968cf` (GREEN) stays gated on this card together with the A4 docs card
  `t_f682dc3c`, matching the "strengthened pins before implementation" rule.
- The RED branch is red-CI by design and is **never** merged; PR #200 is a
  review-holding draft and the GREEN PR carries these pins plus the
  implementation, as OP-92/PR #182 and OP-93/PR #187 did.
- **Numbering hotspot:** `origin/main` claims `0100`–`0103` for the OP-95 lane,
  so the OP-96 block (`0100`–`0104`) collides numerically and is renumbered as a
  contiguous unit at integration, as recorded in ADR-0102 and the ADR README.
