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
  `94f5af0` and merged with `origin/main` `54f8542` at rework — the merge
  renamed this record's ADRs to `0386`/`0387`; production file
  `apps/web/src/server/adapters/cashfree/cashfree-provider.ts`
  sha256 `dd6006c04e8f26e75b9d98a2e18a6f1efe452d6cd7a907e699385ed99447d138`):
  - Pins: `TMPDIR=/root/tmp-mongo npx vitest run --project integration payments-cashfree-drift-log` → **4 passed (4)**, the spec byte-identical to the pins head.
  - Full unit: **108 files / 1859 passed | 3 skipped**; full integration: **76 files / 545 passed**.
  - `tsc` (all three projects) exit `0`; ESLint **0 errors** (105 warnings are pre-existing, none on the touched file); `prettier --check` clean.
  - `test:coverage` exit `0` — statements `92.39 %`, branches `81.14 %`, functions `95.9 %`, lines `92.88 %` (no gate weakened, no test written); the `adr-numbering` guard **29/29**.
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

## Review sign-off — 2026-10-25

_Reviewed in PR [#297](https://github.com/yahodu/openpic-webapp/pull/297) at head `f2e8ae7`
— round 3 (contract lens), verdict **APPROVED**. The reviewer resolved the shared
`docs/adr/README.md` union on the branch (after the trunk's PR #302 landed `ADR-0385` and
moved the lane cell) and the PR was squash-merged to `main` (merge commit `2669c30`,
verified an ancestor of `origin/main`)._

Nothing above is retracted or reworded: §Consequences and the **Evidence** block stand
exactly as merged. This section records only the review that landed them.

- **Lens history on the same card.** Round 1 (artifact) and round 2 (execution) both
  returned `changes_requested` on the recurring **shared ADR-ledger collision** — the pair
  was minted at `0382` in round 1 and renumbered to `0383`/`0384` in round 2, each time
  after a sibling card reached the trunk first. Round 3 (contract) verified the renumber to
  **`0386`/`0387`**, the lane `Next free` cell then reading **`0388`**, and found **no
  duplicate ADR number** on the merged tree (the repo guard `adr-numbering` **29/29**).
- **The pins shipped byte-identical.** The spec
  `apps/web/src/test/integration/payments-cashfree-drift-log.test.ts` still hashes
  `sha256 e86ae726cb14…95411` at the pins head `94f5af0` and on the merged tree
  (re-measured on `origin/main`), and was **re-run green** on the merged head: **4 passed
  (4)** — exactly the figure §Evidence records.
- **Independently reproduced on the merged tree:** pins **4 passed (4)**; full unit
  **108 files / 1859 passed | 3 skipped**; full integration **76 files / 545 passed**;
  combined `--coverage` **184 files / 2404 passed | 3 skipped, exit 0** →
  **92.39 / 81.14 / 95.9 / 92.88**; `tsc` exit `0`; ESLint 0 errors / 0 warnings on the
  touched files; `prettier --check` clean. These match the §Evidence block; the ESLint
  caveat there (105 pre-existing warnings repo-wide, none on the touched file) still holds.
- **Contract mapping (round 3).** Exactly one `payments.upstream_contract_violation` per
  wire path, each carrying the pinned `operation` (`parseWebhook` / `fetchStatus`); the
  public port `normalizeStatus` untouched; no drift line for a status inside the table; no
  secret, signature or payload in the line; TSDoc on the new helper.
- **Post-review status of the recorded findings.** The two items the review found are
  recorded **Info-only, no code change**, and no card was raised for either: the
  `normalizeWireStatus` `catch` is broader than today's single throw, and `createMandate`'s
  response `subscription_status` is still not table-validated. They remain open
  observations, not defects pinned by this card's contract.
- **Related follow-up work, cited by card id only** (no ADR number asserted — the record of
  an open follow-up may renumber before it lands): the boundary-lint pair `t_d3a8bf6f`
  (TEST) → `t_b7f8adfd` (GREEN), and the board process card `t_e5485868`, which owns the
  durable fix for the recurring ADR-ledger collision this card bounced on twice.
