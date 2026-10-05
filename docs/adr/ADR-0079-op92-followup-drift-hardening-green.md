# ADR-0079 — OP-92 follow-up GREEN: reject an inactive step and a duplicate workflow id, and classify a non-JSON 2xx body

- **Status:** Accepted · **Date:** 2026-10-05
- **Ticket:** OP-92 (phase 1 — Notifications, epic: Transport) · GREEN stage (follow-up)
- **Card:** `t_3f26ec7d` (dependent GREEN of the RED-pins card `t_c38934da`) · **Deliverable:** branch `OP-92-task-followup-drift-hardening-green` (extends the RED branch `OP-92-task-followup-drift-hardening-red`, head `7767751`; the RED pins ship inside this GREEN PR)
- **Implements:** `docs/adr/ADR-0078-op92-followup-drift-hardening-red.md` (RED pins)
- **Extends:** `docs/adr/ADR-0076-op92-message-transport-and-novu-drift-guard-green.md` (§3 drift guard, §1 transport error classification)
- **Supersedes:** none

## Context

The OP-92 GREEN review sign-off (`docs/adr/ADR-0077-op92-green-review-signoff.md`)
left three coverage gaps in the drift guard and the Novu transport. The RED-pins
card `t_c38934da` turned them into three failing specs (ADR-0078). This ADR
records the minimum production change that turns those pins green against
`origin/main` `f61a222` + the RED pin commit `7767751`.

**No test file was modified by this card.** The three pin specs, the shared
`makeTransportWorkflow` factory, the MSW setup and every test utility are
byte-for-byte as the RED card left them.

## Decision

### Modules changed

| Path                                                  | Change                    | Contract implemented                                                                                                      |
| ----------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/server/adapters/novu/workflow-drift.ts` | `checkTransportWorkflows` | an inactive single step and a duplicated `workflowId` are reported as problems                                            |
| `apps/web/src/server/adapters/novu/novu-transport.ts` | `novuTransport.send`      | a `2xx` whose body is not JSON rejects with a non-retryable `UpstreamContractError` (`code: upstream_contract_violation`) |

### §3.1 — an inactive single step is drift

`checkTransportWorkflows` now reads the already-normalized
`TransportWorkflowStep.active`. After the existing "exactly one step" and
"channel matches the name" checks it pushes
`transport workflow '<id>' step is not active; it would deliver nothing`.
The existing messages and the exit-code behaviour are unchanged: any problem
makes `report.ok === false`, and `runTransportDriftCheck` logs
`transport.workflow_drift` at `error` and returns `1`.

### §3.2 — a duplicate workflow id is drift

The `Map` keyed by `workflowId` used to collapse duplicates silently. The loop
now remembers ids already seen and, after the scan, pushes
`transport workflow '<id>' appears more than once; the set must have exactly one entry`
for each duplicated id. A byte-identical duplicate still fails the report, so the
"exactly three workflows" invariant holds.

### §3.3 — a non-JSON `2xx` body is a classified `TransportError`

`await response.json()` used to sit outside the classifier, so a `200` with an
HTML body escaped as a bare `SyntaxError` and the dispatch ledger had no retry
policy. The parse is now wrapped: a rejected `json()` is logged as
`transport.upstream_contract_violation` at `error` and rethrown as
`UpstreamContractError` (`retryable: false`, `code: "upstream_contract_violation"`),
exactly like the sibling wire-shape-mismatch path (I2). The success path (the
`novuTriggerResponseSchema` parse and the `transport.sent` log) is unchanged.

## Verification (this card, HEAD `7767751` + the GREEN commit)

- `pnpm test:unit` → **75 files / 1396 tests passed** (the two new pins included).
- `TMPDIR=/root/tmp-mongo pnpm test:int` → **all files / tests passed** (I5c and I19 included).
- Coverage, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm build` are green.

The vendor boundary, the `novu-http.ts` shared plumbing and the Novu-import lint
boundary (AC1) are untouched.

## Consequences

- A dashboard edit that disables a transport step, or duplicates a workflow id,
  now trips the drift guard and exits non-zero instead of passing silently.
- A gateway answering `200` with a non-JSON body is classified like every other
  transport failure, so the retry policy is always well-defined and never a bare
  `SyntaxError`.
- All three behaviours are covered by specs that predate the implementation (the
  RED pins), so future refactors of the guard or the adapter stay safe.

### Assumptions recorded unilaterally

1. **Non-JSON body = non-retryable `upstream_contract_violation`.** Follows the
   GREEN card default and the I2 shape-mismatch pin: a body that no longer
   matches the pinned wire contract cannot be fixed by a retry.
2. **Both problem strings name the offending workflow id**, consistent with every
   existing drift message; the pins assert only the id appears / `ok === false`,
   not the exact wording.
3. **ADR numbering.** `origin/main` `f61a222` is dense `0001`–`0077`; the RED pin
   ADR is `0078` (shipping in this same PR), so the lowest free for this
   implementation ADR is `0079`. A review sign-off for this lane would take
   `0080`, lowest-free-first at integration.

## Alternatives considered

- **Throw a plain `TransportError` for the non-JSON body.** Rejected: it would
  duplicate the classification logic; `UpstreamContractError` already encodes
  `retryable: false` / `upstream_contract_violation` and is what the sibling I2
  pin produces.
- **Compare workflow ids with a `Set` and drop the `Map`.** Rejected: the `Map`
  lookup is still the clearest way to resolve a workflow by id for the
  step/channel checks; the duplicate `Set` is an additive guard.
- **Only assert `problems.length > 0`.** Rejected: `report.ok === false` is the
  operator-observable contract (exit code `1`); wording stays free.
