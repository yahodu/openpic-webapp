# ADR-0059 — OP-89 follow-up: stale ADR-0046 test references in the identity pin specs renumbered to ADR-0050

- **Status:** Accepted · **Date:** 2026-10-06
- **Card:** OP-89 follow-up test-only cleanup (`t_c9c415e6`, Test Author) · **Relates to:** [ADR-0050](ADR-0050-op89-identity-lifecycle-indexes-ttls-red-pins.md) (the pins ADR, renumbered from ADR-0046), [ADR-0058](ADR-0058-op89-identity-lifecycle-indexes-green-review.md) (the GREEN review sign-off that filed this finding), [ADR-0034](ADR-0034-op85-adr-0032-test-reference-renumber.md) (the stale-test-reference precedent)
- **Schema:** n/a · **Contract:** n/a (comment/`describe`-title strings only)

## Context

The OP-89 identity-lifecycle index/TTL RED pins ADR was authored as **ADR-0046**
and **renumbered to ADR-0050** when the GREEN PR #169 integrated: `main` had
already claimed 0045–0049 when PR #165, the OP-90 ADR-0047, and the R3 sign-off
landed, so the pins took the lowest free numbers on `main` (pins **0050**, review
sign-off **0051**, R3 sign-off **0057**, GREEN review sign-off **0058**). ADR-0050
§Numbering records the renumber.

The GREEN coder may not edit test files (AGENTS.md §2.1), so five comment/`describe`
references authored during the RED phase were left pointing at the vacated
number — which on `main` now resolves to PR #165's follow-up RED review sign-off
(ADR-0046), a **different** document. The GREEN review (ADR-0058) routed this as a
Low finding.

A sibling review of the RED coverage pins (`t_ffd7bc07`) additionally flagged two
stale `(ADR-0043 §3)` citations in the same test file: ADR-0043 §3 records the
`contactChangeFanouts` TTL index, whereas the surface-seam contract the specs pin
is recorded in ADR-0045 §3 (the RED follow-up pins for the section 4–6 /
contact-verified surface adapters; GREEN implemented it in ADR-0048 §2).

## Decision

Correct **only** comment and `describe`-title strings; no assertion, seed, helper
or spec body changes. Exactly seven string edits across two files:

### 1. `ADR-0046` → `ADR-0050` (five sites, the pins ADR)

- `apps/web/src/server/db/indexes.test.ts` L193 (block comment) and L209
  (`describe("index spec pins — OP-89 identity lifecycle (ADR-0050)")`).
- `apps/web/src/test/integration/identity-hooks.test.ts` L1162 (block comment),
  L1184 (JSDoc — `(ADR-0043 §2, ADR-0050)`; the `ADR-0043 §2` half is correct and
  stays), and L1295 (`describe("OP-89 new-device read cap (ADR-0050)")`).

### 2. `ADR-0043 §3` → `ADR-0045 §3` (two sites, the flagged surface-seam titles)

- `apps/web/src/test/integration/identity-hooks.test.ts` L1038
  (`describe("section 4-6 surface seam — createIdentityLifecycleSeams (ADR-0045 §3)")`).
- `apps/web/src/test/integration/identity-hooks.test.ts` L1137
  (`describe("section 2 surface — the contact-verified Better Auth adapter (ADR-0045 §3)")`).

The `ADR-0043 §2` reference (the bounded new-device read cap) and the
`ADR-0043`/`ADR-0041` references in the surrounding prose are correct and are
**not** redirected.

## Numbering

This ADR takes the **lowest free number on `main` at the time of the run**:
`origin/main` occupied `0001`–`0058` contiguously, and no in-flight branch or
object claimed `0059`, so this record is **ADR-0059**. Central cross-lane ADR
allocation remains owned by the orchestrator card `t_eb61c823`.

## Consequences

- A future reader following either stale reference now lands on the ADR that
  actually records the behaviour (pins → ADR-0050; surface seam → ADR-0045 §3).
- No behavioural change: only comment/`describe` strings differ; existing specs
  are otherwise byte-identical, and the full suite / typecheck / lint / format are
  green (this is a GREEN, comment-only PR — no RED state).
- Two further stale citations remain in **production** comments and are out of
  scope for this test-author card (production files are immutable here):
  `apps/web/src/server/auth/identity-hooks.ts:659` cites `(ADR-0043 §1)` and
  `apps/web/src/server/auth/identity-lifecycle.ts:120` cites `(ADR-0043 §3)`.
  Both should resolve to ADR-0045 on inspection; they are flagged for a
  production-lane follow-up rather than edited here.
- The reference is documentation only and is not enforced by an automated guard
  (as ADR-0034 also noted).

## Alternatives considered

- **Leave the stale references.** Rejected: ADR-0046 now names an unrelated
  document, so the citations actively mislead.
- **Rename the vacated ADR-0046 file.** Rejected: ADR-0046 is a live, accepted
  document (PR #165's RED review sign-off); the fix is to correct the citations,
  not to disturb an accepted record.
- **Also redirect the two production comments here.** Rejected: they are
  production files outside the Test Author lane; routing them separately keeps
  this diff exactly the seven test-side strings the review finding scoped.
