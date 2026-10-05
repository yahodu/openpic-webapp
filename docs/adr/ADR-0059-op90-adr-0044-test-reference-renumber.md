# ADR-0059 — OP-90 follow-up: stale ADR-0044 test reference renumbered to ADR-0052

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-90 follow-up test-only cleanup (`t_f2b2f2b4`) · **Relates to:** [ADR-0052](ADR-0052-op90-me-projection-red.md) (the RED pins), [ADR-0053](ADR-0053-op90-me-projection-red-review-signoff.md) and [ADR-0054](ADR-0054-op90-me-projection-red-followup-review-signoff.md) (the RED review sign-offs), [ADR-0055](ADR-0055-op90-me-projection-green.md) (the GREEN implementation), [ADR-0056](ADR-0056-op90-me-projection-green-review-signoff.md) (the GREEN review sign-off that filed this finding)
- **Schema:** n/a (comment string only) · **Contract:** n/a

## Context

The OP-90 GREEN PR (#168) renumbered the RED ADRs against `main` because the
originally allocated numbers had already been claimed upstream:

- `ADR-0044-op90-me-projection-red` → **ADR-0052**
- `ADR-0045-op90-me-projection-red-review-signoff` → **ADR-0053**
- `ADR-0047-op90-me-projection-red-followup-review-signoff` → **ADR-0054**
- new GREEN record → **ADR-0055**

`ADR-0044` is now the _OP-89_ identity-lifecycle indexes/TTLs review sign-off
(`docs/adr/ADR-0044-op89-identity-lifecycle-indexes-ttls-review.md`), an
unrelated decision. The GREEN coder may not edit test files (AGENTS.md §3.2),
so one test-side citation authored during the RED phase was left pointing at the
vacated number:

1. `apps/web/src/test/integration/me-current-user.test.ts` — the header
   doc-comment `## Deliberate non-assertions (see the handoff / ADR-0044)`.

All other `ADR-0045` / `ADR-0047` citations in the tree refer to the OP-89
follow-up RED and the OP-90 `/me` contract-decisions records respectively, which
keep those numbers and are therefore correct as written.

## Decision

Rename the ADR reference `0044` → `0052` in exactly that one test-side comment
string. No assertion, fixture semantics, or production code changes. The
renumber is a pure citation fix: it makes the test file point at the ADR that
actually documents the OP-90 RED projection contract and its deliberate
non-assertions, so a future reader following the reference lands on the right
decision record.

The test files are the Test-Author lane; the reviewer/coder could not make this
edit, which is why it is a separate card. Precedent: ADR-0034 (OP-85 stale
ADR-0031 test references renumbered to ADR-0032).

## Consequences

- The `me-current-user.test.ts` header doc-comment now cites ADR-0052, matching
  the OP-90 RED/GREEN records that remain on `main` after the PR #168 squash
  merge.
- No behavioural change: the integration suite for this file is unaffected
  (comment-only edit), Prettier is clean, and `tsc` is unaffected.
- Any future renumber of the OP-90 RED ADR must again sweep these citations; the
  reference is documentation only and is not enforced by an automated guard.

## Alternatives considered

- **Leave the stale reference.** Rejected: it sends future readers to the OP-89
  identity-lifecycle review ADR for an unrelated decision.
- **Add an automated guard that every ADR citation resolves to an existing
  file.** Rejected for this card as out of scope (a new mechanism, not a
  citation fix); could be a separate follow-up.
