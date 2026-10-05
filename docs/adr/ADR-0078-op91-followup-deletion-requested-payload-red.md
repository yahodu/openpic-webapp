# ADR-0078 — OP-91 follow-up RED: pin the `account.deletion.requested` payload (`scheduledAt` + `cancelUrl`)

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-testcase-writer`
- **Renumbered:** 0076 → 0078 (ADR-0076/0077 were claimed by the OP-92 message-transport lane on `main` before this branch merged; content unchanged)
- **Card:** `t_c43cf80c` (OP-91 follow-up, phase 1-Identity) · **Stage:** RED (tests + comments only; no production code)
- **Contract under test:** API contract §1.4 (Account deletion) · notification design §4.2 · ADR-0067 (OP-91 RED), ADR-0068 (OP-91 GREEN), ADR-0069 (green review sign-off), ADR-0070 (deletion-requested emission RED), ADR-0071 (deletion-requested emission GREEN)
- **Branch:** `OP-91-task-followup-deletion-requested-payload`

## Context

ADR-0070/ADR-0071 wired `POST /me/deletion` to emit one
`account.deletion.requested` outbox row through the identity lifecycle seam.
That row's `payload` is still the empty object `{}`:

```ts
await safeEmit(resolved, {
  eventKey: "account.deletion.requested",
  tenantId: event.userId,
  actorRef: userRef(event.userId),
  subjectRef: userRef(event.userId),
  payload: {}, // <-- no schedule, no cancel link
  dedupeKey: `account.deletion.requested:${event.userId}:${now.toISOString()}`,
});
```

Contract §1.4 has the endpoint return
`{ status: "deletion_pending", scheduledAt, cancelUntil, cancelUrl }`, and the
notification design §4.2 requires the deletion-requested notification (in-app +
email + mobile, because the action is irreversible) to tell the user **when** the
purge is scheduled and **where** to cancel it. A consumer that receives the outbox
row cannot reconstruct either fact today: `scheduledAt` lives only on the
`userProfiles` document and `cancelUrl` lives only as `DELETION_PATH` in
`apps/web/src/server/me/deletion.ts`. Nothing pins the payload shape, so the row
is green while the notification requirement is unmet.

This ADR records the follow-up RED decision so the gated GREEN card inherits the
exact contract.

## Decision

### 1. New RED spec I8 pins the payload on the emitted row

`me-sessions-and-deletion.test.ts` gains a sibling to I7:

`I8: the account.deletion.requested row carries scheduledAt and cancelUrl`

It signs in with an email OTP, issues `POST /me/deletion` with a matching
`confirmEmail`, asserts the `202`, reads the response body, then reads the single
emitted `domain_events` row (`eventKey: "account.deletion.requested"`,
`subjectRef.id: String(user._id)`) and asserts:

- `rows` has length **1** (the exactly-one emission stays pinned);
- `typeof row.payload.scheduledAt === "string"`;
- `Number.isNaN(Date.parse(row.payload.scheduledAt)) === false`;
- `row.payload.scheduledAt` equals the response body's `scheduledAt`;
- `row.payload.scheduledAt` equals the response body's `cancelUntil` (the same
  ISO instant — the cancel window closes when the purge becomes eligible);
- `row.payload.cancelUrl === DELETION_PATH` (`/api/v1/me/deletion`).

Field names are camelCase `scheduledAt` / `cancelUrl`, matching the §1.4 202
body. No other payload fields are asserted or permitted.

**Against `main` today the spec fails for the right reason: the payload is `{}`,
so the first assertion sees `undefined`.**

```
FAIL |integration| ...me-sessions-and-deletion.test.ts > account deletion (contract §1.4) > I8: the account.deletion.requested row carries scheduledAt and cancelUrl
AssertionError: expected 'undefined' to be 'string' // Object.is equality

Expected: "string"
Received: "undefined"

 ❯ apps/web/src/test/integration/me-sessions-and-deletion.test.ts:648:40
    648|     expect(typeof payload.scheduledAt).toBe("string");
       |                                        ^
```

### 2. I7 is left untouched

I7 keeps its `countDocuments(...) === 1` assertion verbatim. I8 is a sibling
spec, not an extension, so the emission-count pin and the payload pin fail
independently — a regression in either is attributable to one named spec.

### 3. The observable is the outbox row, not an internal call

I8 asserts on the persisted `domain_events` document and the §1.4 response body,
never on `handleDeletionRequested` directly. Only an integration spec that drives
the real route handler proves the endpoint supplies the schedule to the seam,
exactly as I3/I7 do for the emissions themselves. I8 does not assert `Date` vs
`string` internals beyond the contract's ISO-string requirement.

## Consequences

- **Integration:** 36 files, **1 red** (I8) and **263 pass** — the single intended
  red. The other 35 files are byte-identical in behaviour to `main`.
- **Unit:** unchanged; this card touches one integration spec and the ADR index.
- No production file is modified by this card. The red I8 ships inside the gated
  GREEN PR on the same branch, owned by the GREEN card, which threads the
  response-body `scheduledAt` (the same `computeDeletionScheduledAt` instant the
  route already returns) and `DELETION_PATH` into the `handleDeletionRequested`
  emit and turns I8 green.
- The GREEN implementation must pass the ISO instant the route computes — not a
  fresh `now` inside the handler — so `payload.scheduledAt` is string-equal to the
  202 body's `scheduledAt`/`cancelUntil`, not merely the same instant.

## Alternatives considered

- **Extend I7 in place** — rejected: I7's job is the emission count; folding the
  payload assertions in would make one failure ambiguous between a missing row
  and a wrong payload, and would couple the two contract facts.
- **Assert on `userProfiles.deletionScheduledAt` instead of the row** — rejected:
  the notification consumer reads the outbox row, not the profile. The contract
  fact under test is what the consumer receives.
- **Accept a `Date` for `payload.scheduledAt`** — rejected: the §1.4 body and
  every other outbox payload are JSON, so the ISO string is the wire shape; a
  `Date` would not survive the queue serialization the consumer depends on.
- **Permit extra payload fields** — rejected: the contract is a closed set; a
  consumer that branches on an unspecified field is a latent break, so only the
  two documented fields are pinned.
