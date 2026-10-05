# ADR-0079 — OP-91 follow-up GREEN: carry `scheduledAt` + `cancelUrl` in the `account.deletion.requested` payload

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-backend-coder`
- **Card:** `t_011e5af2` (OP-91 follow-up, phase 1-Identity) · **Stage:** GREEN
- **RED contract:** ADR-0078 (pin the `account.deletion.requested` payload; renumbered from 0076) · ADR-0070 (deletion-requested emission RED), ADR-0071 (emission GREEN, amended here)
- **Contract:** API contract §1.4 (Account deletion) · notification design §4.2
- **Branch:** `OP-91-task-followup-deletion-requested-payload` (same branch as the parent RED card)
- **PR:** #183

## Context

ADR-0070/ADR-0071 wired `POST /me/deletion` to emit exactly one
`account.deletion.requested` outbox row through the identity lifecycle seam, but
left that row's `payload` as the empty object `{}`. The §1.4 202 body already
reports the cancel window (`scheduledAt` = `cancelUntil` = the instant
`computeDeletionScheduledAt` yields, plus `cancelUrl` = `DELETION_PATH`), and
notification design §4.2 requires the deletion-requested notification to tell the
user **when** the purge runs and **where** to cancel it. A consumer reading only
the outbox row could reconstruct neither fact.

The parent RED card (`t_c43cf80c`) added integration spec **I8**, pinning the
emitted row's payload to `{ scheduledAt, cancelUrl }`, with `scheduledAt`
string-equal to the §1.4 body's `scheduledAt`/`cancelUntil` and `cancelUrl`
string-equal to `DELETION_PATH` (`/api/v1/me/deletion`), while leaving I7's
exactly-one-row count intact. This ADR records the GREEN that turns I8 green.

## Decision

### 1. `DeletionRequestedEvent` carries the two §1.4 fields

`identity-hooks.ts` extends the handler input to match the 202 body's field names
and types:

```ts
export interface DeletionRequestedEvent {
  readonly userId: string;
  /** The §1.4 cancel-window instant, as the ISO-8601 UTC string the 202 body reports. */
  readonly scheduledAt: string;
  /** The absolute path that cancels the window (`DELETION_PATH`), for deep-linking. */
  readonly cancelUrl: string;
}
```

### 2. `handleDeletionRequested` puts them on the payload

The emit's identity fields are unchanged (ADR-0043 §1 / ADR-0070): `eventKey`,
`tenantId: event.userId`, `actorRef`/`subjectRef: userRef(event.userId)`, and
`dedupeKey: account.deletion.requested:${userId}:${instant}` stay exactly as they
were. Only `payload` changes from `{}` to the closed two-field set:

```ts
await safeEmit(resolved, {
  eventKey: "account.deletion.requested",
  tenantId: event.userId,
  actorRef: userRef(event.userId),
  subjectRef: userRef(event.userId),
  payload: { scheduledAt: event.scheduledAt, cancelUrl: event.cancelUrl },
  dedupeKey: `account.deletion.requested:${event.userId}:${now.toISOString()}`,
});
```

Exactly one row is still emitted per request.

### 3. The route supplies its already-computed instant, not a fresh `now`

`POST /me/deletion` passes the same values it returns in the 202 body:

```ts
const scheduledIso = scheduledAt.toISOString(); // hoisted above the seam call
…
await createIdentityLifecycleSeams({ db: database }).deletionRequested({
  userId,
  scheduledAt: scheduledIso,
  cancelUrl: DELETION_PATH,
});
```

`scheduledIso` and `DELETION_PATH` already existed in the handler, so no new
imports are needed. Computing the ISO string once and reusing it for the seam,
the log line and the 202 body keeps a single conversion site: the payload is
byte-identical to the body, satisfying I8's exact string equality (not merely
equal instants). The seam in `identity-lifecycle.ts` only forwards the event, so
it needed no change.

## Consequences

- The parent's RED spec **I8** now passes; I7's exactly-one-row count is
  unchanged. Full suites: unit **71 files / 1357 passed**, integration **36 files
  / 264 passed** (`TMPDIR=/root/tmp-mongo`), `tsc`/eslint/prettier clean.
- No test, mock, fixture or test utility was modified. The only production files
  touched are `identity-hooks.ts` and `app/api/v1/me/deletion/route.ts`.
- The payload is now a closed, consumer-facing contract: two fields, camelCase,
  named after the §1.4 body. A notification consumer can deep-link the cancel
  window from the outbox row alone.
- ADR-0071 is amended in place (payload note + rejected alternative) with an
  "amended by ADR-0079" pointer; its historical rationale is preserved.

## Alternatives considered

- **Carry `scheduledAt` as a `Date`** — rejected: every other outbox payload is
  JSON, and I8 pins the wire shape to a `Date.parse`-able ISO string that survives
  queue serialization. It also breaks the exact-match to the 202 body, which is
  the source of truth for the window.
- **Recompute `now` inside the handler** — rejected: I8 requires
  `payload.scheduledAt` to string-equal the body's instant, so any second clock
  read risks a drift of milliseconds and a false red.
- **Return the fields from a shared helper instead of hoisting `scheduledIso`** —
  rejected as speculative: the route already holds both values; a helper would add
  an abstraction no test demands (YAGNI).
- **Leave `payload: {}` and let the consumer read `userProfiles`** — rejected:
  ADR-0078/§4.2 pin the row as the consumer's input; the profile is not the
  notification's contract surface.
