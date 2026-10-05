# ADR-0074 — OP-92 RED-pins follow-up: memory outbox, workflow upsert, unsubscribe headers, logging, Novu-import lint and the timeout env knob

- **Status:** Accepted · **Date:** 2026-10-05
- **Ticket:** OP-92 (phase 1 — Notifications, epic: Transport) · RED stage
- **Card:** `t_97f1df44` (parent of the gated GREEN card `t_8930fc35`) · **Deliverable:** branch `OP-92-task-message-transport-novu-drift`, extends draft PR #182
- **Extends:** `docs/adr/ADR-0072-op92-message-transport-and-novu-drift-guard-red.md` (supersedes its assumptions 4 and 5)
- **Supersedes:** none

## Context

The RED review of `t_fd03ff87` (recorded in ADR-0073) found that the GREEN card
`t_8930fc35` was scoped to build more than the RED tests pinned: §2 (the memory
outbox adapter), §5 (`scripts/novu/upsert-workflows.ts`), §6 (`List-Unsubscribe`
/ `List-Unsubscribe-Post` headers), `security_and_logging_requirements`
(`transport.sent`; never log bodies/contacts) and acceptance criterion 1 (the
Novu-import lint boundary). Under `AGENTS.md` §2.1 no production code may land
without a failing test first, so the orchestrator (`t_23ba7708`) chose **option
(a)**: add the missing RED pins on the same branch before GREEN starts.

This ADR records the extended RED-stage contract — module paths, exported names,
wire/log shapes and the environment knob — so the GREEN implementer builds
exactly what the new specs pin and a later refactor cannot drift from it. It is
**test + docs only**: no production file is added or edited by this card.

## Decision

### §2 — memory outbox adapter `memoryMessageTransport` (finding 3)

