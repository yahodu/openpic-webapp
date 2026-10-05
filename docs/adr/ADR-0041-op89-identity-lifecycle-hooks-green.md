# ADR-0041 — Identity lifecycle hooks GREEN: module contract, profile-precedence read, and account-scope ids (OP-89)

- **Status:** Accepted (GREEN implementation) · **Date:** 2026-10-06
- **Card:** OP-89 `t_eb421b87` (phase 1-Identity, epic Authentication, GREEN) · **Amends:** ADR-0038, ADR-0040 (implements their contract)
- **Contract:** API contract §1.1 (hook table), §1.2 (`GET /me`), §1.5, §6.7, §7.7; schema §13.2, §13.5, §13.6, §19.3; notification design §19.4
- **PR / branch:** `wt/t_eb421b87` (built on the RED pins `OP-89-task-identity-lifecycle-hooks-red`)

## Context

ADR-0038 and ADR-0040 fixed the RED contract for the seven Better Auth
identity-lifecycle hooks. This ADR records the GREEN implementation, the two
places a literal reading of the card was under-specified, and how each was
resolved against the tests.

## Decision

### 1. Modules and the wiring seam

- `@/server/auth/locale` — pure `parseLocale(acceptLanguage, fallback = "en-IN")`.
- `@/server/auth/device-fingerprint` — `NEW_DEVICE_WINDOW_MS`,
  `hashFingerprint(parts, salt)`, `isNewDevice({ fingerprintHash, prior, now, windowMs })`.
- `@/server/auth/identity-hooks` — the six plain-input policy handlers
  (`handleUserCreated`, `handleContactVerified`, `handleSessionCreated`,
  `handleContactChanged`, `handleTwoFactorToggled`, `handleSessionsRevoked`),
  `safeEmit` (logs `identity_hook.emit_failed` and never throws) and the claim
  seam (`identity_hook.claim_failed`).
- `@/server/auth/identity-lifecycle` — `createIdentityDatabaseHooks(wiring)`
  adapting Better Auth's `databaseHooks.user.create.after` and
  `databaseHooks.session.create.after` into the handlers. `createAuth` gained
  the `emit` and `claim` seams and installs the block.

Only the two surface-pinned adapters were wired by this card: **user created**
(pinned by E1) and **session created** (pinned by S7's cookie case). The card's
sections 4–6 were RED-pinned at the **handler** level only; their adapters into
Better Auth's `after` hook were not test-pinned and were deliberately not
invented here (see "Coverage gaps"). The follow-up cards `t_7ce3d03c`
(ADR-0045) and `t_42a91a52` (ADR-0047) have since pinned and wired them.

### 2. Session sightings live in a dedicated `sessionDevices` collection

`handleSessionCreated` compares a salted `deviceHash` against prior sightings to
decide `auth.signin.new_device` (1/device/24h), and the outbox unique index is
the second line of defence via a per-device 24-hour-bucket `dedupeKey`. Better
Auth owns `session` and the schema defines no device-sighting collection, so the
prior sightings are persisted in an app-owned `sessionDevices` collection
(`{ userId, fingerprintHash, createdAt }`), camelCase like the other app-owned
collections the OP-89 contract names (`userProfiles`, `notificationPreferences`,
`contactChangeFanouts`). Raw user-agent/IP never leave the hash.

### 3. Account-scoped events carry `tenantId = userId`

`emitDomainEvent` requires a non-empty `tenantId`, and a brand-new account has
none. Account/auth events (`account.welcome`, `auth.account.completed`,
`auth.signin.new_device`, `auth.admin.signin`, `auth.2fa.*`,
`auth.contact.changed`, `account.sessions.revoked`) therefore use the user id as
the tenant id — a resolvable, non-empty stand-in the specs deliberately do not
assert (ADR-0038 "Assumptions"). The lazy-invite event instead uses the
invitation's real `tenantId`.

### 4. Explicit profiles take precedence over the auto-provisioned default

The user-created hook writes the `userProfiles` defaults, as the contract
requires (and E1 pins). Existing OP-86 fixtures (`auth-guards`,
`admin-two-factor-signin`, `me-ban-exemption`) also insert a profile for the same
user _after_ sign-in, producing two rows for one `userId`. `_id` ordering cannot
break the tie deterministically — the hook's driver and the fixture's insert do
not share an ObjectId generator — so `loadProfile` in `guards.ts` now orders the
match so that an **explicitly managed** profile wins over the **auto-provisioned
default** (the hook's row carries `autoProvisioned: true`; a missing field sorts
before `true` ascending). In production `userProfiles.userId` is unique
(schema §13.2) so there is exactly one row and the rule is inert; it exists to
keep a lazily-created default from ever shadowing a real profile.

### 5. `GET /me` minimal read slice

Per the orchestrator decision, the route returns only the profile-default fields
E1 pins (`locale`, `platformRole`, `status`, `marketingOptIn`,
`accountCompletedAt`, `contactCapabilities`). The full §1.2 projection and
`PATCH /me` remain OP-90's.

### 6. The claim seam defaults to a no-op

§6.7's claim endpoint is out of OP-89 scope (ADR-0040 §5). The seam is injectable
and defaults to a no-op so a sign-in carrying an unclaimed `op_att` cookie is
never blocked; a rejected claim is logged and swallowed.

## Consequences

- Full suite green: 1319 unit, 225 integration, 13 Playwright; `tsc` and ESLint
  clean; coverage global lines 93.4% (threshold 80%).
- A regression that leaks a raw contact into `auth.contact.changed`, drops the
  old-contact fan-out target, emits the wrong 2FA key, double-emits a toggle,
  re-emits `auth.account.completed`, or fails a sign-in on an outbox/claim error
  breaks at least one spec loudly.

## Coverage gaps (requests for the Test Author's next cycle)

- **Surface adapters for sections 4–6.** _Closed by the follow-up cards._ The
  handlers were originally pinned directly; the contact-changed, 2FA-toggle and
  sessions-revoked **endpoint seams** (`createIdentityLifecycleSeams`, ADR-0045)
  and the contact-verified `databaseHooks.user.update.after` adapter are now
  pinned and wired (ADR-0047). What remains open is the **route bodies** that
  call the seam: OP-91 `POST /me/sessions:revoke-all`, the 2FA toggle endpoint
  and the contact-change endpoint — each owns its own card.
- **`_id`/ordering pins.** No spec pins the `sessionDevices` shape or the
  `autoProvisioned` precedence; both are implementation choices this ADR records.
- **2FA transition re-emit.** _Closed by the follow-up pins._ The
  enabled→disabled→enabled re-emit is pinned through the section-5 seam (S10,
  ADR-0045) and satisfies the handler's instant-derived key.
- **`§6.7 POST /me/attendee-sessions:claim` endpoint.** Still out of scope; only
  the session-created hook's non-blocking invocation of the injectable claim
  seam is delivered.

## Alternatives considered

- **Sort duplicate profiles by `_id` descending.** Rejected: the two inserters
  do not share an ObjectId generator, so the order is run-to-run random (observed:
  the same suite alternated pass/fail across runs).
- **Make the hook skip provisioning when a profile already exists.** Rejected:
  the fixture inserts after the hook, so the duplicate is unavoidable this way.
- **Store the raw old/new contact in the `auth.contact.changed` payload.**
  Rejected in ADR-0040 §2 (append-only outbox).
- **Implement the §6.7 claim endpoint here.** Rejected: separate contract
  surface owned by a later card.
