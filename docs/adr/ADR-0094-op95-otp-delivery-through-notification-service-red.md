# ADR-0094 — OP-95 RED: OTP delivery through the synchronous NotificationService entry point

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-95 RED (`t_3bd2a7b4`), GREEN card `t_0e8a6a84` (assignee `openpic-webapp-backend-coder`)
- **Depends on:** OP-94 (ADR-0090/ADR-0092 fan-out; operator routing `t_a4ec4d74` put OP-94 §6 `sendTransactionalNow()` here), OP-92 (ADR-0072/ADR-0076 `MessageTransport`), OP-93 (ADR-0085 `resolveChannel` + `renderTemplate`), OP-85 (ADR-0020/ADR-0021 `OtpSender`)
- **Design:** §5 (channel resolution), §8.2 (`MessageTransport`), §19.1/§19.4/§19.5 (types/feed/dispatches) · **Contract:** §0.13 (secret redaction), §7.6 (type catalogue), §7.7 (domain events)

## Context

OP-85 shipped the auth surface with a `memoryOtpSender`: it recorded every code
into the process `otpInbox` and never touched a provider. OP-92 landed the
vendor-neutral `MessageTransport` port; OP-94 landed the **asynchronous** fan-out
(`runNotificationFanOut`) but explicitly scoped out `sendTransactionalNow()`
(ADR-0090/ADR-0092 "Out of scope"). The OP-94 post-merge hygiene card
(`t_a4ec4d74`) routed OP-94 card §6 back here: **OP-95 owns the synchronous
transactional entry point**.

The user story: _as a user signing in, I want my OTP delivered immediately via
email or SMS only, so auth secrets never touch WhatsApp, the in-app feed or
logs._ The synchronous path must therefore differ from the fan-out in three
ways: it sends immediately (no outbox claim/delay), it never renders an in-app
feed row, and its dispatch ledger row must carry metadata only.

This is a RED card: it touches test files only. The module path, export names and
data shapes below are decided here so the GREEN implementer and any later refactor
cannot drift.

## Decision

### Module contract

Per the operator routing note, `sendTransactionalNow()` lives in the **existing**
`@/server/notifications/fan-out` module (not a new file), alongside the pure
helpers. It is the synchronous sibling of `runNotificationFanOut`.

| Module (specifier)               | New exports                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@/server/notifications/fan-out` | `sendTransactionalNow(input): Promise<TransactionalSendResult>`; `resolveOtpTarget(input): OtpTarget`; `buildDispatchRecord(input): DispatchRecord`; types `OtpChannel`, `OtpTargetInput`, `OtpTarget`, `DispatchRecordInput`, `DispatchRecord`, `TransactionalSendInput`, `TransactionalSendResult` |

```ts
type OtpChannel = "email" | "sms";

interface OtpTargetInput {
  channel: OtpChannel;
  typeRow: NotificationType;
  profile: ResolveProfile;
  contacts: ResolveContacts;
}
interface OtpTarget {
  typeKey: string;
  channelGroup: "in_app" | "email" | "mobile";
  channel: "in_app" | "email" | "sms" | "whatsapp";
}
resolveOtpTarget(input: OtpTargetInput): OtpTarget;

interface DispatchRecordInput {
  typeRow: NotificationType;
  userId?: string | null;
  tenantId?: string | null;
  eventId?: string | null;
  channel: ResolvedChannel;
  channelGroup: string;
  contactHash?: string | null;
  dedupeKey?: string | null;
  templateVersion?: number | null;
  rendered?: { subject: string; body: string } | null;
  now: Date;
  expireAt: Date;
}
interface DispatchRecord {
  typeKey: string;
  channel: ResolvedChannel;
  channelGroup: string;
  status: "queued" | "sent" | "failed" | "skipped";
  skipReason: string | null;
  contactHash: string | null;
  dedupeKey: string | null;
  templateVersion: number | null;
  body: string | null; // retained ONLY when typeRow.retainBody
  attempts: number;
  lastError: { retryable: boolean; code: string; status?: number } | null;
  queuedAt: Date;
  sentAt: Date | null;
  failedAt: Date | null;
  expireAt: Date;
}
buildDispatchRecord(input: DispatchRecordInput): DispatchRecord;

