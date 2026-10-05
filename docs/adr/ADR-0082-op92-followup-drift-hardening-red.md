# ADR-0082 — OP-92 follow-up RED pins: an inactive drift-guard step, a duplicate workflow id, and a classified non-JSON 2xx

- **Status:** Accepted · **Date:** 2026-10-05
- **Ticket:** OP-92 (phase 1 — Notifications, epic: Transport) · RED stage (follow-up)
- **Card:** `t_c38934da` (parent of the gated GREEN card `t_3f26ec7d`) · **Deliverable:** branch `OP-92-task-followup-drift-hardening-red`, draft PR based on `origin/main` `e7c3374`
- **Extends:** `docs/adr/ADR-0076-op92-message-transport-and-novu-drift-guard-green.md` (hardens its §3 drift guard and §1 transport error classification)
- **Supersedes:** none

## Context

The OP-92 GREEN review sign-off (`docs/adr/ADR-0077-op92-green-review-signoff.md`,
card `t_8930fc35`) approved the merged PR #182 with three coverage gaps in the
drift guard and the Novu transport. Under `AGENTS.md` §2.1 no production code may
land without a failing test first, so the reviewer routed the gaps to a Test
Author RED-pins card (this one) and a dependent GREEN card (`t_3f26ec7d`). This
ADR records the three new pins and the contract they fix; it is **test + docs
only** — no production file is added or edited by this card.

The gaps:

1. **(Medium) an inactive step is not guarded.** `checkTransportWorkflows`
   (`apps/web/src/server/adapters/novu/workflow-drift.ts`) normalizes
   `TransportWorkflowStep.active` and `transportWorkflowStepSchema` requires it,
   but the check never reads it. A transport workflow whose single step is
   `active: false` passes the guard (`report.ok === true`) while delivering
   nothing, even though the CLI doc-string and ADR-0076 promise "one **active**
   step".
2. **(Low) a duplicate workflow id is not reported.** The check keys a `Map` by
   `workflowId`, so two entries with the same id overwrite one another and the
   "exactly three workflows" invariant is not enforced for a duplicate.
3. **(Low) a non-JSON 2xx body is not a classified `TransportError`.** In
   `novuTransport.send` (`apps/web/src/server/adapters/novu/novu-transport.ts`)
   only `fetch` sits inside the try/classifier; `await response.json()` on a
   `200` whose body is not JSON throws a raw `SyntaxError` that escapes as a
   non-`TransportError`, leaving the dispatch ledger with no retry policy.

## Decision

Three append-only pins. No existing passing spec is weakened, and the shared
`makeTransportWorkflow` factory needs **no** signature change: it already takes a
`Partial<TransportWorkflow>` override, so the inactive-step fixture is built by
overriding `steps`.

### §3.1 (Medium) — an inactive single step is drift

`checkTransportWorkflows` must report a problem when a transport workflow's
single normalized step has `active === false`. Observable contract:

- Unit (`workflow-drift.test.ts`): a canonical set whose only difference is
  `transport-email`'s step being `active: false` yields `report.ok === false`,
  and at least one problem string names the offending workflow id
  (`transport-email`), matching how every existing drift problem names its
  workflow.
- Integration (`novu-workflow-drift.test.ts`, MSW, I5c): fed that Novu workflow
  list, `runTransportDriftCheck` returns exit code `1` and logs
  `transport.workflow_drift` at `error`.

Working message: `transport workflow '<id>' must have exactly one active step`
(or equivalent — the pin asserts the id appears, not the exact wording). Message
text is otherwise the implementation's choice.

### §3.2 (Low) — a duplicate workflow id is drift

`checkTransportWorkflows` must report a problem when the same `workflowId`
appears more than once, so the "exactly three workflows" invariant holds.
Observable contract (unit): the canonical three workflows plus an **identical**
duplicate `transport-email` (`active: true`, channel `email`) — four entries,
three distinct ids — yields `report.ok === false`. Because the duplicate is
byte-for-byte valid, the report can only fail once duplicate ids are detected,
not because of a mismatching step.

Working message: `workflow id '<id>' appears more than once` (or equivalent). The
pin asserts only `report.ok === false`; the wording is the implementation's
choice.

### §3.3 (Low) — a non-JSON 2xx body is a classified `TransportError`

`novuTransport.send` must classify a `200` response whose body is not JSON, so a
failure never escapes as a bare `SyntaxError`. Observable contract (integration
`novu-transport.test.ts`, MSW, I19): a `200` whose body is
`HttpResponse.text("<html>gateway</html>")` makes `send` reject with a value that
is `instanceof TransportError` and matches `{ retryable: false, code:
"upstream_contract_violation" }`.

This is the same classification as the sibling wire-shape-mismatch pin (I2: a
JSON body that no longer matches `novuTriggerResponseSchema` raises
`UpstreamContractError`, which is a non-retryable `TransportError` with code
`upstream_contract_violation`), so the two boundary failures behave identically.
The GREEN card's stated default (`retryable=false`,
`upstream_contract_violation`, reuse `classifyTransportFailure` /
`UpstreamContractError`) is exactly this pin.

