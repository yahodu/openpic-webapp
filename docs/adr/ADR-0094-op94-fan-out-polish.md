# ADR-0094 — OP-94 follow-up polish: narrow the test-file `unbound-method` scope, parallelize recipient reads, align the mobile skip channel

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-backend-coder`
- **Card:** `t_3b8e846d` (OP-94 Low polish) · **Forked from:** ADR-0093 (OP-94 GREEN review sign-off, findings `eslint-unbound-method-scope`, `serial-recipient-reads`, `groupChannel-mobile-fallback`)
- **Implements (follow-up):** ADR-0092 (fan-out implementation), ADR-0090 (pins + module contract)
- **Branch:** `OP-94-task-fan-out-polish` (fresh from `origin/main` @ `2c42fe1`)

## Context

The OP-94 GREEN review (ADR-0093) approved PR #189 with four Low findings, three
of which were routed to this card as optional, behaviour-preserving polish:

1. `eslint.config.mjs` disabled `@typescript-eslint/unbound-method` for **all**
   test files (`**/*.test.ts` …) to accommodate the fan-out spec idiom
   `expect(repository.method).toHaveBeenCalled…`. The relaxation is documented and
   production keeps the rule on, but it also silences a genuine `this`-loss in any
   future test helper.
2. `loadRecipientContext` (`fan-out.ts`) issued three independent `findOne`s
   serially, once per recipient; `processEvent` loaded `getPlatformSettings` and
   `loadTemplates` serially though both are recipient-independent.
3. `groupChannel`'s mobile fallback recorded `"sms"` for a skip decided before
   candidate selection on a mobile group that declares no `candidates`, while
   `resolveChannel` would have attempted `whatsapp` first
   (`DEFAULT_MOBILE_CANDIDATES = ["whatsapp", "sms"]`).

All three items are behaviour-preserving for every input the schema admits; no
pin asserts the affected internals. Item 1 is an ESLint configuration change, not
a test edit — no test file is touched by this card.

## Decision

- **Item 1 — narrow the exemption to the two fan-out specs.** Remove the
  `unbound-method: "off"` entry from the broad test-files override and add a new
  flat-config object whose `files` list is exactly
  `apps/web/src/server/notifications/fan-out.test.ts` and
  `apps/web/src/test/integration/notification-fan-out.test.ts`. Every other spec
  (and production) keeps the rule on. Evidence: re-enabling the rule for all test
  files produced `unbound-method` violations in **exactly** those two files (9
  sites), so the scoped list is complete, not an arbitrary narrowing.
- **Item 2 — parallelize the independent reads.** `loadRecipientContext` now
  issues the user/profile/preferences `findOne`s via one `Promise.all`;
  `processEvent` fetches `getPlatformSettings` and `loadTemplates` together via
  `Promise.all` before resolving recipients (both depend only on the type/event,
  not on recipients). Reads that share a collection handle and no ordering
  dependency are safe to overlap on the `mongodb` driver.
- **Item 3 — single source of truth for the mobile default.** Export
  `DEFAULT_MOBILE_CANDIDATES` from `resolve-channel.ts` (as
  `as const satisfies readonly ResolvedChannel[]`, the repo's established tuple
  idiom) and have `groupChannel` fall back to `DEFAULT_MOBILE_CANDIDATES[0]`
  (`"whatsapp"`) instead of the hard-coded `"sms"`. The recorded pre-selection
  skip channel now mirrors the candidate `resolveChannel` would have tried, and
  the two definitions can no longer drift.

## Consequences

- `eslint .` reports 0 errors (37 pre-existing `security/*` warnings unchanged);
  the `unbound-method` guard is active for every spec except the two that use the
  extracting-reference assertion idiom.
- Recipient-context loading and per-event settings/template loading overlap
  instead of round-tripping serially. When `loadTemplates` fails it now rejects
  in the same `Promise.all` as — and therefore possibly before —
  `resolveRecipients`; failure still propagates identically (the event stays
  claimable), and no pin observes the ordering.
- A pre-selection mobile skip with no declared `candidates` is recorded as
  `whatsapp` rather than `sms`. No seed type hits this path today (all mobile
  types declare candidates), so it is latent; the change removes the divergence.
- No test, factory, fixture or MSW handler is modified. Full unit
  (78 files / 1438) and integration (39 files / 294) suites, `tsc`, `eslint` and
  `prettier --check` are green on the branch.

## Alternatives

- **Leave the broad `unbound-method` disable.** Rejected: it was explicitly
  flagged as Low polish and the narrower scope costs nothing while restoring the
  guard for every other spec.
- **Keep a `**/*fan-out*.test.ts` glob instead of two explicit paths.** Rejected:
  the guard is most useful when its exemptions are enumerated; a glob would
  silently widen the exemption to any future fan-out spec that has not been
  reviewed against it.
- **Hard-code `"whatsapp"` in `groupChannel` without exporting the constant.**
  Rejected: two literals describing the same default would drift again; importing
  the resolver's constant keeps a single source of truth.
- **Route item 3 to a RED card.** Not warranted: no pin asserts the recorded
  skip channel for this path, and the change is a pure alignment to an
  already-pinned default (`DEFAULT_MOBILE_CANDIDATES`). If the Test Author wants
  it pinned, that is a future RED-cycle request, reported as a coverage gap.
