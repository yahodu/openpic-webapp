# ADR-0102 — OP-96 follow-up RED pins review sign-off: bounding/idempotency/day-boundary/partial-index pins verified; cap-scope decision gated before GREEN

- **Status:** Accepted · **Date:** 2026-10-06
- **Card:** OP-96 follow-up RED pins (`t_7a67b87d`, reviewer `openpic-webapp-reviewer`)
- **Reviewed artifact:** branch `OP-96-task-digest-retry-quiet-hours-crons-red`, head `ca69c34`, base `origin/main` `d261297` (draft PR #200 holds the review)
- **Contract:** ADR-0100 + its A1–A5 addendum · ADR-0101 (phase-1 RED sign-off) · ADR-0028 (bounded cron framework)
- **Verdict:** APPROVED WITH FINDINGS (no Critical/High); the strengthened RED pins are fit to implement against
- **Follow-up:** A4 cap-scope decision → orchestrator card gating GREEN `t_609968cf`; optional I5 filter-shape tightening → Test-Author card

## Context

The phase-1 RED review (ADR-0101) routed four coverage gaps to `t_7a67b87d`, a
parent of the GREEN card `t_609968cf`, so the strengthened pins land **before**
implementation (TDD order). The Test Author appended the pins to the same RED
branch (head `ca69c34`) and documented two product decisions as addendum
A1–A5 to ADR-0100. This ADR records the independent review of that follow-up:
what was verified, what remains to be decided, and the routing.

## Decision

Accept the follow-up RED pins. They reproduce independently as RED for the right
reason (missing modules/routes only), the previously-passing suite is unchanged,
and each new pin is satisfiable against the real seed catalogue, recipient
resolver and `MongoMemoryReplSet`. The one substantive residual — the digest
daily-cap **scope** — is a cross-card inconsistency that must be settled before
GREEN; it is routed to a new orchestrator card that gates `t_609968cf` rather
than silently baked into the pins.

Per `AGENTS.md` §3.3 the reviewer made **no test or implementation edits** — the
only change to this branch is this sign-off ADR and its README row. (A
test-only RED branch has no reviewer refactor scope: every file it touches is
contract.)

## What was independently verified (head `ca69c34`)

- **RED is genuine and precise.** Unit: `vitest run --project unit` → `2 failed |
79 passed`, 1444 tests passed; the two failures are module-not-found for
  `@/server/notifications/digest` and `.../dispatch-retry` (both from phase 1;
  the follow-up adds no unit pins). Integration: `4 failed | 40 passed`, 297
  tests passed; the four failures are the four specs importing the not-yet-built
  modules/routes. `tsc -p apps/web/tsconfig.json --noEmit` → exactly 8 `TS2307`
  (the new modules/routes) and **no other error**. `prettier --check` and
  `eslint` are clean on the three touched specs.
- **The new pins are satisfiable.** I6/I9/I11 assert `affected === limit` and
  `hasMore` against a real backlog — consistent with the §10.2 `CronRunOutcome`
  (`apps/web/src/server/jobs/cron-job.ts:51`, `hasMore` present). I10/I12 pin a
  no-op re-run. I7's day-boundary expectation is reachable: the digest type
  (`attendee.matches.new`, `throttle: digest(6)`) resolves to a `digest` decision
  before quiet hours (`resolve-channel.ts:367-371`), `firstItemAt`/`lastItemAt`
  follow the fan-out clock, and a bucket created at `19:00Z` is due at `19:30Z`.
- **I8's `admin.abuse.flagged` bucket is reachable.** `admin.abuse.flagged` is a
  seeded `digest(1)` type (`notification-types.values.ts:936-945`, `enabled:
true`); its `platform_admin` audience resolves empty in the fixture, but
  `resolveRecipients` always adds the event `subjectUserId`
  (`fan-out.ts:353`), so the pinned subject receives the bucket — the pin
  distinguishes per-recipient from per-type scope rather than passing vacuously.
- **No honesty issues.** No fixture-shaped hardcoding, no environment/test
  conditionals, no `@ts-ignore`/lint suppressions; assertions are on observable
  transport calls, row transitions and computed instants.
- **Scope discipline.** The follow-up touches only the three new specs and
  ADR-0100; no previously-passing spec was modified.

## Findings and routing

1. **Medium — digest daily-cap scope conflict, unresolved.** ADR-0100
   assumption 4 / addendum A4 and I8 pin the cap as **per recipient per local
   day**; the GREEN card body §2 still says "per user **per type**" and design
   §6/G3 say "≤3 emails/day/**event**". A GREEN implementer following its own
   card body would implement per-type and turn I8 red. Routed to a new
   orchestrator card, linked as a **parent of** `t_609968cf`: confirm one of
   per-recipient / per-type / per-event, and either align the GREEN body to
   ADR-0100 or have the Test Author change I8 before GREEN. Never loosen I8
   silently.
2. **Low — I5 pins partial-index presence, not filter shape.** The tightened
   assertion requires a non-null `partialFilterExpression` but not that it
   scopes to `status: "deferred"`; a wrong partial filter would still pass while
   the release sweep silently loses its index. Non-behavioural (optimisation
   only), so it does not block; routed to a Test-Author card (also a parent of
   `t_609968cf`) to assert the filter shape.
3. **Informational — day-boundary source is a documented choice, not a defect.**
   I7 resolves "local day" from `notificationPreferences.quietHours.timeZone`,
   read even when quiet hours are disabled (the only per-recipient zone in the
   schema; UTC fallback). That is deliberate and recorded in ADR-0100 A3.

## Consequences

- The four phase-1 coverage gaps (F1–F4) are closed by I5–I12 and verified RED
  for the right reason.
- `t_609968cf` (GREEN) stays gated: it must not start until the A4 scope is
  settled and the two follow-up cards above land, matching the "strengthened
  pins before implementation" rule that `t_7a67b87d` exists to enforce.
- The RED branch is red-CI by design and is **never** merged; PR #200 is a
  review-holding draft and the GREEN PR carries these pins plus the
  implementation, as OP-92/PR #182 and OP-93/PR #187 did.
