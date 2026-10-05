# ADR-0068 — OP-91 GREEN: sessions & devices and the account-deletion cancel window

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-backend-coder`
- **Card:** `t_19486cb2` (OP-91, phase 1-Identity) · **Stage:** GREEN
- **RED contract:** ADR-0067 (sessions & devices and the account-deletion cancel
  window; renumbered from ADR-0057 on merge — see Consequences)
- **Contract:** API contract §1.3 (Sessions & devices), §1.4 (Account
  deletion), §0.15 (never-return), Appendix A.2

## Context

OP-91's RED suite pinned four endpoint surfaces, two pure helpers and the
`account.sessions.revoked` observable. This ADR records the GREEN
implementation: the module/route map the RED ADR fixed, plus the three
cross-cutting decisions the RED suite forced (a deletion-state guard exemption,
a null-body response path, and the seam-call emission).

## Decision

### 1. Modules and routes

| Surface | Path                                          | Export                                                              |
| ------- | --------------------------------------------- | ------------------------------------------------------------------- |
| Unit    | `@/server/me/sessions`                        | `mapUserAgentToDeviceLabel`, `toSessionSummary`                     |
| Unit    | `@/server/me/deletion`                        | `computeDeletionScheduledAt`                                        |
| Route   | `app/api/v1/me/sessions/route.ts`             | `GET` → `200 { data: SessionSummary[] }`                            |
| Route   | `app/api/v1/me/sessions/[sessionId]/route.ts` | `DELETE` → `204` \| `404 not_found`                                 |
| Route   | `app/api/v1/me/sessions:revoke-all/route.ts`  | `POST { keepCurrent }` → `204`                                      |
| Route   | `app/api/v1/me/deletion/route.ts`             | `POST` → `202`; `DELETE` → `204` \| `409 deletion_already_executed` |

All four routes are `defineRoute` handlers guarded with the `user` label. The
`sessionId` path segment is read from `ctx.request.url` because the shared
pipeline exposes only `(request)` to the handler; `HandlerContext` now carries
the inbound `request` for that purpose.

### 2. `current` comes from the caller's session id

`UserPrincipal` gained an optional `sessionId` (the Better Auth `session.id`,
the hex form of the session document's `_id`) which `requireAuth` publishes on
the request context as `ctx.sessionId`. The list marks exactly the matching
session `current`; the projection compares hex ids, so no list order is assumed
(the round-2 RED finding).

### 3. Revocation runs through Better Auth; the event through the seam

The revoke surfaces call Better Auth's own `revoke-session` /
`revoke-other-sessions` / `revoke-sessions` endpoints through the auth handler
(forwarding the caller's cookie and the request's own Origin to satisfy the
library's origin check) so the library keeps ownership of the session store.
`revoke-all` then announces the transition **once** through
`createIdentityLifecycleSeams().sessionsRevoked({ userId })` (ADR-0043 §3),
which writes the single `account.sessions.revoked` outbox row. The route never
writes a domain event directly, and no `session.delete` database hook is wired,
so there is no double emission.

### 4. `DELETE /me/deletion` must outlive the deletion state

`evaluateAuth` denies `deletion_pending`/`deleted` with `403`, so the cancel
window could not be reached at all. A new `allowDeletionPending` flag (mirroring
`allowBanned`) exempts the deletion states on this one route; the handler then
decides: a `deleted` profile, or a `deletion_pending` profile whose
`deletionScheduledAt` has passed, is `409 deletion_already_executed`; otherwise
the profile is restored to `active` with `deletionScheduledAt: null`.

### 5. Null-body responses

`204` (and `205`/`304`) forbid a response body, but `jsonResponse` always
serializes one. `defineRoute` now short-circuits null-body statuses to a
bodyless `emptyResponse` carrying the default security headers, before the
response serializer runs. The three `204` routes declare a `z.null()` response
placeholder.

### 6. New error codes and the grace-window setting

- `confirmation_mismatch` (`422`) and `deletion_already_executed` (`409`) join a
  new append-only `ACCOUNT_ERROR_CODES` set in `packages/contracts`, transported
  from their own `ACCOUNT_ERROR_TRANSPORT` table so `ERROR_CATALOG` stays the
  exact Appendix A copy.
- `platformSettings.account.deletionGraceDays` (default `14`) is declared in the
  schema and defaults; the request schedule is computed from it, never a
  hard-coded 14 (CONVENTIONS §6). It is intentionally **not** added to
  `SETTING_BOUNDS` (the contract declares no range for it).

`ipCountry` stays `null`: the codebase has no geo resolver and §1.3 only forbids
returning the raw IP.

## Consequences

- ADR numbering: the RED ADR arrived as `ADR-0057-op91-…`, which collided with
  the OP-89 `ADR-0057-…` already on `main`. The merge renumbered the OP-91 RED
  ADR to **ADR-0067**; the one RED integration comment that cites
  "ADR-0057" now points at OP-89's sign-off and should be renumbered in a
  follow-up test-reference card (test files are out of this implementer's scope).
- `account.deletion.requested` (contract §1.4) is **not** emitted yet: no test
  pins it and no `handleDeletionRequested` seam exists, so it is left to the
  card that owns the notification fan-out.
- The green suite is 15 unit tests (`sessions`/`deletion`), 12 integration tests
  (`me-sessions-and-deletion`) and the Playwright E1 spec; all pass, and no test
  file was modified.

## Alternatives considered

- **Delete the `session` documents directly from the route** — rejected: Better
  Auth owns the session store and its `deleteWithHooks` lifecycle; the
  sanctioned seam is its own endpoint.
- **Wire `databaseHooks.session.delete.after` to emit** — rejected: it would
  announce `account.sessions.revoked` for a single-session revoke too, and would
  double-emit alongside the explicit seam call at revoke-all.
- **Emit `account.deletion.requested` inline** — rejected: untested and would
  need a notification handler the card does not own.
