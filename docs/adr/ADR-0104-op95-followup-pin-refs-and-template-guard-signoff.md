# ADR-0104 — OP-95 follow-up GREEN review sign-off: stale ADR-0100 pin refs renumbered to ADR-0102 and the template-group catalogue guard pinned

- **Status:** Accepted · **Date:** 2026-10-06
- **Card:** OP-95 follow-up TEST (`t_4148565a`, assignee `openpic-webapp-testcase-writer`)
- **Depends on:** OP-95 follow-up GREEN (ADR-0103, PR #199 / `a9da3e6`), RED (ADR-0102), OP-94 fan-out ledger (ADR-0092), OP-93 `renderTemplate` (ADR-0085)
- **Findings source:** round-1 review of `t_17ca0cb6` (APPROVED WITH FINDINGS, three Low items; two routed here)
- **Contract:** §0.13 (secret redaction), §7.6 (type catalogue) · **Design:** §5/§8.2

## Context

The round-1 review of the OP-95 follow-up GREEN (`t_17ca0cb6`, ADR-0103, PR
#199, merged `a9da3e6`) returned **APPROVED WITH FINDINGS** with no
Critical/High items. It independently reproduced unit 1444 / integration 302 /
e2e 16, `tsc`, `eslint` and `prettier`, and all GitHub checks. Three Low
findings were recorded; the internal error-message nuance was closed with "no
action", and the remaining two were routed to this Test Author card. Nothing in
this card changes production behaviour — it is comment text plus coverage.

## Decision

### Item 1 — stale `ADR-0100` pin references renumbered to `ADR-0102`

The OP-95 follow-up RED pins (`t_7fde2bdd`) originally claimed ADR numbers
`0100`/`0101`; before merge, a _different_ OP-95 follow-up lane
(test-reference renumber, PR #196/#198) claimed `0100`/`0101` on `origin/main`,
so this lane renumbered to `0102` (RED) / `0103` (GREEN) (ADR-0103 "ADR
renumber"). The RED pins' test-file docstrings were intentionally left citing
`ADR-0100` by the GREEN card, which writes no test changes. This card re-points
them to the authoritative RED record, **docstring text only — no assertion or
logic change**:

- `apps/web/src/test/integration/notification-otp-catalogue-fallback.test.ts:16`
  (`RED, finding F2`) → `ADR-0102`.
- `apps/web/src/test/integration/notification-otp-delivery.test.ts` F1 docstring
  → `ADR-0102`.
- `apps/web/src/test/integration/notification-otp-delivery.test.ts` F5 docstring
  → `ADR-0102`.

### Item 2 — the template-group production guard is pinned (coverage gap)

`sendTransactionalNow` routes **both** seed-fallback sites through
`guardSeededCatalogueFallback`: the type row (`COLLECTIONS.notificationTypes`)
and the template group (`COLLECTIONS.notificationTemplates`) (ADR-0103 F2). The
existing `F2` spec leaves the catalogue _fully_ empty, so the type-row guard
throws first and the template-group production branch was never exercised — the
suite passed even with that branch removed.

New spec `F2c` (same file as `F2`) isolates the branch:

- Stores one schema-valid `notificationTypes` row (taken from
  `SEED_NOTIFICATION_TYPES` for `auth.otp.email.requested`), so the **type-row**
  guard is skipped.
- Leaves `notificationTemplates` **empty**, so `storedTemplates.get(channelGroup)`
  is `undefined` and the **template-group** guard is the branch reached.
- Runs under `APP_ENV=production` via the existing `stubProductionEnv()` shape
  (a production-valid config, so a rejection cannot be confused with a
  `ConfigError`).
- Asserts the call **rejects**, the transport outbox is empty, and no
  `dispatches` row was written — i.e. the rejection is pre-insert and
  pre-hand-off.

No production file was edited. The branch already exists in
`apps/web/src/server/notifications/fan-out.ts`.

**RED-capability evidence.** Because the branch already ships in the merged
GREEN, the pin passes immediately on `origin/main`; this is a coverage pin, not
a behaviour change. Its discriminating power was verified by a transient,
reverted mutation: with the `if (storedForGroup === undefined) {
guardSeededCatalogueFallback(…notificationTemplates) }` block removed, `F2c`
fails (`promise resolved "{ dispatchId, providerMessageId, status: "sent" }"
instead of rejecting`) while `F2` remains green; restoring the block (via `git
checkout`) returns the suite green. That is the RED the pin guards.

### Item 3 — review sign-off recorded

This ADR is the sign-off for the OP-95 follow-up GREEN review plus these two
follow-up items, per the repo convention that each lane records its review
outcome in `docs/adr/`.

## Consequences

- The OP-95 follow-up GREEN and its RED pins now cite a single, correct ADR
  (`0102`); the stale `0100` cross-reference confusion is removed.
- The template-group production guard has a dedicated regression pin; removing
  that branch now breaks `F2c` loudly (verified by mutation), so the
  "production never serves the seed silently" property is pinned at both guard
  sites rather than one.
- The suite count grows by one integration spec; no existing pin changed
  behaviour, and no production code changed.
- The two Low findings are closed; no open follow-ups remain from the round-1
  review.

## Alternatives considered

- **Leave the `ADR-0100` docstrings as-is (the GREEN chose this).** Rejected:
  `0100` belongs to a different lane, so a reader following the reference lands
  on the wrong decision record; the renumber is a one-line, behaviour-free fix.
- **Extend `F2` to cover both guard sites in one spec.** Rejected: one behaviour
  per test — `F2` pins the type-row guard, `F2c` pins the template-group guard,
  and a failure names which branch regressed.
- **Rely on the merged GREEN's own tests for the template branch.** Rejected:
  they never reach it (the type-row guard throws first), which is exactly the
  coverage gap this card closes.
- **Edit production code to make the pin RED first.** Rejected: the branch is
  already merged; the card is explicitly coverage-only and the RED was
  demonstrated by a reverted mutation instead.

## Out of scope

- Any production behaviour change (the merged GREEN is authoritative).
- The asynchronous fan-out path's own fallbacks (unchanged; not pinned here).
- Product copy wording (stays `TODO(product)`).
- The third round-1 Low finding (internal unknown-type error message), closed as
  "no action — internal message only".
