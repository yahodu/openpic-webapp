# ADR-0220 — OP-98 RED: notification preferences and the public type catalogue

- **Status:** Accepted · **Date:** 2026-10-22
- **Card:** OP-98 RED — _Notification preferences and public type catalogue_ (`t_7cecac77`) · **GREEN successor:** `t_d619efde` (inherits this branch/worktree)
- **Epic:** `1-Notifications / Preferences` · **Phase:** 1 · **Depends on:** OP-97 (in-app feed, merged `f95c50f`)
- **Branch:** `OP-98-task-notification-preferences` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_7cecac77`
- **ADR number:** `0220` — the OP-98 lane holds the reserved range `0220`–`0239` ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md); `docs/adr/README.md` § "Reserved ranges"). `0220` is the first and only number consumed by this lane so far. Drawn from the lane's own range, never from `origin/main`'s high-water mark or the index tail.
- **Touches:** three new test files **only**. No production code, schema, route, mock, factory or fixture is created or edited.

## Context

OP-98 is the settings half of the notification system. Two surfaces are specified by
`docs/API Contract.md` §7.4 and §7.6 and elaborated by
`docs/Notification and Database Design.md` §19.1, §19.3 and §5:

1. `GET` / `PATCH /api/v1/me/notification-preferences` — one read returns the user's stored overrides
   **merged with** the catalogue defaults, per channel group, with the **source** of each resolved value
   labelled along the precedence chain `transactional > byEvent > byType > global > catalogue default`.
   The `PATCH` is a **sparse patch**; `null` removes an override and reverts it to the next-most-general
   scope. Transactional types and `in_app` can never be opted out of (design rule 7).
2. `GET /api/v1/notification-types` — the 81-key catalogue **as data** so the settings screen is built
   generically, `Cache-Control: private, max-age=600`, and `retainBody` **never** exposed (it governs
   the internal dispatch ledger for OTP types; design rule 6).

The card fixes the RED scope: unit `U1` (merge + source labelling per precedence level), `U2` (sparse
patch reducer: set / `null`-remove / untouched), `U3` (the `HH:MM` validator), and integration `I1`–`I4`
(opt-outable `byType` off resolves to `source: type`; a transactional opt-out is `422 opt_out_not_allowed`;
`null` reverts to `global`; the catalogue omits `retainBody` and sets the cache header).

## Decision

**Pin the three pure behaviours in a new module and the two surfaces in a new route pair, and test them
before either exists.** This RED delivers only the executable specification; the GREEN card
(`t_d619efde`) implements it.

### The module contract the tests expect

`apps/web/src/server/notifications/preferences.ts` (new in GREEN) exports:

| Export                                                                             | Behaviour                                                                                                                                                                |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mergePreferences({ preferences, catalogue, eventId? })`                           | Merge stored overrides × catalogue into the §7.4 merged document, `resolved[]` grouped by category, each channel `{ effective, optOutAllowed, source }`.                 |
| `applyPreferencesPatch(stored, patch)`                                             | The sparse reducer behind `PATCH`: set present keys, delete explicit `null`s (pruning emptied parents), leave absent keys untouched. **Pure — never mutates its input.** |
| `isValidClockTime(value)`                                                          | `HH:MM` 24-hour validator, `00:00`–`23:59` only.                                                                                                                         |
| `DEFAULT_PREFERENCES`                                                              | The no-override baseline: `global` all `on`, empty sparse maps, quiet hours disabled, `en-IN`.                                                                           |
| `PreferenceValue` / `PreferenceSource` / `StoredPreferences` / `MergedPreferences` | The types the route and the tests share.                                                                                                                                 |

### The route contract the tests expect

- `apps/web/src/app/api/v1/me/notification-preferences/route.ts` (new in GREEN) exports `GET` and
  `PATCH`, both guarded with the `user` label, reading/upserting the §19.3 `notificationPreferences`
  document (`{ userId }` unique) and merging through the module above. `PATCH` `200` returns the full
  merged document; `422 opt_out_not_allowed` (`details.{ typeKey, channelGroup, reason }`),
  `422 unknown_type_key` (`details.typeKey`) and `422 validation_failed` (a bad `HH:MM` clock) are the
  rejection paths.
- `apps/web/src/app/api/v1/notification-types/route.ts` (new in GREEN) exports `GET`, guarded with the
  `user` label, serving the §7.6 projection of every **enabled** `notification_types` document as
  `{ data: [...] }`, with `Cache-Control: private, max-age=600` and **no** `retainBody`.

The tests import these paths directly (`@/server/notifications/preferences`,
`@/app/api/v1/me/notification-preferences/route`, `@/app/api/v1/notification-types/route`) and call
the handlers with a `Request`, asserting on the `Response`. Because the modules do not exist yet, every
suite is RED with a _module-not-found_ failure — the honest red state for a not-yet-written module.

### Which groups resolve, and what "locked" means

`resolved[].channels` carries exactly the type's **enabled** channel groups; a disabled group is
omitted (a routing fact, not a preference). For each group:

