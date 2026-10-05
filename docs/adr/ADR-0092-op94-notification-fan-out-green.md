# ADR-0092 — OP-94 GREEN: notification fan-out consumer implementation (outbox → feed + dispatches)

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-94 notification fan-out consumer GREEN (`t_d8f1e9e5`) · **Relates to:** [ADR-0090](ADR-0090-op94-notification-fan-out-red.md) (the pinned contract), [ADR-0091](ADR-0091-op94-fan-out-red-review-signoff.md) (its sign-off), [ADR-0085](ADR-0085-op93-channel-resolution-and-template-renderer-red.md) (`resolveChannel` + `renderTemplate`), [ADR-0076](ADR-0076-op92-message-transport-and-novu-drift-guard-green.md) (`MessageTransport`), [ADR-0029](ADR-0029-domain-events-outbox.md) (the outbox)

## Context

ADR-0090 pinned the fan-out consumer and left the GREEN card (`t_d8f1e9e5`) to
implement `@/server/notifications/fan-out` against it: 3 unit pins (U1–U3) and 9
integration pins (I1–I8 + I2b) running against a real `MongoMemoryReplSet` and
the real seed catalogue. No new tests were written; this ADR records the
implementation decisions the contract left to the implementer (module shape,
feed/dispatch writes, aggregation, digest handling, secret retention).

## Decision

**Implemented `apps/web/src/server/notifications/fan-out.ts` with the exact
ADR-0090 module contract**

- `resolveRecipients(input)` — audience → source resolution (U1/U2), one
  `listEventRoleMembers` call for the declared organizer roles in canonical
  `["organizer","co_organizer"]` order, event-scoped audiences contributing
  nothing when `eventId` is null, `subjectUserId` always included and
  `actorUserId` always removed, deduped preserving first-seen order.
- `interpolateDedupeKey(template, vars)` — pure `{name}` expansion; a `null`
  template yields `null`, an unsupplied variable throws naming it (U3).
- `runNotificationFanOut(options)` — claims `dispatch.notifications: "pending"`
  rows via `claimPendingEvents`, fans each out, and marks it `done` or (on a
  retryable failure) leaves it claimable via `markFailed`.
- Types `RecipientRepository`, `ResolveRecipientsInput`, `FanOutRunOptions`,
  `FanOutSummary` (`{ claimed, processed, failed }`).

Decisions the contract left open:

1. **Failure isolation boundary.** Each recipient is fanned out inside a
   `try/catch`; a retryable transport failure sets a run-level flag so the event
   is left `pending` while its peers are still delivered. An unexpected
   per-recipient error is treated as retryable (at-least-once) and logged as
   `notification.fan_out_failed` without tenant/contact data.
2. **Aggregation predicate.** A feed row aggregates (`findOneAndUpdate` with
   `readAt: null` in the filter, `$inc groupCount`, `$set updatedAt`) when the
   type's `throttle.strategy` is `digest` or `coalesce`; every other type
   inserts a fresh row. The `$inc` is the event `payload.count` when it is a
   positive number, else `1`.
