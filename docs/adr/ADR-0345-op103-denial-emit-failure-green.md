# ADR-0345 — OP-103 follow-up GREEN: the denial survives a failing blocked-event emit

- **Status:** Accepted
- **Date:** 2026-10-24
- **Lane:** OP-103 (Entitlements), reserved range `0340`–`0359`
- **Card:** `t_2d83385c` (GREEN), worktree `/root/openpic/openpic-webapp/.worktrees/t_429ad6f8`,
  branch `OP-103-task-denial-emit-failure-green`, stacked on the pins head `9908b34`
- **Consumes:** `0345`
- **Follows:** [ADR-0340](ADR-0340-op103-entitlements-red.md) /
  [ADR-0341](ADR-0341-op103-entitlements-green.md) (the generic entitlement service),
  [ADR-0344](ADR-0344-op103-denial-emit-failure-red.md) (the RED pins this GREEN satisfies)
- **Satisfies:** [ADR-0344](ADR-0344-op103-denial-emit-failure-red.md) (round-1 review finding **F2 — Medium**)

## Context

`consumeEntitlement` (`apps/web/src/server/services/entitlements/service.ts`) is
the enforcement point for a metered write. On a denial it recorded the blocked
action — `recordDenial` logs `entitlement.denied` and emits
`usage.action.blocked` **outside** the caller's transaction — and only then
threw the Appendix A `AppError` (`plan_limit_exceeded` / `payment_required` /
`feature_not_available`, contract §0.14).

Because `recordDenial` was `await`ed **before** the throw, a failing outbox emit
replaced the denial: the reviewer's probe (a tenant-scoped key at its limit,
`emit` rejecting with `new Error("outbox write failed")`) threw
`{ code: null, status: null, message: "outbox write failed" }` instead of
`403 plan_limit_exceeded`. The HTTP pipeline maps any non-`AppError` throw to a
generic `500 internal_error`, so the route that should answer `402`/`403` with
the upgrade CTA answered a `500` and the client lost the denial reason.

[ADR-0344](ADR-0344-op103-denial-emit-failure-red.md) pinned the corrected
behaviour (RED); this card is the GREEN that satisfies those pins.

## Decision

### 1. The denial is authoritative; the emit failure is never rethrown

`recordDenial` now wraps the `usage.action.blocked` emit in a `try`/`catch`. On a
rejection the catch logs and returns; `consumeEntitlement` proceeds to
`throw denialError(tenantId, verdict)` unchanged. The thrown value is always the
Appendix A `AppError` for the denial, with its contract
`code`/`status`/`details` (`403 plan_limit_exceeded`, `402 payment_required`,
`403 feature_not_available`). A failing `usage.action.blocked` emit never
surfaces as the thrown value.

The `try` spans **both** emit paths — the injected `options.emit` seam and the
default `emitDomainEvent` — so the invariant holds for the production path and
for a unit spec's seam alike.

### 2. The emit failure stays observable, as a `warn` log line

The failure is not swallowed silently. It is recorded through the existing
logging port as a **`warn`-level** entry with
`event: "entitlement.denied.emit_failed"`, carrying `tenantId`, `entitlementKey`
and the original error under `err` (serialized by the logger's existing
`serializeError`). This mirrors the lane's precedent for a degraded-but-handled
emit — `safeEmit` in `@/server/auth/identity-hooks` logs
`identity_hook.emit_failed` and swallows — differing only in level: the auth
hook's emit is a first-class side effect and logs at `error`, whereas the
blocked event is a best-effort notification whose loss must not affect the
response, so `warn` is the pinned level (ADR-0344 §2).

### 3. The denial record and the emit attempt are preserved

The `entitlement.denied` `info` line is still written and the blocked emit is
still attempted exactly once before the throw. The fix stops the emit from
masking the `AppError`; it does not stop recording the denial.

### 4. The durable emit stays outside the caller's session

The emit is not moved inside the caller's transaction. The throw aborts that
transaction, so the `usage.action.blocked` record must survive it — the
deliberate deviation recorded in
[ADR-0340](ADR-0340-op103-entitlements-red.md). The `catch` changes only what
happens to a rejection, not where the emit runs.

## Consequences

- A denial is answered `402`/`403` (with the upgrade CTA) regardless of outbox
  health; an emit outage degrades observability of the blocked event, not the
  client contract.
- The `apps/web/src/server/services/**` branch threshold (90 %) is unaffected:
  the new `catch` branch is exercised by the ADR-0344 pins
  (`entitlements-denial-emit-failure.test.ts`), and the `emit === undefined`
  branch keeps its existing coverage.
- The change is three lines of production behaviour (a `try`/`catch` plus the
  `warn` call) inside one private helper; no new module, export or dependency.

## Alternatives

- **Let the emit error win (status quo).** Rejected by ADR-0344: it breaks
  contract §0.14 and turns a denial into an unmapped `500`.
- **Swallow the emit failure silently.** Rejected: an outage would be
  undetectable; the `warn` line keeps it observable without affecting the
  response.
- **Re-throw the `AppError` with the emit error attached as a `cause`.**
  Rejected: the pipeline would still receive a different reason code path and it
  adds nothing over a `warn` line.
- **Move the emit inside the caller's transaction so a failure aborts it.**
  Rejected: the transaction is aborted by the throw anyway, and the durable
  blocked record must survive it (ADR-0340).

## Number allocation

The lane cell read `0345` on the pins head (`origin/main` `c50ef7c` plus
ADR-0344). `0342`/`0343` are held by the unmerged F1 branch
(`OP-103-task-nontenant-scope-green`, PR #281) and `0344` is consumed by
[ADR-0344](ADR-0344-op103-denial-emit-failure-red.md), so this record takes
`0345` — the first number free across all refs — and advances the lane cell to
`0346`. No number outside the lane range `0340`–`0359` is touched.
