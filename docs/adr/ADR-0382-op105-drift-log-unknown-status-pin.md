# ADR-0382 — OP-105 follow-up TEST: the drift log fires for a vendor `subscription_status` outside the pinned table (F2)

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-105 follow-up TEST (`t_8ccb6c1f`) · **Branch:** `OP-105-task-driftlog-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_e553b2c9`
- **Lane:** OP-105 (Payments adapter), reserved range `0380`–`0399` · **Consumes:** `0382`
- **Relates to:** [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) (the RED contract — §1 the unknown-status case, §6 the drift line), [ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (the GREEN implementation), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Supersedes:** nothing. It **strengthens** ADR-0380 §6: the drift line was pinned for a _response that breaks the pinned contract_, and an unknown vendor status is exactly such a response — the one detection path that did not emit it.
- **Fixes:** round-1 (artifact-lens) review finding **F2 — Medium** on the merged OP-105 GREEN card `t_e553b2c9` (PR [#292](https://github.com/yahodu/openpic-webapp/pull/292), head `d3b6bdc`).

## Context

ADR-0380 §1 makes "a new vendor status Cashfree adds tomorrow" the case the pinned
contract exists for, and §6 pins `payments.upstream_contract_violation` as "the signal
an on-call engineer is paged on" for a response that breaks the pinned contract. The
wire schemas are deliberately non-strict on the status string
(`cashfreeWebhookEventSchema.subscription_details.subscription_status` and the two
response schemas are `z.string().min(1)`), so a brand-new vendor status **parses
cleanly** and is detected only by the `STATUS_TABLE` lookup.

That lookup — `normalizeVendorStatus` — is called from `fetchStatus`, from
`parseWebhook`, and from `kindForEvent`, all **outside** the `contractViolation(...)`
helper that owns the drift log. An unknown status therefore raised
`UpstreamContractError` with no log line at all. Reproduced on the merged head
`d3b6bdc` with a `memoryTransport` logger and the card's own fixtures:

- `provider.parseWebhook(<schema-valid SUBSCRIPTION_STATUS_CHANGED body with subscription_status: "SOME_NEW_VENDOR_STATUS">)` → throws `UpstreamContractError`; logged events `[]` (nothing).
- `provider.fetchStatus(ref)` against a `200` JSON body carrying the same unknown status → throws `UpstreamContractError`; logged events `["payments.call"]` (an `info` line) only.

So an API change was loud in the _tests_ but silent _in production_ — the precise
failure the drift line exists to prevent.

## Decision

The drift signal fires on **both** detection paths, and the pin fixes the `operation`
each path must report. Two new integration specs (and two regression guards) in
`apps/web/src/test/integration/payments-cashfree-drift-log.test.ts`:

1. **`parseWebhook`** with a schema-valid body whose `subscription_status` is outside
   the twelve-row table logs **exactly one** entry with
   `event === "payments.upstream_contract_violation"`, `level === "error"`,
   `provider === "cashfree"` and **`operation === "parseWebhook"`**, and throws
   `UpstreamContractError`.
2. **`fetchStatus`** against a `200` body with an unknown `subscription_status` logs
   the same drift entry with **`operation === "fetchStatus"`** and throws
   `UpstreamContractError`.
3. **Guard (both paths):** a _known_ status (`ACTIVE`) emits **no** drift entry — the
   line stays a drift signal, not a per-call line. `parseWebhook`'s guard also asserts
   the returned event's `status === "active"`; `fetchStatus`'s guard asserts the
   normalized `{ status: "active", mandateStatus: "active" }`.

The `operation` value is pinned per path (`parseWebhook` / `fetchStatus`) rather than
left as "any non-empty string": the drift line's job is to tell an on-call engineer
**which surface drifted**, and ADR-0380 §6 already makes `operation` part of the line's
shape. The fix that satisfies these pins is free to reach the shared
`contractViolation(operation, …)` helper by whatever refactor it chooses — the pins
assert the log entry and the thrown error, never a helper signature.

## Consequences

- An unrecognised vendor status is now loud **in production** on both entry points, not
  only in the test suite: the on-call page fires where it was silently swallowed.
- The two guards make the line non-vacuous: a fix that emitted the drift log on _every_
  call (a per-call line, which would page on-call on healthy traffic) breaks them.
- **No production file is touched by this card.** The pins are additive; the existing
  `payments-cashfree-adapter.test.ts` spec, the fixtures and the ADRs are byte-unchanged.
- The pins are **RED** against the merged adapter (`d3b6bdc`). Exact command and
  failure:
  - `TMPDIR=/root/tmp-mongo npx vitest run --project integration apps/web/src/test/integration/payments-cashfree-drift-log.test.ts`
  - `2 failed | 2 passed (4)` — both drift specs fail
    `AssertionError: expected [] to have a length of 1 but got +0`; the two guards pass
    (they lock existing behaviour).
- **Load-bearing, proven by mutation** on a throwaway copy of `cashfree-provider.ts`
  (restored afterwards; `sha256` unchanged at
  `2e4300e7c6a007174ff1a1e92c9bdd271ceca7519576db615808101546070ccd`, `git diff` empty):
  - **Faithful fix** — a local `normalizeStatusLogged` / `kindForEventWithLog` wrapper
    that logs the drift via `contractViolation` and rethrows → **4 passed (4)**: the
    pins are satisfiable and the guards stay green.
  - **Per-call drift log** — the drift entry emitted unconditionally in `fetchStatus`
    and `parseWebhook` → **2 failed | 2 passed (4)**: both guards fail
    (`AssertionError: expected [ { service: 'openpic-web', …(9) } ] to have a length of
+0 but got 1`). The pins are not satisfiable by logging on every call.
- The GREEN sibling `t_92de5343` (assignee `openpic-webapp-backend-coder`) is gated on
  this card and reuses this worktree; this card ends with `kanban_complete` (not
  `kanban_request_review`) so that completion releases it — review of the pins happens
  inside the GREEN's PR, per the lane's RED→GREEN precedent.

## Alternatives considered

- **Assert a non-empty `operation` instead of a pinned value.** Rejected: the card
  recommends `"parseWebhook"` and the fix can name it — the operation is a contract
  surface an on-call engineer reads, so it is pinned rather than left free.
- **Assert only that _a_ drift entry appears (any level/provider).** Rejected: it would
  pass on a `warn` line with no provider, which is not the pinned page-worthy signal.
- **Fold the two paths into one spec.** Rejected: one behaviour per spec keeps the
  failure message diagnostic (`parseWebhook` vs `fetchStatus`, and the `operation`
  value each must carry).
- **Make the log a per-call line so the existing `payments.call` becomes the signal.**
  Rejected: that pages on-call on healthy traffic; the guard pins forbid it.
- **Change production here to make the pins pass.** Not done — this is the TEST card;
  the implementation belongs to the GREEN sibling `t_92de5343`.

## Review sign-off

_Pending. This card ends with `kanban_complete` to release the gated GREEN `t_92de5343`;
the pins are reviewed inside that PR._
