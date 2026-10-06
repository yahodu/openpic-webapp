# ADR-0107 — OP-94 §1 follow-up TEST pins: the non-memory transport branch, the recipient audiences and the `after()` trigger failure path

- **Status:** Accepted · **Date:** 2026-10-06 · **Author:** `openpic-webapp-testcase-writer`
- **Card:** `t_bd94250c` (OP-94 §1 follow-up TEST) · **Origin:** review of the GREEN card `t_205e5ae7` (PR #201, squash-merged to `main` as `49126f4`), findings M1 + M2
- **Relates to:** [ADR-0106](ADR-0106-op94-followup-fanout-cron-route-green.md) (the implementation under pin), [ADR-0105](ADR-0105-op94-followup-fanout-cron-route-red.md) (the original pins), [ADR-0090](ADR-0090-op94-notification-fan-out-red.md) (the `RecipientRepository` port), [ADR-0076](ADR-0076-op92-message-transport-and-novu-drift-guard-green.md) (`MessageTransport`), [ADR-0024](ADR-0024-client-ip-trust-model.md) / [ADR-0028](ADR-0028-internal-hmac-and-cron-framework.md) (fail-closed deploy posture)

## Context

ADR-0106 §"Coverage gap (handoff)" self-reported that the modules it added are
exercised only where the existing suite reaches them: the `memory` branch of the
transport registry, the cron route/job wiring, and a consumer that claims events
with **no recipients**. Three production seams therefore had no direct pin:

1. `@/server/adapters/message-transport-provider` — the non-memory branch, which
   OP-94 §1 changed from a loud `throw` to `novuTransport(...)` built from
   `getNovuRuntimeConfig()`.
2. `@/server/repos/notification-recipients` — the concrete `RecipientRepository`
   audiences.
3. `@/server/notifications/fan-out-trigger` — the opportunistic `after()`
   failure path.

This card pins them. Tests only; no production file was modified. The merged
implementation head is `49126f4`.

## Decision

### 1. A two-test pin for `getMessageTransport()` adds one intended RED

`apps/web/src/server/adapters/message-transport-provider.test.ts` (unit, MSW —
no live network) imports a fresh copy of the factory under a replaced
`process.env` (mirroring `config/env.test.ts`, whose "parse once" cache would
otherwise leak between selections).

- **U1 (green).** With `MESSAGE_TRANSPORT=ses` (the only legal non-memory value
  — `config/env.ts` `PROVIDER_SPECS` accepts `memory | ses`; `novu` is **not** a
  valid selector) and `NOVU_API_KEY` set, the returned transport POSTs the
  trigger to `<NOVU_BASE_URL>/v1/events/trigger` with `ApiKey <key>` and returns
  the provider receipt. This is the branch ADR-0106 left unexecuted.

- **U2 (intended RED).** With a non-memory provider selected and `NOVU_API_KEY`
  unset **or** blank, the factory must **fail closed at selection time**: it
  refuses to build a transport and names the missing key (`ConfigError`), rather
  than building `novuTransport({ apiKey: "" })` and failing only on the first
  `send()`. Today the factory returns a transport in both cases, so both cases
  are RED:

  ```
  AssertionError: expected undefined to be an instance of ConfigError
   ❯ apps/web/src/server/adapters/message-transport-provider.test.ts:145:20
  ```

  The posture is deliberate and mirrors two existing precedents:
  `getRateLimitConfig()` refuses a `redis` selection without Upstash credentials,
  and `getConfig()` refuses a `memory` provider in production. A deploy that
  cannot send should not boot. **This ADR does not change production code**; the
  fix is routed to a GREEN child for `openpic-webapp-backend-coder` (finding
  M1). The implementation agent must add the fail-closed guard to
  `getMessageTransport()` (throw `ConfigError` naming `NOVU_API_KEY`) without
  altering the two branch arms.

### 2. The concrete recipient repository is pinned audience-by-audience

`apps/web/src/test/integration/notification-recipients.test.ts` (integration,
real `MongoMemoryReplSet`) drives `mongoRecipientRepository(db)` directly and
seeds each collection, mirroring the `notification-fan-out.test.ts` style. It
pins:

- `organizer` / `co_organizer` active `eventMembers` for the event, matched
  whether the id is stored as an `ObjectId` **or** a hex string; a removed
  membership and a non-requested role are excluded.
- The co-organizer audience additionally reaches the invitee of
  **pending/accepted** `event_co_organizer` `invitations`; a declined invitation
  and a non-`event_co_organizer` kind are excluded. An organizer-only audience
  never reads `invitations` at all.
- `attendee_identified` → `attendeeEventProfiles` whose `subject.kind === "user"`;
  a cookie-bound uploader (`kind: "cookie"`) and an anonymous subject are
  unreachable.
- `billing_contact` → `tenants.billingContactUserId`, both id forms, and `null`
  when the field is absent or the tenant does not exist.
- `platform_admin` → active `userProfiles` with `platformRole: "admin"`;
  suspended admins and active non-admins are excluded.
- Resilience: empty collections and rows with a missing id field yield no
  recipients rather than a crash.

### 3. The opportunistic trigger's failure path is pinned without a database

`apps/web/src/server/notifications/fan-out-trigger.test.ts` (unit) mocks the
fan-out, the transport service, the recipient repo and the logger, and pins:

- The fan-out module is not evaluated when the trigger is imported (the cycle
  the dynamic `import()` exists to break) and is evaluated on the first run,
  which then calls `runNotificationFanOut` with the resolved transport and
  recipient source.
- A rejection from `runNotificationFanOut` — and a synchronous failure while
  resolving the collaborators — is swallowed: the trigger **resolves**, and it
  logs `notification.fan_out_trigger_failed` at error. A scheduled failure can
  never surface as an unhandled rejection after the response.

## Consequences

- The three ADR-0106 coverage gaps (M1/M2) are now covered by named pins.
- The full `unit` suite is **green except the two intended U2 RED cases**
  (1458 passed / 2 failed, one file); the full `integration` suite is green
  (326 passed); `tsc` (root + contracts + web), `eslint .` (0 errors) and
  `prettier --check` are clean.
- A regression in any pinned audience, the vendor POST URL/key, the lazy
  dynamic import or the swallow-and-log path now fails a named test.
- M1 lands as a GREEN child; until it lands, `pnpm test:unit` reports the two
  intended failures.

## Alternatives considered

- **Characterize the empty-key branch (green) instead of pinning fail-closed.**
  Rejected: the codebase's established deploy posture is fail-closed
  (`getRateLimitConfig`, the production `memory` refusal), and a transport that
  silently carries an empty key fails asynchronously at first send. The card
  explicitly anticipated this and asked for a GREEN child rather than a
  production edit in the TEST lane.
- **Fake `fetch` with a spy in the unit project.** Rejected: MSW is the only
  sanctioned HTTP fake; the spec uses `setupServer` directly.
- **Drive the recipient repository through the whole fan-out.** Rejected: the
  `notification-fan-out.test.ts` lane already injects a deterministic port; the
  gap was the concrete repository, so this spec drives it directly.
- **Assert the trigger source text uses `await import(`.** Rejected: that is an
  implementation-detail assertion. The lazy-evaluation behaviour (the fan-out
  module is not evaluated at `fan-out-trigger` import time, only when the
  trigger runs) is the observable contract and is what is pinned.
