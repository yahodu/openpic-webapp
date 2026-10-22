# ADR-0221 — OP-98 GREEN: notification preferences, the merged read and the public type catalogue

- **Status:** Accepted · **Date:** 2026-10-22
- **Card:** OP-98 GREEN — _Notification preferences and public type catalogue_ (`t_d619efde`) · **RED predecessor:** `t_7cecac77` ([ADR-0220](ADR-0220-op98-notification-preferences-red.md))
- **Epic:** `1-Notifications / Preferences` · **Phase:** 1 · **Depends on:** OP-97 (in-app feed, merged `f95c50f`)
- **Branch:** `OP-98-task-notification-preferences` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_7cecac77`
- **ADR number:** `0221` — the OP-98 lane holds the reserved range `0220`–`0239` ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md); `docs/adr/README.md` § "Reserved ranges"). `0220` was consumed by [ADR-0220](ADR-0220-op98-notification-preferences-red.md), so the lane-local counter is `0221`. Drawn from the lane's own range, never from `origin/main`'s high-water mark or the index tail.
- **Touches:** `apps/web/src/server/notifications/preferences.ts` (new), `notification-types-read.ts` (new), `apps/web/src/app/api/v1/me/notification-preferences/route.ts` (new), `apps/web/src/app/api/v1/notification-types/route.ts` (new), `packages/contracts/src/errors.ts`, `apps/web/src/server/http/catalog.ts`, and `docs/adr/README.md` (range ledger + this record). **No test, mock, fixture or factory is modified** — the three RED specs _and_ ADR-0220 are byte-unchanged.

## Context

[ADR-0220](ADR-0220-op98-notification-preferences-red.md) pinned the settings half of the
notification system as three red suites: the pure module
(`mergePreferences` / `applyPreferencesPatch` / `isValidClockTime`), the
`GET`/`PATCH /me/notification-preferences` route pair and `GET /notification-types`
(contract §7.4, §7.6; design §19.1, §19.3, §5). This card implements exactly that
contract and nothing more.

## Decision

### The module (`apps/web/src/server/notifications/preferences.ts`)

`mergePreferences`, `applyPreferencesPatch`, `isValidClockTime`, `DEFAULT_PREFERENCES`
and the shared preference types, as pinned by ADR-0220. Two readings the RED review
traced to the shipped resolver are implemented literally:

- **A `global` `"on"` is reported `source: "default"`.** The catalogue default is
  `"on"` (design §5), so a `global` value of `"on"` carries no more information than
  the default; only a `global` `"off"` (or a more specific scope) is a real override.
  This is forced by the pinned `GET` case: a caller with no stored row renders
  `global` all `on` and yet `source: "default"` for an opt-outable email group.
- **A locked group reports `effective: "on"`, `source: "default"` but is still
  present.** A group that cannot be opted out of (`in_app`, `optOutAllowed: false`,
  or a transactional type) ignores a stored `off` entirely — the "locked toggles are
  reported, not hidden" acceptance criterion.

`resolved[]` carries exactly the type's **enabled** channel groups (a disabled group
is a routing fact, not a preference) and is grouped by category, categories sorted
for determinism. Labels are a read-route projection (`humaniseKey`), since the seed
stores no copy.

`DEFAULT_PREFERENCES` is declared `as const satisfies StoredPreferences` rather than
typed `: StoredPreferences`. The pinned unit spec asserts
`structuredClone(DEFAULT_PREFERENCES) as StoredPreferences`; annotating the constant
with the interface made that cast **unnecessary** and reddened the CI lint gate
(`@typescript-eslint/no-unnecessary-type-assertion`) on a test file this card may not
edit. `satisfies` keeps the assertion necessary while preserving the literal
`on`/`off` types and the runtime value — the constant is not changed to accommodate a
test, only its declaration style.

### The routes

- `GET /me/notification-preferences` reads the §19.3 `notificationPreferences`
  document (`{ userId }`), completed to the all-`on` `global` baseline, and merges it
  with the enabled catalogue. It never writes.
- `PATCH /me/notification-preferences` validates **before** any write — an
  unrecognised `byType` `typeKey` is `422 unknown_type_key`; disabling a locked group
  is `422 opt_out_not_allowed` with `details.{ typeKey, channelGroup, reason }`; a
  malformed quiet-hours clock is `422 validation_failed` (rejected by the body schema
  before the handler runs) — then applies the sparse patch, upserts and returns the
  full merged document.
- `GET /notification-types` serves the §7.6 projection of every enabled catalogue
  row, filters on `category`/`audience`, sets `Cache-Control: private, max-age=600`
  and never projects `retainBody`.

### The catalogue read and the sanctioned seed fallback (`notification-types-read.ts`)

Both routes read the catalogue through one accessor. When the collection is **empty**
a database has not yet been seeded (`instrumentation.ts` seeds at boot), so the
compile-time `SEED_NOTIFICATION_TYPES` stands in — mirroring the fan-out resolver's
`seededTypeRow` and guarded exactly as ADR-0098 §6 / ADR-0102 require: **production
throws** rather than serve the seed behind an empty catalogue, non-production logs
`notification.catalogue_fallback` at `warn`. This is what lets the pinned
preferences suite (which seeds only the preference document) resolve
`event.details.updated` honestly instead of against nothing.

### Error-code placement (RED review finding F1 — the handoff was wrong)

`opt_out_not_allowed` and `unknown_type_key` are **not** added to `ERROR_CATALOG`.
That table is typed `Readonly<Record<ErrorCode, …>>` (neither code is in
`ERROR_CODES`, so it would not typecheck) and `apps/web/src/server/http/errors.test.ts`
pins it to exactly the 23 base Appendix A rows. Instead:

1. `packages/contracts/src/errors.ts` — a new append-only
   `NOTIFICATION_ERROR_CODES` set, spread into `API_ERROR_CODES` and added to the
   `AppErrorCode` union;
2. `apps/web/src/server/http/catalog.ts` — a `NOTIFICATION_ERROR_TRANSPORT` table
   (both rows `422`, non-retryable, mirroring `REQUEST_SHAPE_ERROR_TRANSPORT`),
   spread into the private `TRANSPORT` table so `catalogEntryFor` resolves them.

This is the fourth code-set of the existing identity/auth/internal/request-shape
pattern; **the rejected alternative** (adding both rows to `ERROR_CATALOG`) would
both fail typecheck and redden a test this card may not edit. Contract Appendix A.8
already defines both rows with exactly the `details` the specs assert.

### Drive-by docs fix (RED review finding F3) — **declined, with evidence**

RED review finding F3 asked for missing spaces "after closing backticks" in ADR-0220
§ "Assumptions & open questions" (`` `default`source ``, `` no-row`GET` ``,
`` `global`all`on` ``), on the premise that "`prettier --check` is clean, so CI will
not catch it". **The premise is wrong**: this repository's Prettier actively
re-renders those code spans _without_ the space, so the spaces were **withdrawn**
rather than applied. Reproduced directly:

```
$ cp patched-paragraph.md docs/adr/_probe.md
$ npx prettier --check docs/adr/_probe.md
[warn] docs/adr/_probe.md   # the spaced form is NOT prettier-clean
$ npx prettier --write docs/adr/_probe.md && cat docs/adr/_probe.md
… This drives the `default`source and the no-row`GET` result (`global`all`on`).  # spaces removed
```

Applying F3 would therefore make the intended `prettier --check .` gate red — the
opposite of the intent. `docs/adr/ADR-0220-…-red.md` is left **byte-identical** to
its RED commit, and no ADR number is consumed. This is the only RED-review finding
declined; F1 is resolved above.

## Evidence

All commands run in `/root/openpic/openpic-webapp/.worktrees/t_7cecac77`.

```
vitest run --project unit apps/web/src/server/notifications/preferences.test.ts
  Test Files  1 passed (1) · Tests  37 passed (37)

