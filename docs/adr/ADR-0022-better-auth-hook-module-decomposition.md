# ADR-0022 — Better Auth hooks split into focused modules (OP-85 follow-up refactor)

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-85 follow-up `t_1c33f490` (epic Authentication, refactor) · **Amends:** ADR-0021 · **Depends on:** OP-85 (PR #128)
- **Supersedes / amends:** ADR-0021 is unchanged in substance (one global `hooks.before` + `hooks.after`, hook-based policy). This ADR records only the file-level decomposition of the module that ADR-0021 described as a single file.

## Context

ADR-0021 recorded that all OpenPic auth policy lives in one global `hooks.before`
and one `hooks.after`, because better-auth 1.7.7 exposes exactly one of each.
That decision is sound, but its implementation put the entire `createAuth`
configuration, the rate-limit closure, and every policy branch of both hooks in a
single 487-line `apps/web/src/server/auth/index.ts`. The reviewer round-1
follow-up flagged the monolith: it mixes config, shared helpers, and four
unrelated policies, so an edit to any one of them has to be reviewed against all
of the others.

## Decision

Split the implementation into focused modules and let `index.ts` compose them.
The observable behaviour is unchanged — the same single `before`/`after`
middleware, the same branch order, the same statuses, cookie attributes, inbox
records and log lines.

New internal modules under `apps/web/src/server/auth/`:

- **`internal.ts`** — the shared surface: the inferred `AuthHookContext` type, the
  structural `InternalAdapterLike`, the OTP constants, and `bodyOf(ctx)`.
- **`rate-limit-hook.ts`** — `createRateLimitHook({ rateLimiter, salt })`: the
  `auth.otp` / `auth.verify` classes, the path sets, and the unauthenticated-only
  `auth.verify` rule.
- **`callback-url.ts`** — `assertTrustedCallback(ctx, trustedOrigins)`: the
  `trustedOrigins` open-redirect guard.
- **`phone-hook.ts`** — `runPhoneHook(ctx)`: the anonymous send-otp eligibility
  guard and the authenticated `/phone-number/verify` `updatePhoneNumber` rewrite.
- **`two-factor.ts`** — `runTwoFactorBeforeHook(ctx, sender)` (enable/disable) and
  `runTwoFactorAfterHook(ctx, sender)` (the sign-in conversion), plus the
  two-factor code helpers.

`index.ts` keeps only the public surface (`AuthLike`, `CreateAuthOptions`,
`createAuth`, `getAuth`, `auth`), builds the collaborators (`sender`,
`rateLimiter`, `salt`, `cookieOptions`), and composes the two middleware:

```ts
const before = createAuthMiddleware(async (ctx) => {
  await rateLimitHook(ctx);
  assertTrustedCallback(ctx, trustedOrigins);
  const phoneResult = await runPhoneHook(ctx);
  if (phoneResult !== undefined) return phoneResult;
  const twoFactorResult = await runTwoFactorBeforeHook(ctx, sender);
  if (twoFactorResult !== undefined) return twoFactorResult;
  return undefined;
});
const after = createAuthMiddleware(async (ctx) => runTwoFactorAfterHook(ctx, sender));
```

### 1. The hook-context type is inferred, not reached for

The hook modules need the exact context type Better Auth hands a middleware. The
library does not export it (`getSessionFromCtx` takes an internal
`GenericEndpointContext`), and importing an internal type would couple us to a
non-public path across version bumps. `internal.ts` therefore derives it by
inference from a throwaway middleware (`Awaited<ReturnType<typeof probe>>`), so
the modules track whatever the installed better-auth hands them.

### 2. Compose with explicit short-circuit returns, not separate hooks

Each leg is a plain async function returning `unknown | undefined`; `index.ts`
returns the first defined result. This preserves the original branch order
exactly and keeps the "one global hook" constraint from ADR-0021 — it does not
register multiple Better Auth hooks (which the library does not support anyway).

## Consequences

- The OP-85 safety harness is the acceptance gate and stays green: unit 1155/56
  files, integration 159/27 (auth 14/14), e2e 9/9, plus `tsc`, `eslint` and
  `prettier`.
- Behaviour is preserved byte-for-byte: the same 429/403/401/400 envelopes, the
  same `__Secure-`/`HttpOnly; SameSite=Lax; Path=/` cookie policy, the same
  `auth.otp.sent` log shape, the same inbox channel, and the same
  `/phone-number/verify` body rewrite.
- Adding or changing one policy now touches one module; a reviewer only has to
  read that module and the composition in `index.ts`.
- `assertTrustedCallback` is synchronous (it performs no I/O); the other legs stay
  async. This is a lint-driven detail (`require-await`), not a behaviour change.

## Alternatives considered

- **Keep one file, extract only helpers.** Rejected: the policy branches are the
  part that needs isolation, not the leaf helpers.
- **Register a `before` hook per module.** Rejected: better-auth exposes a single
  `before`/`after` slot, so this is not expressible without a hand-rolled
  dispatcher.
- **Re-export a `GenericEndpointContext` from better-auth internals.** Rejected:
  it is not part of the public API; the inferred probe type is version-agnostic.
