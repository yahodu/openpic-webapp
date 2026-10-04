# ADR-0007 — `platformSettings` singleton: create-only seed, bounded guards, clock-once cache

- **Status:** Accepted · **Date:** 2026-10-04

## Context

OP-82 (`phase: 0-Foundations`, epic _Runtime Tunables_) makes every runtime knob
that used to be a hard-coded constant — dunning grace, reminder schedule,
pipeline lease, upload limits, notification poll cadence — readable from a single
document so an operator can change a threshold **without a deploy**. The
authoritative shape is schema §20.4 and the guard ranges are contract §9.10:

> Validation guards: `gracePeriodDays` 1–60; `reminderDays` strictly increasing
> and all `< gracePeriodDays`; `leaseMinutes` 1–60; `pollIntervalSeconds` 10–300.
> `422 setting_out_of_range` otherwise.

The RED tests in this card (`tdd_stage: RED`, no production code required) fix
the module contract before the GREEN implementer writes it. Several decisions in
that contract were not pinned by the card text and had to be chosen; they are
recorded here so the implementer and any future refactor cannot drift from them.

## Decision

The module lives at `apps/web/src/server/settings/platform-settings.ts`
(import specifier `@/server/settings/platform-settings`) and exports
`PlatformSettings`, `PLATFORM_SETTINGS_DEFAULTS`, `SETTING_BOUNDS`,
`checkSettingBound`, `validateReminderDays`, `getPlatformSettings`,
`invalidatePlatformSettings`, `seedPlatformSettings`.

1. **Bounds are pinned by value, not derived.** `SETTING_BOUNDS` is exactly the
   three bounded scalars from §9.10, with literal ranges `gracePeriodDays 1–60`,
   `leaseMinutes 1–60`, `pollIntervalSeconds 10–300`. U1 asserts the _literal_
   ranges and the inclusive edges (`min`/`max` accepted; `min−1`/`max+1`
   rejected). An earlier revision derived the expected range from `SETTING_BOUNDS`
   itself, so a stale (`max: 61`) or widened (`min: 0, max: 1000`) range would
   have passed — that is corrected.
2. **`checkSettingBound` returns `null` when in range, else the violation
   `{ key, min, max }`** — the exact `details` shape of `422 setting_out_of_range`
   (contract Appendix A.2), so the later admin route can forward it unchanged.
3. **`validateReminderDays` precedence is pinned.** A day is flagged
   `not_strictly_increasing` when it is not `> previous`, else `not_before_grace`
   when it is not `< grace`. Exactly one violation per offending index, and the
   result is ordered by index. (Any index that both fails to increase and is
   `>= grace` necessarily follows a day that is itself `>= grace`, so the
   previous index is reported `not_before_grace` and the shared index reports
   `not_strictly_increasing`.)
4. **Seeding is create-only idempotent.** `seedPlatformSettings` upserts on
   `_id: "singleton"` with `$setOnInsert`, stamping `updatedAt` (from the clock)
   and `updatedByUserId`. Running it twice leaves exactly one document and never
   resets a value an operator already changed. A `$set` upsert (reset-to-defaults)
   is explicitly rejected.
5. **The read cache reads the injected clock exactly once per call and keys its
   TTL on that single reading.** Cache hits return the same object reference;
   `invalidatePlatformSettings()` clears it so the very next `get` hits the DB.
   The default TTL is recommended at 30 s and is not asserted, so the tunable
   stays an implementation choice.
6. **Persistence goes through `platformRepo(db).collection("platformSettings")`.**
   `platformSettings` is platform-scope (no `tenantId`), so `platformRepo` — not
   `tenantRepo` — is correct, and the `no-direct-collection-access` ESLint rule
   forbids raw `db.collection(...)` under `apps/web/src/**`.

## Consequences

- A wrong guard range or a non-inclusive boundary now fails U1 instead of silently
  shipping. Widening a range is a deliberate, test-visible change.
- Operators can tune a value and rely on the seeder never clobbering it on the
  next cron/deploy; recovering the documented default requires an explicit admin
  write (owned by the later `GET/PATCH /admin/settings` story).
- The clock-once rule makes the fixedClock TTL spec (U3) deterministic; an
  implementation that reads `clock.now()` more than once per call will flip the
  cache expire/populate branches and fail.
- The admin route, `If-Match`/ETag handling, the `reason` requirement and the
  Zod request/response schemas in `packages/contracts` are **out of scope** for
  this story and are not covered by these tests.
- Missing-singleton behavior (`getPlatformSettings` fallback-to-defaults vs
  throw) is deliberately unspecified here and is pinned by the admin-route story.

## Alternatives considered

- **Reset-to-defaults seed (`$set` upsert)** — rejected: a cron/deploy re-run
  would silently revert an operator's tuned threshold, defeating the story's
  purpose ("thresholds change without a deploy").
- **Per-key bound guards** (a function per tunable) — rejected: one
  `SETTING_BOUNDS` table plus `checkSettingBound` keeps the `{key,min,max}`
  error shape uniform and lets the admin route enumerate valid keys.
- **Cache keyed on an absolute expiry computed outside the cache** — rejected:
  makes the cache read the clock at construction rather than per call, which the
  injected-clock test cannot drive deterministically.
