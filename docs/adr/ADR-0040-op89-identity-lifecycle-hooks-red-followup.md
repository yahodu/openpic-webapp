# ADR-0040 — OP-89 identity lifecycle hooks: sections 4–6 and the `op_att` claim hook (RED follow-up pins)

- **Status:** Accepted (RED pins) · **Date:** 2026-10-06
- **Card:** OP-89 `t_eb12bb8a` (phase 1-Identity, epic Authentication, RED follow-up) · **Amends:** ADR-0038 (extends the module contract; does not supersede it)
- **Contract:** API contract §1.1 (hook table), §1.5 (anonymous attendee sessions), §6.7 (claim endpoint), §7.7 (domain events); notification design §4.1; ADR-0029 (outbox), ADR-0039 (RED review finding 1)
- **Branch / PR:** `OP-89-task-identity-lifecycle-hooks-red` (draft PR #160) — append-only extension.

## Context

ADR-0038 pinned the `@/server/auth/identity-hooks` module contract for OP-89
sections 1–3 (user created, contact verified, session created) but only the
emit-failure half of §7. The RED review (ADR-0039, finding 1) found that
GREEN `t_eb421b87` also asks for sections 4, 5, 6 and the unclaimed-`op_att`
claim service, none of which had RED pins — and AGENTS.md §2.1 forbids
implementing them untested. This ADR records the extended contract the
follow-up RED suite pins so GREEN can implement all seven sections against
the tests alone.

The additions are **additive**: the three original handlers
(`handleUserCreated`, `handleContactVerified`, `handleSessionCreated`), their
inputs and the `createAuth({ db, emit? })` seam are unchanged except that
`SessionCreatedEvent` gains one optional field and the handler/deps gain one
optional seam (below). The three new handlers reuse the exact
`handler(event, deps)` convention of ADR-0038.

## Decision

### 1. Three new plain-input handlers in `@/server/auth/identity-hooks`

```ts
handleContactChanged(event, deps): Promise<void>
handleTwoFactorToggled(event, deps): Promise<void>
handleSessionsRevoked(event, deps): Promise<void>

event:
  ContactChangedEvent   { userId: string;
                          previous: { email?: string | null; phoneNumber?: string | null };
                          current:  { email?: string | null; phoneNumber?: string | null } }
  TwoFactorToggledEvent { userId: string; enabled: boolean }
  SessionsRevokedEvent  { userId: string; sessionIds?: readonly string[] }

deps: { db: Db; emit?: EmitDomainEvent; clock?: Clock; claim?: ClaimAttendeeSession }
```

`previous` is an _input_ because the replaced contact is no longer readable
from the stored user once the change commits; the same reason the ADR-0038
handlers take fully-plain inputs from the Better Auth context.

### 2. `auth.contact.changed` — flags in the payload, contacts in a transient record

Contract §1.1 requires the event to be **fanned out to both the old and the
new contact** (notification §4.1: "so a hijacker cannot silently lock the
owner out"). But contract §7.7 forbids contact details in a `domainEvents`
payload (the outbox is append-only with a 180-day TTL). The two are reconciled
by splitting the data:

- The emitted `auth.contact.changed` payload carries **change flags only**:
  `{ emailChanged: boolean, phoneChanged: boolean }`. No email, phone, hash or
  identifier of a contact is present.
- The raw previous and current contacts go into a **transient fan-out record**
  in the `contactChangeFanouts` collection, which the notification fan-out
  reads once:

  ```ts
  { _id, eventId: string /* the emitted domain-event id */,
    userId: string,
    previous: { email?, phoneNumber? },
    current:  { email?, phoneNumber? },
    expireAt: Date }
  ```

The record references the emitted event (`eventId`) so the fan-out consumer can
resolve it from the row it claims; `previous` and `current` are the two fan-out
targets. The record is short-lived (TTL-bound) — it exists only long enough for
the fan-out to read it, which is why it may hold raw contact values where the
append-only payload may not.

**Flagged assumption.** The GREEN card `t_eb421b87` words this as "store the
old contact **hash** in a transient fan-out record". A hash alone cannot be
messaged: nothing else retains the replaced address once the change commits, so
the fan-out could not reach the previous contact. The tests therefore pin the
raw previous/current contact _references_ on the transient record (as this
card's own body requires: "the transient fan-out record references both
contacts"). If the implementer prefers hashes, the fan-out must be given a
second source for the raw value first — out of scope here.

### 3. `auth.2fa.enabled` / `auth.2fa.disabled` — distinct keys, transition-deduped

`handleTwoFactorToggled` emits `auth.2fa.enabled` when `enabled` is true and
`auth.2fa.disabled` when false — never both. Because the catalogue deliberately
sets no throttle and no dedupe template for the 2FA types (a re-enable after a
disable is itself a security event), idempotency is keyed on the **transition**,
not the user or the state:

```
dedupeKey = `auth.2fa.${enabled ? "enabled" : "disabled"}:${userId}:${at.toISOString()}`
```

where `at` is `deps.clock.now()`. A re-run of the same hook invocation (same
clock instant) is deduped by the outbox unique index; a genuinely new
enable/disable carries a new instant and re-emits.

### 4. `account.sessions.revoked` — the endpoint is OP-91's, the hook is OP-89's

`handleSessionsRevoked` emits one `account.sessions.revoked` event with
`subjectRef { kind: "user", id }`. The `POST /api/v1/me/sessions:revoke-all`
endpoint that _triggers_ this hook belongs to OP-91 (`t_19486cb2`); OP-89 pins
only the hook's emission and does not implement the route.

### 5. The unclaimed `op_att` claim hook — an injectable seam

`SessionCreatedEvent` gains `attendeeSessionToken?: string | null` — the raw,
unclaimed `op_att` cookie value (contract §1.5) when the session-created
request carried one. `index.ts` reads it from the after-hook context headers.
When present and non-empty, `handleSessionCreated` invokes the attendee-session
claim service **non-blocking**:

```ts
type ClaimAttendeeSession = (input: { userId: string; token: string }) => Promise<unknown>;
```

- The seam is injected exactly like `emit`: handler deps `{ ..., claim? }` and
  `createAuth({ db, emit?, claim? })`. `claim` defaults to the real service.
- "Non-blocking" is pinned as **await-inside-try/catch**: the handler awaits the
  claim (so the outcome is deterministic and testable) but swallows any
  rejection, so a claim failure can never fail the sign-in. A rejected claim
  logs `identity_hook.claim_failed` at **error** level.
- No token (absent/empty) ⇒ the seam is not invoked.

**Scope.** The full `POST /api/v1/me/attendee-sessions:claim` endpoint — the
atomic `subject.kind: anonymous → user` re-point, the `200 { claimed, skipped }`
body, `attendee.event.linked` and the `op_att` cookie clear in contract §6.7 —
is **out of OP-89 scope** and is owned by a later card. OP-89 pins only the
hook's invocation of the injectable seam.

## Consequences

- Sections 4–6 and the claim hook now fail RED for exactly one reason: the new
  handlers and the `claim` seam do not exist yet (the file cannot resolve
  `@/server/auth/identity-hooks`). No production code was written.
- A regression that leaks a raw contact into an `auth.contact.changed` payload,
  drops the old-contact fan-out target, emits the wrong 2FA key, double-emits a
  re-run toggle, or lets a claim failure fail a sign-in breaks at least one spec
  loudly.
- The transient `contactChangeFanouts` collection and the `claim` seam are new
  surface the implementer must create; both are named and shaped here because
  the specs assert them.

## Alternatives considered

- **Carry the previous contact in the event payload.** Rejected: the outbox is
  append-only (180-day TTL) and contract §7.7 forbids contact details in a
  payload; a short-lived fan-out record is the only place a not-yet-sent
  security alert may hold the replaced address.
- **Hash-only fan-out record (the GREEN card's wording).** Rejected for these
  specs: a hash cannot be delivered to, so the previous contact could never be
  notified — defeating the contract's stated purpose. Flagged above for the
  implementer.
- **Fire-and-forget (`void claim(...)`) instead of await+catch.** Rejected: the
  log write races the sign-in response, making the "failure is logged" pin
  flaky. Await-inside-catch gives the same non-blocking guarantee,
  deterministically.
- **Lifetime dedupe (`auth.2fa.enabled:{userId}`).** Rejected: it would suppress
  the second enable after a disable, and the catalogue sets no throttle for
  these types precisely so every toggle is announced.
- **Implement the §6.7 claim endpoint here.** Rejected: it is a separate
  contract surface (atomic re-point, response body, event, cookie clear) owned
  by a later card; OP-89 only owns the hook that calls it.
