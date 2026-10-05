# ADR-0070 — OP-92 RED: `MessageTransport` port, Novu adapter and the workflow drift guard

- **Status:** Accepted · **Date:** 2026-10-05
- **Ticket:** OP-92 (phase 1 — Notifications, epic: Transport) · RED stage
- **Supersedes:** none

## Context

Notification design §8 makes Novu drift structural by giving Novu **nothing** but
three single-step pass-through workflows (`transport-email`, `transport-sms`,
`transport-whatsapp`). Everything that decides _what_ to send — routing, copy,
locales, preferences, quiet hours, throttle, dedupe — is first-party and applied
before the adapter is called. Novu's remaining job is provider credentials,
retries and receipts.

The requirement is therefore an operator-facing guarantee: **outbound email/SMS
sits behind a one-method adapter so Novu can be replaced without touching
routing, templates or call sites.** API contract §9.4 adds the second half of the
guarantee: a CI assertion that fails the build unless the workflow set is exactly
the three expected ids, each with exactly one step whose channel matches its name.

This ADR records the RED-stage contract — module paths, exported names, wire and
log shapes, and the drift semantics — so the GREEN implementer builds exactly
what the tests pin and a later refactor cannot drift from it.

## Decision

### Module layout and exports

| Path                                                     | Kind   | Exports the tests rely on                                                                                                                                                      |
| -------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/server/notifications/message-transport.ts` | port   | `MessageTransport` (`send(OutboundMessage) -> { providerMessageId }`), `OutboundMessage`, `OutboundRecipient`, `TransportReceipt`, `OutboundChannel`                           |
| `apps/web/src/server/adapters/transport-error.ts`        | shared | `TransportError`, `UpstreamContractError`, `classifyTransportFailure`, `TransportFailure`                                                                                      |
| `apps/web/src/server/adapters/novu/schemas.ts`           | wire   | `novuTriggerRequestSchema`, `novuTriggerResponseSchema`, `novuWorkflowListSchema`, normalized `transportWorkflowSchema`/`transportWorkflowListSchema` and their inferred types |
| `apps/web/src/server/adapters/novu/workflow-map.ts`      | vendor | `TRANSPORT_WORKFLOW_IDS`, `workflowIdForChannel`, `channelForWorkflowId`                                                                                                       |
| `apps/web/src/server/adapters/novu/workflow-drift.ts`    | vendor | `checkTransportWorkflows` (pure), `toTransportWorkflows`, `runTransportDriftCheck` (fetch + exit code)                                                                         |
| `apps/web/src/server/adapters/novu/novu-transport.ts`    | vendor | `novuTransport(options) -> MessageTransport`                                                                                                                                   |
| `scripts/novu/assert-no-drift.ts`                        | admin  | thin CLI over `runTransportDriftCheck` (exit `0`/`1`)                                                                                                                          |

Domain code imports **only** the port. The vendor name lives in
`adapters/novu/**` and in the workflow ids; no domain field carries it
(`docs/CONVENTIONS.md` §7, ADR-0001).

### `OutboundMessage` (fully rendered before the adapter)

`{ channel: "email" | "sms" | "whatsapp"; to: { userId; email?; phoneE164? }; subject?; html?; text?; templateName?; variables?; headers? }`.

The adapter derives the Novu `subscriberId` from `to.userId` and passes the
contact inline (`to.email` for email, `to.phone` for SMS/WhatsApp). The port
returns the vendor-neutral `{ providerMessageId }`; for Novu that value **is** the
trigger response's `data.transactionId`. No vendor-native type crosses the port.

### Novu trigger contract (parsed at the boundary, §3)

`POST {baseUrl}/v1/events/trigger`, header `Authorization: ApiKey <key>`, body:

```json
{
  "name": "transport-email",
  "to": { "subscriberId": "<userId>", "email": "<addr>" },
  "payload": { "subject": "…", "html": "…", "text": "…" }
}
```

`novuTriggerResponseSchema` is `{ data: { transactionId: string } }` (Zod objects
are non-strict, so Novu's extra `acknowledged`/`status` fields are tolerated). A
body that fails the response schema raises `UpstreamContractError` and is logged
at `error` under event `transport.upstream_contract_violation`.

### Error classifier (the retry table)

`classifyTransportFailure({ status?, error? }) -> { retryable, code, status? }`:

- HTTP 4xx **except** `408`/`429` → `retryable: false`.
- `408`, `429`, and every `5xx` → `retryable: true`.
- An aborted (timed-out) request → `retryable: true`, `code: "timeout"`.
- A network failure → `retryable: true`, `code: "network"`.
- `UpstreamContractError` → `retryable: false`, `code: "upstream_contract_violation"`.

### Timeout

`novuTransport` accepts `timeoutMs`, wraps each attempt in an `AbortController`,
and throws `{ retryable: true, code: "timeout" }` on expiry. The tests pin the
_option_; wiring the option to an environment knob in a factory is deferred (see
below).

### Drift guard

`checkTransportWorkflows` is pure over normalized `TransportWorkflow[]`
(`{ workflowId, steps: [{ active, channel }] }`) and returns
`{ ok, problems: string[] }`. It fails when the set is not exactly
`{transport-email, transport-sms, transport-whatsapp}`, when any of those has
other than exactly one step, or when a step's `channel` does not match the
workflow name. `runTransportDriftCheck` fetches `GET {baseUrl}/v1/workflows`
(`Authorization: ApiKey <key>`), parses the raw Novu shape
(`steps[].template.type` → normalized `channel`) and returns exit `0`/`1`; on
drift it logs `transport.workflow_drift` at `error`. The CI script is a thin
wrapper, unit-testable in-process so MSW can intercept Novu.

## Consequences

- Swapping Novu for SendGrid + Twilio + Meta is one adapter file plus an env
  change; routing, templates and call sites are untouched.
- The retry policy lives in exactly one place, so a permanent failure cannot be
  retried forever and a transient one cannot be dropped.
- A dashboard edit that adds a workflow, adds a step or changes a step's channel
  fails `scripts/novu/assert-no-drift.ts` (exit `1`) instead of silently changing
  production.
- The RED suite fails with `Cannot find package '@/server/adapters/novu/…'` —
  the intended modules do not exist yet; the implementation agent creates them.

### Assumptions recorded unilaterally (flag to reviewer/implementer)

1. **Novu trigger route/header.** `POST /v1/events/trigger` with
   `Authorization: ApiKey <key>`; response `{ data: { transactionId } }`. This is
   the Novu v2 REST shape; if the deployed Novu differs, the schema (not the
   tests' intent) is what changes.
2. **`providerMessageId` = `transactionId`.** Design §8.4 names the port result
   `providerMessageId`; the card names the observed value `transactionId`. The
   two are reconciled as above.
3. **Raw workflow shape.** Novu step channel is read from `steps[].template.type`.
   Fixtures use `email`/`sms`/`whatsapp` verbatim; the real `chat` → `whatsapp`
   mapping is an adapter detail, not pinned here.
4. **Timeout source.** I4 pins the adapter `timeoutMs` option; the environment
   knob and its factory default are deliberately **not** pinned by these tests.
5. **Email unsubscribe headers.** The GREEN card mentions `List-Unsubscribe` /
   `List-Unsubscribe-Post`; the RED card's test list does not, so no assertion
   pins them (out of scope for this RED).

## Alternatives considered

- **Fetch steps at runtime / reconcile DB against Novu.** Reintroduces a second
  source of truth and detects drift only after a mis-delivery. Rejected (design §8.1).
- **Drift script tested only by spawning a subprocess.** A child process cannot
  be intercepted by MSW, so the check would be untestable offline. The engine
  lives in `src/server` and the script is a thin CLI. Rejected the subprocess-only test.
- **A single vendor-shaped `send` return type.** Would leak `transactionId` into
  domain vocabulary and break on a provider swap. Rejected (ADR-0001, P1).
