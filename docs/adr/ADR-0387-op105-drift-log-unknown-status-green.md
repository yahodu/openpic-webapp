# ADR-0387 — OP-105 follow-up GREEN: emit the drift log for a vendor `subscription_status` outside the pinned table (F2)

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-105 follow-up GREEN (`t_92de5343`) · **Branch:** `OP-105-task-driftlog-green` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_e553b2c9` (shared with the TEST lane)
- **Lane:** OP-105 (Payments adapter), reserved range `0380`–`0399` · **Consumes:** `0387`
- **Relates to:** [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) (the RED contract — §1 the unknown-status case, §6 the drift line), [ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (the GREEN implementation), [ADR-0386](ADR-0386-op105-drift-log-unknown-status-pin.md) (the pins this GREEN turns green), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Supersedes:** nothing. It **satisfies** ADR-0386's pins by making the drift line fire on both detection paths, reusing the `contractViolation(...)` helper ADR-0380 §6 already owns.
- **Fixes:** round-1 (artifact-lens) review finding **F2 — Medium** on the merged OP-105 GREEN card `t_e553b2c9` (PR [#292](https://github.com/yahodu/openpic-webapp/pull/292), head `d3b6bdc`).

## Context

ADR-0386 pinned the defect: the wire schemas are deliberately non-strict on the
`subscription_status` string, so a brand-new vendor status parses cleanly and is
detected only by the `STATUS_TABLE` lookup — the one detection path that raised
`UpstreamContractError` **without** emitting `payments.upstream_contract_violation`.
The lookup runs at two wire call sites in `apps/web/src/server/adapters/cashfree/cashfree-provider.ts`:

- `fetchStatus` → `normalizeVendorStatus(response.subscription_status)`;
- `parseWebhook` → the status is also resolved **inside** `kindForEvent`
  (`kindForStatus(normalizeVendorStatus(vendorStatus).status)`) for a
  `SUBSCRIPTION_STATUS_CHANGED` event, and again at the post-`kindForEvent` line.

The second point is the subtle one: on the `parseWebhook` path the unknown status
throws from **inside** `kindForEvent` _before_ the post-`kindForEvent`
normalization runs, so wrapping only the later line would still log nothing.

## Decision

Emit the drift signal at both wire call sites through the existing
`contractViolation(...)` helper, and leave the pure port method untouched.

1. **A closure-level helper `normalizeWireStatus(operation, vendorStatus)`** is
   added inside `createCashfreeProvider`. It calls `normalizeVendorStatus` and,
   on the table miss, `throw contractViolation(operation, message, error)` — so
   the drift line carries `event = payments.upstream_contract_violation`,
   `level = error`, `provider = cashfree` and the operation, and a same-class,
   same-message `UpstreamContractError` propagates. A status **inside** the
   table returns normally and logs nothing, so the line stays a drift signal and
   not a per-call line (ADR-0386 guard pins).
2. **`fetchStatus`** calls `normalizeWireStatus("fetchStatus", response.subscription_status)`.
3. **`parseWebhook`** resolves the status **before** deriving the kind —
   `normalizeWireStatus("parseWebhook", vendorStatus)` then `kindForEvent(type, data)`.
   This is what makes the `parseWebhook` path log exactly once: the unknown status
   throws from the wire-lookup helper (logging once) and `kindForEvent`'s internal
   `normalizeVendorStatus` is never reached. For a known status the result is
   unchanged (both lookups succeed, no line).
4. **The public port method `normalizeStatus(vendorStatus)` is unchanged** and
   still throws. A log belongs to the wire path — the surface that observed the
   response — not to the pure table lookup, which the U1 unit pin exercises
   directly with no logger.
5. **The thrown message is unchanged.** The `Unknown Cashfree subscription
status: <status>.` text is hoisted into a module-private `unknownStatusMessage`
   helper shared by `normalizeVendorStatus` and `normalizeWireStatus`, so the
   error U1 asserts (`/SOME_NEW_VENDOR_STATUS/`) and the drift line always carry
   the same text. No second log shape is invented.

The `operation` values are fixed by ADR-0386 (`parseWebhook`, `fetchStatus`) and
were not re-decided. The log line carries message + provider + operation only —
no secret, signature or raw payload (`docs/CONVENTIONS.md` §5.3), exactly like the
existing `contractViolation` line.

## Consequences

- An unrecognised vendor status is now loud **in production** on both entry
  points, not only in the test suite: the on-call page fires where it was
  silently swallowed.
- The two guard specs (a known `ACTIVE` status emits **no** drift entry) keep the
  line non-vacuous — a per-call log fails them, and it does not.
- `parseWebhook`'s unknown-status throw now originates from the wire-lookup
  helper rather than from `kindForEvent`. Same class, same message, same eventual
  return shape; the only observable change is the added drift line.
- **Precedence (round-1 review finding F2):** `parseWebhook` now resolves the
  `subscription_status` **before** deriving the event kind, so a payload that is
  malformed in **both** ways — an unknown event `type` **and** an unknown
  `subscription_status` — surfaces `Unknown Cashfree subscription status: <status>.`
  rather than `Unknown Cashfree webhook event type: <type>.` It is the same
  `UpstreamContractError` class, still non-retryable, and still carries the single
  drift line. Reverting to derive the kind first would break ADR-0386's
  exactly-one-drift-entry pin, so the precedence is documented rather than reverted.
- **Evidence** (branch `OP-105-task-driftlog-green`, stacked on the pins head
  `94f5af0`; production file `apps/web/src/server/adapters/cashfree/cashfree-provider.ts`
  sha256 `dd6006c04e8f26e75b9d98a2e18a6f1efe452d6cd7a907e699385ed99447d138`):
  - Pins: `TMPDIR=/root/tmp-mongo npx vitest run --project integration payments-cashfree-drift-log` → **4 passed (4)**.
  - Full unit: **104 files / 1800 tests passed**; full integration: **74 files / 525 tests passed**.
  - `tsc` (all three projects) clean; ESLint **0 errors** (the 102 warnings are pre-existing, none on the touched file); `prettier --check` clean.
  - `test:coverage` exit `0` — statements `92.32 %`, branches `80.84 %`, functions `96.19 %`, lines `92.82 %` (no gate weakened, no test written).
- The pins are reviewed inside this GREEN's PR per the lane's RED→GREEN precedent;
  the sibling TEST card `t_8ccb6c1f` reviewed them as a frozen deliverable.

## Alternatives considered

- **Log inside `normalizeVendorStatus`.** Rejected: that is the pure table lookup,
  reached directly by the port method `normalizeStatus` (U1) — the log would fire
  on a surface that observed no response, contradicting ADR-0386's
  wire-path-only framing.
- **Wrap only the post-`kindForEvent` normalization in `parseWebhook`.** Rejected:
  for a `SUBSCRIPTION_STATUS_CHANGED` event the unknown status throws inside
  `kindForEvent` first, so no line would be emitted on that path.
- **Catch in `parseWebhook` and rethrow, translating any `UpstreamContractError`.** Rejected:
  it would also turn "unknown vendor event type" and "no `subscription_status`"
  into drift lines the pins do not ask for, and the defensive `instanceof` branch
  is unreachable (see below).
- **Defensive `if (!(error instanceof UpstreamContractError)) throw error;` in the
  helper.** Rejected: `normalizeVendorStatus` only ever throws
  `UpstreamContractError`, so the false branch would never run and would add an
  uncovered branch to a suite sitting near the 80 % branch gate.
- **Reuse the caught error's `message` (`error.message`) instead of a shared
  helper.** Rejected: reading it from `unknown` needs an `as` cast (ESLint-banned)
  or an `instanceof` ternary whose false side is unreachable — the same uncovered
  branch. Hoisting the message keeps one source of truth with no branch.
