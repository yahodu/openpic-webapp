# ADR-0402 — OP-106 follow-up TEST: pin the subscription read's unpinned edges (multi-row tie-break, `scheduledChange`/`updatedAt` serialization, zeroed `pendingDue`, terminal-row `cancelAt`)

- **Status:** Accepted · **Date:** 2026-10-25
- **Lane:** OP-106 (Subscriptions), reserved range `0400`–`0419`
- **Card:** `t_09e53bea` (follow-up TEST — characterisation pins), worktree
  `/root/openpic/openpic-webapp/.worktrees/t_8f332485`, branch
  `OP-106-task-subscription-read-followup-pins`, off `origin/main` `cab62e8`
  (the `1.31.0` release chore on top of the OP-106 squash `68f73ff`)
- **Consumes:** `0402`
- **Fixes:** the round-1 review findings **F1** and **F2** by way of the OP-106
  GREEN review (`t_b08b6d61`), whose `F3` routed the projection-serialization
  gap here
- **Supersedes nothing.** [ADR-0400](ADR-0400-op106-subscription-read-red.md)
  (the RED contract) and [ADR-0401](ADR-0401-op106-subscription-read-green.md)
  (the GREEN) are unchanged; this record only adds pins over the shipped
  implementation. Where a pin characterises behaviour those records explicitly
  left open, it is labelled as such below.

## Context

