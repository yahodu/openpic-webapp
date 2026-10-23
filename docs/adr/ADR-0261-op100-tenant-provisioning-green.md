# ADR-0261 — OP-100 GREEN: tenant provisioning, `tenantId` resolution and tenant read/update

- **Status:** Accepted
- **Date:** 2026-10-23
- **Card:** OP-100 GREEN (`t_2d03b293`) · **RED spec:** [ADR-0260](ADR-0260-op100-tenant-provisioning-red.md) (`t_a5def1f1`) · **Follow-up TEST pin:** `t_83118bad` · **Dependencies:** OP-90 (`GET`/`PATCH /me`), OP-77 (tenant-scoped repository)
- **Branch:** `OP-100-task-tenant-provisioning` · **Workspace:** `/root/openpic/openpic-webapp/.worktrees/t_a5def1f1`
- **Spec sources:** API contract §0.4 (tenancy in URLs), §2.1 (tenants), Appendix A.1/A.4; schema §10.2, §13.3 (`tenants`), §13.4 (`tenantMembers`)

## Context

ADR-0260 pinned the RED contract: four test files (two unit specs, one
integration/contract spec, one Playwright spec) that import production paths which
did not exist. This record documents the GREEN that turns them green on the same
branch, and the two decisions that the RED deliberately left to the
implementation (the transaction shape of provisioning, and where the two
catalogue codes are transported).

## Decision

### D1 — the pinned interface was implemented unchanged

The four RED module paths exist with exactly the pinned exports and no others:

| Path                                    | Exports                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `@/server/tenancy/slug`                 | `generateTenantSlug()`                                                                           |
| `@/server/tenancy/permissions`          | `TenantRole`, `TenantPatchField`, `TENANT_PATCH_PERMISSIONS`, `canPatchTenantField(role, field)` |
| `@/server/tenancy/provisioning`         | `EnsureTenantOptions`, `TenantProvisioningResult`, `ensureTenantForUser(userId, options?)`       |
| `@/app/api/v1/tenants/[tenantId]/route` | `GET`, `PATCH` via `defineRoute({ route: "/api/v1/tenants/:tenantId", … })`                      |

Supporting modules the RED did not name (and no test imports directly):
`@/server/tenancy/schema` (the §2.1 DTO zod schema), `@/server/tenancy/patch-schema`
(the `PATCH` body), `@/server/tenancy/projection` (stored doc → DTO),
`@/server/tenancy/route-stage` (the reusable `tenant` stage).

### D2 — provisioning is one MongoDB transaction, not compensating code

`ensureTenantForUser` runs `tenants` insert + `tenantMembers` owner upsert +
the `userProfiles.primaryTenantId` claim inside a single
`session.withTransaction` callback:

- **Idempotency** is a fast path: when `primaryTenantId` resolves to a live
  `tenants` row, the call returns it and writes nothing.
- **Race-safety** does not rely on a read-then-write window. The claim is the
  conditional update `{ userId, primaryTenantId: <value this attempt read> } →
$set primaryTenantId`. Exactly one of two concurrent attempts can match; the
  loser either raises a `WriteConflict` (which the driver's `withTransaction`
  retries, after which the callback takes the fast path) or matches nothing
  in-transaction, which aborts the attempt (`ProvisioningRaceError`) so the
  server rolls its half-created tenant and membership back rather than the
  application compensating for them.
- **Slug collision** is retried by an outer loop keyed on MongoDB E11000. A
  duplicate-key failure aborts a transaction, so the retry must re-run the whole
  attempt with a fresh slug; `MAX_SLUG_ATTEMPTS = 5`.

The alternative — insert outside a transaction and delete the loser's rows — was
rejected: it leaves a window where a second tenant is visible, and the cleanup is
application-managed state rather than an atomic outcome.

### D3 — the tenant stage is reusable; only the write path provisions

`tenantStage(options)` resolves the segment (`current` → `userProfiles.primaryTenantId`
before any `tenants` query), verifies an **active** `tenantMembers` row, publishes
`ctx.tenantId`/`ctx.tenantRole`, echoes `X-Tenant-Id`, and denies uniformly with
`404 not_found` (never `403` — no cross-tenant existence oracle). Denials log
`warn tenancy.access_denied` with a machine-readable `reason`; a successful
resolution logs `debug tenancy.resolved`.