| Path                                                       | Exports the tests rely on                                                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/web/src/server/adapters/memory-message-transport.ts` | `memoryMessageTransport()` → `MemoryMessageTransport` (`MessageTransport` + inspectable outbox) |

```ts
interface MemoryMessageTransport extends MessageTransport {
  readonly outbox: readonly OutboundMessage[];
}
```

- **Name.** `memoryMessageTransport` — deliberately **not** `memoryTransport`,
  which `@/server/logging` already exports (the memory _log sink_ whose
  `entries` hold log lines). The two ports must not be confusable.
- **Signature.** `memoryMessageTransport()` takes no options; state is per
  instance, so a fresh factory call isolates each test (no `clear()`).
- **Behaviour.** `send(message)` appends the exact `OutboundMessage` to `outbox`
  in call order and resolves a `TransportReceipt` whose `providerMessageId` is a
  non-empty string, distinct per send (e.g. a monotonically increasing
  `memory-<n>`). No vendor type crosses the port.

### §5 — workflow upsert engine `runWorkflowUpsert`

| Path                                                    | Exports the tests rely on                        |
| ------------------------------------------------------- | ------------------------------------------------ |
| `apps/web/src/server/adapters/novu/upsert-workflows.ts` | `runWorkflowUpsert(options) -> Promise<number>`  |
| `scripts/novu/upsert-workflows.ts`                      | thin CLI over `runWorkflowUpsert` (exit `0`/`1`) |

`runWorkflowUpsert({ baseUrl, apiKey, logger? }) -> Promise<number>` mirrors
`runTransportDriftCheck`: it returns the process exit code (`0` ok, non-zero on
a problem). The engine is tested in-process (MSW cannot intercept a child
process); the CLI is not spawned by any spec.

- **List.** `GET {baseUrl}/v1/workflows` with `Authorization: ApiKey <apiKey>`.
- **Create (only when missing).** `POST {baseUrl}/v1/workflows` with the same
  header and body:

  ```json
  {
    "workflowId": "transport-email",
    "name": "transport-email",
    "active": true,
    "steps": [{ "active": true, "template": { "type": "email" } }]
  }
  ```

  Exactly the three transport workflows (`transport-email`, `transport-sms`,
  `transport-whatsapp`) from the frozen mapping (`workflow-map.ts`), one active
  step each, `template.type` matching the workflow's channel.

- **Idempotent.** A second run against a Novu already holding the three
  workflows issues **zero** `POST`s.
- **Failure.** A non-2xx list/create outcome logs `transport.workflow_upsert_failed`
  at `error` and returns a non-zero exit code.

Real Novu exposes `POST /v1/workflows`; the exact create body is our contract,
pinned by the request captured in I9. If the deployed Novu differs, the body
schema (not the tests' intent) is what changes.

### §6 — email headers at `payload.headers`

`OutboundMessage.headers` (`{ "List-Unsubscribe": "<mailto:…>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }`)
is passed through into the Novu trigger body at **`payload.headers`**. When the
message carries no `headers`, the `payload.headers` key is omitted entirely (no
empty object). The pin is `List-Unsubscribe` / `List-Unsubscribe-Post`; any
other header keys travel verbatim in the same map.

### §4 (Low) — the `NOVU_TIMEOUT_MS` environment knob

The adapter's `timeoutMs` option is surfaced through `@/server/config` — the
single `process.env` exemption in `eslint.config.mjs` — never read in the
adapter itself.

- **Config path/field:** `getConfig().transport.timeoutMs` (a number of
  milliseconds) in `apps/web/src/server/config/env.ts`.
- **Environment variable:** `NOVU_TIMEOUT_MS`, a positive integer.
- **Default:** `10_000` ms when the variable is unset, blank, non-numeric or
  non-positive (mirrors `positiveInteger` for the Mongo pool tunables).
- **Adapter default:** `novuTransport({ … }).timeoutMs` defaults to
  `getConfig().transport.timeoutMs` when the caller omits it.
- **Docs:** `.env.example` documents the knob and `env-example.test.ts` lists it
  in `REQUIRED_KEYS`, so the example cannot drift behind the schema.

### AC1 — the Novu-import lint boundary

`eslint.config.mjs` must register a `no-restricted-imports` boundary banning the
Novu SDK — the `novu` package and the `@novu/*` scope — **everywhere except**
`apps/web/src/server/adapters/novu/**` and `scripts/novu/**`. Every other
domain, service, route and job module depends on the vendor-neutral
`MessageTransport` port (ADR-0001, `docs/CONVENTIONS.md` §7).

The pin is a behavioural guard spec
(`apps/web/src/test/unit/eslint/novu-import-boundary.test.ts`) that drives the
**real** flat config: for each probed path it resolves the config with
`ESLint.calculateConfigForFile(path)` and then executes the resolved
`no-restricted-imports` rule over synthetic source (`Linter.verify` configured
with only that rule). A Novu import from a service, route or domain module must
be reported; the same import inside the adapter or `scripts/novu` must not be.

The spec is RED today (RED review round 2): for every probed **non-exempt** path
the resolved options carry only the pre-existing logging/notification patterns,
so a Novu import produces `[]` and the assertion fails with
`expected [] to include 'no-restricted-imports'` — i.e. because the boundary is
absent, not because of a parsing error. It needs no source-text snapshot of the
config. The two exemption assertions (adapter and `scripts/novu`) are
intentionally green before GREEN: they pin that the exemption must not overreach.

> **Why resolve-then-lint, not `lintText`.** The config sets
> `parserOptions.projectService: true`. `lintText` on a synthetic path that is
> not a member of any TS project yields only a parsing error (`ruleId === null`)
> and type-aware rules cannot run without parser services, so the boundary could
> never be reported. Resolving the config first (which works for virtual paths)
> and running only the syntactic `no-restricted-imports` rule sidesteps both: the
> rule is a core, non-type-aware rule, and its per-path options are exactly what
> `eslint.config.mjs` produces.

> **Implementation caveat.** Flat config _replaces_ a rule's options when a later
> matching config object sets the same rule. The existing `apps/web/src/app/**`,
> `apps/web/src/server/**` and `apps/web/src/server/jobs/**` blocks already set
> `no-restricted-imports` (logging/notification boundaries), so the Novu patterns
> must be merged into those blocks (or registered so they are not overwritten) —
> not merely added in a standalone early object. The adapter and `scripts/novu`
> exemptions must be registered so the exempt paths resolve to options without
> the Novu patterns.

### `security_and_logging_requirements`

- A successful send logs `transport.sent` at `info` with at least
  `channel`, `provider` (`"novu"`) and `messageId` (the `providerMessageId`).
- **No** entry on any path — success, upstream contract violation, retryable
  failure or timeout — may carry `html`, `text`, or a contact value
  (`to.email` / `to.phoneE164`). The pin asserts over the whole memory sink
  (`sink.entries`), by value canaries **and** by key name, so a leaked contact
  cannot hide behind the logging port's value redaction (which preserves the key
  and masks the value).