The OP-106 GREEN is merged (PR #294, squash `68f73ff`, ancestor of `origin/main`)
and its round-1 review (`t_b08b6d61`) approved it **with findings**. Three of the
findings are behaviours the OP-106 pins did not cover, and ADR-0400's own
**out-of-scope** note lists exactly those: _"multi-document ordering when a tenant
holds both a live row and cancelled history (the read is pinned only for the
single-row and no-row cases)"_ and _"`scheduledChange` cancellation"_, while
ADR-0401 §Consequences adds the **`cancelAt`-on-a-terminal-row** open question and
the unpinned `scheduledChange`/`updatedAt` serialization.

The merged read is `readSubscriptionView` (`apps/web/src/server/services/subscriptions/view.ts`):

- `loadSubscriptionRow` is
  `tenantRepo(tenantId, db).collection(COLLECTIONS.subscriptions).findOne({}, { sort: { updatedAt: -1 } })`
  — the _most recently updated_ row per ADR-0400 §1, but with **no tie-break** for
  two rows at an equal `updatedAt` (MongoDB's natural order is unspecified);
- `projectStoredRow` serializes `scheduledChange.effectiveAt` and `updatedAt`
  with `.toISOString()`, and gates `pendingDue` on `pendingDueMinor > 0`;
- `buildSubscriptionBanner`'s last rule (`cancelAt !== null` → `cancelling`,
  ADR-0400 §1 row 5) is unconditional and does not exclude a terminal status.

None of the four was pinned. This card adds **characterisation pins** — tests
that lock the shipped behaviour rather than driving new code — so the contract
stops resting on unpinned code.

## Decision

Five specs are added inside a new nested `describe` in the existing
`apps/web/src/test/integration/subscription-read.test.ts`; the eight original
specs are byte-unchanged and `seedSubscription` gains two optional overrides
(`scheduledChange`, `updatedAt`) defaulting to today's values, so every existing
call site keeps its baseline. No production file is touched.

1. **Zeroed `pendingDue`.** A stored row with `pendingDueMinor: 0` serves
   `pendingDue: null` (never `{ amountMinor: 0, currency: "INR" }`). Only the
   positive case (`49900`, I2) and the free state were pinned before.
2. **`scheduledChange` + `updatedAt` serialization.** A row whose
   `scheduledChange = { toPlanKey, effectiveAt: Date, reason }` and `updatedAt`
   are stored as `Date`s serves both as RFC 3339 strings
   (`effectiveAt.toISOString()`, `updatedAt.toISOString()`), asserted exactly
   **and** as `typeof … === "string"` so a regression that leaks a `Date`
   object fails. Unit-only coverage does not exist for this projection — it is
   only reachable through the read.
3. **`scheduledChange` null case.** A row with no scheduled change serves
   `scheduledChange: null` **and** still serializes `updatedAt` (so the null pin
   is not vacuous against a dropped field).
4. **Multi-row tie-break (characterisation).** Two tenants are seeded with two
   `subscriptions` rows each at the **same** `updatedAt`, one `active` and one
   `cancelled`, in **opposite insertion orders**. The pin asserts the served row
   tracks **insertion order, not status**: active-inserted-first serves `active`,
   cancelled-inserted-first serves `cancelled`. This fixes the shipped answer for
   this harness while making the _intent_ question explicit — if product wants
   "the live row wins" (the natural reading of "most recently updated" plus a
   cancelled history), that is a **new RED** against ADR-0400 §1, not a silent
   behaviour change. The pin is deterministic in this harness (verified over four
   consecutive runs) but MongoDB's tie-break remains formally unspecified, so the
   record flags the residual fragility rather than pretending it away.
5. **Terminal row carrying `cancelAt` (characterisation).** A `cancelled` row
   whose `cancelAt` is still non-null serves `status: "cancelled"` with
   `banner: { kind: "cancelling", severity: "informational" }` and
   `cancelAt` as an RFC 3339 string. The spec comment names **ADR-0400 §1 row
   5** (unconditional) and **ADR-0401's open question**; if product decides the
   banner must be suppressed on a terminal status, that is a RED + GREEN change
   to ADR-0400 row 5, not an edit of this pin.

## Consequences

- **The pins are green on the trunk** — they lock existing behaviour, they do
  not drive new code. **No GREEN sibling is needed** and none is created.
- Pins 1–3 close the projection-serialization gap; pin 4 closes the multi-row
  ordering gap ADR-0400 declared out of scope; pin 5 closes the `cancelAt`
  open question by recording the shipped answer rather than guessing a product
  intent.
- **Evidence at the pin head (`cab62e8` + this change):** focused unit
  `subscription-view.test.ts` **32 passed (32)**; focused integration
  `subscription-read.test.ts` + `subscription-history.test.ts` **20 passed (20)**
  (was 15; +5 new specs); full unit **106 files / 1843 passed | 3 skipped**;
  full integration **75 files / 541 passed** (was 536 on the trunk); `pnpm
typecheck` exit 0 on all three workspace projects; `eslint` 0 problems on the
  touched file; `prettier --check` clean on the touched file; the
  `adr-numbering` guard green. The multi-row tie-break spec was additionally run
  in isolation **4×**, green each time.
- **Fragility recorded, not hidden.** Pin 4 depends on a fresh collection's
  natural (insertion) order, which WiredTiger preserves for an unmodified
  collection but MongoDB does not contractually guarantee. The pin is written so
  a _status_-based order (either direction) is caught — only a stable
  insertion-order answer passes. If a future Mongo version reorders, the failure
  is loud and the correct response is to escalate to the orchestrator, not to
  loosen the assertion.
- No test was weakened: the existing eight specs and the two pre-existing
  focused counts are unchanged; the five added specs are net-new coverage.
- `docs/adr/README.md` remains the shared-ledger **hotspot** — this record adds
  one index row after `0401`, advances the OP-106 lane `Next free` cell
  `0402` → `0403`, and appends a lane note. The pool cell stays `0420`+.

## Alternatives considered

- **Pin "the live row wins" and raise a RED for the current behaviour.**
  Rejected: the card says to pin the **shipped** behaviour and raise the product
  question separately, and ADR-0400 §1's out-of-scope note is explicit that the
  ordering was deliberately left unspecified — a RED here would drive code the
  lane never contracted.
- **Assert the served row merely belongs to the two seeded rows.** Rejected: it
  cannot fail on a reordering regression, so it pins nothing.
- **Force determinism with a third "newest" row.** Rejected: it changes the
  scenario under test (no longer an equal-`updatedAt` tie).
- **Add unit coverage for the projection helper directly.** Rejected: the
  projection is private to `view.ts`; exercising it through the route is what the
  card asks for and what keeps the pin behaviour-facing.
- **Change production to break the tie (`updatedAt`, then `status`).** Not this
  card: it is a test-only follow-up and a contract change; it would require a
  RED-pin + GREEN pair via the orchestrator (OP-106 precedent).

## ADR number allocation

`0400` is consumed by [ADR-0400](ADR-0400-op106-subscription-read-red.md) (the
RED contract) and `0401` by
[ADR-0401](ADR-0401-op106-subscription-read-green.md) (the GREEN), so this record
takes `0402`, the lane cell's value re-read at the branch cut immediately before
committing, and advances the lane's `Next free` cell to `0403`. No number outside
the lane range `0400`–`0419` is touched.
