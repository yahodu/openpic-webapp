# ADR-0260 — OP-100 RED: tenant provisioning, `tenantId` resolution and tenant read/update

- **Status:** Accepted
- **Date:** 2026-10-23
- **Card:** OP-100 RED (`t_a5def1f1`) · **GREEN successor:** `t_2d03b293` (gated on this card) · **Dependencies:** OP-90 (`GET`/`PATCH /me`), OP-77 (tenant-scoped repository)
- **Branch:** `OP-100-task-tenant-provisioning` · **Workspace:** `/root/openpic/openpic-webapp/.worktrees/t_a5def1f1`
- **Spec sources:** API contract §0.4 (tenancy in URLs) and §2.1 (tenants); schema §10.1–§10.2 (the tenant is the billable workspace; row-level `tenantId` isolation) and §13.3/§13.4 (`tenants`, `tenantMembers`)

## Context

The user story is _"my workspace is created on my first organizer action and is
accessible by id or the alias `current`, so costs attach to my tenant
automatically"_. Phase 2 lands three coupled behaviours:

1. **Provisioning** — `ensureTenantForUser(userId)` creates `tenants` +
   `tenantMembers(owner)` + `userProfiles.primaryTenantId`, idempotently and
   race-safely.
2. **Resolution** — a reusable `defineRoute` tenant stage turns the literal alias
   `current` into `userProfiles.primaryTenantId` _before any DB call_, echoes the
   resolved id in `X-Tenant-Id`, and verifies an active membership, denying with
   `404 not_found` (never `403` — contract §0.4: do not confirm existence across
   tenants).
3. **Read/update** — `GET`/`PATCH /api/v1/tenants/{tenantId}` per §2.1, with the
   two-level role split (`owner`|`admin`, `billingContactUserId` owner only).

This ADR records what the RED pins, and — because the contract leaves two things
genuinely unstated — the two interpretations this card resolved unilaterally so
the GREEN card and the reviewer can accept or overturn them with evidence.

## Decision

### D1 — the tests are the contract; module paths and exports are pinned

The RED imports exactly these production paths. If the GREEN renames or splits
them, the pins break — that is deliberate, so the interface cannot drift silently.

| Path                                    | Pinned export(s)                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `@/server/tenancy/slug`                 | `generateTenantSlug(): string`                                                                   |
| `@/server/tenancy/permissions`          | `TenantRole`, `TenantPatchField`, `TENANT_PATCH_PERMISSIONS`, `canPatchTenantField(role, field)` |
| `@/server/tenancy/provisioning`         | `EnsureTenantOptions`, `TenantProvisioningResult`, `ensureTenantForUser(userId, options?)`       |
| `@/app/api/v1/tenants/[tenantId]/route` | `GET`, `PATCH` (declared via `defineRoute`, `route: "/api/v1/tenants/:tenantId"`)                |

The tests assert **behaviour**, never internals: stored documents, HTTP status,
response body fields, `X-Tenant-Id`, and the value `ensureTenantForUser`
returns. No test imports the tenant stage or asserts a private helper, so the
stage may be implemented inline or as its own module.

### D2 — slug: 8 chars of `[a-z0-9]`, unique and non-sequential

§13.3 calls the slug "stable … non-sequential" and gives it a unique index.
U1 pins the charset/width (`/^[a-z0-9]{8}$/`), uniqueness over 200 draws, and
non-monotonicity over 20 draws (a counter or clock walk would be ascending with
probability `1/20!`, i.e. never). Uniqueness _under concurrency_ is not the
generator's job — it is the `{slug:1}` index plus the caller's collision retry,
which is why I1 pins the end state rather than a collision path.

### D3 — the alias never provisions; the first tenant-scoped **write** does

**This is the card's principal assumption** (see D3 above and the handoff note).

- `GET /tenants/current` for a caller with no workspace is `404` (I2/I4) — a read
  must never create a billable workspace. This matches OP-90's `/me` bootstrap,
  where a fresh account has `primaryTenant: null` and `canCreateEvent: false`.
- The **first tenant-scoped write** by such a caller provisions the workspace
  (caller becomes `owner`) and then applies the write, after which the alias
  resolves (I7 at the handler level, E1 over a real `next start` server).

