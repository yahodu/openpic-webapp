# ADR-0076 — OP-92 GREEN: `MessageTransport` port, Novu adapter and the workflow drift guard

- **Status:** Accepted · **Date:** 2026-10-05
- **Ticket:** OP-92 (phase 1 — Notifications, epic: Transport) · GREEN stage
- **Card:** `t_8930fc35` · **Deliverable:** branch `OP-92-task-message-transport-novu-drift` (extends draft PR #182; the RED pins ship inside this GREEN PR)
- **Implements:** `docs/adr/ADR-0072-op92-message-transport-and-novu-drift-guard-red.md` (RED) and `docs/adr/ADR-0074-op92-message-transport-red-pins-followup.md` (RED-pins)
- **Supersedes:** none

## Context

The RED lane (`t_fd03ff87`) and its pins follow-up (`t_97f1df44`) turned the
operator-facing guarantee — _outbound email/SMS sits behind a one-method adapter
so Novu can be replaced without touching routing, templates or call sites_ —
into failing specs. This ADR records the GREEN implementation that makes those
specs pass: the vendor-neutral port, the Novu adapter, the boundary schemas, the
error classifier, the workflow drift guard, the in-memory outbox, the timeout
environment knob, the Novu-import lint boundary and the admin CLIs.

The tests are the specification; nothing below is implemented without a pin. No
test was edited. The starting RED state was reproduced on the pins HEAD
(`645dbbb`): unit `7 failed / 1359 passed` and integration `2 failed / 36 passed`
(the pinned modules absent; `env.test.ts` timeout field absent; the
`no-restricted-imports` boundary absent).

## Decision

### Modules created / changed

| Path                                                       | Kind    | Contract implemented                                                                                     |
| ---------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `apps/web/src/server/notifications/message-transport.ts`   | port    | `MessageTransport.send`, `OutboundMessage`, `OutboundRecipient`, `TransportReceipt`, `OutboundChannel`   |
| `apps/web/src/server/adapters/transport-error.ts`          | shared  | `TransportError`, `UpstreamContractError`, `classifyTransportFailure`, `TransportFailure`                |
| `apps/web/src/server/adapters/novu/schemas.ts`             | wire    | Zod request/response/workflow schemas + normalized transport-workflow schemas and inferred types         |
| `apps/web/src/server/adapters/novu/workflow-map.ts`        | vendor  | `TRANSPORT_WORKFLOW_IDS`, `workflowIdForChannel`, `channelForWorkflowId`                                 |
| `apps/web/src/server/adapters/novu/workflow-drift.ts`      | vendor  | `checkTransportWorkflows`, `toTransportWorkflows`, `runTransportDriftCheck`                              |
| `apps/web/src/server/adapters/novu/novu-transport.ts`      | vendor  | `novuTransport(options) -> MessageTransport`                                                             |
| `apps/web/src/server/adapters/novu/upsert-workflows.ts`    | vendor  | `runWorkflowUpsert(options) -> Promise<number>`, `buildTransportWorkflowBodies`                          |
| `apps/web/src/server/adapters/memory-message-transport.ts` | outbox  | `memoryMessageTransport()` → `MemoryMessageTransport` (port + inspectable `outbox`)                      |
| `scripts/novu/upsert-workflows.ts`                         | admin   | thin CLI over `runWorkflowUpsert` (exit `0`/`1`)                                                         |
| `scripts/novu/assert-no-drift.ts`                          | admin   | thin CLI over `runTransportDriftCheck` (exit `0`/`1`)                                                    |
| `apps/web/src/server/config/env.ts`                        | config  | `transport.timeoutMs` (`NOVU_TIMEOUT_MS`, default `10000`) + `getNovuRuntimeConfig()` for the admin CLIs |
| `eslint.config.mjs`                                        | lint    | `no-restricted-imports` Novu boundary (AC1) with the adapter + `scripts/novu` exemptions                 |
| `package.json`                                             | tooling | `novu:upsert-workflows`, `novu:assert-no-drift` scripts                                                  |

### Port and adapters (§1, §2)

- The port is one method. `OutboundMessage` is fully rendered before it reaches
  an adapter; no vendor-native type crosses the boundary (`transactionId` →
  `providerMessageId`).
- `novuTransport` derives the Novu `subscriberId` from `to.userId` and passes the
  contact inline (`email` for email, `phone` for SMS/WhatsApp). The rendered
  `subject`/`html`/`text`/`templateName`/`variables` travel in the pass-through
  `payload`, with `headers` at `payload.headers` (§6, omitted entirely when the
  message carries none).
- `memoryMessageTransport` records each `OutboundMessage` in `outbox` in call
  order and mints `memory-<n>`; each factory call is isolated. It is a distinct
  port from the `@/server/logging` memory sink (`memoryTransport`).

### Novu contract validation (§3) and error mapping (§4)

- Every request is parsed with `novuTriggerRequestSchema`; every response with
  `novuTriggerResponseSchema.safeParse`. A response that no longer matches raises
  `UpstreamContractError` and is logged at `error` under
  `transport.upstream_contract_violation`.
- `classifyTransportFailure` is the single retry table: 4xx except `408`/`429`
  non-retryable; `408`/`429`/5xx retryable; an abort → retryable `timeout`; any
  other `fetch` throw → retryable `network`; `UpstreamContractError` →
  non-retryable `upstream_contract_violation`. The policy travels on the thrown
  `TransportError`.
- Each attempt runs under an `AbortController`; `timeoutMs` defaults to
  `getConfig().transport.timeoutMs`.

### Workflow drift guard (§5)

- `checkTransportWorkflows` is pure over normalized workflows: exactly the three
  transport ids, each with exactly one step whose channel matches its name.
- `runTransportDriftCheck` fetches `GET {baseUrl}/v1/workflows`
  (`Authorization: ApiKey …`), normalizes `steps[].template.type` → `channel`, and
  returns `0`/`1`; on drift it logs `transport.workflow_drift` at `error`.
- `runWorkflowUpsert` lists the workflows and `POST`s only the missing canonical
  bodies (`{ workflowId, name, active, steps: [{ active, template: { type } }] }`),
  so a second run is a no-op; a failure logs `transport.workflow_upsert_failed`
  at `error` and returns non-zero.

### Logging (`security_and_logging_requirements`)

- A successful send logs `transport.sent` at `info` with `channel`,
  `provider: "novu"` and `messageId` — and nothing else. No path logs `html`,
  `text`, `to.email` or `to.phoneE164`; the pins assert this over the whole
  memory sink by value canary and by key name.

### Timeout environment knob (§4)

- `NOVU_TIMEOUT_MS` → `getConfig().transport.timeoutMs` (positive integer,
  default `10000`), read only in `src/server/config` (the `process.env`
  exemption). `.env.example` documents the knob and `env-example.test.ts` lists
  it in `REQUIRED_KEYS`.

### Novu-import lint boundary (AC1)

- A `no-restricted-imports` pattern group `["novu", "@novu/*"]` is merged into
  the `apps/web/src/app/**`, `apps/web/src/server/**` and
  `apps/web/src/server/jobs/**` config blocks (flat config replaces a rule's
  options, so the patterns are merged into each block that already sets the
  rule), and a later `apps/web/src/server/adapters/novu/**` block restores the
  logging boundary without the Novu patterns.

### ADR numbering

Re-fetched `origin/main` at integration: `0001`–`0071` are landed (the OP-91
follow-up lane, PR #181, merged and took `0070`/`0071` plus its review sign-off
`0075`). The OP-92 lane therefore holds the lowest free numbers `0072`–`0074`
(RED/pins) and this GREEN implementation is **`0076`**; `0077` is the GREEN
review sign-off.

## Consequences

- Swapping Novu for another provider is one adapter file plus an env change;
  routing, templates and call sites are untouched.
- The retry policy lives in one place, so a permanent failure is not retried
  forever and a transient one is not dropped.
- A dashboard edit that adds a workflow, adds a step or changes a step's channel
  makes `scripts/novu/assert-no-drift.ts` exit `1` instead of silently changing
  production.
- The Novu SDK cannot leak into domain/service/route code.

## Assumptions and deviations recorded unilaterally

1. **Adapter timeout default degrades gracefully (deviation from ADR-0074
   §4/assumption 6).** The pinned specs construct `novuTransport` _without_ a
   `timeoutMs` in a harness that never loads a valid application environment
   (all I1/I3/I12/I14–I17). Calling `getConfig()` eagerly in the factory would
   throw `ConfigError` there. The adapter therefore resolves
   `getConfig().transport.timeoutMs` and, when configuration is unavailable or
   invalid, falls back to the same `10_000` ms default (`FALLBACK_TIMEOUT_MS`).
   Behaviour is identical when configured; the env default remains `10_000`.
2. **`NOVU_BASE_URL` / `NOVU_API_KEY` accessor.** The admin CLIs need an origin
   and API key. Rather than read `process.env` in `scripts/` (which the
   `no-restricted-properties` boundary forbids) or widen the frozen `AppConfig`
   shape (asserted by `env.test.ts`), a `getNovuRuntimeConfig()` accessor joins
   the existing `getRateLimitConfig`/`getMongoPoolConfig` operational-wiring
   pattern and is the single reader of those two variables. Both are documented
   in `.env.example`. This surface is not pinned by a spec; it exists only to
   make the card-mandated CLIs runnable.
3. **No GitHub Actions job added for the drift guard.** AC2's _behaviour_ is
   pinned by I5b (`runTransportDriftCheck` → `1`, error log), and the card's
   `scripts/novu/assert-no-drift.ts` + `pnpm novu:assert-no-drift` entrypoint
   exist. Wiring a workflow job requires `NOVU_API_KEY` in repository secrets and
   would block every PR until the production Novu holds the three workflows; that
   is an ops decision left as a follow-up.
4. **Create-if-missing, not update.** Per ADR-0074 assumption 1: the engine never
   mutates an existing workflow; drift repair would be a new pin.

## Alternatives considered

- **Require `timeoutMs` on the adapter.** Rejected: the pinned specs intentionally
  exercise an adapter omission-tolerance, and ADR-0074 mandates a config default.
- **Read `process.env` in the CLIs.** Rejected: it would require weakening the
  repository-wide `no-restricted-properties` boundary (or a `scripts/**`
  exemption) for two variables.
- **Add `NOVU_API_KEY`/`NOVU_BASE_URL` to `AppConfig`.** Rejected: it would break
  the frozen `getConfig()` shape pinned by `env.test.ts`.
