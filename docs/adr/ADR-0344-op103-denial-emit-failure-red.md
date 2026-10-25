# ADR-0344 — OP-103 follow-up RED: a denial is authoritative when the outbox emit fails

- **Status:** Accepted
- **Date:** 2026-10-24
- **Lane:** OP-103 (Entitlements), reserved range `0340`–`0359`
- **Card:** `t_4ce9a410` (TEST / RED), worktree `/root/openpic/openpic-webapp/.worktrees/t_429ad6f8`,
  branch `OP-103-task-denial-emit-failure-pins`, off `origin/main` `c50ef7c` (the `1.29.0` release)
- **Consumes:** `0344`
- **Follows:** [ADR-0340](ADR-0340-op103-entitlements-red.md) /
  [ADR-0341](ADR-0341-op103-entitlements-green.md) (the generic entitlement service)
- **Gated GREEN:** child card `t_2d83385c`

## Context

`consumeEntitlement` (`apps/web/src/server/services/entitlements/service.ts`) is
the enforcement point for a metered write. On a denial it records the blocked
action — `recordDenial` logs `entitlement.denied` and emits
`usage.action.blocked` **outside** the caller's transaction — and only then
throws the Appendix A `AppError` (`plan_limit_exceeded` / `payment_required` /
`feature_not_available`, contract §0.14).

Round-1 review of OP-103 (card `t_429ad6f8`, finding **F2 — Medium**) reproduced
a defect in that ordering: because `recordDenial` is `await`ed **before** the
throw, a failing outbox emit replaces the denial. The reviewer's probe (a
tenant-scoped key at its limit, `emit` rejecting with
`new Error("outbox write failed")`) threw
`{ code: null, status: null, message: "outbox write failed" }` instead of
`403 plan_limit_exceeded`. The HTTP pipeline maps any non-`AppError` throw to a
generic `500 internal_error`, so the route that should answer `402`/`403` with
the upgrade CTA answered a `500` and the client lost the denial reason.

This card is test-only: pin the corrected behaviour (RED) so the gated GREEN can
implement it.

## Decision

### 1. The denial is authoritative; the emit failure is never rethrown

When `options.emit` rejects, `consumeEntitlement` still throws the Appendix A
`AppError` for the denial, with its contract `code`/`status`/`details`
(`403 plan_limit_exceeded`, `402 payment_required`, `403 feature_not_available`).
A failing `usage.action.blocked` emit must never surface as the thrown value.

### 2. The emit failure stays observable, as a `warn` log line

The emit failure must not be silently swallowed either. It is recorded through
the existing logging port as a **`warn`-level** entry with
`event: "entitlement.denied.emit_failed"`, carrying the tenant id, the
entitlement key and the original error, so an operator can see the lost blocked
row. This follows the lane's precedent of recording a degraded-but-handled path
at `warn` (`notification.catalogue_fallback`). The pin fixes the event name and
level only; the exact transport/fields beyond `event`/`level`/`tenantId`/
`entitlementKey` are not pinned.

### 3. The denial record and the emit attempt are preserved

The `entitlement.denied` `info` line is still written and the blocked emit is
still attempted exactly once before the throw — the fix must not stop recording
the denial, only stop it from masking the `AppError`.

### 4. New spec file only

The pins live in a **new** unit spec,
`apps/web/src/test/unit/entitlements-denial-emit-failure.test.ts`, which injects
a rejecting emitter through the `options.emit` seam. The existing entitlement
specs, fixtures, helpers and the U7 guard are untouched, and no production code
is added.

## Consequences

- A denial is answered `402`/`403` (with the upgrade CTA) regardless of outbox
  health; an emit outage degrades observability of the blocked event, not the
  client contract.
- The GREEN must catch the emit rejection inside the denial path (around the
  `recordDenial` emit), log `entitlement.denied.emit_failed` at `warn`, and still
  throw the `AppError`.
- The pins fail on the current trunk (`isAppError(error) === false`,
  `error.code === undefined`) and are expected to be folded into the GREEN's PR
  (`t_2d83385c`).

## Alternatives

- **Let the emit error win (status quo).** Rejected: it breaks contract §0.14
  (`402`/`403` with the CTA) and turns a denial into an unmapped `500`.
- **Swallow the emit failure silently.** Rejected: an outage would be
  undetectable; the `warn` log keeps it observable without affecting the
  response.
- **Re-throw the `AppError` with the emit error attached as a `cause`.**
  Rejected: it still hands the pipeline a different reason code path and adds no
  value over a `warn` line.

## Number allocation

The lane cell on `origin/main` read `0342`, but `0342`/`0343` are held by the
unmerged OP-103 follow-up F1 branch
(`OP-103-task-nontenant-scope-green`, PR #281, which records `ADR-0342` /
`ADR-0343` and sets its own cell to `0344`).
Taking `0342` would duplicate F1's record on merge, so this card takes `0344`
(the first number free across both refs) and advances the lane cell to `0345`.
No number outside the lane range `0340`–`0359` is touched; the F1 merge should
resolve the lane-cell row to `0345`.
