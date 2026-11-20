# ADR-0897 — OP-138 RED: data subject requests, consent history and policy acknowledgement

- **Status:** Accepted
- **Date:** 2026-11-20
- **Card:** `t_a99f5cce` (OP-138, phase 6-M2M — Jobs & Compliance, epic Compliance,
  `tdd_stage: RED`, dependencies OP-131 and OP-88)
- **Branch:** `OP-138-task-dsr-consent-policy-red`
- **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_a99f5cce`
- **Number allocation:** first card of the **OP-138 lane**, which holds
  `0897`–`0916`; this record consumes `0897`, the lane's `Next free` cell reads
  `0898`, and the `unallocated (future lanes)` cursor advances `0897` → `0917`.
  Every live surface was enumerated immediately before the commit: `origin/main`
  `f27eb8db` carries `ADR-0896` as its highest record, the reserved-range table's
  two `Next free` cells read `0897` (OP-136 exhausted its `0849`–`0868` block and
  drew `0896` from the pool), and no `.worktrees/*/docs/adr` tree holds a number
  above `0896`. No cell is lowered and no range is re-cut.

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
windowSeconds: 86_400}`. Contract §0.11 has no DSR class, so §0.11 owes a row
  too. **Known consequence:** `rate-limit/classes.test.ts`'s
  "configures every class named in the contract and no others" case reddens
  until the contract table and that spec both learn the class.

## 5. Evidence (this RED)

- **Delivered:** `apps/web/src/server/compliance/data-request.test.ts` (19
  cases: U1 8, U2 4, U3 6, plus the request-type enumeration),
  `apps/web/src/test/integration/data-subject-requests.test.ts` (25 cases:
  I1–I15, I8 as ten `it.each` rows) and `apps/web/e2e/data-requests.spec.ts`
  (E1), with this record and the ledger.
- **Honest RED:** the unit spec fails with `Cannot find module
'./data-request'`; the integration spec fails with `Cannot find package` for
  each of the five route modules. `tsc -p apps/web/tsconfig.json --noEmit` with
  the probe stubs present exits `0` (the specs are type-correct), and the four
  adr guards' dangling-reference sweep is what reddens the `ADR-0897` citations
  until this file exists.
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
  temporary catalogue edit was deleted and `git status` shows the three specs
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
- **Contract debt routed:** §0.11 owes the `compliance.dsr` row; Appendix A owes
  `invalid_scope`; §20.4 owes `compliance.slaDays` and the three `legal` keys;
  §8.1's list endpoint owes an envelope sentence.

## 7. Consequences

The GREEN implements six things: the pure module, the five route modules, the
settings sections, the collection registration, the code + transport pair and
the rate class. `rate-limit/classes.test.ts` and `platform-settings.test.ts`
will red until the contract rows and their expectations are extended in the same
PR — that is the intended signal that two contract documents owe an entry, not a
pin to weaken. Once green, a refactor that preserves behaviour breaks none of
these cases, while any of the twelve behaviours above regressing breaks exactly
the case that names it.
