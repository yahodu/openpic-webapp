# ADR-0044 — OP-89 follow-up RED review sign-off: idempotency pins, 2FA transition and section 4–6 seams verified RED for the right reason

- **Status:** Accepted (RED review sign-off) · **Date:** 2026-10-06
- **Card:** OP-89 `t_7ce3d03c` (RED follow-up review) · **Verifies:** ADR-0043
- **Branch / PR:** `OP-89-task-identity-lifecycle-hooks-followup-red` (draft #163)
- **Reviewed head:** `6966364` (pre-sign-off; this ADR is the only commit added after it)
- **Reviewer:** `openpic-webapp-reviewer`, round 1, artifact lens

## Context

The RED follow-up card `t_7ce3d03c` (ADR-0043) appended nine specs to
`apps/web/src/test/integration/identity-hooks.test.ts` to pin the three OP-89
GREEN-review findings (ADR-0042 findings 4–6). The card was handed to review.
The RED PR is a _pin_, not a shippable change, so the review question is not
"does it work" but "does it fail for the right reason, and is the pinned
contract genuinely implementable by the GREEN follow-up?"

## Verification performed (round 1, artifact lens)

Independently reproduced on the exact head `6966364` in worktree
`.worktrees/t_7ce3d03c`:

- `vitest run --project unit` → **1319 passed (67 files)**.
- `TMPDIR=/root/tmp-mongo vitest run --project integration identity-hooks.test.ts`
  → **9 failed | 21 passed (30)**. All nine failures are the intended ones:
  - `I8` (×2) and `I9` fail `expected length 1 but got 2` / `expected 2 to be 1`
    — the redelivery emits a second row because `handleContactChanged` and
    `handleSessionsRevoked` carry no `dedupeKey` today (verified at
    `identity-hooks.ts:574-580` and `:640-646`).
  - `S8` (×3), `S9`, `S10` fail `expected 'undefined' to be 'function'` —
    `createIdentityLifecycleSeams` is not exported.
  - `S11` fails `expected 'undefined' to be 'function'` — the
    `databaseHooks.user.update.after` adapter is absent.
- `tsc -p apps/web/tsconfig.json --noEmit` → exit 0; ESLint → 0 errors;
  Prettier → clean. Diff hygiene scan (no `@ts-ignore`, `.only`, `.skip`,
  `console.*`, `TODO`) → clean.
- PR #163: draft, OPEN, `MERGEABLE`; `unit_test`, `lint`, `secret-scan`,
  `validate-branch-name`, `validate-pr-title` SUCCESS; `test_coverage` and `ci`
  FAILURE **by design** (the RED integration specs are meant to fail).

## Contract feasibility (the GREEN follow-up can satisfy every pin)

- The instant-derived `dedupeKey` collapses a redelivery because the outbox
  unique partial index `domain_events_dedupe_unique` already exists
  (`db/indexes.ts:244-247`, on `dedupeKey` when it is a string).
- `handleContactChanged` already returns before the `contactChangeFanouts`
  insert when the emit dedupes (`emitted.id === null`, `identity-hooks.ts:582-587`),
  so adding the `dedupeKey` alone yields the pinned one-fan-out-row result.
- `handleTwoFactorToggled` already keys on
  `auth.2fa.{enabled|disabled}:userId:instant` (`:618-625`), so the section-5
  seam delegate makes `S10` green transitively.
- `handleContactVerified` re-reads the `user` document's verified flags and
  conditionally sets `accountCompletedAt`, so `S11`'s `user.update.after`
  delegate is transition-agnostic and idempotent (`identity-hooks.ts:407-449`).

## Decision

Approve. The nine pins are additive (the six approved blocks and the two
approved RED files are untouched; only the test file's import header gained
`type Db` and the `identity-lifecycle` namespace import), they fail only for the
unimplemented behaviour, and the contract ADR-0043 records is implementable
without any behavioural change to the existing handlers. No change request.

## Consequences

- `t_42a91a52` (GREEN follow-up) can implement `dedupeKey`, the seam factory and
  the `user.update.after` adapter directly against these pins.
- The RED PR #163 stays a **draft and is never merged**; the pins ship inside the
  gated GREEN PR, per the established OP-89 pipeline convention.

## Alternatives considered

- **Merge the RED PR.** Rejected: RED CI is intentionally red (the specs must
  fail before GREEN); RED pins are always shipped by their GREEN PR.
- **A content-derived dedupe key.** Rejected by ADR-0043 for the same privacy
  reason ADR-0040 §2 forbids contact material in the append-only outbox.
