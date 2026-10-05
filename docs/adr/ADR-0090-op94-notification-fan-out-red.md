# ADR-0090 — OP-94 RED: notification fan-out consumer contract (outbox → feed + dispatches)

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-94 RED (`t_ccfe8295`) · **Depends on:** OP-88 (ADR-0029 outbox), OP-92 (ADR-0076 `MessageTransport`), OP-93 (ADR-0085 `resolveChannel` + `renderTemplate`)
- **Design:** §2 (audiences), §5 (channel resolution), §6 (throttle/digest/aggregation), §7 (cross-channel idempotency), §19.3–§19.6 (preferences, feed, dispatches, digests/suppressions), §18.3 (`domainEvents`) · **Contract:** §7.7 (domain event contract), §19.5 (`SkipReason`), Appendix F Phase 1 ("notification fan-out worker")
- **GREEN card:** `t_d8f1e9e5` (assignee `openpic-webapp-backend-coder`)

## Context

OP-88 landed the transactional outbox: one `domainEvents` row per domain change,
each consumer owning a `dispatch.*` flag. OP-92 landed the vendor-neutral
`MessageTransport` port and the Novu adapter. OP-93 landed the pure
`resolveChannel` decision and the strict `renderTemplate`.

OP-94 is the missing join: the `notifications` consumer that **claims** pending
outbox rows, resolves recipients at send time, runs `resolveChannel` per
(recipient × group), writes the in-app feed row and the `notificationDispatches`
ledger (including every skip), and hands rendered messages to the injected
transport — exactly once, isolating a per-recipient provider failure.

The RED card pins the behaviours (`U1`–`U3`, `I1`–`I8` plus the actor-exclusion
pin `I2b`) but not the module path,
export names, the recipient-port shape, the dedupe-key composition or the feed
aggregation filter. Those are decided here so the GREEN implementer and any
later refactor cannot drift.

## Decision

### Module contract

| Module (specifier)                     | Exports                                                                                                                                                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@/server/notifications/fan-out` (new) | `runNotificationFanOut(options): Promise<FanOutSummary>`; `resolveRecipients(input): Promise<readonly string[]>`; `interpolateDedupeKey(template, vars): string \| null`; types `RecipientRepository`, `ResolveRecipientsInput`, `FanOutRunOptions`, `FanOutSummary` |

```ts
interface RecipientRepository {
  listEventRoleMembers(input: {
    tenantId: string;
    eventId: string;
    roles: readonly ("organizer" | "co_organizer")[];
  }): Promise<readonly string[]>;
  listIdentifiedAttendeeUserIds(input: {
    tenantId: string;
    eventId: string;
  }): Promise<readonly string[]>;
  getBillingContactUserId(input: { tenantId: string }): Promise<string | null>;
  listPlatformAdminUserIds(): Promise<readonly string[]>;
}

interface ResolveRecipientsInput {
  typeRow: NotificationType;
  tenantId: string;
  eventId: string | null;
  actorUserId: string | null;
  subjectUserId: string | null;
  repository: RecipientRepository;
}

