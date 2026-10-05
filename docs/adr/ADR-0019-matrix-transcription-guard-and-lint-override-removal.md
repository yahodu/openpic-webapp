# ADR-0019 — §4 matrix transcription is guarded by a table-driven spec; the broad test-lint override is removed

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-84 follow-up RED (`t_13fc7d18`) · **Relates to:** [ADR-0016](ADR-0016-notification-routing-matrix-as-data.md) (frozen keys, inline-never-snapshot), [ADR-0017](ADR-0017-notification-routing-matrix-green-implementation.md) (the GREEN transcription and its coverage gap)
- **Schema:** §19.1, §19.2, §4 (matrix), §4.1 (authentication severity), §6 (dedupe/digest) · **Contract:** §7.6

## Context

Two non-blocking findings from the PR #123 review (card t_46ce87e5) required a
test-authoring follow-up:

1. **The transcription itself was unguarded.** `notification-types.test.ts` pins
   the structural invariants (U1–U9) plus a handful of rows; the _per-key_ §4
   channel/opt-out/throttle matrix and the §4.1 severity rule were never asserted
   against the seed. A real drift slipped through: `auth.account.completed` was
   `severity: "important"` while §4.1 says every authentication type is
   `critical`. This is exactly the drift the seed-as-data design (§8) exists to
   eliminate; only a key-by-key guard can catch it.
2. **The test-file lint override was over-broad.** `eslint.config.mjs` disabled
   `@typescript-eslint/no-unnecessary-type-conversion` and
   `@typescript-eslint/non-nullable-type-assertion-style` for **every** test file
   in the repo to accommodate ~7 sites in the OP-84 specs. Production code was
   unaffected, but the blast radius was repo-wide.

The follow-up also had to be RED-first: the new spec must fail against the
pre-fix seed, and the GREEN fix (the severity correction) is fanned out
separately.

## Decision

### 1. The whole §4 matrix is inlined as an expected table, never snapshotted

`notification-matrix.test.ts` transcribes all **81** §4 rows into an inlined
`MATRIX` table (key, category, `[in_app, email, mobile]`, opt-out, throttle
strategy) and asserts `SEED_NOTIFICATION_TYPES`/`SEED_NOTIFICATION_TEMPLATES`
against it, one `it.each` case per row and aspect. The expected values are
literal — **never** a Vitest snapshot — because a snapshot is written on first
run and would pass before the seed exists, making the red state vacuous
(ADR-0016 "The frozen 81-key list is inlined, never snapshotted").

The §4-table → routing-field mapping is fixed here so a future edit cannot
silently reinterpret a column:

- **`⚙️` (conditional) is transcribed as an enabled group.** `channelGroups[].enabled`
  is a boolean; the conditional rule ("mobile only at T-24h", "email only if
  ≥100 files") is a resolver concern, not a per-type toggle. Flagged as an
  assumption.
- **Opt-out** is the §4 Opt-out column (`Yes` → `true`, `"Yes (80 % only)"` →
  `true`), forced `false` on `in_app` (U4) and on any disabled group.
- **Throttle strategy** maps the §4 Throttle column: `—` and quota-folded rows →
  `none`; any `N/…` budget → `rate_limit`; "…digest" → `digest`; "coalesce N
  min" → `coalesce`. A row whose §4 basis is _dedupe_
  (`attendee.matches.ready`, "once per attendee+event (dedupe)") is `none`,
  because §6 treats dedupe as a separate mechanism from rate limiting.
- **Severity** is pinned only for `authentication`, where §4.1 is normative:
  every authentication type is `critical`. Per-category severity for the other
  sections is not normative in §4 and stays a later story's concern.

`SEED_NOTIFICATION_TEMPLATES` is asserted from the same table: an active `en-IN`
template exists for exactly the enabled groups and for no disabled one.

### 2. The two lint rules are removed by fixing the spec sites, not scoping the override

Instead of narrowing the override, the offending sites use a shared `requireType`
helper, exported from the test factories module
(`apps/web/src/test/factories/notification.ts`) and reused by both notification
specs, that throws when a key is missing, so no `as T` / `!` assertion is needed
at all:

```ts
// apps/web/src/test/factories/notification.ts
export function requireType(key: string): NotificationType {
  const type = SEED_NOTIFICATION_TYPES.find((candidate) => candidate.typeKey === key);
  if (type === undefined) throw new Error(`Missing seeded notification type: ${key}`);
  return type;
}
```

This satisfies both lint rules (no redundant `String()` wrap, no assertion the
rule wants to rewrite) **and** `@typescript-eslint/no-non-null-assertion`, which
the `!` substitution the first rule suggests would otherwise trip. Both rules are
deleted from `eslint.config.mjs`; lint is back to 0 errors repo-wide.

## Consequences

- **RED demonstrated:** `auth.account.completed` fails `expect(...severity).toBe("critical")`
  against the pre-fix seed (the only failure — every other row already matches
  the transcription). The GREEN severity fix is a separate card.
- A future edit that flips a channel, changes an opt-out, or swaps a throttle
  strategy now fails the suite with a message naming the exact key and aspect,
  instead of silently mis-routing a production notification.
- The `⚠️`/dedupe/severity mapping rules above are the single interpretation of
  §4 the guard encodes; a future §4 prose change must be transcribed here first.
- The lint override's blast radius is gone: the two type-aware rules are active
  for every test file again. `pnpm lint` is 0 errors (warnings from PR #123's
  `notification-templates.ts` / `seed-notification-types.ts` are pre-existing and
  non-blocking).
- **Out of scope:** the §4.1 severity correction itself (sibling GREEN card);
  per-category severity for non-auth sections; `label`/`description` requiredness
  (read-route projection, ADR-0016).

## Alternatives considered

- **Snapshot the seeded catalogue.** Rejected: a snapshot passes on first write
  and absorbs an unintended change silently (ADR-0016).
- **Scope the lint override to the OP-84 spec files.** Rejected: an alternative
  the card allowed, but it leaves the stylistic exemptions in the ruleset for
  files that no longer need them; `requireType` removes the need entirely and
  keeps the rules honest everywhere.
- **Replace `as T` with `x!` at each site.** Rejected: `@typescript-eslint/no-non-null-assertion`
  (part of `strictTypeChecked`) forbids `!`, so the substitution the
  `non-nullable-type-assertion-style` rule suggests just trades one error for
  another. A throwing helper removes the assertion instead of relocating it.
- **Pin non-auth severity now.** Rejected: §4 does not state it, so it would be a
  guess; ADR-0017 already flags it `TODO(product)`.
