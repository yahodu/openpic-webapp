# ADR-0002 — Logging behind a port; Better Stack swappable

- **Status:** Accepted · **Date:** 2026-10-01

## Context

Observability is a delivery requirement, but the aggregator (Better Stack today)
is a vendor. Application code must not depend on its SDK, switching aggregators
must not touch business logic, and the level policy, required fields and
redaction list need one enforcement point.

## Decision

Define a single **`Logger` port** (US-003). All application code logs through the
port only; `console` and vendor SDKs are forbidden outside the adapter. The
Better Stack adapter lives in `src/server/adapters/logging/` and is selected by
env (US-002). The port owns the level policy (`fatal|error|warn|info|debug|trace`,
conventions §5.1), the required-field contract (`event`, `requestId`; optional
`tenantId`, `userId`, `durationMs`, `err`), and the US-003 redaction list applied
before emission. Default dev/test emits one JSON line per event to stdout;
production emits to Better Stack. Batching, sampling and retry live in the
adapter, never in callers.

## Consequences

- Swapping Better Stack is a new adapter plus an env change.
- Redaction and level policy are enforced once and testable against the port.
- The port surface stays small; vendor features stay in the adapter.

## Alternatives considered

- Calling the Better Stack SDK directly — couples every module to the vendor and
  makes redaction per-call. Rejected.
- A `console` wrapper — no structured contract, no swappable backend. Rejected.
