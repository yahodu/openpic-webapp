# ADR-0027 — OP-86 follow-up GREEN: wire the `/me` ban exemption and confirm the 2FA sign-in branch

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-86 follow-up GREEN `t_bbfcefed` (phase 1-Identity, epic Authentication) · **Amends:** ADR-0026
- **Implements:** contract §0.3 · **Depends on:** OP-86 (auth guards, `@/server/auth/guards`)

## Context

ADR-0026 pinned two OP-86 review gaps with append-only RED specs and stated the
expected production change. This GREEN card turns those pins green with the
minimum production change:

- `me-ban-exemption.test.ts` was RED (`expected 423 to be 200`) because the
  shipped `apps/web/src/app/api/v1/me/route.ts` built
  `requireAuth("user", { auth, database })` with no `allowBanned`.
- `admin-two-factor-signin.test.ts` was GREEN on current code (no production
  change required): `recordVerifiedSession` already reads
  `ctx.context.newSession ?? ctx.context.session`, so the session minted by
  `setSessionCookie` on `/two-factor/verify-otp` is marked
  `twoFactorVerified: true`.

## Decision

### 1. `GET /api/v1/me` passes `allowBanned: true`

The route's per-request auth stage now builds
`requireAuth("user", { auth: getAuth(), database: getDb(), allowBanned: true })`.

The flag is scoped to the two contract §0.3 exempt routes; `GET /me` is one of
them, so a banned user may read the route that explains the ban. Nothing else
changed: the decision table (`evaluateAuth`) already honours `allowBanned` by
skipping the ban check only (ADR-0025 §2), and the per-request
`getAuth()`/`getDb()` construction is preserved because `next build`'s
page-data collection depends on it (ADR-0025 §6.D). The ban rule remains
enforced on every non-exempt route, which the same spec pins with the same
banned session (`423 account_banned`).

### 2. The 2FA sign-in branch needed no production change

`recordVerifiedSession` already prefers `ctx.context.newSession` over the
(pre-second-factor, absent) `ctx.context.session`, so a fresh sign-in that
completes the second factor marks the newly minted session. `two-factor.ts` is
deliberately untouched: the card's change #2 is conditional on the spec going
red, and it does not. The new spec now makes that behaviour regression-proof —
a future refactor back to reading only `ctx.context.session` fails loudly.

## Consequences

- The suite fails if the `allowBanned` flag is removed from the shipped `/me`
  route, or if the 2FA sign-in branch stops marking the new session.
- No test, mock or fixture was modified; the RED specs are unchanged.
- No new dependency, no logging of credentials, no change to the enable/confirm
  branch of the two-factor flow.

## Alternatives considered

- **Replicate the exemption in the spec instead of the route.** Rejected: that
  is the I5 synthetic-flag gap ADR-0026 §1 exists to close; the shipped route
  must set the flag.
- **Change `recordVerifiedSession` even though the spec passes.** Rejected:
  behaviour changes only via a RED spec (YAGNI); the existing
  `newSession ?? session` already satisfies both the enable and sign-in
  branches.
