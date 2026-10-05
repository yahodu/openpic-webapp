# ADR-0055 — OP-90 GREEN: the full `GET`/`PATCH /me` §1.2 projection on the OP-89 read slice

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-backend-coder`
- **Card:** OP-90 `t_43a20f13` (phase 1-Identity, epic Current User, GREEN) · **Parents:** `t_572f5d3b` (RED pins), `t_daff2bfa` (contract decisions), `t_fa8f43f5` (RED follow-up pins), `t_44552eee` (docs)
- **Contract:** API contract §1.2 (Current user), §0.13 (data types), §0.14 (advisory capabilities), §0.15 (never-return), Appendix A.2 (`forbidden_field`, `unknown_timezone`); schema §13.1–§13.4, §13.6, §16.1, §19.4
- **Completes:** the minimal `GET /me` slice OP-89 landed (ADR-0041); adds `PATCH /me`.

## Context

OP-89 (ADR-0041) shipped only the `userProfiles` profile-default read slice of
`GET /api/v1/me`. Contract §1.2 specifies the single bootstrap call for the
authenticated shell — identity, profile, the active tenant list, advisory
capabilities and the bell/invite counts — plus a `PATCH /me` for profile edits.
The RED pins (`me-current-user.test.ts`, `capabilities.test.ts`,
`patch-schema.test.ts`, `me-current-user.spec.ts`) and ADR-0052/0053/0054 pin
that complete projection. This record describes how GREEN satisfies it.

## Decision

### 1. Module layout

| Module                     | Responsibility                                                                 |
| -------------------------- | ------------------------------------------------------------------------------ |
| `@/server/me/capabilities` | Pure `deriveCapabilities({ platformRole, status, tenants })` (§0.14, advisory) |
| `@/server/me/patch-schema` | The `PATCH /me` body schema (`mePatchSchema`)                                  |
| `@/server/me/schema`       | The `Me` response schema (route response schema) and its DTO types             |
| `@/server/me/projection`   | `buildMe(db, userId)` — the parallel §1.2 read + assembly                      |
| `@/app/api/v1/me/route`    | The `GET`/`PATCH` handlers, guard wiring, `PATCH` mutation and validation      |

`Me`/`MePatch` live under `apps/web/src/server/me` rather than
`packages/contracts` as the card's prose suggested: the RED unit spec imports
`mePatchSchema` from `@/server/me/patch-schema`, so that path is the binding
contract, and the `Me` schema is only ever consumed by this route. Promoting
either to `packages/contracts` later is a pure move (no wire change).

### 2. `GET /me` — one parallel read

`buildMe` issues the caller-scoped reads in a single `Promise.all`: the Better
Auth `user` document, the `userProfiles` row, the **active** `tenantMembers`
rows, the unread-notification count (`userId == caller`, `readAt == null`) and
the pending-invitation count (`invitee.userId == caller`, `status == "pending"`).
The workspace list is the active memberships joined to `tenants`
(`status == "active"` only, schema §13.4); a membership whose tenant document is
missing is skipped.

`primaryTenant` is the projected tenant whose id matches
`userProfiles.primaryTenantId`, or `null` — so a **removed** membership or a
**dangling** `primaryTenantId` can never resurrect a workspace (the I9 pins). A
pure attendee therefore gets `primaryTenant: null`, `tenants: []` and all-false
capabilities, which is normal, not an error (§1.2).

`capabilities` is derived at read time (never stored) from the platform role,
account status and the active memberships: `isAdmin` (active admin),
`canCreateEvent` (active + owner/admin membership), `canPurchase` (active +
owner membership). A suspended/deletion-pending account grants nothing.

`contactCapabilities` is narrowed to `{ whatsappCapable, whatsappCheckedAt }` —
`pushTokens` are hashed credentials and are never returned (§0.15).
`avatarUrl` is `null` until the media-signing infrastructure lands (OP-117); the
stored `avatarAssetId` is not signed here. `phoneNumber` is the caller's own, raw
E.164 (ADR-0047 D1) — the Better Auth `user.phoneNumber` returned verbatim.

### 3. `PATCH /me` — validated mutation returning the full body

`mePatchSchema` is a **loose** object (unknown keys survive) with
`displayName` (trimmed, 1–80), `locale` (`"en-IN"`), `timeZone` (`string`),
`marketingOptIn` (boolean), `avatarAssetId` (`string | null`) — all optional,
**at least one required**. Loose, not stripping, because the route must still
see a supplied `email`/`phoneNumber`/`platformRole` to reject it; a stripping
schema would hand the route `{}` and silently no-op the request.

The route, in order:

1. rejects any supplied key outside the editable set with `422 forbidden_field`
   (`details.fields` names them) — covering `email`, `phoneNumber`,
   `platformRole` and any other server-owned field (pins I4/I6);
2. rejects an unparseable IANA zone with `422 unknown_timezone`
   (`details.field: "timeZone"`, via `ianaTimeZoneSchema` — the schema
   deliberately accepts any string so the route, not `parseJsonBody`, owns this
   code);
3. resolves `avatarAssetId` to a caller-owned branding-class asset
   (`mediaAssets` where `tenantId` is one of the caller's active workspaces and
   `kind ∈ {event_logo, watermark}`), or `null` to clear it. A malformed id, a
   foreign asset and a non-existent asset all produce the same
   `422 validation_failed` with `details.fields[].path === "avatarAssetId"`
   (ADR-0047 D2), so the response never leaks whether a foreign asset exists;
4. `$set`s only the supplied editable fields (+ `updatedAt`) and returns the
   full §1.2 body via `buildMe`.

An empty body (`{}`) fails the schema's "at least one field" refinement inside
`parseJsonBody`, yielding `422 validation_failed` with a non-empty
`details.fields` (pin I7).

### 4. Error codes: a dedicated transport table, not `ERROR_CATALOG`

`unknown_timezone` and `forbidden_field` are contract Appendix A.2 codes, but
they are **not** added to `ERROR_CODES`/`ERROR_CATALOG`. The HTTP-pipeline story
pinned `ERROR_CATALOG` to exactly its base Appendix A row set
(`errors.test.ts` U2 asserts an exact key match), and GREEN may not amend a
test. Instead the codes join a new closed set
`REQUEST_SHAPE_ERROR_CODES` in `@openpic/contracts`, are appended to the
client-facing `API_ERROR_CODES` (so `errorCodeSchema`/`apiErrorSchema` accept the
envelope) and carry their transport in a dedicated
`REQUEST_SHAPE_ERROR_TRANSPORT` table merged into the dispatcher — exactly the
pattern already used for the auth, pipeline and internal codes. `ERROR_CATALOG`
stays the exact base copy, all existing specs stay green, and the observable
contract (`error.code`) is unchanged.

**Deviation from ADR-0052 §5**, which proposed adding the codes to
`ERROR_CATALOG` and amending the exact-match spec. That is the same end state
for clients; the split-table route is the only one that keeps the pinned base
table intact without editing a test. If the contract owner wants them in the
base table, a Test-Author cycle should extend the fixture first.

### 5. Guard wiring

`GET` keeps the §0.3 ban exemption (`allowBanned: true`); `PATCH` uses the plain
`user` label. Both resolve `getAuth()`/`getDb()` per request (never at module
scope) so `next build`'s page-data collection, which runs without configuration,
does not fail.

## Consequences

- One round trip renders the shell; a second tenant-scoped call is unnecessary.
- Identity fields are asserted against the stored Better Auth document, so the
  spec does not encode library defaults.
- The projection is the route's response schema and is validated strictly by
  `serializeResponse`, so a leaked/extra field fails loudly outside production.
- `phoneNumber` is returned raw for the caller only; another user's contact is
  still masked at its own endpoint (§0.15).

## Alternatives considered

- **Add a `Me`/`MePatch` Zod schema to `packages/contracts`.** Rejected for
  GREEN: the RED spec binds `mePatchSchema` to `@/server/me/patch-schema`, and no
  test consumes a contract-package copy. A later promotion is a pure move.
- **Add `forbidden_field`/`unknown_timezone` to `ERROR_CODES`/`ERROR_CATALOG`.**
  Rejected: it breaks the pinned exact-match spec, which GREEN must not edit;
  the dedicated transport table is the established pattern and keeps the wire
  contract identical.
- **A strict `mePatchSchema` + raw-body inspection in the route.** Rejected:
  parsing twice splits the validation truth; the loose schema preserves the
  forbidden-field decision in the route while still validating the editable
  fields in one place.
- **Sign `avatarUrl` now.** Rejected: the media signer does not exist yet
  (OP-117); the test pins `null` when no avatar is set.
