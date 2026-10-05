# ADR-0026 — Closing the two OP-86 review gaps: the `/me` ban exemption and the 2FA sign-in branch

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-86 follow-up RED `t_33e1c6dc` (phase 1-Identity, epic Authentication, RED) · **Amends:** ADR-0025
- **Implements:** contract §0.3 · **Depends on:** OP-86 (auth guards, `@/server/auth/guards`)

## Context

The OP-86 review (round 1, artifact lens) approved the auth-guards delivery but
found two Medium gaps the shipped suite did not pin. ADR-0025 §8 already
recorded a first round of follow-up pins (I8, strengthened I7, U4/U5); this ADR
records a second, narrower follow-up whose whole purpose is to add the missing
observable expectations **without changing any existing spec or production
code**.

The two gaps are:

- **F1 — the ban exemption is not wired onto the shipped route.** ADR-0025 §2
  and contract §0.3 exempt `GET /me` and `POST /me/data-requests` from the ban
  rule via the `allowBanned` guard flag. Integration I5 proves the _flag_
  works on a synthetic `defineRoute` route, but the shipped
  `apps/web/src/app/api/v1/me/route.ts` builds
  `requireAuth("user", { auth, database })` with no `allowBanned`, so a banned
  user gets `423 account_banned` on `/me` while every existing spec stays green.
- **F2 — the admin 2FA _sign-in_ branch is unpinned.** I8 exercises the admin
  ALLOW path only on a session that **already existed** when 2FA was enrolled
  (the same cookie enables and confirms the second factor). The rival branch —
  a 2FA-enabled user signs in (email OTP → `twoFactorRedirect`, no session),
  completes `/two-factor/verify-otp`, and Better Auth's plugin mints a **new**
  session through `setSessionCookie` — is never exercised end to end.
  `recordVerifiedSession` marks `ctx.context.newSession ?? ctx.context.session`;
  if it read only the (absent) `session`, a fresh admin session would deny with
  `admin_2fa_required`.

## Decision

### 1. Gap 1 pins the REAL route handler, sharing the singleton database

The RED spec
`apps/web/src/test/integration/me-ban-exemption.test.ts` imports the handler
that actually ships — `import { GET } from "@/app/api/v1/me/route"` — and drives
it with a banned session cookie. It pins both halves of §0.3 with the **same**
banned session:

- `GET /api/v1/me` → `200` (the route is on the exemption list);
- a non-exempt synthetic `requireAuth("user")` route → `423 account_banned`.

This is RED on the current code for exactly the intended reason: the deployed
`/me` handler denies `423` where the contract says `200` (`expected 423 to be
200`).

**Why the handler can run at all.** The real handler resolves `getAuth()` /
`getDb()` from validated configuration, i.e. the process-wide singletons, not
from anything the spec can inject. To make the session the spec writes visible
to the route, the spec is the one integration file that must share a database
with those singletons: it points `MONGODB_URI` at a private, uniquely-named
database **before** the singleton client is built (`closeMongoClient()` first,
then the URI with the db path appended), builds its auth instance on the same
database, and asserts `database.databaseName` matches. This keeps per-run
isolation (unique name, dropped in `afterAll`) while proving the shipped route,
not a stand-in.

The `/me` response **body** is deliberately not asserted — it is OP-88's
contract.

### 2. Gap 2 pins the new-session sign-in branch (already GREEN)

The RED spec
`apps/web/src/test/integration/admin-two-factor-signin.test.ts` enrols 2FA on
one session, makes the user an admin, then signs in from a fresh session:

1. email OTP sign-in returns `{ twoFactorRedirect: true }` and sets **no**
   session cookie;
2. the challenge code arrives by SMS;
3. `/two-factor/verify-otp` with the challenge cookie returns `200` and mints a
   session cookie whose value **differs** from the enrolment session's (proof
   the signing-in branch, not a re-used session, produced it);
4. `resolvePrincipal(...)` reports `sessionTwoFactorVerified === true`; and
5. the admin guard route answers `200` with `ctx.principal` set.

The current implementation already satisfies this: `recordVerifiedSession`
reads `ctx.context.newSession`, which `setSessionCookie` populates on the
sign-in branch, so the spec **passes**. Per the card, a pin that passes on
current code is the deliverable; it exists so a future refactor that reverts to
`ctx.context.session` breaks loudly. This branch's RED/GREEN status is therefore
"GREEN today, regression-proof thereafter", and the GREEN child only touches
production code if it goes red.

### 3. The RED specs are append-only; helpers are duplicated, not imported

Both specs are new files. Per the repository RED rule, **no existing test, mock
or fixture is modified**, and the follow-up does not reach across spec files for
helpers: `guardRoute`, `insertProfile`, `requireOtp`, the identity factory and
the OTP flow helpers are re-declared locally (as OP-85/OP-86 specs already do).
Sharing them would couple an OP-86 follow-up to another suite's internals and
make either file's refactor a cross-suite break.

### 4. Determinism

Both specs follow the existing integration isolation rules: a unique
email/phone/IP identity per spec (no shared `auth.otp` / `auth.verify`
buckets), a fresh auth instance per spec, a fixed future `banExpires`, and a
per-run private database for the route-sharing spec.

## Consequences

- The suite now fails loudly if the ban exemption is removed from `/me`, or if
  the 2FA sign-in branch stops marking the newly minted session.
- `me-ban-exemption.test.ts` is the only integration file that shares the
  singleton Mongo client database; that coupling is documented in its header
  and isolated to a private database name, so it cannot perturb other files.
- No production code changed in this card.

## Alternatives considered

- **Test the exemption by replicating the `/me` route declaration in the spec**
  (a synthetic `requireAuth("user", { allowBanned: true })`). Rejected: that is
  what I5 already does, and it is exactly the gap F1 identified — it proves the
  flag, not that the shipped route sets it.
- **Inject the database into the real handler** (call `GET` with a custom
  context). Rejected: the route is `defineRoute`-built and takes only a
  `Request`; there is no injection point, and mocking `getDb` would test the
  mock instead of the wiring.
- **Assert the `/me` body or the session document's `twoFactorVerified` field
  directly.** Rejected: the body is OP-88's contract, and the session document
  is an implementation detail — the contract-visible facts are the principal
  and the HTTP status.
