# ADR-0008 — `platformSettings` GREEN implementation: full §20.4 schema, defaults fallback, deferred §4

- **Status:** Accepted · **Date:** 2026-10-04
- **Relates to:** [ADR-0007](ADR-0007-platform-settings-singleton.md) (the module contract)
- **Card:** OP-82 GREEN

## Context

ADR-0007 fixed the _contract_ of the `platformSettings` module from the RED
specs: module path, export names, the three bounded scalars, the reminder-day
precedence, the create-only seed and the clock-once cache. The GREEN card
(`t_9098a24b`) then had to write the implementation, and three decisions it
confronted were deliberately left open by ADR-0007 or by the card's prose:

1. ADR-0007 §5 says the default cache TTL is "recommended at 30 s and is not
   asserted" — a value had to be chosen.
2. ADR-0007's consequences say missing-singleton behaviour
   (`getPlatformSettings` fallback-to-defaults vs throw) "is deliberately
   unspecified here and is pinned by the admin-route story".
3. The card body lists the full schema §20.4 (`retention`, `face`, `pipeline`,
   `upload`, `notifications`) plus additive sections (`account.deletionGraceDays`,
   `legal.policies[]`, `limits.selfieMaxBytes`, `invitations.expiryDays`) and an
   §4 upload type-guard. The OP-82 RED specs exercise only `dunning` and
   `notifications`.

## Decision

1. **The full schema §20.4 is implemented** — `dunning`, `retention`, `face`,
   `pipeline`, `upload`, `notifications` — because card §1 ("a Zod schema of the
   `platformSettings` singleton (schema §20.4 + contract §9.10)") requires the
   document shape, and later stories read their tunables from here. Only
   `dunning` and `notifications` are exercised by OP-82's RED specs; the
   remaining sections are contract-shaped but currently untested (see
   Consequences — a coverage gap to be pinned by their owning stories).
2. **One bounds source.** `SETTING_RANGES` (a `ReadonlyMap`) holds the three
   literal ranges; `SETTING_BOUNDS` and the Zod field bounds are both derived
   from it, so they cannot drift. U1 still pins the literal values and inclusive
   edges independently, per ADR-0007 §1.
3. **Default cache TTL is 30 000 ms**, matching the ADR-0007 recommendation. It
   stays overridable per call and unasserted.
4. **A missing singleton falls back to the documented defaults** (stamped with
   `updatedAt = <clock now>` and `updatedByUserId: null`) instead of throwing, so
   the read path is total. This is the choice ADR-0007 left to the admin-route
   story; the fallback is a safe default until that story pins the behaviour.
5. **§4 (upload type guards) and the additive sections are out of scope** for
   this card, per the OP-82 review scope (`t_79815559` RED → `t_41a594b8`
   GREEN). `upload.supportedMimeTypes` ships a provisional image allow-list
   pending the product confirmation the card flags; it is not consumed by any
   test yet.

## Consequences

- `checkSettingBound` returns the exact `{ key, min, max }` of
  `422 setting_out_of_range`, so the later admin route forwards it unchanged.
- The seed is `$setOnInsert`-only, so a cron/deploy re-run can never clobber an
  operator's tuned value (integration I1 pins this).
- The read cache reads the injected clock exactly once per call, so the
  `fixedClock` TTL spec (U3) is deterministic.
- **Coverage gap:** `retention`, `face`, `pipeline` and `upload` (apart from the
  shape implied by `PLATFORM_SETTINGS_DEFAULTS`), the defaults-fallback branch,
  and `boundedInt`'s unknown-key guard are not pinned by any OP-82 spec. They
  are implemented to the contract shape and should be pinned by the stories that
  own those tunables. The module still clears the global coverage threshold
  (91 % lines at delivery).
- §4's magic-byte guard (415 `unsupported_format`, delete-and-write-nothing) and
  the additive sections land on `t_41a594b8`; this module must be extended there,
  not here.

## Alternatives considered

- **Minimal `dunning`/`notifications`-only schema** — rejected: card §1 and the
  acceptance criterion "later stories read tunables only from here" require the
  whole §20.4 document; a partial schema would force every later story to widen
  it.
- **Throw on a missing singleton** — rejected: the read path is called from
  request handlers and should not 500 on a not-yet-seeded deploy; the
  fallback-to-defaults is the safe, documented value. ADR-0007 permitted either.
- **Deriving `SETTING_BOUNDS` from the Zod schema** — rejected: the guard table
  is the contract's flat error surface, and U1 pins it by literal value; making
  the schema the source would invert the dependency the test fixes.
