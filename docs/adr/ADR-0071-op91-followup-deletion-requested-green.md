# ADR-0071 — OP-91 follow-up GREEN: emit `account.deletion.requested` on `POST /me/deletion`

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-backend-coder`
- **Card:** `t_3ca3db85` (OP-91 follow-up, phase 1-Identity) · **Stage:** GREEN
- **RED contract:** ADR-0070 (pin the `account.deletion.requested` emission + test
  hygiene) · ADR-0067 (OP-91 RED), ADR-0068 (OP-91 GREEN), ADR-0069 (green review sign-off)
- **Contract:** API contract §1.4 (Account deletion) · notification design §4.2
- **Branch:** `OP-91-task-followup-deletion-requested-red` (same branch as the parent RED card)

## Context

The OP-91 GREEN round-1 review (ADR-0069) found that `POST /me/deletion` flips
`userProfiles.status` to `deletion_pending` and logs `me.deletion.requested` but
never emits the `account.deletion.requested` domain event the card scope (§1.4)
requires. ADR-0068 §Consequences recorded this as a deliberate deferral; the
parent RED card (`t_86eb4525`) then added integration spec **I7** pinning exactly
one `account.deletion.requested` row subject to the deleting user, leaving the
branch red and a draft PR open. This ADR records the GREEN that turns I7 green.

## Decision

### 1. A `handleDeletionRequested` policy handler

`identity-hooks.ts` gains `handleDeletionRequested(event, deps)` next to
`handleSessionsRevoked`. It emits one event through the injected outbox door
(`safeEmit`, so a broken outbox never fails the endpoint):

```
eventKey:   "account.deletion.requested"
tenantId:   event.userId
actorRef:   userRef(userId)          // { kind: "user", id: userId }
subjectRef: userRef(userId)
payload:    { scheduledAt, cancelUrl }   // amended by ADR-0079 (was {})
dedupeKey:  `account.deletion.requested:${userId}:${instant}`
```

The dedupe scheme (`eventKey:userId:instant`) matches the sessions-revoked,
contact-changed and 2FA handlers, so a redelivered invocation collapses to one
row while a genuinely new request at a later instant re-emits. `userRef` keeps
the subject/actor convention every identity emit already uses.

### 2. Exposed on the endpoint-facing seam

`IdentityLifecycleSeams` gains `deletionRequested(event: DeletionRequestedEvent)`,
mirroring `sessionsRevoked`: `createIdentityLifecycleSeams` returns a method that
delegates to `handleDeletionRequested` wrapped in `safeRun("deletion.requested", …)`.

### 3. The route calls the seam once, after its own write

`POST /me/deletion` calls
`createIdentityLifecycleSeams({ db: database }).deletionRequested({ userId })`
immediately after the `userProfiles` update succeeds. The route does **not** write
a domain event directly — the emission belongs to the policy handler (ADR-0043
§3), exactly like `account.sessions.revoked`. There is no `userProfiles`
database hook for this transition, so there is no double-emit.

## Consequences

- The parent's RED spec I7 now passes. Full suites: unit **71 files / 1357
  passed**, integration **36 files / 263 passed** (`TMPDIR=/root/tmp-mongo`),
  Playwright `--project api` **14 passed**; `tsc`/eslint/prettier clean.
- No test, mock, fixture or test utility was modified — the only changes are the
  three production files named above.
- `payload` was intentionally `{}` in this round: the contract's §1.4 requirement
  pinned by I7 was the emission and its subject; payload shape was the
  notification matrix's concern (§4.2), which was out of scope for this card
  (ADR-0070). **Amended by ADR-0079:** a follow-up RED/GREEN pair (ADR-0078 /
  ADR-0079) pins and now carries `{ scheduledAt, cancelUrl }` on the row, because
  §4.2 needs the notification consumer to deep-link the cancel window.

## Alternatives considered

- **Emit `emitDomainEvent` directly in the route** — rejected: it bypasses the
  identity-lifecycle seam every other §4–§6 surface uses (ADR-0043 §3) and would
  diverge from the `sessionsRevoked` precedent the RED spec explicitly mirrors.
- **Add a `userProfiles` update database hook to emit** — rejected: there is no
  such hook, and wiring one would risk a double-emit alongside the explicit seam
  call (the I7 count assertion would catch it).
- **Carry `scheduledAt`/`cancelUrl` in the payload now** — rejected as
  speculative at this stage: no test pinned the payload, and §4.2 owned its
  shape. **Amended by ADR-0079:** the follow-up RED (ADR-0078) pinned the payload
  and the GREEN (ADR-0079) now carries `{ scheduledAt, cancelUrl }`, so this
  alternative is the decision taken once a test demanded it.
