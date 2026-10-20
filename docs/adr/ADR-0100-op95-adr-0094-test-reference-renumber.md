# ADR-0100 — OP-95 follow-up: stale ADR-0094 test-reference renumber to ADR-0096

- **Status:** Accepted · **Date:** 2026-10-06
- **Card:** OP-95 follow-up test-only cleanup (`t_7b9d9f16`, Test Author lane)
- **Relates to:** [ADR-0096](ADR-0096-op95-otp-delivery-through-notification-service-red.md) (the OP-95 RED pins), [ADR-0094](ADR-0094-op94-fan-out-polish.md) (main's accepted OP-94 polish — _not_ the referenced record), [ADR-0099](ADR-0099-op95-otp-delivery-green-review-signoff.md) (the GREEN review sign-off that filed this finding)
- **Schema:** n/a (comment/docstring strings only) · **Contract:** n/a

## Context

The OP-95 lane's RED records originally used `ADR-0094`/`ADR-0095`, but `main`
had already accepted `ADR-0094-op94-fan-out-polish` (PR #193) and its sign-off
`ADR-0095`. At integration the OP-95 lane was renumbered:

- OP-95 RED `0094 → ADR-0096`
- OP-95 RED sign-off `0095 → ADR-0097`
- OP-95 GREEN `0096 → ADR-0098`

Production comments were updated on the GREEN branch, but the GREEN implementer
may not edit test files, so the OP-95 spec docstrings/comments still cited the
vacated `ADR-0094` — which on `main` now resolves to the unrelated OP-94 polish
record. Three spec files were stale (six citations total):

1. `apps/web/src/server/notifications/fan-out-transactional.test.ts` — the
   header contract line (~15) and the `## Assumptions` heading (~107).
2. `apps/web/src/test/integration/notification-otp-delivery.test.ts` — the
   header contract line (~35), the `sendTransactionalNow` contract bullet (~56),
   and the `## Assumptions` heading (~63).
3. `apps/web/e2e/otp-notification-delivery.spec.ts` — the E1 header line (~7).

This is the same class of finding as ADR-0034 (OP-85) and the OP-93 test-ref
renumber (`2bca932`): a pure citation fix owned by the Test Author lane because
the implementer/reviewer could not touch test files.

## Decision

Rename the ADR reference `0094 → 0096` in exactly those six test-side
strings. **No assertion, fixture, test-logic, or production change.** The
renumber makes the specs point at the ADR that actually documents the
synchronous-OTP contract, so a future reader following the reference lands on
the right decision record instead of the OP-94 polish ADR.

## Consequences

- The three OP-95 specs cite ADR-0096 for the RED pins, matching the production
  source comments updated on the GREEN branch.
- No behavioural change: the same specs compile and run unchanged (comment text
  only), so the affected unit/integration/e2e suites and Prettier stay green.
- Any future renumber of the RED ADR must again sweep these citations; the
  reference is documentation only and is not enforced by an automated guard.

## Alternatives considered

- **Leave the stale references.** Rejected: it sends future readers to the
  unrelated OP-94 polish ADR (and a docstring claim that no longer matches the
  record).
- **Add an automated guard that every ADR citation resolves to an existing
  file.** Rejected here as out of scope (a new mechanism, not a citation fix);
  could be a separate follow-up.