### ADR numbering (finding 2 — central allocation `t_eb61c823`)

`origin/main` @ `819cdf1` is dense `0001`–`0069`; PR #181 (OP-91 follow-up) is
still open and keeps `0070`/`0071`. This branch therefore:

| Before | After  | File                                                                        |
| ------ | ------ | --------------------------------------------------------------------------- |
| `0070` | `0072` | OP-92 RED: MessageTransport port, Novu adapter and the workflow drift guard |
| `0071` | `0073` | OP-92 RED review sign-off                                                   |
| —      | `0074` | this ADR (RED-pins follow-up)                                               |

`0070`/`0071` are left **reserved** in `docs/adr/README.md` for PR #181
(`ADR-0070-op91-followup-deletion-requested-red` + `ADR-0071-op91-…-green`).
GREEN `t_8930fc35` owns `0075` (implementation) and `0076` (review sign-off).
Resolution rule at integration: re-fetch `origin/main`, lowest-free-first; if
`0070`–`0073` are free, take the lowest. The numbers actually used here are
`0072`/`0073`/`0074`.

## Specs added (all RED against the current tree)

| Spec     | File                                                                | Pins                                                                                                                                            |
| -------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| I6–I8    | `apps/web/src/test/integration/novu-transport.test.ts`              | memory outbox records in order, mints distinct ids, is distinct from the log sink                                                               |
| I9–I11   | same                                                                | upsert creates exactly the three workflows with one active matching step each; idempotent second run; failure logged at `error` + non-zero exit |
| I12–I13  | same                                                                | `payload.headers` carries the unsubscribe headers; omitted when absent                                                                          |
| I14–I18  | same                                                                | `transport.sent` at `info`; no body/contact leakage on success/violation/retryable/timeout                                                      |
| env pins | `apps/web/src/server/config/env.test.ts`                            | `transport.timeoutMs` default `10000`, override, invalid fallback                                                                               |
| env docs | `apps/web/src/server/config/env-example.test.ts` (+ `.env.example`) | `NOVU_TIMEOUT_MS` documented                                                                                                                    |
| AC1      | `apps/web/src/test/unit/eslint/novu-import-boundary.test.ts`        | the flat config bans Novu imports outside adapter + `scripts/novu`                                                                              |

Every new spec fails **only** because the pinned module/field/rule is absent —
never from an accidental import or compile error. Reproduce (RED review round 2,
HEAD `bdbd8a6` + the guard-spec fix):

- `pnpm test:unit` → exit 1; **5 failed files / 70 passed (75)**; **7 failed
  tests / 1359 passed (1366)**. Only the intended reasons:
  - 3 files (pre-existing OP-92) fail at import with `Cannot find package`
    (`@/server/adapters/transport-error`, `…/novu/workflow-drift`,
    `…/novu/workflow-map`) — the pinned modules do not exist yet;
  - `env.test.ts` fails 4 (3 timeout pins + the exact-shape expectation) on the
    absent `getConfig().transport.timeoutMs`;
  - `novu-import-boundary.test.ts` fails 3 with
    `expected [] to include 'no-restricted-imports'` — the boundary is absent,
    and the rule **ran** (it resolves to the real per-path options), so this is
    no longer a parsing error.