- a **transactional** type forces `effective: "on"`, `optOutAllowed: false`, `source: "transactional"`;
- otherwise, the precedence chain
  `byEvent[eventId] > byType[typeKey] > global > "on"` decides the value and the
  `event | type | global | default` source;
- an override is **ignored** (value `"on"`, `optOutAllowed: false`, `source: "default"`) when the group
  cannot be opted out of — `optOutAllowed: false`, `in_app` (never opt-outable, design rule 7), or a
  transactional type. This is the card's "locked toggles are reported, not hidden" criterion: the entry
  is still present.

### Test files delivered (all RED)

- `apps/web/src/server/notifications/preferences.test.ts` — U1/U2/U3, 37 unit cases.
- `apps/web/src/test/integration/me-notification-preferences.test.ts` — auth + I1/I2/I3 plus
  `unknown_type_key` and the `HH:MM` rejection.
- `apps/web/src/test/integration/notification-types-catalogue.test.ts` — auth + I4 plus the §7.6 shape
  and the `category`/`audience` filters.

## Evidence

All commands run in `/root/openpic/openpic-webapp/.worktrees/t_7cecac77` on a clean fast-forward of
`origin/main` (`cb7fff7`, which carries OP-97's feed).

**RED, after the stubs are removed:**

```
vitest run --project unit apps/web/src/server/notifications/preferences.test.ts
  Error: Cannot find package '@/server/notifications/preferences'
  Test Files  1 failed (1) · Tests  no tests

vitest run --project integration me-notification-preferences.test.ts notification-types-catalogue.test.ts
  Error: Cannot find package '@/app/api/v1/me/notification-preferences/route'
  Error: Cannot find package '@/app/api/v1/notification-types/route'
  Test Files  2 failed (2) · Tests  no tests
```

**Type-correctness probe.** The intended contract was implemented as a throwaway stub at the three
expected paths, `tsc -p apps/web/tsconfig.json --noEmit` returned **exit 0**, and the unit suite then ran
**37 tests (29 failed / 8 passed) with assertion failures only — no harness or import error** — proving
the tests execute against a plausible contract and fail for behavioural reasons. All three stubs were
then deleted; `git status` lists only the three new test files.

## Consequences

- The GREEN card has an exact, executable definition of every function signature, route, status code
  and body shape it must produce — no guessing.
- U1's merge function takes an optional `eventId` so all five `source` levels are reachable in a unit
  test. The `GET` route calls it **without** `eventId` (the settings screen is not event-scoped), so
  `source: "event"` appears only when a caller supplies the event — consistent with §7.4, which lists
  `event` in the vocabulary but shows no `eventId` parameter.
- The `PATCH` rejection paths must write nothing: I2 asserts the stored document is unchanged after a
  rejected transactional opt-out, so a "validate after write" implementation cannot pass.

## Assumptions & open questions

- **Catalogue default is `"on".** A preference document stores only overrides; the absence of an
override means the send happens (design §5). This drives the `default`source and the
no-row`GET` result (`global`all`on`).
- **A locked group reports `source: "default".** When a group cannot be opted out of, the stored value
is not a preference at all — the winning value is the forced `"on"`. An alternative reading (report
the stored scope with `effective: "on"`) is possible; it is rejected here because a `source: "global"`entry whose`effective`contradicts the stored`global` value would be incoherent to render.
- **`resolved[].label` / `resolved[].category` labels and the catalogue `label`/`description` are not
  pinned to exact prose.** The seed stores no copy (`notification-types.values.ts` header), so the tests
  assert a non-empty `label` string and a `description` of type `string` only. A humanised fallback
  (e.g. `auth.otp.email.requested` → `Auth Otp Email Requested`, the shape already used by
  `notification-templates.values.ts`) satisfies this; real product copy is a later decision.
- **`resolvesTo` / `resolvesToReason` for the `mobile` group are deliberately not pinned.** They are
  informational and depend on the recipient's `contactCapabilities`, which the settings read does not
  load; guessing them would over-constrain the GREEN. They are out of scope for this RED.
- **An unknown `category`/`audience` filter returns `data: []`, not `422`.** §7.6 names no error for it
  and the query is a filter, not a validated enum.
- **Only enabled types are served.** A disabled catalogue row is a routing fact the settings screen must
  not offer.

## Out of scope

- No production code of any kind (this is the RED card). The GREEN successor implements to these tests.
- `PATCH`'s full validation matrix beyond the pinned cases (digest-enum rejection, `global` group
  validation, the `scope`-based `all`/`marketing` unsubscribe of §7.5) is not pinned here; only the
  three rejection paths §7.4 names plus the `HH:MM` gate are.
- §7.5 unsubscribe/suppression, §7.7 domain events and the admin catalogue editor are later phases.
- The `notificationPreferences` defaults written at account creation by `identity-hooks.ts` (global
  `mobile: "off"`, quiet hours enabled) are **not** reconciled with the module's no-override baseline in
  this RED; the integration specs seed a deterministic document per test instead of relying on the hook.
