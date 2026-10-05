# ADR-0034 — OP-85 follow-up: stale ADR-0031 test references renumbered to ADR-0032

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-85 follow-up test-only cleanup (`t_921a05f9`) · **Relates to:** [ADR-0024](ADR-0024-client-ip-trust-model.md) (client-IP trust model), [ADR-0032](ADR-0032-op85-production-trusted-client-ip-required-red.md) (the RED pins), [ADR-0033](ADR-0033-op85-production-trusted-client-ip-required-green-signoff.md) (the GREEN review sign-off that filed this finding)
- **Schema:** n/a (comment/label strings only) · **Contract:** n/a

## Context

The OP-85 GREEN PR (#147) renumbered the RED ADR `ADR-0031` → `ADR-0032`
(`docs/adr/ADR-0032-op85-production-trusted-client-ip-required-red.md`) because
`main` had already claimed ADR-0031 for the OP-88 outbox sign-off. The GREEN coder
may not edit test files, so three comment/label references authored during the RED
phase were left pointing at the vacated number:

1. `apps/web/src/server/config/env.test.ts` — the header env-var table comment
   (`(unset/blank refused — OP-85 follow-up, ADR-0031)`).
2. `apps/web/src/server/config/env.test.ts` — the `describe` label
   `getConfig — production requires TRUSTED_CLIENT_IP_HEADER (ADR-0031)`.
3. `apps/web/src/test/factories/env.ts` — the `makeProductionEnv` JSDoc
   (`(OP-85 follow-up, ADR-0031)`).

The production source (`env.ts`, `instrumentation.ts`) already cites ADR-0032;
only the test-side references were stale. This was raised as review finding #1
(Low, cosmetic) on PR #147.

## Decision

Rename the ADR reference `0031` → `0032` in exactly those three test-side strings.
No assertion, fixture semantics, or production code changes. The renumber is a
pure citation fix: it makes the test files point at the ADR that actually
documents the required-`TRUSTED_CLIENT_IP_HEADER` contract, so a future reader
following the reference lands on the right decision record.

The test files are the Test-Author lane; the reviewer/coder could not make this
edit, which is why it is a separate card.

## Consequences

- The `env.test.ts` header comment and `describe` label, and the
  `makeProductionEnv` JSDoc, now cite ADR-0032, matching `env.ts` and
  `instrumentation.ts`.
- No behavioural change: the unit suite is unchanged at **76 passed** for
  `env.test.ts` + `env-example.test.ts`, and Prettier is clean on both files.
- Any future renumber of the RED ADR must again sweep these citations; the
  reference is documentation only and is not enforced by an automated guard.

## Alternatives considered

- **Leave the stale references.** Rejected: it sends future readers to the OP-88
  sign-off ADR for an unrelated decision.
- **Add an automated guard that every ADR citation resolves to an existing
  file.** Rejected for this card as out of scope (a new mechanism, not a
  citation fix); could be a separate follow-up.