Contract §2.1 says a tenant is created "the first time a user takes an organizer
action", and forbids `POST /api/v1/tenants` in v1. The events lane that would
host the obvious organizer action (`POST /tenants/{t}/events`) is **not** a
dependency of this card, so the lane's own tenant-scoped write is the only
in-scope trigger. If the orchestrator intends a different trigger (an explicit
activation endpoint, or event creation), **only I7 and E1 change**; I1–I6 are
trigger-independent and stand either way.

### D4 — `invalid_billing_contact` is a new catalogue code

§2.1 names it only in prose ("must be an active `tenantMembers` row → `422
invalid_billing_contact`"); it does not exist in `@openpic/contracts`. I6 pins
status `422` **and** `error.code === "invalid_billing_contact"`, and the GREEN
appends the code (non-retryable) to the request-shape error transport, following
the append-only convention the existing `unknown_timezone`/`forbidden_field`
codes document. `forbidden` and `not_found` already exist and are used as-is.

### D5 — read/update DTO scope

`GET` must advertise `counters.approximate: true` (§2.1 makes it mandatory, not
optional) and return branding URLs as `null` until the OP-117 signer exists
(GREEN scope §3). `counters.reconciledAt` is deliberately **not** asserted: its
absence semantics for a never-reconciled tenant are unstated, and pinning it
would over-constrain a value the contract shows only by example.

## Consequences

- The GREEN lane has an executable, complete interface for provisioning,
  resolution and the two tenant routes without reading this card's prose.
- `tsc` on this branch is red **by design** (four `TS2307` missing-module
  errors), matching the OP-93 precedent that RED branches are red-CI and carry
  RED + implementation in one PR. With minimal stubs at the four paths the suite
  is type-clean (`tsc` exit 0, no other diagnostics) and all 15 integration
  assertions fail on the stub's `501` — evidence the fixtures, session boot and
  seeding are sound, not merely that a module is missing.
- Two review questions are raised explicitly rather than buried: A1 (the
  provisioning trigger, D3) and A2 (the new error code, D4).

## Alternatives

- **Provision on any `current` access (read included).** Rejected: it turns a
  dashboard poll into billing-side-effect creation, and contradicts OP-90's
  pinned attendee shell. I4 exists precisely to forbid it.
- **Provision in the Better Auth `user.created` hook.** Rejected: tenant creation
  would fire for attendees who never organize anything, so every account would
  carry a billable workspace and `primaryTenant` could never be null.
- **Let the tenant stage provision on a miss.** Rejected: it would make `404`
  unreachable for the alias and remove the stage's ability to deny uniformly; the
  provision-on-write decision belongs to the write path, not to resolution.
- **Assert the slug collision retry directly.** Rejected as untestable without a
  seam into the random source; I1 pins the observable end state (one tenant, one
  owner membership) and the unique index does the rest.

## Deliberate non-assertions

- `tenant_suspended` → `423` on writes **is** pinned — by I8, added in the
  follow-up TEST card `t_83118bad`. The code is a contract catalogue row
  (Appendix A.1, `docs/API Contract.md` line 3484) and is a member of the doc's
  `ErrorCode` union (line 3664), so it is not a doc-only invention; its only real
  gap was the TypeScript transport — the same position `invalid_billing_contact`
  is in (D4), which this RED did decide to pin. An earlier revision of this ADR
  wrongly recorded the code as having "no code in the contract catalogue"; that
  claim is corrected here **in place** (no new ADR number is consumed, following
  the OP-99 in-place-amendment precedent under `t_28ab0e00`), and suspension is no
  longer a non-assertion. `GET` on a suspended workspace **remains** a
  non-assertion: the contract states nothing about reads of a suspended tenant,
  so pinning one would invent a requirement.
- `POST /api/v1/tenants` (v2, multi-workspace) is not touched.
- Nested tenant routes (`/tenants/{t}/events/…`), the `eventMembers` fallback of
  the membership check, filters/rate-limits, and domain-event emission on
  provisioning are not pinned here; the stage is specified to be reusable so
  those lanes can extend it without changing this contract.
