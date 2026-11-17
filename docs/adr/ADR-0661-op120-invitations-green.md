# ADR-0661 — OP-120 GREEN: co-organizer invitations (create, list, preview, revoke)

- **Status:** Accepted
- **Date:** 2026-11-11
- **Ticket:** OP-120 (Collaboration epic, phase 3 — Events & Collaboration)
- **Card:** `t_c39cd740` (tdd_stage GREEN, backend-coder)
- **Branch:** `OP-120-task-invitations-green` (worktree
  `/root/openpic/openpic-webapp/.worktrees/t_defedc69`, based on the approved
  RED head `34820a2` of `OP-120-task-invitations-red`, PR #407)
- **Range:** `0660`–`0679` (lane block). This record consumes `0661`, the cell's
  value re-read at the branch head immediately before committing; the cell
  advances to `0662`.
- **Consumes:** [ADR-0660](ADR-0660-op120-invitations-red.md) (the pins) — both
  spec files are carried into this PR **unchanged**.

## Context

ADR-0660 pinned the co-organizer invitation surface: invitee normalization, the
sha256 token hash and its lookup filter, the `coorganizers.per_event` seat count,
`POST`/`GET …/events/{event}/invitations`, the idempotent `DELETE …/{invitationId}`
revoke and the public `GET /invitations/{token}` preview. This record is the
implementation that turns those pins green, and the places where implementing
them settled a question the pins left open.

## Decision

### D1 — One primitive module, one projection module

- `@/server/collaboration/invitations` — the pure decisions the pins name
  (`normalizeInvitee`, `hashInvitationToken`, `generateInvitationToken`,
  `invitationByTokenFilter`, `coOrganizerSeats`). No I/O, so the 29 unit cases
  run without a database.
- `@/server/collaboration/invitation-dto` — the three closed wire shapes
  (nine-key body, `{ data }` list, five-key preview) and the row→body projection.
  `serializeResponse` validates object schemas **strictly**, so a key that should
  not be on the wire fails the response instead of being stripped.
- `@/server/collaboration/invitation-access` — the async reads the four
  projections share: the stored invitee re-normalized, the account email behind
  a `user` invitee, and the membership lookup an `email`/`phone` invitee implies.
- `@/server/collaboration/invitation-delivery` — the synchronous send (D3).

### D2 — The raw token exists in exactly two places

The token is minted per request, hashed with `sha256`, and the **row stores only
`tokenHash`**. The raw value is held in the handler's local scope and
interpolated into the invitation link at dispatch time; there is no
`tokenCiphertext` field. The card offered either shape; minting at dispatch time
was chosen because a ciphertext column is a second long-lived secret with its own
key-rotation and backup-exposure problem, while a value that exists only for the
duration of one request has neither.

The link is rendered through the existing `{{actionUrl}}` template variable, so
no new catalogue machinery was needed for the email copy. The **mobile** group of
`collab.invite.sent` gained an `{{actionUrl}}` body, because the generic mobile
copy carries no link and a phone invitee has no app to open yet
(`notification-templates.values.ts`).

### D3 — Delivery is the synchronous seam, not the outbox (ADR-0660 A9 corrected)

ADR-0660 A9 claimed that "a route that sends synchronously and a route that
defers to the fan-out both pass". **That claim is false for this surface** and is
corrected here: the deferred path resolves recipients from accounts
(`notification-recipients.ts` adds an invitation's audience only via
`invitee.userId`, and `fan-out.ts` fills contacts only from the Better Auth `user`
document), so an **email or phone invitee — the whole point of the story — could
never be addressed**, and the outbox payload must not carry the raw token
anyway. The route therefore sends through `sendTransactionalNow`
(`fan-out.ts`), the seam that stamps `contactHash = sha256(destination)`, retains
the rendered body on the dispatch ledger when the type sets `retainBody` (it
does) and hands the message to the configured transport.

The `collab.invite.sent` domain event is **still emitted** in the same
transaction as the row: it is the in-app/feed fan-out and the audit fact, and its
payload carries the invitation id, event id, role and kind — never the token
(the ADR-0660 I1 outbox scanner passes because of this).

### D4 — A failed send never loses the invitation, and never reaches the log

The invitation is committed before delivery. If the transport fails, the
dispatch row is already `failed` with its classified `lastError`, which is the
architecture's own retry record (`notification-dispatch-retry`, ADR-0120); the
route logs `collab.invite.delivery_failed` with the invitation id, the channel
and the error **class**, and answers `201` — the organizer did create a durable
invitation. No log line anywhere in this path carries the link or the token
(`notification.transactional_sent` logs a truncated `contactHash` prefix only).

`channelsNotified` records the channels the invitee's contact actually earns: an
email invite `["email"]`, a phone invite `["sms"]`, an account invite
`["in_app", "email"]` (or `["in_app"]` when the account has no address), which is
a non-empty subset of the `in_app | email | sms` vocabulary ADR-0660 A6 pins.

### D5 — Refusal precedence and the duplicate guard

Self → member → plan limit (ADR-0660 A11), in that order, so each of the three
refusals is the _true_ one an implementer would otherwise have to guess between.

The duplicate guard is the **database**, not the pre-check: three partial unique
indexes on `{eventId, invitee.<contact>}` filtered on
`{status: "pending", "invitee.<contact>": {$type: "string"}}` make one live
invitation per invitee per event, and a revoked/rejected/expired row drops out of
the index so a re-invite succeeds. The `$type` clause is load-bearing: without it
a partial unique index collects every `pending` row of the other kinds with a
missing contact and rejects the second invite of a _different_ kind.

### D6 — Revoke is idempotent by construction

`updateOne({_id, eventId, status: "pending"}, {$set: {status: "revoked", …}})`:
the first call stamps `revokedAt`/`revokedByUserId`, every later call matches
nothing and re-reads the row, so the audit instant never moves and no second row
is written. Two concurrent revokes agree for the same reason. `collab.invite.revoked`
is emitted with a `dedupeKey`, so a retried `DELETE` cannot produce a second
notification of one decision.

### D7 — List admission is event membership, not workspace membership

ADR-0660's route note said `userAuth()` + `tenantStage()`, but the pin is
stricter than that note: the I9 reader is a co-organizer with **no
`tenantMembers` row**, and `tenantStage()` answers `404` for exactly those
callers. The list therefore reuses the OP-119 pattern
(`resolveEventActorRole`, ADR-0641): authenticated, event-scoped, and readable by
an `organizer` or `co_organizer`. `POST`/`DELETE` keep `tenantStage()` because
the organizer is always a workspace member and the outsider pin (`404`) depends
on it.

### D8 — Registry debts paid

- `COLLABORATION_ERROR_CODES` (`invitation_already_pending` `409`,
  `cannot_invite_self` `422`, `already_member` `409`) appended to the
  client-facing enum with their own `COLLABORATION_ERROR_TRANSPORT` table.
  `ERROR_CATALOG` is untouched — it stays the exact base Appendix A copy that
  `errors.test.ts` pins.
- `INDEX_SPECS`: `{tokenHash: 1}` unique and the three duplicate-live-invite
  partial indexes (§13.6).

## Disputed pin (resolved test-side, card `t_f2e56c5c`)

`apps/web/src/test/integration/event-invitations.test.ts` —
**"I3: refuses an invite over coorganizers.per_event with 403 plan_limit_exceeded"**
reads the one-shot response body **twice**:

```ts
expect(await errorCode(response)).toBe("plan_limit_exceeded"); // body read #1
const parsed = await body(response); // body read #2 → TypeError
```

`errorCode` calls the same `body()` helper the next line calls, and
`Response.json()` consumes the stream, so the second read throws
`TypeError: Body is unusable: Body has already been read` **after** the status
and code assertions have passed. This is a test-authoring defect, not a behavior
gap: the same repository already hit it in OP-115 and fixed the _test_ with the
comment "One body read (the Response body is one-shot)"
(`event-create.test.ts:421-424`). The remaining 25 integration cases and all 29
unit cases pass. Proposed fix: derive the code and the details from that single
parse (`const parsed = await body(response); parsed.error.code …`). No
implementation change can make a one-shot body re-readable, and simulating one
in the shared response type would be test accommodation in production code.

### Resolution (TEST-FIX, one parse)

The Test Author fixed the pin **test-side only**; no implementation line and no
other case in either spec changed. One parse now supplies the code _and_ the
details:

```ts
const parsed = (await body(response)) as {
  error: { code: string; details?: { entitlementKey?: string } };
};
expect(parsed.error.code).toBe("plan_limit_exceeded");
expect(parsed.error.details?.entitlementKey).toBe("coorganizers.per_event");
```

- **Rejected — `errorCode` reading `response.clone()`.** It would leave an
  unread clone at each of the nine other `errorCode` call sites in this file,
  and the OP-115 precedent already uses the single-parse form.
- **Assertion content unchanged:** `403`, `plan_limit_exceeded`,
  `details.entitlementKey === "coorganizers.per_event"`.
- **Evidence.** Before the fix, the focused case threw
  `TypeError: Body is unusable` (`Body has already been read`) at
  `event-invitations.test.ts:740`. After the fix the same command runs
  `Test Files 1 passed (1)` and `Tests 26 passed (26)`;
  `tsc -p apps/web/tsconfig.json --noEmit` exits `0` and `prettier --check` is
  clean. The whole suite at this head: `--project integration`
  `96 passed (96)` / `870 passed (870)` (it was `869 passed | 1 failed`), and
  `--project unit` `145 passed (145)` / `2334 passed | 3 skipped`.
- **The pin stayed load-bearing** (two mutation probes on the route, each
  restored byte-identically, `git diff` empty afterwards): a wrong emitted
  `entitlementKey` fails with
  `expected 'coorganizers.per_seat' to be 'coorganizers.per_event'`; answering
  the same `403` with code `forbidden` fails with
  `expected 'forbidden' to be 'plan_limit_exceeded'` **while the status
  assertion still passes**, so the code assertion is not a proxy for the
  status.
- **Ledger:** no ADR number is consumed (this section amends an existing
  record) and `docs/adr/README.md` is untouched.

## Consequences

- The API surface never returns the token in any form; the four "no raw token"
  scanners (response keys, response values, domain-event payload, rendered
  message) all hold.
- An invitation is durable even when the message is not: the dispatch ledger is
  the retry record, so a transport outage degrades to a late email rather than a
  lost invite.
- The seat count is read, not consumed: `coorganizers.per_event` has `scope:
"event"` and its usage _is_ the set of member rows plus live pending
  invitations, so `checkEntitlement` with `counts` is the whole decision. Two
  simultaneous invites that both fit under the cap can therefore both land; the
  unique index still prevents a duplicate for the _same_ invitee, and the
  sequence is bounded by the organizer's own request rate. A strict
  cross-invitee reservation would need a per-event counter row, which the schema
  does not define for this key.
- `GET /me/invitations`, accept/reject, member removal, the expiry sweeper, the
  reminder cron and the 20/min preview budget stay out of scope, exactly as
  ADR-0660 declared; the preview route is public and unthrottled by this story.

## Alternatives

- **`tokenCiphertext` column** (the card's other option) — rejected: a
  second long-lived secret, with key rotation and backup exposure, for a value
  that only has to survive one request.
- **Outbox delivery plus a contact-bearing audience row** — rejected: it would
  put an address (or the token) into the outbox/recipient graph the never-return
  rules exist to keep clean, and it still cannot address an account-less invitee
  without inventing a recipient kind.
- **Make the response body re-readable to satisfy the disputed pin** — rejected
  as test accommodation (see above).
