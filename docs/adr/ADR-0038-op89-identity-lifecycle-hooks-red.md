# ADR-0038 — Identity lifecycle hooks: profile defaults, lazy invites, completion, new-device and admin sign-in (OP-89 RED)

- **Status:** Accepted (RED pins) · **Date:** 2026-10-06
- **Card:** OP-89 `t_7fe0b494` (phase 1-Identity, epic Authentication, RED) · **Depends on:** OP-88 (outbox, ADR-0029), OP-86 (guards, ADR-0025)
- **Contract:** API contract §1.1 (hook table), §1.2 (`GET /me`), §7.7; schema §13.2, §18.3, §19.3; notification design §19.4
- **Supersedes / amends:** nothing. First record of the identity-lifecycle hook contract.

## Context

ADR-0020/0021/0022 wired Better Auth (OTP, phone, 2FA, rate limits, cookie,
origin policy) but deliberately left the _identity lifecycle_ hooks out of
scope: on first account creation, on contact verification and on session
creation nothing yet writes `userProfiles`, `notificationPreferences`, resolves
lazy invitations, sets `accountCompletedAt`, or emits the security events
`auth.signin.new_device` / `auth.admin.signin` / `auth.account.completed` /
`account.welcome`.

Contract §1.1 fixes their observable effects:

- after user created → `userProfiles` + `notificationPreferences` defaults,
  `account.welcome`, and the lazy-invite resolution;
- after email **or** phone verified → `accountCompletedAt` once, then
  `auth.account.completed` once;
- after session created → `auth.signin.new_device` (dedupe 1/device/24h) and
  `auth.admin.signin` for admins.

This ADR pins the module contract the RED suite drives, so the implementer can
build against the tests alone.

## Decision

### 1. Three plain-input policy handlers in `@/server/auth/identity-hooks`

Following ADR-0022's decomposition style, the policy lives in one focused
module exporting three async functions and their input/deps types:

```ts
handleUserCreated(event, deps): Promise<void>
handleContactVerified(event, deps): Promise<void>
handleSessionCreated(event, deps): Promise<void>

event:
  UserCreatedEvent     { userId: string; email: string;
                         phoneNumber?: string | null;
                         acceptLanguage?: string | null;
                         timeZone?: string | null }
  ContactVerifiedEvent { userId: string }
  SessionCreatedEvent  { userId: string; sessionId: string;
                         device: { userAgent?; ip?; acceptLanguage? } }
deps: { db: Db; emit?: EmitDomainEvent; clock?: Clock }
```

`index.ts` adapts Better Auth's single global `hooks.after` context into these
app-level events; the tests never construct a Better Auth context. This keeps
the specs coupled to the observable contract, not to the library's internal
middleware type (the same rationale as ADR-0020 §1).

### 2. `createAuth` gains an optional `emit` seam

`I6` requires proving that a broken outbox logs an error and the sign-in still
succeeds. The outbox door is injected, mirroring the existing `db` seam:

```ts
createAuth({ db, emit? }): AuthLike
```

`emit` defaults to `emitDomainEvent`. Every handler catches an emit rejection,
logs `identity_hook.emit_failed` at **error** level, and returns normally — a
security notification must never fail the authentication it describes.

### 3. Hash the device fingerprint with the deployment salt

`U2`/`I4` require a deterministic, salted, non-reversible fingerprint. The
fingerprint is built from the request's user-agent, client IP and accepted
languages and hashed with `getRateLimitConfig().salt` (the same salt the OTP
and rate-limit identity paths use). The `auth.signin.new_device` outbox payload
carries only `{ deviceHash }`; raw user-agent/IP values never reach the log.

`U3` pins the pure 24-hour decision (`NEW_DEVICE_WINDOW_MS`) against prior
fingerprint sightings; `I4` pins the outbox outcome (one event per device per
24 h, a fresh event past the window).

### 4. Idempotency is a first-class requirement

