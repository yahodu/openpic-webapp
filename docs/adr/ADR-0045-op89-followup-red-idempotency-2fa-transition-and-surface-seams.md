# ADR-0043 — OP-89 follow-up RED pins: re-run idempotency, 2FA transition re-emit and the section 4–6 / contact-verified surface adapters

- **Status:** Accepted (RED pins) · **Date:** 2026-10-06
- **Card:** OP-89 `t_7ce3d03c` (phase 1-Identity, epic Authentication, RED follow-up) · **Amends:** ADR-0040, ADR-0041 (extends the module contract; does not supersede them)
- **Contract:** API contract §1.1 (hook table), §1.2, §1.5, §6.7, §7.7; schema §13.2, §18.3, §19.3; ADR-0029 (outbox), ADR-0038/0040 (handler contract), ADR-0042 (review findings 4–6)
- **Branch / PR:** `OP-89-task-identity-lifecycle-hooks-followup-red` (draft) — append-only extension of `apps/web/src/test/integration/identity-hooks.test.ts`.

## Context

The OP-89 GREEN review (ADR-0042) accepted the delivery and routed three
findings to a RED re-pin followed by a GREEN follow-up (`t_42a91a52`):

- **Medium (finding 4)** — sections 4–6 and contact-verified are met at
  **handler** level only; the Better Auth / endpoint **surface** adapters were
  never wired, so contract AC "Every hook's effects match the contract" is not
  proven at the surface.
- **Medium (finding 5)** — `handleContactChanged` and `handleSessionsRevoked`
  carry **no `dedupeKey`**, so a redelivered invocation emits a second row.
- **Low (finding 6)** — the 2FA `enabled → disabled → enabled` re-emit is
  unpinned (carried from ADR-0040 §3).

Better Auth 1.7.7 offers `databaseHooks.user.create|update|delete.after` and
`session.create|update|delete.after`, but no `after` hook carries the
**transition** (previous value) for a contact change, a 2FA toggle, or a
revoke-all. This ADR records the extended contract the RED suite pins so GREEN
can implement all of it against the tests alone.

All additions are **additive**: the six existing handlers, their inputs and the
`createAuth({ db, emit?, claim? })` seam are unchanged.

## Decision

### 1. Re-run idempotency — a redelivered hook emits exactly once

Both handlers gain a `dedupeKey` on their single emit, so the outbox unique
partial index (`domain_events_dedupe_unique`, ADR-0029 §7) collapses a redelivery:

```
auth.contact.changed      → `auth.contact.changed:${userId}:${at.toISOString()}`
account.sessions.revoked  → `account.sessions.revoked:${userId}:${at.toISOString()}`
```

where `at = deps.clock.now()`. The key is **instant-derived**, matching the
scheme ADR-0040 §3 already fixed for the 2FA and new-device events:

- it never carries a **raw contact** (nor a contact hash) into the append-only
  180-day outbox, which ADR-0040 §2 forbids;
- the boolean flags `{ emailChanged, phoneChanged }` alone are too coarse (a
  second email change would be suppressed), so they are not a usable key;
- a genuinely new change at a later instant re-emits.

`handleContactChanged` already skips the `contactChangeFanouts` insert when the
emit dedupes (`emitted.id === null`), so a re-run leaves **one** fan-out row as
well as one event row. The tests pin both.

### 2. 2FA transition re-emit — pinned at the section 5 surface

`handleTwoFactorToggled`'s key is unchanged
(`auth.2fa.{enabled|disabled}:${userId}:${at.toISOString()}`): a re-run of the
same invocation dedupes and a genuine transition re-emits. The RED pin drives
`enabled@T0 → disabled@T1 → enabled@T2` through the section 5 surface seam
(§3 below) and asserts **two** `auth.2fa.enabled` rows plus **one**
`auth.2fa.disabled` row. It is RED today because that surface seam does not
exist yet; once the seam delegates to the (already correct) handler, the pin
holds transitively.

### 3. Surface adapters — one seam per remaining section

**Contact-verified → a Better Auth database hook.** `createIdentityDatabaseHooks`
gains `user.update.after`, delegating to `handleContactVerified({ userId })`.
Better Auth fires it on the `emailVerified` / `phoneNumberVerified` writes; the
handler is idempotent (conditional `accountCompletedAt` update), so firing on
every user update is safe. Pinned by `S11`.

**Sections 4–6 → an injectable endpoint seam.** Because Better Auth has no
`after` hook that carries the transition, `@/server/auth/identity-lifecycle`
gains:

