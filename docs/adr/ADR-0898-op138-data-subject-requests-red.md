# ADR-0898 — OP-138 RED: data subject requests, consent history and policy acknowledgement

- **Status:** Accepted
- **Date:** 2026-11-20
- **Card:** `t_a99f5cce` (OP-138, phase 6-M2M — Jobs & Compliance, epic Compliance,
  `tdd_stage: RED`, dependencies OP-131 and OP-88)
- **Branch:** `OP-138-task-dsr-consent-policy-red`
- **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_a99f5cce`
- **Number allocation:** first card of the **OP-138 lane**, which holds
  `0898`–`0917`; this record consumes `0898`, the lane's `Next free` cell reads
  `0899`, and **both** the `OP-136 jobs lane` cell and the `unallocated (future
lanes)` cursor advance to `0918` (§11 item 18: the block is cut from the pool,
  so every cell that named the pool head moves past the block, not onto its first
  number).
  This is a **re-number**: the round-1 review found `0897` minted twice
  (C1). The first draft of this record drew `0897` from the pool while PR
  [#768](https://github.com/yahodu/openpic-webapp/pull/768) — the OP-137
  contact-digest pin card — held `ADR-0897-op137-contact-digest-writer-pins.md`
  in flight; #768 has since squash-merged as `d1f99b8a`, so `0897` is now
  **trunk-owned** and this lane cannot start there. Every live surface was
  re-enumerated immediately before this commit, and the sweep now includes the
  open-PR-head source ADR-0300 §12 item 23 requires (the first draft read
  `origin/main` and the worktrees only):
  - `origin/main` `d1f99b8a` carries `ADR-0897` as its highest record;
  - every `.worktrees/*/docs/adr` tree stops at `0897` (this branch's pre-rename
    head is the only holder, and the rename is this commit);
  - the open PR heads carry `0897` at most (#769 this branch before the rename,
    #755 `0889`, #743 `0881`, #272 `0306`; #768's `0897` is now on the trunk);
  - `git rev-list --objects --all -- docs/adr` resolves no `ADR-0898` object;
  - the reserved-range table's two `Next free` cells read `0898` on `d1f99b8a`.

  So the pool head `0898` is free and this block starts there. The block is
  20 numbers wide (`0898`–`0917`, the board's fixed lane width, §10 item 13: a
  fresh block starts above the highest in-flight range **and** outside every
  reserved range — the highest reserved end is `0868`, so no row intersects).
  No cell is lowered and no range is re-cut.

## 1. Context

Contract §8.1 and §8.2 describe a resource the platform owes every data subject:
the right to file an access, erasure or portability request, to be told a
statutory deadline, to read back what was actually deleted, and to see the
consent records that make a processing decision demonstrable years later. §0.3
also makes exactly one promise about a _banned_ account — `GET /me` and
`POST /me/data-requests` stay open — and §0.3's ban rule already carries the
`allowBanned` flag for it, unused until now.

The card delivered only a test list, so this record fixes every contract detail
the tests pin: the pure rules, the module paths and signatures, the request and
response shapes, the new settings keys, the new error code, the new rate-limit
class and the collection shape. The GREEN card `t_ab90931d` carries the same
endpoint list and is the implementation's brief.

## 2. Decision — the pure rules (`@/server/compliance/data-request`)

```ts
export const DSR_REGULATIONS = ["gdpr", "dpdpa"] as const;
export const DSR_REQUEST_TYPES = [
  "access", "erasure", "rectification", "portability", "consent_withdrawal",
  "correction", "restriction", "objection", "nomination", "grievance",
] as const;

resolveRegulation(input: {
  requested?: DsrRegulation;
  tenantDataRegion?: "in" | "eu" | null;
  callerCountry?: string | null;
}): DsrRegulation;

computeSlaDueAt(
  now: Date,
  regulation: DsrRegulation,
  settings: { compliance: { slaDays: Record<DsrRegulation, number> } },
): Date;

resolveAttendeeScope(
  requested: readonly string[] | undefined,
  sessionEventIds: readonly string[],
): readonly string[];
```

- **Regulation precedence is body → tenant → geo → platform default.** An
  explicit `regulation` wins outright; then the tenant's `dataRegion`
  (`eu` → `gdpr`, `in` → `dpdpa`); then the caller's ISO 3166-1 alpha-2 country
  (an EU member → `gdpr`, `IN` → `dpdpa`); otherwise `dpdpa`, because the
  platform's own default data region is `in` (`tenancy/projection.ts`) and a
  caller the platform cannot attribute is served the home jurisdiction's law.
  The EU list lives in the module; the route resolves the country from its own
  transport seam (out of scope here — see §6).
- **The deadline is milliseconds-exact**: `now + slaDays[regulation]` 24-hour
  days in UTC, never rounded to midnight. §8.1 fixes the acknowledgement
  sentence ("by 25 October 2026"), which the route renders from this instant; a
  rounding rule would make the stored deadline disagree with the promise for any
  request filed after 00:00 UTC.
- **The attendee scope is the session's `eventIds`.** Omitted → the session's
  events; a subset → itself, request order preserved, duplicates collapsed; an
  empty array → refused (a request about nothing); any id outside the session →
  `422 invalid_scope` with `details.eventIds` naming the offenders.
- **`slaDays` is settings, not a constant** (§20.4's "every number quoted
  anywhere in this document is read from here"). Defaults are `{gdpr: 30,
dpdpa: 30}`, the window §8.1's own example shows.

## 3. Decision — the endpoints

| Endpoint                               | Contract                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/me/data-requests`        | user **or** attendee; `Idempotency-Key` required; 5 / day / principal; `202` with exactly `{id, requestType, status, slaDueAt, acknowledgement, pollUrl}`; one `dataSubjectRequests` row; one `privacy.dsr.received` outbox row per accepted create, `tenantId` = the scope's tenant, `payload` carrying `requestType`, `regulation` and `slaDueAt` |
| `GET /api/v1/me/data-requests`         | the caller's rows only, in §0.8's `{data, page}` envelope (the shape `GET /me/events` and `GET /me/notifications` answer, because §8.1 documents only the single-request body)                                                                                                                                                                      |
| `GET /api/v1/me/data-requests/{id}`    | the owner's row in §8.1's shape, `executionLog` counts included, `export: null` while nothing is ready; anybody else's id is `404 not_found`                                                                                                                                                                                                        |
| `GET /api/v1/me/consents?purpose=`     | a bare array (§8.2 spells it `[{ … }]`), each row carrying `policyDocumentHash`                                                                                                                                                                                                                                                                     |
| `POST /api/v1/me/consents/acknowledge` | `201` and one `consents` row; a version the platform no longer serves is `422 policy_version_stale` with `details.currentPolicyVersion` + `details.policyUrl`, and writes nothing                                                                                                                                                                   |
| `GET /api/v1/legal/policies/current`   | public, `Cache-Control: public, max-age=3600`, one entry per purpose (`terms_of_service`, `biometric_processing`) with `version`, `url`, `effectiveFrom`, `documentHash`; the biometric pair is `platformSettings.legal.biometricPolicyVersion`/`Url`                                                                                               |

`acknowledgement` is §8.1's sentence verbatim, rendered from `slaDueAt` as
`25 October 2026` (`en-GB`, UTC).

The filing route's auth is a **combined** stage, because §0.3's table lets an
attendee session satisfy only the `attendee` label and a user only the user
labels: the route resolves the principal itself and enforces `attendee` for an
anonymous session and `user` with `allowBanned: true` for an account
(precedents: `POST /me/media/signed-urls` and `requireAttendeeSubject`).

## 4. Decision — the schema additions

- **`platformSettings.compliance.slaDays`** — a new defaulted section
  (`{gdpr: 30, dpdpa: 30}`), documented in §20.4's singleton.
- **`platformSettings.legal`** gains `termsPolicyVersion`, `termsPolicyUrl` and
  `effectiveFrom` (defaults `tos-2026-03`, its URL, `2026-03-01T00:00:00.000Z`),
  because §8.2 needs a second policy document and a verifiable effective date.
- **`COLLECTIONS.dataSubjectRequests`** — the §20.3 collection, read by name.
- **`COMPLIANCE_ERROR_CODES = ["invalid_scope"]`** with its own
  `COMPLIANCE_ERROR_TRANSPORT` (`422`, non-retryable), never `ERROR_CATALOG`,
  which `catalog.test.ts` pins to exactly Appendix A. `invalid_scope` is not an
  Appendix A row, so the contract owes it a row (routed as a finding).
- **`RateLimitClass` gains `compliance.dsr`** — `{scope: "user", limit: 5,
windowSeconds: 86_400}`, contract §8.1's "5 / day / principal". Contract §0.11
  has no DSR class, so §0.11 owes a row (routed as a finding). This RED **owns
  both halves** of that addition, because `rate-limit/classes.test.ts` is the
  executable copy of §0.11 and an implementer may not edit a test: the lane
  appends `compliance.dsr` to `CONTRACT_CLASSES`, its exact rule to
  `LANE_RULES` (`[{ scope: "user", limit: 5, windowSeconds: 86400 }]`, asserted
  with `toEqual`, so neither the limit nor the window can drift) and its policy
  membership to `FAIL_OPEN`. The rule sits in `LANE_RULES` and not in
  `CONTRACT_RULES` for the reason `attendee.session` does: `CONTRACT_RULES` is
  the trunk-owned copy of §0.11 and §0.11 has no DSR row yet, so writing it there
  would claim the contract already declares a class it does not. Those arrays are typed on the production
  `RateLimitClass` union, so until the GREEN adds the member the spec carries a
  `tsc` diagnostic naming it — the same compile-time contract `attendee.session`
  carries (ADR-0787 §Review), and the intended RED for "the union must gain this
  class". At runtime two cases red: "configures every class named in the contract
  and no others" (`expected … to deeply equal …`, `compliance.dsr` missing) and
  the `it.each` rule case (`contract §0.11 class compliance.dsr is missing from
RATE_LIMIT_CLASSES`).
- **The failure policy is `fail-open`.** `rateLimitFailurePolicy("compliance.dsr")
=== "fail-open"`. **Reason:** the class is authenticated — a user account or an
  anonymous attendee session, and the latter is already capped at 60 / hour / IP
  by `attendee.session` before it reaches this route — and every allowed call
  writes a self-scoped, `Idempotency-Key`-guarded row that no external party ever
  receives: a DSR is inert until an admin queue (OP-150) executes it, so an
  outage-induced burst makes reviewable no-op rows, not mail, SMS or a
  credential. The `FAIL_CLOSED` membership the other classes share is argued from
  the opposite facts — unauthenticated and every allowed call mints a durable
  credential or sends to a third party (ADR-0787 §2) — and neither holds here.
  Against that, `503` would refuse a **statutory right** (DPDPA / GDPR) for the
  duration of a Redis outage while the deadline that starts at `receivedAt`
  cannot be met at all; the right is better served by accepting the request and
  recording it. The observable of a fail-open class is the request proceeding
  with no `503`, which is what `I1`/`I5` already depend on.

## 5. Evidence (this RED)

- **Delivered:** `apps/web/src/server/compliance/data-request.test.ts` (19
  cases: U1 8, U2 4, U3 6, plus the request-type enumeration),
  `apps/web/src/test/integration/data-subject-requests.test.ts` (24 cases from
  15 `it()` declarations, `I8` being a ten-row `it.each`),
  `apps/web/e2e/data-requests.spec.ts`
  (E1) and the lane's half of
  `apps/web/src/server/rate-limit/classes.test.ts` (40 → 42 cases: the
  `compliance.dsr` policy row in `FAIL_OPEN` and its exact-rule row in
  `LANE_RULES`), with this record and the ledger. The rate-limit edit is
  additive — every pre-existing class, rule and policy in that file is
  byte-identical — because the round-1 review found the GREEN could not go green
  without editing a test (M1), and an implementer may not.
- **Case inventory, so the card can be counted line by line:** unit — `U1` 8
  (regulation ladder), `U2` 4 (settings-driven SLA), `U3` 6 (attendee scope),
  `U0` 1 (the ten types) = 19; integration — `I1` 202 with `slaDueAt` and one
  domain event, `I2` out-of-session scope 422, `I3` banned account 202,
  `I4` another user's request 404, `I5` sixth request 429, `I6` stale policy
  version 422, `I7` 2 (cache header + both purposes hashed), `I8` ten rows (one
  per type), `I9` anonymous session scoped to its own event, `I10` execution log
  and null export, `I11` list isolation, `I12` consent history,
  `I13` 401, `I14` 400 idempotency, `I15` 422 validation = 24; e2e — `E1` files an
  erasure request and polls it = 1. `rate-limit/classes.test.ts` adds the two
  lane rows to its existing 40.
- **Honest RED:** the unit spec fails with `Cannot find module
'./data-request'`; the integration spec fails with `Cannot find package` for
  each of the five route modules; `classes.test.ts` fails **2 of 42** at
  assertion level — "configures every class named in the contract and no others"
  (`expected [… 14] to deeply equal [… 15]`, the diff naming `compliance.dsr` on
  the expected side) and "configures compliance.dsr with exactly its §0.11
  rules" (`contract §0.11 class compliance.dsr is missing from
RATE_LIMIT_CLASSES`). `tsc -p apps/web/tsconfig.json --noEmit` names each
  module the GREEN must create plus the two `TS2322` rows the typed `LANE_RULES`
  and `FAIL_OPEN` arrays raise for `"compliance.dsr"` — the compile-time half of
  "the production union must gain this class", the same contract `attendee.session`
  carries (ADR-0787 §Review).
- **The whole `unit` project was run to bound the blast radius:** on this head
  it is `2 failed | 189 passed (191)` files and `2 failed | 3185 passed | 3
skipped (3190)` cases — the two failures are exactly this RED's
  (`data-request.test.ts` at module resolution and `classes.test.ts`'s two
  assertion-level cases), so no other unit spec reddens and the GREEN needs no
  test edit anywhere else. Only one spec file in the tree names `RATE_LIMIT_CLASSES`
  or `rateLimitFailurePolicy`, and it is `classes.test.ts`. The `integration`
  project's only change is the new spec (module-resolution red); no other
  integration file is in the diff, so nothing else in that project is touched by
  construction. The seven `adr-*` guard files are **green** on this head
  (`248 passed (248)`) now that this record and its ledger row exist.
- **M1 satisfiability probe (throwaway worktree at `de7751ee`, deleted):** the
  round-1 review's M1 objection was that the GREEN could not go green without
  editing a test, so the rate-limit half was measured rather than argued. Adding
  only the union member and the table row to
  `apps/web/src/server/rate-limit/classes.ts` — no test touched — answers
  **`42 passed (42)`**. Two single-anchor mutations of the same probe then
  reddened exactly one case each: moving the class into `FAIL_CLOSED_CLASSES`
  answers `1 failed | 41 passed (42)` at "U4: compliance.dsr fails open"
  (`expected 'fail-closed' to be 'fail-open'`), and narrowing the window to
  `3600` answers `1 failed | 41 passed (42)` at "configures compliance.dsr with
  exactly its §0.11 rules" alone. The worktree was removed and the mutation was
  never committed.
- **Probe (deleted, three passes):** with signature stubs (functions that
  `throw`, routes answering `500`) the unit spec reddens 17 of 19 at the throw
  (the two enumeration guards are satisfied by construction) and every
  integration case fails at `expected … received 500` — never a harness error.
  With a faithful near-fix the unit spec is **19 passed (19)**, the integration
  spec **22 passed (22)** on a real `MongoMemoryReplSet` (I1–I12, the pack that
  existed at probe time), `tsc` exit `0`, and `E1` **passes** against a real
  `next start` standalone server (`1 passed`). Four single-anchor mutations each
  reddened only their own pins: dropping `allowBanned` (`I3`: `expected 202 …
received 423 account_banned`), a hard-coded 30-day SLA (`I1` + 3 `U2` rows),
  accepting any attendee scope (`I2`: `expected 202 to be 422`), and removing
  the identity rate stage (`I5`: `expected 202 to be 429`). Every stub and
  temporary catalogue edit was deleted and `git status` shows the test files
  plus this record.
- **I13–I15 are appended after that probe** and carry no new route behaviour:
  they assert the three refusals the pipeline already owns — `401
unauthenticated` (`errors.test.ts`'s catalogue), `400 idempotency_key_required`
  (`idempotency/stage.ts`'s own spec) and `422 validation_failed` (the
  `defineRoute` validation stage) — so a faithful wiring satisfies them without
  a code path the other cases do not already force, and none of them is claimed
  as probe-measured.
- **E1's own catch:** the first e2e run failed at `slaDueAt` — the probe route
  rendered the stored instant with `String(date)`, losing milliseconds, so the
  poll disagreed with the receipt. The spec was right and the probe was wrong;
  the journey reaches its own assertions, not a selector or a timeout.

## 6. Assumptions and open questions

- **A request that resolves no tenant is not exercised.** `emitDomainEvent`
  requires a `tenantId` (`z.string().min(1)`), and an unscoped DSR by a user
  with no tenant can resolve none. Every case here files through a tenant, and
  the emission is pinned only for the tenant-scoped case; the platform-scoped
  case (what `E1` files) is pinned for its `202` and poll only. **Open
  question:** does a platform-scoped DSR emit `privacy.dsr.received` under a
  synthetic platform tenant, or write no event and let the cron read the rows?
- **`subject.userId` is the caller's `ObjectId`** (§20.3, the representation
  `consents` already uses); `scope.eventIds` is compared in string form, so an
  implementation may store `ObjectId`s or hex strings.
- **A user may reference the events of the tenants they are an active member
  of** (`tenantMembers`). The negative user case is not pinned; only the
  attendee's negative (I2) is.
- **An attendee's DSR is not gated on biometric consent.** §6.2's gate covers
  the selfie surface; a data-subject request is the right itself.
- **`verifiedEmail` must match the caller's verified email** when present is
  _not_ pinned (the card's list omits it).
- **Out of scope:** DSR execution and the admin queue (OP-150), the
  `admin.dsr.sla_risk` cron, `privacy.export.ready` / `privacy.erasure.completed`
  delivery, the caller-geo header the route resolves (U1 pins the ladder, not
  the transport), page cursors beyond the first page, and a repeat
  `Idempotency-Key` replay assertion (the stage's own spec owns replays).
- **Contract debt routed:** §0.11 owes the `compliance.dsr` row (`{scope:
"user", limit: 5, windowSeconds: 86400}`, and the failure-policy sentence this
  record decides in §4); Appendix A owes `invalid_scope`; §20.4 owes
  `compliance.slaDays` and the three `legal` keys; §8.1's list endpoint owes an
  envelope sentence.
- **The request-type enumeration is a documented divergence from the contract.**
  This pack pins **ten** types in `DSR_REQUEST_TYPES` — `access`, `erasure`,
  `rectification`, `portability`, `consent_withdrawal`, `correction`,
  `restriction`, `objection`, `nomination`, `grievance` — so that `I8` can prove
  each accepted type answers `202` with its own SLA. The contract enumerates
  **five** in three places and none of the three carries the other five:
  §8.1's prose (`docs/API Contract.md:2856`), §8.1's TS block (`:4523`,
  `DataSubjectRequest.requestType`) and schema §20.3
  (`docs/Notification and Database Design.md:2042`). The five extras are real
  rights the two regimes grant — `correction`, `nomination` and `grievance` are
  DPDPA §11–13, `restriction` and `objection` are GDPR Art. 18 and 21 — so the
  resolution of record is that **both documents owe the wider union**, not that
  the pack should shrink to five; narrowing it would delete the coverage that
  makes `I8` a per-type SLA proof. The five extra types are pinned as accepted
  values with an SLA, not as executable behaviour: nothing in this pack asserts
  what `correction`, `restriction`, `objection`, `nomination` or `grievance`
  _do_ beyond filing, because the contract says nothing about their execution and
  OP-150 owns it.

## 7. Consequences

The GREEN implements six things: the pure module, the five route modules, the
settings sections, the collection registration, the code + transport pair and
the rate class. `classes.test.ts` is **already the pin** for the rate class's two
halves — its class table, its exact rule and its failure policy are all asserted
here, so the GREEN adds the union member and the table row and the suite goes
green with no test edit. `platform-settings.test.ts` does **not** red on the new
settings sections: `SETTING_BOUNDS` pins only the three bounded scalars
(`dunning.gracePeriodDays`, `notifications.pollIntervalSeconds`,
`pipeline.leaseMinutes`, §9.10), and the settings the GREEN adds —
`compliance.slaDays` and the three `legal` keys — are unbounded, so no existing
case enumerates them; the integration spec reads `PLATFORM_SETTINGS_DEFAULTS` by
reference, not by literal, so it widens with the type. The intended signal is
therefore narrower and sharper than the first draft claimed: **one** suite reddens
against a contract document (`classes.test.ts` against §0.11), and nothing
reddens against §20.4. Once green, a refactor that preserves behaviour breaks
none of these cases, while any of the twelve behaviours above regressing breaks
exactly the case that names it.