interface TransactionalSendInput {
  db?: Db;
  transport: MessageTransport;
  clock?: Clock;
  typeKey: string; // e.g. "auth.otp.email.requested"
  channel: "email" | "sms";
  destination: string; // email address or E.164 phone
  payload: Readonly<Record<string, unknown>>; // template vars, includes `code`
  userId?: string | null;
}
interface TransactionalSendResult {
  dispatchId: string;
  status: "sent";
  providerMessageId: string;
}
sendTransactionalNow(input: TransactionalSendInput): Promise<TransactionalSendResult>;
```

### U1 — channel pinning for the mobile OTP

`resolveOtpTarget` maps a Better Auth OTP channel to the concrete
`(typeKey, channelGroup, channel)`. It **reuses the real `resolveChannel`**
against the seeded type row rather than re-implementing the resolver; a `send`
decision is required and any other decision throws naming the skip reason.

- `auth.otp.email.requested` → `{ channelGroup: "email", channel: "email" }`.
- `auth.otp.mobile.requested` → `{ channelGroup: "mobile", channel: "sms" }`,
  **even when `whatsappCapable === true`** (design §4.1: the mobile OTP type
  pins `mobileCandidates: ["sms"]`; WhatsApp must never carry an auth secret).
  The same holds when capability is unknown (`null`).
- An unverified phone throws `/no_verified_contact/`.

### U2 — the dispatch record builder omits the body for `retainBody: false`

`buildDispatchRecord` is the pure ledger row. The rendered body is stamped onto
`record.body` **only when `typeRow.retainBody === true`**; for every `auth.otp.*`
type (`retainBody: false`, OP-84 seed) `body` is `null`, so the one-time code can
never reach the durable ledger (rule 6, API Contract §0.13).

This is the one place OP-95 adds a field to the §19.5 shape: the synchronous
path's ledger keeps a copy **only** when the type permits it. The fan-out ledger
(ADR-0092 decision 9) still stores no body. The GREEN implementer persists
`body: null` for OTP and must not persist the code under any other key.

### I1–I3 — integration against MongoMemoryReplSet + the real seed catalogue

`createAuth({ db, transport })` accepts an injected `MessageTransport`
(defaulting from config) and wires `notificationOtpSender` (which calls
`sendTransactionalNow`) in place of OP-85's `memoryOtpSender`.

- **I1** — `POST /api/auth/email-otp/send-verification-otp` (`type: "sign-in"`)
  returns `200`; exactly one email message reaches the memory transport and
  contains the captured 6-digit code; exactly one `notification_dispatches` row
  exists for `auth.otp.email.requested` with `channel: "email"`, `status: "sent"`,
  and the code appears **nowhere** in that document (deep string scan); no
  `notifications` feed row is written.
- **I2** — a seeded user with `contactCapabilities.whatsappCapable === true` and
  a verified phone requests an SMS OTP: the transport receives exactly one
  message on `sms` and none on `whatsapp`; the dispatch row is
  `{ channelGroup: "mobile", channel: "sms", status: "sent" }`.
- **I3** — a transport whose `send` rejects with a retryable `TransportError`
  (`status 503`): Better Auth's endpoint surfaces `503`; a single
  `status: "failed"`, `attempts: 1`, `lastError.retryable: true` dispatch row is
  recorded with no code anywhere; `expectNoSecretsInLogs` passes and no captured
  log entry contains a bare 6-digit string.

### E1 — e2e with the real sender + memory transport

`apps/web/e2e/otp-notification-delivery.spec.ts` drives the deployed HTTP
surface: send → read back → sign in. The test-only OTP read route must expose the
transport receipt (`providerMessageId`) alongside the code — it is the only
e2e-observable proof that the code traversed the injected `MessageTransport`
(the OP-85 `memoryOtpSender` minted no provider id and the legacy route returned
only `{ code }`), so the spec is RED until the real sender is wired.

### Assumptions (ambiguities resolved, none silently guessed)

1. **`sendTransactionalNow` lives in `fan-out.ts`.** Per the operator routing
   note on `t_a4ec4d74`; the card's wording ("through NotificationService") names
   the _concept_, the module is the fan-out's.
2. **The OTP templates must render `{{code}}`.** The seeded copy is placeholder
   (`TODO(product)`) and currently declares only `actionUrl`; `renderTemplate`
   rejects an undeclared supplied variable (OP-93 U20), so the GREEN card adds
   `code` to the `auth.otp.*` templates' `variables[]` and body.
3. **Dispatch `body` is conditional.** `retainBody: false` ⇒ `null`. Recorded
   above; the only §19.5 deviation, and it strictly reduces secret retention.
4. **`userId` may be `null`.** An OTP can be requested before an account exists;
   the synchronous row stores the resolved id when present, else `null`.
5. **The sync path resolves the recipient's channel fact only.** Audience
   resolution belongs to the fan-out and is not exercised here.
6. **`resolveOtpTarget` returns `in_app` never** — OTP types have `in_app:
false`, so a `send` on the `in_app` group is unreachable; the type union keeps
   the resolver's vocabulary.

### RED evidence

- `pnpm vitest run --project unit fan-out-transactional` fails with
  `Module '"@/server/notifications/fan-out"' has no exported member 'buildDispatchRecord'`
  (and `'resolveOtpTarget'`) — the exports do not exist yet.
- `pnpm vitest run --project integration notification-otp-delivery` fails on the
  assertions (`expected [ ] to have length 1` for the transport outbox) because
  `createAuth` still uses `memoryOtpSender` and writes no dispatch row.
- `npx tsc -p apps/web/tsconfig.json --noEmit` reports only the expected
  missing-export errors plus the `transport` property not yet on
  `CreateAuthOptions`.
- The e2e spec is outside the Vitest projects; it fails on
  `expect(typeof body.providerMessageId).toBe("string")` until the read route
  exposes the receipt.

## Consequences

- The synchronous OTP path is specified end-to-end: a regression in channel
  pinning, secret retention or transport-failure surfacing fails loudly instead
  of leaking a code into the feed, a log or the ledger.
- The two retention regimes are explicit: the fan-out ledger stores no body; the
  synchronous ledger stores a body only for `retainBody: true` types.
- `createAuth` gains an injectable transport, so the auth surface is testable
  without a live provider and the provider swap stays one adapter file.

## Out of scope (deliberately not tested)

- **Suppressed contact handling** (GREEN card §4: a hard-bounce/DND contact is
  skipped and the caller gets `503 upstream_unavailable` or a validation error).
  OP-95's listed pins do not cover it; the suppression-list read
  (`notificationSuppressions`, hashing the destination) is a separate lane. This
  is a surfaced gap, not an omission.
- Non-OTP transactional types, the `after()` opportunistic trigger and the
  `/internal/cron/notification-fanout` route (OP-94 §1 / OP-87).
- The async fan-out's behaviour (owned by ADR-0090/ADR-0092).

## Alternatives considered

- **A new `notification-service.ts` module.** Rejected at operator routing:
  OP-94 §6 names `sendTransactionalNow()` and it belongs with the fan-out's
  shared helpers, so one module owns both the async and sync paths.
- **Pin the channel only through the seeded type (no `resolveOtpTarget`).**
  Rejected: `resolveChannel`'s OTP pin is already green (OP-93 U17); OP-95 must
  pin the _sender's_ use of it, which is a distinct behaviour.
- **Never store a body for any dispatch.** Rejected: the card explicitly frames
  `retainBody` as the switch; a builder that ignores it would not express the
  contract it is named for.
- **Deliver E1 as a green regression guard.** Rejected: every RED test must fail
  for the right reason; the `providerMessageId` receipt makes it a genuine proof
  that the real transport carried the code.
