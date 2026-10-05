# ADR-0044 — `GET`/`PATCH /me`: the full §1.2 projection contract (OP-90 RED)

- **Status:** Accepted (RED pins) · **Date:** 2026-10-05
- **Card:** OP-90 `t_572f5d3b` (phase 1-Identity, epic Current User, RED) · **Depends on:** OP-89 (ADR-0041, `GET /me` slice), OP-88 (outbox, ADR-0029), OP-86 (guards, ADR-0025)
- **Contract:** API contract §1.2 (Current user), §0.13 (data types), §0.14 (advisory capabilities), §0.15 (never-return); schema §13.1, §13.2, §13.3, §13.4, §13.6, §16.1, §19.4; Appendix A.2 (`unknown_timezone`, `forbidden_field`)
- **Supersedes / amends:** completes the `GET /me` slice OP-89 (ADR-0041) landed; adds `PATCH /me`.

## Context

OP-89 shipped a minimal `GET /api/v1/me` read slice: the `userProfiles`
profile-default fields (`locale`, `platformRole`, `status`, `marketingOptIn`,
`accountCompletedAt`, `contactCapabilities`). Contract §1.2 specifies the
**single bootstrap call** for the authenticated shell — identity fields, the
full tenant list, advisory capabilities and the bell/invite counts — plus a
`PATCH /me` for profile edits, all in one round trip. This card owns that
complete projection on top of OP-89's slice.

The RED suite (this ADR) drives the real route handlers and pins the observable
contract; it writes no production code.

## Decision

### 1. What `GET /me` must return, and from where

| Field(s)                                                                                                                                                                                | Source                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `id`, `email`, `emailVerified`, `phoneNumber`, `phoneNumberVerified`, `twoFactorEnabled`                                                                                                | Better Auth `user` (§13.1)                                                                                |
| `displayName`, `avatarUrl` (from `avatarAssetId`), `locale`, `timeZone`, `platformRole`, `status`, `marketingOptIn`, `contactCapabilities`, `accountCompletedAt`, `deletionScheduledAt` | `userProfiles` (§13.2)                                                                                    |
| `primaryTenant`, `tenants[]`                                                                                                                                                            | `tenantMembers` where `status == "active"`, joined to `tenants` for `slug`/`name`/`status` (§13.3, §13.4) |
| `capabilities`                                                                                                                                                                          | pure derivation from `platformRole`, `status` and the active memberships (§0.14, advisory)                |
| `unreadNotificationCount`                                                                                                                                                               | `notifications` where `userId == caller` and `readAt == null` (§19.4)                                     |
| `pendingInvitationCount`                                                                                                                                                                | `invitations` where `invitee.userId == caller` and `status == "pending"` (§13.6)                          |

`primaryTenant` is `null` for a pure attendee and is normal, not an error.
`contactCapabilities` must not leak `pushTokens` (§0.15).

### 2. Capability derivation is a pure function

`@/server/me/capabilities` exports
`deriveCapabilities({ platformRole, status, tenants }): Capabilities`
where `tenants` is the **active-only** membership list the route already built:

- `isAdmin` = `platformRole === "admin"` AND `status === "active"`;
- `canCreateEvent` = `status === "active"` AND an active `owner`/`admin` membership;
- `canPurchase` = `status === "active"` AND an active `owner` membership.

A non-active account grants nothing: the projection must never claim a
capability the write guard would deny.

### 3. The `PATCH /me` body schema is a pure module

`@/server/me/patch-schema` exports `mePatchSchema`: every field optional,
**at least one required**, `displayName` trimmed to 1–80 chars, `marketingOptIn`
a boolean (an explicit `false` counts as a provided field), `avatarAssetId`
`string | null`.

The schema must **not** silently strip unknown keys and then report an empty
body: the route must still see a supplied `email`/`phoneNumber`/`platformRole`
to reject it with `422 forbidden_field`. Consequently the body schema is not
`.strict()`; the forbidden-field decision lives in the route, not in
`parseJsonBody` (which maps every schema failure to `validation_failed`).

### 4. `PATCH /me` accepts `displayName`, `locale`, `timeZone`, `marketingOptIn`, `avatarAssetId`

