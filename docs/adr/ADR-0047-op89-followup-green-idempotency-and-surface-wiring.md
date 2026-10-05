# ADR-0047 — OP-89 follow-up GREEN: re-run dedupe for contact.changed / sessions.revoked and the sections 4–6 / contact-verified surface adapters

- **Status:** Accepted (GREEN implementation) · **Date:** 2026-10-06
- **Card:** OP-89 `t_42a91a52` (phase 1-Identity, epic Authentication, GREEN follow-up) · **Implements:** ADR-0045 (pins), ADR-0043 (`t_5e541eaa` indexes — numbering only) · **Amends:** ADR-0041 (refreshes its "Coverage gaps")
- **Contract:** API contract §1.1 (hook table), §7.7 (domain events); schema §13.2, §18.3; ADR-0029 (outbox), ADR-0038/0040 (handler contract), ADR-0042 (review findings 4–6)
- **PR / branch:** `OP-89-task-identity-lifecycle-hooks-followup-green` (built on the reviewed RED pins `OP-89-task-identity-lifecycle-hooks-followup-red`, `6966364`)

## Context

The OP-89 GREEN review (ADR-0042) routed three findings to a RED re-pin
(`t_7ce3d03c`, ADR-0045) and this GREEN follow-up (`t_42a91a52`):

- **finding 4 (Medium)** — sections 4–6 and contact-verified were met at
  **handler** level only; the Better Auth / endpoint **surface** adapters were
  unwired;
- **finding 5 (Medium)** — `handleContactChanged` and `handleSessionsRevoked`
  carried **no `dedupeKey`**, so a redelivery emitted a second row;
- **finding 6 (Low)** — the 2FA `enabled → disabled → enabled` re-emit was
  unpinned.

The reviewed pins (`ADR-0045` §1–3) fixed the contract this card implements; no
new tests were written here (AGENTS.md §2.1 — GREEN implements against the pins).

## Decision

### 1. Instant-derived `dedupeKey` on the two remaining handlers

`handleContactChanged` and `handleSessionsRevoked` now pass a `dedupeKey` to
their single `safeEmit`:

```
auth.contact.changed      → `auth.contact.changed:${userId}:${at.toISOString()}`
account.sessions.revoked  → `account.sessions.revoked:${userId}:${at.toISOString()}`
```

where `at = resolveDeps(deps).clock.now()`. The outbox unique partial index
`domain_events_dedupe_unique` (ADR-0029 §7) collapses a redelivery sharing the
injected instant, and `handleContactChanged` already returns before its
`contactChangeFanouts` insert when the emit dedupes (`emitted.id === null`), so
the re-run leaves exactly one event **and** one fan-out row. The key is
instant-derived, not content-derived: the append-only outbox lives 180 days and
ADR-0040 §2 forbids contact material (raw or hashed) in it, while the flags-only
payload is too coarse to key on. A genuinely new change at a later instant
re-emits — the "different change" pin (S8) guards the boundary.

`handleTwoFactorToggled` is unchanged: it already keys on
`auth.2fa.{enabled|disabled}:${userId}:${at}`.

### 2. Sections 4–6 surface — one injectable endpoint seam

`@/server/auth/identity-lifecycle` exports
`createIdentityLifecycleSeams(wiring: IdentityHookWiring): IdentityLifecycleSeams`
returning `contactChanged`, `twoFactorToggled` and `sessionsRevoked`. Each method
delegates to its policy handler with the wired `db`/`emit`/`clock` and is wrapped
in the module's existing `safeRun`, so a seam failure logs `identity_hook.failed`
and never throws into the endpoint. Better Auth exposes no `after` hook that
carries the **transition** for these three, so the endpoint cards call the seam
once after their own write:

| Section            | Surface                                            | Owning card                                 |
| ------------------ | -------------------------------------------------- | ------------------------------------------- |
| 4 contact changed  | `createIdentityLifecycleSeams(...).contactChanged` | contact-change endpoint                     |
| 5 2FA toggled      | `...twoFactorToggled`                              | 2FA toggle endpoint                         |
| 6 sessions revoked | `...sessionsRevoked`                               | OP-91 `POST /api/v1/me/sessions:revoke-all` |

The route **bodies** are out of scope here (as the pins recorded); this card
delivers the seam they call.

### 3. Contact-verified surface — a Better Auth `user.update.after` adapter

`createIdentityDatabaseHooks` gains `user.update.after`, delegating to
`handleContactVerified({ userId })` inside `safeRun`. Better Auth fires it on the
`emailVerified` / `phoneNumberVerified` writes; the handler is
transition-agnostic and idempotent (conditional `accountCompletedAt` update), so
firing on every user update is safe: the second update no-ops.

The wiring→deps projection was factored into a private `toHookDeps` helper shared
by `createIdentityDatabaseHooks` and `createIdentityLifecycleSeams`.

## ADR numbering (collision resolution)

The sibling indexes/TTLs follow-up (`t_5e541eaa`, PR #162) reserves ADR-0043
(indexes) and ADR-0044 (its review sign-off). To avoid a collision on `main`, the
RED pins ADR was renumbered **0043 → 0045** and its review sign-off **0044 →
0046**, with the `docs/adr/README.md` rows updated; 0043/0044 are left for the
indexes PR. This is a rename only — no decision content changed. The comment
header inside `apps/web/src/test/integration/identity-hooks.test.ts` still cites
"ADR-0043" from the RED commit; it is not corrected here because test files are
immutable to the implementer (AGENTS.md §2.1) — flagged for the next cycle.

## Consequences

- The nine follow-up pins (`I8` ×2, `I9`, `S8` ×3, `S9`, `S10`, `S11`) go green
  for the right reason; `identity-hooks.test.ts` is 30/30.
- Full suite green: 1319 unit, 234 integration, 13 Playwright; `tsc` and ESLint
  clean; Prettier clean.
- A regression that drops the `dedupeKey` (double row on redelivery), unwires a
  seam or the `user.update.after` adapter, or double-emits a Toggle breaks a spec.
- ADR-0041's "Coverage gaps" is refreshed: the section 4–6 adapters and the 2FA
  transition re-emit are closed; the route bodies and the §6.7 claim endpoint
  remain open in their own cards.

## Alternatives considered

- **Content-derived `dedupeKey`.** Rejected: privacy (ADR-0040 §2) and the
  180-day outbox; a contact hash is still contact material.
- **Lifetime `eventKey:userId` key.** Rejected: suppresses a second revoke-all /
  re-enable; the S8 "different change" pin fails.
- **Drive sections 4–6 through `user.update.after` / `session.delete.after`.**
  Rejected: neither carries the previous value, so a contact change cannot
  compute `previous` and a revoke-all would fire once per deleted session.
- **Implement the §6.7 claim endpoint or the route bodies here.** Rejected:
  separate contract surfaces owned by their own cards.