3. **`in_app` is never digested.** A `digest` decision on the `in_app` group
   still upserts the feed row (design §6 — "in-app aggregation is separate from
   digesting"); `in_app` never writes a dispatch row (acceptance criterion).
4. **Outbound digest.** A `digest` decision on an outbound group records a
   `queued` dispatch row and does not send; the digest bucket accumulation and
   flush light up with the (out-of-scope) digest cron. This keeps the "every
   decision produces a dispatch row" criterion true without inventing routing.
5. **`defer` (quiet hours).** Persisted as a `skipped` row with
   `skipReason: "quiet_hours_deferred"` (the seventh `SkipReason`).
6. **Skip-before-candidate channels.** A skip decided before candidate
   selection (opt-out, suppression) records the group's channel: the group name
   for `in_app`/`email`, the first declared candidate for `mobile`.
7. **Dedupe is the unique index only.** The stored key is
   `` `${interpolateDedupeKey(keyTemplate, vars)}:${channel}` `` (ADR-0090's
   channel-suffix decision); a duplicate insert (E11000) becomes a
   `skipped`/`deduped` row with `dedupeKey: null` (so it cannot itself collide)
   and is never sent.
8. **Action target / actions.** An actionable type derives
   `actionTarget: { kind: subjectRef.kind, id: subjectRef.id, state: "open" }`
   and, for an `invitation` target, `accept`/`reject` actions all
   `state: "available"` (design §7; `collab.invite.sent` is the only
   actionable type in v1). Non-actionable types store `actionTarget: null`,
   `actions: []`.
9. **No body is ever persisted on a dispatch.** The schema §19.5 row has no
   `body` field, so `retainBody: false` (I6) is satisfied by construction and a
   rendered secret never reaches the ledger; the sent message itself is handed
   to the transport only.
10. **`expireAt` from `platformSettings`** — `retention.notificationDays` for a
    feed row, `retention.dispatchDays` for a dispatch.
11. **`userId`/`tenantId` typing.** `userId` is stored as an `ObjectId` (the
    specs compare against `new ObjectId(hex)`); `tenantId` stays the caller's
    string; `eventId` is stored as an `ObjectId` when the payload value is a
    24-hex id, else `null`. The in-app `groupKey` is the raw `payload.eventId`
    string (§6).

**Deliberately not implemented (ADR-0090 "Out of scope").** The
`/internal/cron/notification-fanout` route, the `after()` opportunistic trigger
and `sendTransactionalNow()` (OP-95). No test references them, so they stay
out — the cron route's HMAC framework (ADR-0028) is a separate lane.

## Evidence (RED → GREEN)

- RED reproduced at base `855c7be`:
  `vitest run --project unit fan-out` and
  `vitest run --project integration notification-fan-out` both fail with
  `Cannot find package '@/server/notifications/fan-out'`; `tsc -p
apps/web/tsconfig.json --noEmit` reports only the two expected `TS2307`s.
- GREEN: unit `fan-out` **15/15**, integration `notification-fan-out`
  **9/9**, full unit project **1438/1438**, full integration project green;
  `tsc` (root + contracts + web), `eslint` and `prettier --check` clean on the
  production file.

## Consequences

- The outbox → feed → dispatch path is wired end-to-end and every pin is earned
  by general behaviour: audience routing, actor exclusion, `readAt`-safe
  aggregation, database-enforced dedupe, provider-failure isolation and
  secret non-retention all fail loudly if regressed.
- `in_app` rows carry no `dedupeKey`; dedupe is an outbound concern only.
- An outbound digest currently lands a `queued` row with no flusher — a known,
  explicitly deferred gap that the digest cron will close; it is not
  user-visible in v1 because no seed type digests an outbound channel except
  `attendee.matches.new`/`pipeline.image.failed`/`event.attendee.milestone`.
- The `RecipientRepository` port still has no production implementation; the
  real membership reads (`eventMembers`/accepted `invitations`/
  `attendeeEventProfiles`) remain a follow-up lane.

## Alternatives considered

- **Pre-check the dedupe key with `findOne`.** Rejected: the acceptance
  criterion is "dedupe via the unique index only"; the spec asserts the outcome
  (one sent, one `deduped`), not the mechanism.
- **Mark the event `done` despite a retryable failure.** Rejected:
  at-least-once delivery requires the failed event to be reclaimable; I5 pins
  `pending`.
- **Render the feed row on read.** Rejected by design §19.4 ("render at write
  time") and pinned by I1 storing a `title`/`body`.
- **Store the rendered body on the dispatch (even gated by `retainBody`).**
  Rejected: schema §19.5 has no `body` field, and I6 asserts the OTP sentinel is
  absent from the stored row.
- **Implement the cron route / `after()` / `sendTransactionalNow()` now.**
  Rejected: no test demands them and ADR-0090 explicitly scopes them out;
  writing them would be untested surface.

## Lint: a test-lane rule relaxation (not a production suppression)

The RED specs assert on an interface method by extracting the reference
(`expect(repository.listEventRoleMembers).toHaveBeenCalled…`), which trips
`@typescript-eslint/unbound-method` — a known false positive for that idiom
(the method is never called, so no `this` can be lost). The test-file override
in `eslint.config.mjs` relaxed the unsafe-* rules but not this one, so `eslint .`
reported nine errors (eight in the unit spec, one in the integration spec).

Test files are owned by the Test Author and were left untouched. The cause is
the rule matching a test assertion, so the fix is a narrow, documented
`"@typescript-eslint/unbound-method": "off"` in the _test-files-only_ override —
a shared config change, not a test edit and not a production suppression
(production keeps the rule on). `eslint .` is now 0 errors.