`email`/`phoneNumber` are never accepted here — they change through Better Auth
(which triggers `auth.contact.changed`) → `422 forbidden_field`.
`platformRole` (and other server-owned fields) → `422 forbidden_field`.
An unparseable IANA zone → `422 unknown_timezone`.
`200` returns the **full** `/me` body, exactly like `GET`.

### 5. New error codes must be added to the catalogue

`forbidden_field` and `unknown_timezone` are contract Appendix A.2 codes but are
**not yet** members of `ERROR_CODES` (`packages/contracts/src/errors.ts`) or
`ERROR_CATALOG` (`apps/web/src/server/http/catalog.ts`). The implementer adds
both (`422`, non-retryable), and amends any spec that pins those tables
exactly. `forbidden_field.details` is `{ fields: string[] }`;
`unknown_timezone.details` is `{ field: string }`.

### 6. Stored collection names follow OP-89's camelCase convention

`user` (Better Auth), `userProfiles`, `tenants`, `tenantMembers`,
`notifications`, `invitations`, `mediaAssets` — the schema §13/§16/§19 names,
consistent with ADR-0041 §2 (`userProfiles`, `notificationPreferences`,
`sessionDevices`). The legacy snake_case `COLLECTIONS` registry
(`media_assets`, `users`) is not the `/me` read path.

## Assumptions resolved unilaterally (flagged for the implementer)

- **`phoneNumber` is asserted against the stored value.** An email-OTP account
  has no phone, so the spec pins `null` and never exercises the
  raw-vs-masked representation. The §1.2 example masks the caller's own number
  (`+919****3210`) while §0.13 defines E.164 and a separate masked-contact form;
  the conflict is deliberately left unpinned (the settings screen plausibly
  needs the real value to edit it). **Open question** for the contract owner.
- **`avatarUrl` is `null` when no avatar is set.** Signed-URL generation for an
  attached asset needs media-signing infrastructure that does not exist yet; it
  is out of scope and not pinned.
- **`deletionScheduledAt` is `null` for a served session.** A `deletion_pending`
  account is denied by the guard, so the read path only serves `active`.
- **I5's code is `validation_failed`.** An `avatarAssetId` owned by another
  tenant is an invalid _value_ of an allowed field, not a forbidden field, so
  `validation_failed` (with `details.fields[].path == "avatarAssetId"`) is
  assumed rather than `forbidden_field`.
- **Ownership of a media asset is tenant-scoped.** `mediaAssets` carries
  `tenantId` (not `createdByUserId`, which lives on `uploadSessions` §16.2), so
  "owned by the caller" means the asset's tenant is one of the caller's active
  memberships.
- **`isAdmin` is status-gated.** A suspended admin is not `isAdmin`; the guard
  denies the session regardless, but the projection stays internally consistent.
- **`capabilities` is derived at read time, never stored.** It is advisory
  (§0.14) and must not be persisted on `userProfiles`.

## Consequences

- The RED suite fails only for the missing `/me` slice (`expected undefined to be
<id>`) and the missing `PATCH` export (`PATCH is not a function`), so the
  implementer sees the contract, not an accidental error.
- A regression in the projection (a dropped field, a removed membership leaking
  into `tenants`, an unread/read miscount, a forbidden-field edit slipping
  through) breaks at least one spec loudly.
- I1 asserts identity fields against the _stored_ Better Auth document, so the
  spec does not encode library defaults that a Better Auth upgrade could change.

## Alternatives considered

- **Assert `phoneNumber` as E.164 or masked.** Rejected: the contract is
  self-contradictory here; pinning either would bake in a guess.
- **Unit-test the forbidden-field mapping on the schema.** Rejected: the
  observable contract is the HTTP `422 forbidden_field`, and the mapping
  mechanism (strict schema vs raw-body inspection) is an implementation choice.
- **Snapshot the whole `/me` body.** Rejected: a snapshot hides which field
  regressed; every field is asserted by name.
- **Drive `GET`/`PATCH` only through e2e.** Rejected: the projection needs
  seeded tenants, notifications, invitations and a foreign media asset, which
  e2e cannot seed; the integration suite owns those cases and e2e proves the
  wired HTTP surface end to end (E1).
