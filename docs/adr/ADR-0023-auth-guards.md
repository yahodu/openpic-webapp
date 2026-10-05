# ADR-0023 — Auth guards: one pure decision per label, a resolver port, and the per-session 2FA fact

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-86 `t_e0f66f3f` (phase 1-Identity, epic Authentication, RED) · **Implements:** contract §0.3 · **Depends on:** OP-85 (Better Auth config)
- **Supersedes / amends:** nothing. Pins the contract the OP-86 GREEN implementer must satisfy.

## Context

OP-85 configured Better Auth and proved the auth _surface_ works. OP-86 is the
layer every endpoint declares against: exactly one auth label per route, with a
single uniform enforcement point. The API contract §0.3 names six credential
facts (`public`, `user`, `user:complete`, `attendee`, `admin`, `internal`,
`provider`), a ban rule with a two-route exemption, 2FA mandatory for admins,
and a per-route declaration as the only knob.

The RED suite therefore has to pin _policy_ (what a principal is allowed to do)
separately from _transport_ (the status/body a denial becomes) and from
_resolution_ (how a real Better Auth session becomes a principal), so the
implementer cannot accidentally couple them and a refactor of one cannot break
the others.

## Decision

### 1. New module `@/server/auth/guards` with three named exports

```ts
evaluateAuth(label: GuardLabel, facts: GuardFacts): AuthDecision   // pure
resolvePrincipal(request, { auth, db }): Promise<Principal | null> // real session
requireAuth(label, options?): RouteStage                            // pipeline stage
```

`GuardLabel` is the five identity labels this story owns —
`"public" | "user" | "user:complete" | "attendee" | "admin"`. The full
`AuthLabel` union additionally carries `"internal" | "provider"`, which are
_delegated_ to OP-87/OP-113 and deliberately have no decision rule here.

`evaluateAuth` never throws, never reads the network/clock/DB (`now` is a
`GuardFacts` input), and returns either `{ allowed: true }` or
`{ allowed: false, code, details? }`. That makes the whole policy a table a
reviewer can read.

### 2. The decision table (contract §0.3)

Order of checks for a `user` principal; the first that matches wins:

| #   | Condition                                              | Denial                   |
| --- | ------------------------------------------------------ | ------------------------ |
| 1   | `status == "suspended"`                                | `423 account_suspended`  |
| 2   | `status == "deletion_pending" \| "deleted"`            | `403 forbidden`          |
| 3   | banned and not `allowBanned` and not expired           | `423 account_banned`     |
| 4   | label `user:complete` and `accountCompletedAt == null` | `403 account_incomplete` |
| 5   | label `admin` and `platformRole != "admin"`            | `403 forbidden`          |
| 6   | label `admin` and 2FA not satisfied this session       | `403 admin_2fa_required` |

- A **missing** principal is `401 authentication_required` for any non-`public`
  label; an **attendee** principal is also `authentication_required` for the
  user labels (an attendee session is not a user session).
- `public` always allows. `attendee` allows a `user` **or** an `attendee`
  principal.
- **Ban expiry** is inclusive: `banExpires <= now` means _not_ banned;
  `banExpires == null` is permanent. `allowBanned` (set by the route for
  `GET /me` and `POST /me/data-requests`) skips check 3 only.
- `account_incomplete.details.missing` is computed from the verification flags,
  in the fixed order `["emailVerified", "phoneNumberVerified"]`; `accountCompletedAt`
  is the gate, so a null value with both flags true still fails closed with
  `missing: []`.

Denials are `code`-only for the pure function. The status and retry policy live
in the shared catalogue: the implementer must add
`authentication_required`, `session_expired`, `account_incomplete`,
`admin_2fa_required`, `account_banned`, `account_suspended` to
`@openpic/contracts` `ERROR_CODES` and the server catalogue with the Appendix A
statuses (401/401/403/403/423/423).

### 3. The typed principal is resolved from the real session

`UserPrincipal` is the union of the Better Auth `user` fields the policy needs
and the `userProfiles` fields (schema §13.2):

```
userId, status, platformRole, accountCompletedAt,
emailVerified, phoneNumberVerified, twoFactorEnabled,
sessionTwoFactorVerified, banned, banReason, banExpires
```

`resolvePrincipal` forwards the request's `Cookie`/`Authorization` headers to
Better Auth's `GET /api/auth/get-session`, then loads `userProfiles` by user id.

- **`userProfiles.userId` is an ObjectId** (schema §13.2) while `getSession`
  returns the id as a hex string; the resolver must convert before querying, or
  every profile lookup silently misses.
- A **missing** profile resolves to the permissive defaults
  (`status: "active"`, `platformRole: "client"`, `accountCompletedAt: null`).
- **Bearer (mobile)** requires the Better Auth `bearer` plugin: the resolver
  relies on the sign-in response's `set-auth-token` header, which the plugin
  emits, and on the plugin turning `Authorization: Bearer <token>` into a session.

### 4. `sessionTwoFactorVerified` is per-session, not per-user

The contract's "the admin label must check that this session passed the second
factor" cannot be satisfied by `user.twoFactorEnabled` alone: a session minted
_before_ 2FA was enabled (I6), and a phone-OTP first-factor sign-in (I7), both
carry the flag yet never passed the second factor. Better Auth 1.7.7 stores no
such session fact (verified in the installed plugin source), so the
implementation must materialise one — e.g. a boolean session field set on the
2FA verify path, or `session.createdAt` compared against a
`twoFactorEnabledAt` timestamp. The **I7** phone-OTP case rules out the
timestamp heuristic on its own, so an explicit session marker is the expected
mechanism. The RED tests pin only the observable fact
(`sessionTwoFactorVerified`), leaving the mechanism to GREEN.

### 5. Transmission and logging

`requireAuth` publishes the user id on `ctx.principal` (the string the identity
rate-limit tier consumes, ADR-0005) and, on denial, throws the catalogue
`AppError` with the decision's `details`. Every denial emits one `warn` log with
`event: "auth.denied"`, `label` and `reason` (the code) — never the credential.

### 6. E1 targets a guarded `GET /api/v1/me`

The e2e pin needs a real user-labelled route. None exists yet, so OP-86 GREEN
must add a minimal `GET /api/v1/me` protected by `requireAuth("user")` (the
contract §1.2 route; its response body is OP-88's concern). Without it E1
answers `404`, not `401`.

## Consequences

- Policy, resolution and transport are independently testable: unit specs drive
  `evaluateAuth` with principal fixtures; integration specs resolve a genuine
  session then drive a `defineRoute` route; e2e drives a deployed route.
- The RED suite fails for the right reason today: `@/server/auth/guards` does
  not exist (module-resolution failure) and `GET /api/v1/me` is `404`.
- The `internal`/`provider` labels are intentionally unimplemented here; their
  specs belong to OP-87/OP-113.

## Alternatives considered

- **One `if`-chain per route instead of a shared stage.** Rejected: the story's
  whole point is uniformity, and a per-route check cannot be pinned by one table.
- **Treat `user.twoFactorEnabled` as sufficient for admins.** Rejected: it
  fails I6 and I7 by construction.
- **Resolve the session by hand from the cookie.** Rejected (ADR-0020): no
  hand-rolled auth; use Better Auth's own `get-session`.
- **Expose the principal as `ctx.principal` only (object).** Rejected: OP-79
  pinned `ctx.principal` as the rate-limit principal _string_; the typed union
  is exposed through `resolvePrincipal`'s return type instead.