## Specs added (all RED against the current tree, `OP-92` `main` `e7c3374`)

| Pin | File                                                        | Pins                                                                                                                |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| U   | `apps/web/src/server/adapters/novu/workflow-drift.test.ts`  | inactive single step → `ok === false` + problem names the workflow; identical duplicate id → `ok === false`         |
| I5c | `apps/web/src/test/integration/novu-workflow-drift.test.ts` | inactive step → `runTransportDriftCheck` exits `1`, logs `transport.workflow_drift` at `error`                      |
| I19 | `apps/web/src/test/integration/novu-transport.test.ts`      | `200` non-JSON body → rejects `instanceof TransportError` with `retryable:false`/`code:upstream_contract_violation` |

Reproduce (this card, HEAD of `OP-92-task-followup-drift-hardening-red`):

- `pnpm test:unit` → exit 1; **1 failed file / 74 passed (75)**; **2 failed tests
  / 1394 passed (1396)**. Both failures are the new inactive-step and
  duplicate-id assertions: `expected true to be false` on `report.ok`.
- `TMPDIR=/root/tmp-mongo pnpm test:int` → exit 1; **2 failed files / 36 passed
  (38)**; **2 failed tests / 282 passed (284)**:
  - I5c fails `expected +0 to be 1` (the guard returns ok today);
  - I19 fails `expected SyntaxError: Unexpected token '<', "<html…" to be an
instance of TransportError` — a bare `SyntaxError`, the exact wrong reason
    the finding describes.
- Every other test passes; no failure is an import/compile/typo error.
- `tsc -p apps/web/tsconfig.json --noEmit`, `eslint` and `prettier --check` are
  clean on the three touched specs.

## Consequences

- The three gaps are pinned as failing specs, so the GREEN card
  (`t_3f26ec7d`) implements the minimum to turn them green against a concrete
  contract instead of prose.
- A future dashboard edit that disables a step, or duplicates a workflow id,
  now trips the drift guard and exits non-zero instead of passing silently.
- A provider/gateway answering `200` with a non-JSON body is classified like
  every other transport failure, so the retry policy is always well-defined.
- The vendor boundary, the `novu-http.ts` shared plumbing and AC1 (the Novu
  import lint boundary) are untouched — this card changes only specs.

### Assumptions recorded unilaterally (flag to reviewer / implementer)

1. **Non-JSON body = non-retryable `upstream_contract_violation`.** A body that
   is not the pinned JSON shape is treated as a contract violation, identical to
   the I2 shape-mismatch pin. The GREEN card's own instruction states this
   default; if a transient HTML gateway page should instead be retryable, that is
   a new pin, not a silent choice.
2. **Inactive-step problem names its workflow.** The pin requires the problem
   string to include the offending `workflowId`, consistent with every existing
   drift message. The exact wording is not pinned.
3. **Duplicate-id message wording is not pinned.** Only `report.ok === false` is
   asserted, because the fixture isolates the duplicate as the sole anomaly.
4. **No factory signature change.** `makeTransportWorkflow(overrides:
Partial<TransportWorkflow>)` already supports the inactive-step override; its
   default remains the canonical `active: true` `transport-email`. The factory is
   left unchanged so the existing pins keep their meaning.
5. **ADR numbering.** `origin/main` `e7c3374` (→ `f61a222`, the 1.17.0 release
   commit on top) is dense `0001`–`0077`; the lowest free at RED time was
   **`0078`** for this RED pin ADR. The dependent GREEN card expects `0079`
   (implementation) and `0080` (review sign-off) — each must re-fetch
   `origin/main` and take the lowest free at integration.

   **Renumbered at integration (GREEN PR #186).** `origin/main` `80fe618` merged
   the OP-91 follow-up payload lane first, which claimed `0078` (RED), `0079`
   (GREEN) and `0081` (sign-off) and holds `0080` for OP-93. This lane therefore
   takes the next free contiguous block: this RED ADR `0078 → 0082`, the GREEN
   implementation `0079 → 0083` (`ADR-0083-…-green.md`) and the review sign-off
   `0080 → 0084` (`ADR-0084-…-green-review-signoff.md`).

## Alternatives considered

- **Fold the checks into the existing specs.** Rejected: one behavior per test;
  the new failing tests must be independently named so the GREEN implementer
  sees exactly which behavior to build.
- **Relax the duplicate pin to only assert `problems.length > 0`.** Rejected:
  `ok === false` is the observable operator contract (exit code 1); message
  wording stays free.
- **Pin the non-JSON body as retryable.** Rejected: it would contradict the
  sibling shape-mismatch classification (I2) and the GREEN card's default; a
  body that no longer matches the contract cannot be fixed by a retry.
- **Add a new factory for the inactive step.** Rejected as redundant: the
  existing `Partial<TransportWorkflow>` override already expresses it, and a new
  factory would add surface without adding a guarantee.