vitest run --project integration \
  me-notification-preferences.test.ts notification-types-catalogue.test.ts
  Test Files  2 passed (2) · Tests  19 passed (19)

vitest run --project unit
  Test Files  90 passed (90) · Tests  1602 passed (1602)

vitest run --project integration
  Test Files  63 passed (63) · Tests  418 passed (418)

tsc -p packages/contracts/tsconfig.json --noEmit   # exit 0
tsc -p apps/web/tsconfig.json --noEmit              # exit 0
npx eslint .                                        # 0 errors (80 pre-existing security warnings)
npx prettier --check .                              # clean for every touched file
```

The three RED spec files are byte-identical to ADR-0220's commit (`ad0e16e`), as is
ADR-0220 itself (its F3 spacing fix was declined, above).

## Consequences

- The settings screen can be built generically from the two routes; the frontend
  never hard-codes the 81 `typeKey`s.
- `source` and `optOutAllowed` are decided once, in the pure merge, and are reused by
  both the `GET` and the `PATCH` `200` body.
- A rejected `PATCH` cannot leave a phantom override: every rejection path precedes
  the upsert.
- The seed fallback keeps a bootstrap-pending environment renderable while making
  production fail loudly instead of silently serving stale compile-time data.

## RED review sign-off (round-1, artifact-lens)

The RED parent `t_7cecac77` was **APPROVED WITH FINDINGS** by
`openpic-webapp-reviewer`; the review record is PR #247 (opened by the reviewer to
hold the review) with body comment
`https://github.com/yahodu/openpic-webapp/pull/247#issuecomment-6336031005` and one
inline comment (`discussion_r4345994684`) on the `opt_out_not_allowed` assertion.
No reviewer edits were made to the deliverable. F1 (the error-code placement) is
resolved above; F3 (the ADR-0220 code-span spacing) is **declined with evidence**
above. This GREEN turns PR #247 from red-by-design to green and requests review.

## Out of scope

- RED review findings **F2** (coverage gaps: cross-user isolation, no-write-on-reject
  for `unknown_type_key` / bad-clock, read-does-not-create) are routed to the
  downstream TEST card `t_4873d3d2`, gated on this card; this GREEN writes no tests.
- **F4** (the catalogue route reads all enabled rows per request; the contract
  mandates only the response `Cache-Control`, not a server-side cache) and **F5** (no
  rate-limit stage bound; the repo convention) are informational, tracked by the
  human.
- `GET`'s `resolvesTo` / `resolvesToReason` for the `mobile` group remain
  informational and are not emitted (ADR-0220 § "Assumptions").
- §7.5 unsubscribe/suppression, §7.7 domain events and the admin catalogue editor are
  later phases.