`GET` installs `tenantStage()`; `PATCH` installs
`tenantStage({ provisionOnMissing: true })`, which is the _only_ place the first
write provisions (ADR-0260 D3 / contract §2.1). The stage is a plain
`defineRoute` stage, so event-nested routes that must fall back to `eventMembers`
(contract §0.4) extend it rather than reimplementing alias resolution — the
fallback is out of this story's scope, as ADR-0260 records.

### D4 — the two tenancy codes get their own transport table

Contract Appendix A.1 carries `tenant_suspended | 423 | { reason, supportUrl }`
and A.4 carries `invalid_billing_contact | 422`; both are members of the
document's `ErrorCode` union, but neither was in the TypeScript transport.

They are added **append-only**, following the existing `unknown_timezone` /
`forbidden_field` / account-code precedent:

- `packages/contracts`: a new closed set `TENANCY_ERROR_CODES` (`TenancyErrorCode`)
  appended to `API_ERROR_CODES` and to `AppErrorCode`;
- `@/server/http/catalog`: a new `TENANCY_ERROR_TRANSPORT` spread into the
  dispatch table.

`ERROR_CATALOG` is deliberately untouched: the HTTP-pipeline unit spec pins its
keys to exactly the base Appendix A rows. One table for both codes (rather than
one per Appendix sub-table) is the honest grouping — they are the tenancy
story's codes — and keeps the append-only surface to a single new symbol.

### D5 — the stored-document defaults

Three values are not pinned by any test and are recorded here rather than left to
a reader's inference:

- a freshly provisioned workspace is named **`"My workspace"`** until the action
  that triggered it (or a later `PATCH`) names it; I7/E1 both rename in the same
  request;
- `dataRegion` is **`"in"`** (schema §13.3 records it even with one region);
- `settings.defaultTimeZone` defaults to **`Asia/Kolkata`**, matching
  `handleUserCreated`'s `DEFAULT_TIME_ZONE` (contract §1.1).

### D6 — `tenants` is registered and indexed

`COLLECTIONS.tenants` and the three schema §13.3 indexes
(`tenants_slug_unique`, `tenants_owner_user`, `tenants_status_created_at`) are
declared. The unique slug index is not decorative: it is the guard the
provisioning collision retry (D2) depends on, so leaving it undeclared would make
that retry unreachable in production.

## Consequences

- `GET`/`PATCH /api/v1/tenants/{tenantId}` are live on the shared pipeline; the
  §2.1 DTO advertises `counters.approximate: true` and returns `null` branding
  URLs until the OP-117 signer exists.
- A suspended workspace refuses writes with `423 tenant_suspended` **before** any
  field is touched, so the stored document is provably unchanged (I8).
- `PATCH` gates every supplied field through the permission matrix, so a `member`
  and an `admin`-setting-the-billing-contact both answer `403 forbidden`, while a
  billing contact that is not an active member answers `422
invalid_billing_contact` — the permission check runs before the membership
  check, which is what makes I5's admin case `403` rather than `422`.
- The `tenant` stage is one import away for every future `/tenants/{tenantId}/…`
  route.

## Alternatives

- **Provision in the Better Auth `user.created` hook.** Rejected in ADR-0260
  (every attendee would carry a billable workspace).
- **Provision on any `current` access.** Rejected in ADR-0260; I4 pins the read
  path to `404` with zero owned tenants.
- **`findOneAndUpdate` claim without a transaction.** Simpler, and race-safe for
  the claim, but the created tenant/membership would need application-side
  compensation on the losing path. Rejected in favour of the server-rolled-back
  transaction (D2).
- **Add the two codes to `ERROR_CATALOG` / `REQUEST_SHAPE_ERROR_TRANSPORT`.**
  Rejected: the former breaks the pinned Appendix A copy; the latter misclassifies
  an A.1 (`423`) and an A.4 (`422`) code as request-shape codes.

## Deliberate non-assertions carried forward

- `GET` on a suspended workspace stays unpinned (the contract states nothing
  about reads of a suspended tenant).
- The `eventMembers` fallback, nested routes, filters and rate limits are not
  implemented here; the stage is the extension point (ADR-0260).
- `counters.reconciledAt` is serialized (string | null) but not asserted.