- `TMPDIR=/root/tmp-mongo pnpm test:int` → exit 1; **2 failed files / 36 passed
  (38)**; **262 tests passed (262)**. `novu-transport.test.ts` and
  `novu-workflow-drift.test.ts` fail at import with `Cannot find package
'@/server/adapters/memory-message-transport'` / `'@/server/adapters/novu/
workflow-drift'` — the pinned modules do not exist yet.

## Consequences

- GREEN implements §2/§5/§6, the logging requirements, AC1 and the timeout knob
  against concrete failing specs instead of prose, so its blast radius is known
  before it writes production code.
- The outbox and the log sink can never be confused (`memoryMessageTransport`
  vs `memoryTransport`).
- The timeout is configurable in production without touching the adapter, and
  the adapter remains free of `process.env`.
- The Novu SDK cannot leak into domain/service/route code; a provider swap stays
  one adapter file.

### Assumptions recorded unilaterally (flag to reviewer/implementer)

1. **Upsert is create-if-missing, not update.** The spec requires the three
   workflows to exist and a second run to create none; it does not pin mutating
   an existing workflow's step. If a later card needs drift _repair_, that is a
   new pin.
2. **Create-body shape.** `POST /v1/workflows` with
   `{ workflowId, name, active, steps: [{ active, template: { type } }] }` is our
   chosen Novu shape; the step channel reuses `template.type` so the create body
   and the drift reader agree.
3. **`runWorkflowUpsert` returns an exit code** (a `number`), mirroring
   `runTransportDriftCheck`, rather than a result object.
4. **Header path `payload.headers`** is chosen (rather than a top-level
   `headers`) so it travels inside the pass-through `payload` alongside
   `subject`/`html`/`text`.
5. **`timeoutMs` lives at `transport.timeoutMs`.** No separate `novu` config
   group is introduced; the transport group already owns
   `provider`/`unsubscribeSigningSecret`.
6. **Adapter-default timeout — explicit waiver (RED review round 2, Low).** No
   spec exercises `novuTransport({ … })` _without_ a `timeoutMs` option to prove
   the default equals `getConfig().transport.timeoutMs`. The card scoped the
   timeout pin to `env.test.ts`, which pins the config value (default `10_000`,
   override, invalid fallback); the existing I4/I18 pins exercise an explicit
   `timeoutMs`. Wiring the omitting path would need env manipulation before the
   cached `getConfig()` runs and is deferred — a follow-up pin if the adapter
   default ever needs its own guarantee. GREEN must still default the option to
   `getConfig().transport.timeoutMs` (per §4 above).

## Revision — RED review round 2

The round-1 RED review found the AC1 guard spec was RED for the wrong reason:
under `parserOptions.projectService: true`, `lintText` on a synthetic non-project
path returned only `Parsing error … was not found by the project service`
(`ruleId === null`), so the boundary could never be reported and GREEN could not
turn AC1 green. Fixed by resolving the real config (`calculateConfigForFile`) and
running the resolved `no-restricted-imports` rule directly (see the AC1 section).
The spec now fails with `expected [] to include 'no-restricted-imports'` because
the Novu patterns are absent — the correct RED — and reports the import once the
patterns are merged. All other round-1 findings were verified good and are
unchanged.

## Alternatives considered

- **Narrow the GREEN card instead of adding pins.** Rejected: §2/§5/§6 and the
  logging/lint requirements are real operator guarantees; dropping them would
  ship the feature without the adapter, the workflows-as-code script or the
  privacy constraint.
- **Test the upsert CLI by spawning a subprocess.** Rejected: a child process
  cannot be intercepted by MSW, so the check would require a live Novu. The
  engine lives in `src/server` and the CLI is a thin wrapper.
- **Pin AC1 by snapshotting `eslint.config.mjs`.** Rejected: a source-text
  snapshot breaks on harmless refactors and does not prove the rule fires. The
  guard spec resolves the real config for each path and runs the real
  `no-restricted-imports` rule over synthetic source.
- **Name the outbox `memoryTransport` and alias the import.** Rejected: two
  same-named ports across two modules is a permanent footgun (finding 3).