`I1` calls the user-created handler twice and asserts exactly one
`userProfiles` and one `notificationPreferences` document. Both writes are
upserts keyed by `userId` (`$setOnInsert`), so a duplicate hook invocation
(Retry/at-least-once) cannot create a second row. `I3` likewise asserts that
re-verifying a contact neither re-emits `auth.account.completed` nor moves
`accountCompletedAt`.

### 5. Locale resolution is a pure function

`U1` pins `parseLocale(acceptLanguage, fallback = "en-IN")` in
`@/server/auth/locale`. The only served locale is `en-IN`; the bare language
`en` maps to it, an unsupported or absent header falls back. It never stores a
tag no template exists for.

### 6. Stored defaults are the schema's, verbatim

`userProfiles` defaults: `platformRole: "client"`, `status: "active"`,
`accountCompletedAt: null`, `primaryTenantId: null`, `marketingOptIn: false`,
`contactCapabilities: { whatsappCapable: null, whatsappCheckedAt: null,
pushTokens: [] }`, `schemaVersion`. `notificationPreferences` defaults match
schema §19.3: `global: { email: "on", mobile: "off", in_app: "on" }`, empty
`byType`/`byEvent`/`digest`, quiet hours `22:00–07:00`, `locale` from the
profile.

## Assumptions resolved unilaterally (flagged for the implementer)

- **Lazy-invite emits `collab.invite.sent`.** The card requires "an in-app
  notification domain event on sign-up"; the only catalogue key for an invite
  notification is `collab.invite.sent`, so the lazy hook re-emits that event
  with the invitation as subject. The notification design §19.4 describes
  inserting feed rows directly; the card's "domain event" wording wins here.
  Dedupe (`1/invite`) keeps a previously-emitted invite from duplicating.
- **Account-level events carry a non-empty `tenantId`.** `emitDomainEvent`
  requires a non-empty `tenantId` (schema §18.3); a brand-new user has no
  tenant. The specs therefore do **not** assert `tenantId` for account-scoped
  events (`account.welcome`, `auth.account.completed`, `auth.signin.new_device`,
  `auth.admin.signin`) — only `eventKey`, `subjectRef` and dedupe behaviour.
- **`userId` crosses the boundary as a hex string** and is stored as an
  `ObjectId` in `userProfiles` / `invitee.userId` (schema §13.2, §13.6), the
  shape `resolvePrincipal` already loads by (`new ObjectId(userId)`).
- **Fingerprint sensitivity includes accepted languages** (schema §13.5 lists
  `uaHash`, `ipHash`, `acceptLangHash`), so changing `acceptLanguage` changes
  the digest.
- **`GET /me` body is required by E1.** The route today returns `{}` behind an
  empty schema; E1 pins the §1.2 profile-default fields
  (`locale`, `platformRole`, `status`, `marketingOptIn`,
  `accountCompletedAt`, `contactCapabilities`). Expanding the `/me` projection
  is part of delivering this card's E1.
- **The fallback locale argument** is `"en-IN"` by default and overridable; the
  sanity spec passes `"en-US"` to prove the parameter is honoured.

## Consequences

- The RED suite fails only for missing modules / the missing `emit` seam, so
  the implementer sees the contract, not an accidental error.
- A regression in any lifecycle branch (a duplicate profile, a re-emitted
  completion, a second new-device inside 24 h, a swallowed sign-in) breaks at
  least one spec loudly.
- `I6` forces the emit seam to be injectable; this is a testability affordance
  consistent with `createAuth({ db })` in ADR-0020 §10-13.

## Alternatives considered

- **Drive every lifecycle spec through the real Better Auth HTTP surface.**
  Rejected: the "hook runs twice" idempotency case and the injected-emit failure
  case are not expressible through HTTP without a seam, and a library version
  bump would over-couple the specs. `I1`/`I6`/`E1` still prove the wiring.
- **Mock the outbox in the integration specs.** Rejected: the outbox is
  first-party; the specs assert the real persisted rows against a memory
  replica set.
- **Store separate `uaHash`/`ipHash`/`acceptLangHash` on the event.** Rejected
  for the payload; a single salted `deviceHash` is enough for the 24 h decision
  and is the smaller thing to leak.
