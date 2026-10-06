# ADR-0105 — OP-96 follow-up: digest daily-cap scope docs alignment review sign-off

- **Status:** Accepted · **Date:** 2026-10-06
- **Card:** OP-96 A4 follow-up DOCS (`t_f682dc3c`, reviewer `openpic-webapp-reviewer`)
- **Reviewed artifact:** branch `OP-96-task-digest-retry-quiet-hours-crons-red`, head `573f5f9`, base `origin/main` `d261297` (draft PR #200 holds the review)
- **Contract:** ADR-0100 (assumption 4 / addendum A4) · ADR-0102 (cap-scope decision gated before GREEN) · orchestrator decision card `t_ad6e0ec3`
- **Verdict:** APPROVED (no Critical/High/Medium findings; no changes requested)

## Context

ADR-0102 finding gated the digest daily-cap scope before GREEN: the GREEN card
body said "per user per type", ADR-0100 assumption 4 / addendum A4 and RED pin
I8 said "per recipient", and design §6 / API contract G3 said "per event". The
orchestrator settled the scope as **per recipient per local day, shared across
digest types** (`t_ad6e0ec3`, 2026-10-06), corrected the GREEN card body §2, and
routed the three remaining doc-consistency edits to this card. No test or
production file is involved.

## Decision

Accept the alignment. The three normative cap-scope statements now agree with
ADR-0100 assumption 4 and RED pin I8, and I8 is untouched. Per `AGENTS.md` §3.3
the reviewer made **no test or implementation edits** — the only change to this
branch by the reviewer is this sign-off ADR and its README row. On a
test/docs-only RED branch every file the implementer touched is contract, so the
reviewer has no refactor scope.

## What was independently verified (head `573f5f9`)

- **Scope discipline.** `git show --stat 573f5f9` and `git diff --name-only
326612e 573f5f9` list exactly three files: `docs/adr/ADR-0100-…-red.md`,
  `docs/Notification and Database Design.md`, `docs/API Contract.md`
  (`3 files changed, 10 insertions(+), 10 deletions(-)`). No test, fixture,
  factory or source file changed.
- **A4 content.** ADR-0100 addendum A4 now reads "per recipient per local day,
  shared across digest types (not per type, not per event)", keeps the required
  "three digests of one type exhaust the day's allowance … a _different_ digest
  type the same day is deferred (`affected: 0`, bucket stays `open`)" sentence,
  and replaces the old "Flagged for the orchestrator" clause with the resolution
  note citing card `t_ad6e0ec3` and 2026-10-06.
- **Design §6 / G3.** `docs/Notification and Database Design.md` line 326 now
  reads `cap 3 emails/day/recipient (shared across digest types)`; `docs/API
Contract.md` G3 now reads `≤3 emails/day/recipient`. Edits are prose-only; no
  unrelated line was reflowed.
- **Acceptance grep.** `grep -rn "per user per type\|emails/day/event" docs/`
  returns a single hit: `docs/adr/ADR-0101…-review-signoff.md:73`, a
  point-in-time RED review quote recorded as of head `639fd06`. The three
  **normative** cap-scope locations are clean. Leaving the historical quote is
  correct: this repo resolves review findings with **new** ADRs (cf. ADR-0103 /
  ADR-0104 resolving ADR-0101's finding #4 rather than rewriting 0101), and
  rewriting a sign-off would misstate what the reviewer saw.
- **Formatting.** `prettier --check` is clean on all three touched files.
- **No honesty issues.** No fixture-shaped hardcoding, no environment
  conditionals, no suppression or skip directives; the edits are plain prose.

## Findings

None. No Critical/High/Medium finding; no changes requested.

## Consequences

- The digest daily-cap scope is documented consistently as per recipient per
  local day across ADR-0100 A4, design §6 and API G3; I8 remains the unchanged
  pin. The GREEN card `t_609968cf` stays gated on this card together with
  `t_8113a184` before implementation.
- The RED branch is red-CI by design and is **never** merged; PR #200 is a
  review-holding draft and the GREEN PR carries these docs plus the
  implementation, as OP-92/PR #182 and OP-93/PR #187 did.
- **Numbering hotspot:** `docs/adr/README.md` and the OP-96 ADR block
  (`0100`–`0105`) collide numerically with the OP-95 lane's claimed range, so the
  block is renumbered as a contiguous unit at integration, as recorded in
  ADR-0102 and ADR-0104.
