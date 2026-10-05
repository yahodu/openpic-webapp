# ADR-0057 — OP-90 follow-up: declare the `tenantMembers` and `invitations` indexes behind `GET /me`

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-backend-coder`
- **Card:** `t_8599578e` (OP-90 follow-up, Medium) · **Deliverable:** branch `OP-90-task-me-indexes`, PR _pending_
- **Contract:** schema §13.4 (`tenantMembers`), §13.6 (`invitations`), §21 (index invariants); API contract §1.2, Appendix C · **Precedent:** ADR-0043

## Context

ADR-0056 (OP-90 GREEN review sign-off, PR #168) found that the shell bootstrap
endpoint `GET /api/v1/me` reads two collections that carry **no declared index**
in `apps/web/src/server/db/indexes.ts`:

1. **`tenantMembers`** — `find({ userId, status: "active" })` in
   `apps/web/src/server/me/projection.ts` (`buildMe`) and again in
   `apps/web/src/app/api/v1/me/route.ts` (`resolveOwnedAvatar`). Schema §13.4
   mandates `{ tenantId: 1, userId: 1 }` **unique** · `{ userId: 1, status: 1 }`.
2. **`invitations`** — `countDocuments({ "invitee.userId": userId, status:
"pending" })` (`pendingInvitationCount`). Schema §13.6 mandates
   `{ "invitee.userId": 1, status: 1, createdAt: -1 }` ("my pending
   invitations"). `INDEX_SPECS` declared **only** the
   `invitations_expire_at_ttl` TTL for this collection.

Appendix C of `docs/API Contract.md` states "Every read path must be served by an
existing index", but its `GET /me` row omitted `invitations` entirely even
though §1.2 requires `pendingInvitationCount` — so the contract row was also
incomplete.

Impact today is bounded (schema §13.4 estimates ~1,000 `tenantMembers` documents),
but this is the one call every shell load makes, and an unindexed collection scan
only grows. This follows the ADR-0043 pattern for the OP-89 identity indexes.

## Decision

`INDEX_SPECS` remains the single source of truth; this ADR only adds the missing
declarations and registers the collection name they key on. **No runtime
behaviour changes** — the query shapes in `projection.ts` / `route.ts` are
unchanged and already match the declared keys.

### 1. Register `tenantMembers` in `COLLECTIONS`

`tenantMembers` is added to `COLLECTIONS` (`apps/web/src/server/db/collections.ts`,
value `"tenantMembers"`) so `IndexSpec.collection` — typed `CollectionName` —
accepts the specs below. The reading modules still carry their own private
literals (`TENANT_MEMBERS_COLLECTION` in `projection.ts` / `route.ts`); wiring
them to the registry is a separate, non-load-bearing cleanup and is out of scope
here (the registry's job is to make the index declaration type-safe, exactly as
ADR-0043 §1 did for the identity collections).

### 2. `tenantMembers` — the two schema §13.4 indexes

| Index                        | Name                                | Notes                                                                               |
| ---------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| `{ tenantId: 1, userId: 1 }` | `tenant_members_tenant_user_unique` | **unique** — composite identity; also backs `GET /tenants/{t}/members` (Appendix C) |
| `{ userId: 1, status: 1 }`   | `tenant_members_user_status`        | workspace switcher + the caller's active-membership load on `GET /me`               |

### 3. `invitations` — the schema §13.6 lookup index

| Index                                               | Name                                      | Notes                                                                               |
| --------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `{ "invitee.userId": 1, status: 1, createdAt: -1 }` | `invitations_invitee_user_status_created` | "my pending invitations" — the `GET /me` `pendingInvitationCount` and the §1.2 feed |

The other §13.6 indexes (`{tokenHash:1}` unique, the partial live-invite
uniqueness pair, the expiry-sweeper partial, and `{tenantId, eventId, status}`)
are **not** declared here: their read paths are not behind `GET /me`, they were
not part of ADR-0056's finding, and declaring them is a separate scope. This ADR
records only what the bootstrap endpoint needs.

### 4. `tenantMembers` is not tenant-scoped — the U1 lint does not apply

`tenantMembers` is deliberately **not** a member of `TENANT_SCOPED_COLLECTIONS`.
Those collections model documents that each belong to exactly one tenant, so a
compound index on them must lead with `tenantId` (U1). `tenantMembers` is a
_join_ collection — one row per **(tenant × user)** pair — and its
`{ userId, status }` index is resolved from the **subject**, not from an ambient
tenant: the workspace-switcher and the `/me` membership load ask "which
workspaces is _this user_ active in?", which by construction spans tenants and
therefore cannot lead with a single `tenantId`. The U1 lint only constrains
tenant-scoped collections (`indexes.test.ts`: `isCompound(spec) && isTenantScoped(spec)`),
so this declaration passes without an exception entry. This is the same
subject-scoped reasoning the registry already applies to `faceMatches` and
`attendeeEventProfiles` (see the `TENANT_SCOPED_COLLECTIONS` doc comment).

## Appendix C correction

The `GET /me` row of Appendix C now lists `invitations` among the collections and
adds `{"invitee.userId":1, status:1, createdAt:-1}` to its index column, so the
row names every collection §1.2 reads and every index those reads use.

## Consequences

- `ensureIndexes` builds three new indexes in one idempotent pass; the
  `index-bootstrap` integration suite (I1) derives its expectation from
  `INDEX_SPECS`, so the new specs are exercised without a test edit.
- `indexes.test.ts` U1/U2 read `INDEX_SPECS` dynamically; the new compound
  `{ userId, status }` key is not a U1 violation because `tenantMembers` is not
  tenant-scoped, and neither new spec declares `expireAfterSeconds`.
- The uniqueness of `{ tenantId, userId }` is now enforced by the database in
  every indexed environment (previously an unenforced assumption of §13.4).
- A regression that removes either `tenantMembers` index or the `invitations`
  lookup index is caught by the bootstrap I1 set comparison; a regression that
  reclassifies `tenantMembers` as tenant-scoped would fail U1, which is the
  correct signal.

## Coverage gaps (requests for the Test Author's next cycle)

- No spec pins the exact `tenantMembers` or `invitations` index spec set; they
  are implementation choices this ADR records (same position as ADR-0043
  "Coverage gaps"). The generic registry lint only covers the invariants it
  enumerates.
- No spec asserts that `{ tenantId, userId }` uniqueness is actually enforced by
  a duplicate-key rejection (the bootstrap suite tests the other §21 invariants,
  not this one).

## Alternatives considered

- **Treat `tenantMembers` as tenant-scoped and lead `{ userId, status }` with
  `tenantId`.** Rejected: it would not serve the workspace-switcher query at all
  (the query has no ambient tenant), and it would misstate the collection's
  subject-scoped model.
- **Declare all five §13.6 indexes now.** Rejected as scope creep: the finding
  is about the `GET /me` read path; the token/sweeper/event-settings indexes
  belong to the routes that use them and can be a separate follow-up.
- **Point `projection.ts` / `route.ts` at the `COLLECTIONS.tenantMembers` value.**
  Rejected for this card: it is a pure cosmetic de-duplication with no bearing on
  the index declaration, and touching the already-signed-off `/me` read modules
  widens the diff for no behavioural gain.