```ts
export interface IdentityLifecycleSeams {
  contactChanged(event: ContactChangedEvent): Promise<void>;
  twoFactorToggled(event: TwoFactorToggledEvent): Promise<void>;
  sessionsRevoked(event: SessionsRevokedEvent): Promise<void>;
}

export function createIdentityLifecycleSeams(wiring: IdentityHookWiring): IdentityLifecycleSeams;
```

Each method delegates to its handler with the wired `db`/`emit`/`clock` and is
wrapped in the existing `safeRun` (never throws; a failure logs
`identity_hook.failed`). The owning endpoint cards call one seam after their own
write:

| Section            | Surface                                            | Called by                                   |
| ------------------ | -------------------------------------------------- | ------------------------------------------- |
| 2 contact verified | `databaseHooks.user.update.after`                  | Better Auth (library-driven)                |
| 4 contact changed  | `createIdentityLifecycleSeams(...).contactChanged` | the contact-change endpoint card            |
| 5 2FA toggled      | `...twoFactorToggled`                              | the 2FA toggle endpoint card                |
| 6 sessions revoked | `...sessionsRevoked`                               | OP-91 `POST /api/v1/me/sessions:revoke-all` |

## Contract summary (what GREEN must add)

- `@/server/auth/identity-hooks`: `dedupeKey` on the `auth.contact.changed` and
  `account.sessions.revoked` emits (`eventKey:userId:at`). No new exports.
- `@/server/auth/identity-lifecycle`: export `createIdentityLifecycleSeams` and
  `IdentityLifecycleSeams` (signature above); add `user.update.after` to the
  returned `databaseHooks` block.
- No change to the handler event/deps types or `createAuth` options.

## Tests added (append-only; 9 specs, all RED for the right reason)

- `I8` ×2 — `handleContactChanged` twice ⇒ one `auth.contact.changed` row and
  one `contactChangeFanouts` row.
- `I9` — `handleSessionsRevoked` twice ⇒ one `account.sessions.revoked` row.
- `S8` ×3 — the contact-changed seam emits event + fan-out; a genuinely
  different change is a second row; a broken outbox does not throw (logs
  `identity_hook.emit_failed`).
- `S9` — the sessions-revoked seam emits one row.
- `S10` — the 2FA toggle seam re-emits across enable/disable/enable.
- `S11` — `user.update.after` completes the account and emits once.

Reproduced RED (`TMPDIR=/root/tmp-mongo vitest run --project integration
identity-hooks.test.ts`): 9 failed / 21 passed. The three idempotency specs fail
`expected length 1 but got 2`; the six surface specs fail
`expected 'undefined' to be 'function'`.

## Assumptions resolved unilaterally (flagged for the implementer)

- **Instant-derived, not content-derived, dedupe.** ADR-0040 §3's
  same-instant scheme is reused so no contact material can reach the outbox
  `dedupeKey`. The tests exercise the redelivery with an injected fixed clock,
  so a content-derived key that is privacy-safe would pass too, but it must not
  suppress a genuinely distinct transition (pinned by the "different change"
  case).
- **A contact hash in the key is rejected** for the same privacy reason ADR-0040
  §2 rejects contact material in the payload; the outbox row lives 180 days.
- **One seam factory, three methods.** Sections 4–6 share the factory because
  they share the wiring; better to add one import than three.
- **Contact-verified uses the database hook, not the seam,** because
  `user.update.after` genuinely exists and the handler is transition-agnostic
  (it re-reads the verified flags and no-ops until both are true).

## Consequences

- Sections 4–6 now fail RED for exactly one reason: `createIdentityLifecycleSeams`
  is not exported. Contact-verified fails RED because `user.update.after` is not
  wired. Idempotency fails RED because the emits carry no `dedupeKey`.
- A regression that double-emits a redelivered contact change or revoke-all,
  drops the fan-out row count, suppresses the second 2FA enable, or leaves the
  sections 4–6 surface unwired breaks at least one spec loudly.
- No production code was written by this card; the PR is a draft whose RED CI
  is the intended state (RED PRs are never merged).

## Alternatives considered

- **Drive sections 4–6 through Better Auth's `user.update.after` /
  `session.delete.after`.** Rejected: neither carries the previous value, so a
  contact change cannot compute `previous` and a revoke-all would fire once per
  deleted session; a per-transition seam is the honest surface.
- **Key the dedupe on the raw/ hashed contacts.** Rejected: the outbox is
  append-only (180-day TTL).
- **Lifetime `eventKey:userId` dedupe.** Rejected: it would suppress a second
  revoke-all or a repeated 2FA re-enable; the pinned "different change" and
  "re-emit" cases would fail.
- **Only pin at handler level.** Rejected for the 2FA transition: the handler
  already re-emits today (three distinct keys), so a handler-only pin is not RED;
  pinning through the unimplemented surface seam both stays RED and proves the
  surface the endpoint card must call.