interface FanOutRunOptions {
  db?: Db; // defaults to the shared client
  clock?: Clock; // defaults to systemClock
  transport: MessageTransport;
  recipients: RecipientRepository;
  batch?: number;
  claimerId?: string;
}
```

### Recipient resolution (U1, U2)

Audience → source is fixed (design §2 "audience is derived at send time, never
stored"):

| Audience              | Source                                         |
| --------------------- | ---------------------------------------------- |
| `organizer`           | `listEventRoleMembers(roles=["organizer"])`    |
| `co_organizer`        | `listEventRoleMembers(roles=["co_organizer"])` |
| `attendee_identified` | `listIdentifiedAttendeeUserIds`                |
| `billing_contact`     | `getBillingContactUserId`                      |
| `platform_admin`      | `listPlatformAdminUserIds`                     |
| `attendee_anonymous`  | nobody (design §2: "deliberately unreachable") |

- `organizer`/`co_organizer` share **one** `listEventRoleMembers` call; the
  `roles` array is the canonical `["organizer", "co_organizer"]` filtered by the
  type's declared audiences.
- Event-scoped audiences (`organizer`, `co_organizer`, `attendee_identified`)
  contribute nothing when `eventId` is null and their repository method is not
  called.
- `subjectUserId` is always a recipient (the notification is about them); the
  `actorUserId` is then removed (design §4.5/§4.6 "minus the actor"). The result
  is deduped, first-seen order preserved.
- `billing_contact` resolves through `getBillingContactUserId` **only**; I7 pins
  that `listEventRoleMembers` is _not_ called for a billing type, so a
  co-organizer cannot be pulled into a `billing.payment.failed` audience.

**Deriving `actorUserId` / `subjectUserId` from a stored event.** `resolveRecipients`
takes the two ids, not the refs, so the fan-out must map the `domainEvents` row
itself: `actorUserId = actorRef.kind === "user" ? actorRef.id : null` and
`subjectUserId = subjectRef.kind === "user" ? subjectRef.id : null`. Any other ref
kind (`system`, `invitation`, `event`, `subscription`, …) yields `null` for that
side. I2 and I5 therefore set the actor to a **non-recipient** peer, so they
exercise the opt-out skip and the failure isolation independently of actor
exclusion; I2b additionally pins that an actor who _is_ in the resolved audience
is still dropped (no feed row, no dispatch).

**Why a repository port.** The membership data layer (`eventMembers` /
`event_organizers`, accepted co-organizer `invitations`, `attendeeEventProfiles`
subject.userId) is not built out yet, and the design's §13.4/§15.2 collections do
not all exist in `COLLECTIONS`. A port keeps `resolveRecipients` unit-testable
with zero Mongo (U1) while the GREEN card owns the real reads. The integration
lane stubs the port with a deterministic source and exercises the **Mongo** side
of the fan-out (outbox claim, feed upsert, dispatch ledger, transport).

**The invitation invitee.** `collab.invite.sent`'s audience is `co_organizer`
and the recipient is the invitee. The GREEN card lists "invitee" as a separate
source; this lane does not pin that read (it resolves through the injected port),
so the implementation may resolve the invitee from the invitation subject and
return it from `listEventRoleMembers`, or add an explicit source — the RED tests
only require the injected port to supply them.

### Dedupe key (U3)

`interpolateDedupeKey(template, vars)` expands `{name}` placeholders from a type's
`dedupe.keyTemplate` (e.g. `"{typeKey}:{profileId}"`); `null` template yields
`null`; a template referencing an unsupplied variable **throws** naming the
variable. It is a pure string function.

**Channel suffix decision.** Design §19.5 describes the index as a unique
`{dedupeKey}`; the index actually implemented in `indexes.ts`
(`dispatches_tenant_dedupe_unique`) is `{tenantId, dedupeKey}` partial on a string
`dedupeKey` — per tenant, not per channel. A single interpolated key shared by the
`email` and `sms` dispatches of `attendee.matches.ready` would make the second
channel collide with the first. The fan-out therefore composes the stored `dispatch.dedupeKey` as `` `${interpolateDedupeKey(typeRow.dedupe.keyTemplate, vars)}:${channel}` ``.
U3 pins the pure interpolation; I8 pins the channel-correct outcome (two batches
→ exactly one SMS sent, the second skipped `deduped`). **This is the author's
resolution of an ambiguity in §19.5** and is recorded here as an assumption.

### Fan-out behaviour (I1–I8)

Per claimed event (GREEN card §2–§5):

1. Type lookup by `eventKey`; absent/disabled → the event is consumed with no
   recipients.
2. `resolveRecipients` (port) — actor excluded, deduped.
3. For each recipient, load contacts (`user`), profile (`userProfiles`) and
   preferences (`notificationPreferences`); run `resolveChannel` per **enabled**
   group.
4. `in_app` → upsert/insert a pre-rendered feed row (`title`/`body` at write
   time); actionable types get `actions[].state: "available"` and an
   `actionTarget`; `groupKey` types upsert with **`readAt: null` in the filter**
   (`$inc groupCount`, `$set updatedAt`) so a read row is never resurrected
   (design §6, I3). `in_app` writes **no** dispatch row (GREEN acceptance
   criterion).
5. External channels → insert a `notificationDispatches` row with the composed
   `dedupeKey`, `contactHash`, `templateVersion`, `channelGroup` + resolved
   `channel`; render via `renderTemplate`; call `transport.send`; update
   `sent`/`failed` with `attempts`/`lastError`. A duplicate `dedupeKey` (unique
   index) becomes a `skipped`/`deduped` row and is **not sent** (I4, I8).
6. Every skip (opt-out, no verified contact, suppression, throttled, deduped)
   is persisted with `skipReason` (design §5).
7. Per-recipient failures are isolated; a retryable failure leaves the event
   claimable (`markFailed`), so `dispatch.notifications` stays `"pending"`
   (I5). A clean run marks it `"done"` (I1).

### Assumptions (ambiguities resolved, none silently guessed)

1. **`in_app` is never digested.** `resolveChannel` returns `{kind:"digest"}` for
   _every_ group of a digest-throttled type (OP-93), but design §6 says
   "in-app aggregation is separate from digesting". The fan-out consumes the
   digest decision for `in_app` as **upsert the feed row**, not as a skip; only
   outbound channels accumulate a `notificationDigests` bucket. I3 pins this.
2. **Channel-suffixed dispatch `dedupeKey`** (see above) — required by the
   schema's per-tenant (not per-channel) unique index; I8 pins it.
3. **`in_app` rows carry no `dedupeKey`**; dedupe is an outbound concern.
4. **Quiet hours are off in the seeded preferences** so the injected fixed clock
   cannot defer a send; quiet-hours deferral itself is OP-93's contract.
5. **Template variables are filtered to the template's declared `variables[]`**
   before `renderTemplate`, because `renderTemplate` throws on an undeclared
   supplied value. The fan-out supplies a superset source (`actionUrl`, `count`,
   `eventName`, …) and passes only what each template declares. I1 (in-app/mobile
   templates declare no variables while the email template declares `actionUrl`)
   pins this.
6. **`retainBody: false`** (OTP) means the rendered copy is **never persisted**
   on the dispatch; I6 supplies a sentinel that appears in the sent message but
   must not appear in the stored dispatch (field-name-agnostic).
7. **Recipient role/spread** is stubbed in the integration lane via
   `RecipientRepository`; the real membership reads are the GREEN card's.

### RED evidence

- `pnpm vitest run --project unit fan-out` → `Cannot find package
'@/server/notifications/fan-out'` (module does not exist yet).
- `pnpm vitest run --project integration notification-fan-out` → the same
  module-not-found error; the MongoMemoryReplSet global setup boots cleanly.
- `npx tsc -p apps/web/tsconfig.json --noEmit` reports **only** the two expected
  `TS2307` module-not-found errors for `@/server/notifications/fan-out` — the two
  spec files are otherwise type-correct (no unrelated errors).

Base tree: the OP-93 GREEN branch `OP-93-task-channel-resolution-and-template-renderer-green`
(`origin/main` already merged, `resolve-channel`/`render-template` present), on
the worktree branch `OP-94-task-notification-fan-out-red`.

## Review round 2 — fixture corrections (same card)

Review round 1 (PR #188) requested changes; all were test-side/ADR-wording and
none changed the contract. Corrections applied in place (no new ADR row, to keep
the `docs/adr/README.md` hotspot untouched):

1. **I2 / I5 actor collision (blocking).** Both fixtures set `actorRef.id` to a
   member of the resolved recipient set, which U2 excludes, making their asserted
   deliveries unsatisfiable. The actor is now a distinct non-recipient peer
   (`editor`), so I2 measures the opt-out skip and I5 the per-recipient failure
   isolation. The `actorRef`/`subjectRef` → `actorUserId`/`subjectUserId`
   derivation is stated above (the root-cause contract gap).
2. **New pin I2b.** An event whose audience explicitly contains the actor is
   dropped for the actor (no feed row, no dispatch) and delivered to the peer —
   the wiring-level proof that was missing.
3. **I7 strengthened.** The co-organizer/billing claim was structural; I7 now
   also asserts `listEventRoleMembers` is **not** called for a
   `billing_contact`-only type, making it a behavioural pin.
4. **§19.5 citation** corrected (design text says unique `{dedupeKey}`; the
   implemented index is `{tenantId, dedupeKey}`).

## Consequences

- The outbox→feed→dispatch path is specified end-to-end; a regression in
  audience routing, aggregation, dedupe, secret retention or failure isolation
  fails the suite loudly instead of reaching a provider or the feed.
- Dedupe is pinned at the **database** boundary (the unique index), matching the
  acceptance criterion "dedupe via the unique index only".
- The `RecipientRepository` port keeps U1/U2 offline-testable; the integration
  lane proves the Mongo and transport wiring with the real seed catalogue.
- One design tension is surfaced rather than hidden: `resolveChannel`'s
  group-agnostic digest decision vs. in-app aggregation (assumption 1). The GREEN
  implementer must handle `in_app` separately; I3 fails if they do not.

## Out of scope (deliberately not tested)

- The `/internal/cron/notification-fanout` route, the `after()` opportunistic
  trigger and `sendTransactionalNow()` (OP-95 synchronous OTP) — GREEN card
  §1/§6. No Playwright e2e (the card's `e2e_api_playwright` is empty).
- Digest-bucket flush cron, quiet-hours release cron, suppression-list CRUD and
  the deliverability-forensics routes.
- The real membership/contact data layer behind `RecipientRepository`
  (`eventMembers`, accepted `invitations`, `attendeeEventProfiles`).
- `contact.changed`'s old+new contact fan-out (a special recipient set; the
  GREEN card owns it and this lane's port can supply it).

## Alternatives considered

- **Fan-out reads memberships/contacts directly (no port).** Rejected: the
  membership data layer does not exist yet, so the spec could not run at all;
  and the card explicitly says "recipient resolution per audience (with injected
  repos)".
- **Dedupe key without the channel suffix.** Rejected: the schema's unique index
  is per tenant, so `email` and `sms` of the same type+subject would collide and
  the second channel would never send.
- **Pre-check the dedupe key with `findOne` before insert.** Rejected: the
  acceptance criterion says "dedupe via the unique index only"; the spec asserts
  the outcome (one sent, one `deduped` row), not the mechanism.
- **Mark the event `done` despite a retryable failure.** Rejected: at-least-once
  delivery requires the failed event to be reclaimable; I5 pins `pending`.
- **Render the feed row on read.** Rejected by design §19.4 ("render at write
  time") and pinned by I1 storing a `title`/`body`.
