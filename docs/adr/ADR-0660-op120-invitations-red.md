# ADR-0660 — OP-120 RED: co-organizer invitations pinned (create, list, preview, revoke)

- **Status:** Accepted
- **Date:** 2026-11-11
- **Ticket:** OP-120 (Collaboration epic, phase 3 — Events & Collaboration)
- **Card:** `t_defedc69` (tdd_stage RED, test-author)
- **Branch:** `OP-120-task-invitations-red` (worktree
  `/root/openpic/openpic-webapp/.worktrees/t_defedc69`, off `origin/main`
  `eab1291`, the `1.50.0` release)
- **Range:** `0660`–`0679` (drawn as this lane's first card from the allocator
  pool; the pool advances to `0680`+, no number outside the block is touched)
- **Gated GREEN:** `t_c39cd740` (`openpic-webapp-backend-coder`) — consumes
  `0661` next and **must base its branch on this pins branch**.

## Context

Contract §2.3 specifies the invitation surface and schema §13.6 the row. The
card's user story is "invite a co-organizer by user, email or phone so they can
help upload, **even before they have an account**". Nothing of the surface
exists on the trunk: `apps/web/src/server/collaboration/` is absent, all four
route folders are new, `COLLECTIONS.invitations` exists only as a name (with a
TTL index and the `me/invitations` compound index, but **not** the
`tokenHash` unique index or the duplicate-live-invite partial index), and no
`collab.invite.*` template carries a link today.

Two pieces of the trunk already commit this lane to a shape, and the RED is
written against them rather than inventing a parallel design:

- `@/server/auth/identity-hooks` already reads `invitations` for the lazy-invite
  hook (`{ status: "pending", $or: [{ "invitee.email": email },
{ "invitee.phoneE164": phone }] }`) and re-emits `collab.invite.sent` with
  `subjectRef { kind: "invitation", id }`, payload `{ inviteId, role, kind,
eventId }` and `dedupeKey collab.invite.sent:<id>`. It compares the stored
  contact **exactly**, which is why invitee normalization is a contract (U1).
- `@/server/domain/domain-events` rejects a payload nesting a `token`/`email`/
  `phone` **key** and `@openpic/contracts`' never-return scanner already forbids
  `tokenHash` on the wire, so both halves of "the raw token never leaves the
  server" have an existing enforcement point to lean on.

This RED delivers **test files only** — one unit spec and one integration spec
— plus this ADR and the README ledger rows. No production file is touched.

## Decision

### Module and route contract

- **`@/server/collaboration/invitations`** (new; unit-pinned)
  - `normalizeInvitee(input): NormalizeInviteeResult` — returns a discriminated
    **result**, not a throw, so the route can name the offending field in
    `details.fields[]`. `field` ∈ `invitee` | `invitee.kind` |
    `invitee.userId` | `invitee.email` | `invitee.phoneE164`; `code` ∈
    `unknown_kind` | `missing_contact` | `invalid_user_id` | `invalid_email` |
    `invalid_phone`.
  - `hashInvitationToken(rawToken): string` — `sha256` lowercase hex.
  - `generateInvitationToken(): string` — 32 random bytes, unpadded base64url
    (43 chars).
  - `invitationByTokenFilter(rawToken): { tokenHash: string }` — the preview's
    lookup, so the raw token is never a query value.
  - `coOrganizerSeats({ members, invitations, now }): number` — the
    `coorganizers.per_event` usage.
- **Routes**
  - `…/tenants/[tenantId]/events/[eventId]/invitations/route.ts` → `POST`
    (`userAuth()` + `tenantStage()` + a **required** idempotency stage — a
    create with no `Idempotency-Key` answers `400 idempotency_key_required` and
    writes nothing) and `GET` (event member).
  - `…/tenants/[tenantId]/events/[eventId]/invitations/[invitationId]/route.ts`
    → `DELETE` (organizer).
  - `…/invitations/[token]/route.ts` → `GET`, **public** (no auth stage), 20/min
    per IP (§2.3).
- **Wire shapes**: the `201` body is exactly §2.3's nine keys (`id`, `kind`,
  `eventId`, `role`, `status`, `inviteeMasked`, `channelsNotified`,
  `expiresAt`, `createdAt`); the preview is exactly five (`status`, `eventName`,
  `inviterDisplayName`, `expiresAt`, `inviteeMasked`); the list is `{ data }`
  sorted `createdAt` desc.
- **Registry debts the GREEN owes**: `INDEX_SPECS` entries for
  `{tokenHash: 1}` unique and the duplicate-live-invite partial indexes
  (§13.6), `cannot_invite_self` (`422`) and `already_member` (`409`) appended to
  the executable error catalogue in the `cannot_demote_owner` append-only shape
  (Appendix A.5 carries `invitation_already_pending` but the catalogue lacks it
  too), a `collab.invite.sent` template whose copy carries the link, and the
  invitation read/render path the delivery pin needs.

### Assumptions (each is pinned by a named case, so a disagreement fails loudly)

- **A1** — normalization is total: trim + lowercase email; strip spaces, dashes,
  dots and parentheses from a phone but require a leading `+` (a number without
  one is refused, not guessed); lowercase a 24-hex user id.
- **A2** — a normalized invitee carries **exactly** `kind` plus that kind's one
  contact key, so the lazy-invite `$or` can never match two accounts.
- **A3** — `coOrganizerSeats` counts **every** active event member (the
  organizer row included) plus live pending invitations. §2.3 says
  `eventMembers(active) + invitations(pending)` and the organizer is an
  `event_organizers` row; this is the literal reading.
- **A4** — a `pending` invite whose `expiresAt` has passed does **not** hold a
  seat, even before the hourly sweeper flips it (otherwise a lapsing invite
  blocks the next one for up to an hour).
- **A5** — `kind: "event_co_organizer"`, `role: "co_organizer"` (the §2.3
  example).
- **A6** — `channelsNotified` is a non-empty subset of
  `["in_app", "email", "sms"]`; which channels an invitee earns is a contact
  decision, so only the vocabulary is pinned.
- **A7** — `expiresAt` is a future ISO instant within 60 days. §13.6 says
  "Default 14 days" but no `platformSettings` field carries it, so the exact
  default is unpinned.
- **A8** — the five preview key names are this ADR's choice; §2.3 names the
  facts, not the fields.
- **A9** — delivery is pinned by **outcome**, not mechanism: a
  `collab.invite.sent` dispatch row exists whose rendered copy contains a token
  whose `sha256` is the stored `tokenHash`, and whose `contactHash` is
  `sha256(invitee email)`. The spec settles delivery by draining the outbox with
  the **production** wiring (`runNotificationFanOut({ transport:
getNotificationTransport(), recipients: mongoRecipientRepository(db) })`, the
  cron route's own composition), so a route that sends synchronously and a route
  that defers to the fan-out both pass.
- **A10** — the list is `{ data }`, newest first.
- **A11** — refusal precedence is **self → member → plan limit**:
  `422 cannot_invite_self` before `409 already_member` before
  `403 plan_limit_exceeded`. The card names the three outcomes without an order;
  without a fixed order an organizer inviting themselves could be failed for
  answering the "wrong" true thing.

### Deliberately out of scope

`GET /me/invitations`, accept/reject (both paths), member removal, the expiry
sweeper, the reminder cron and the 20/min preview rate limit belong to OP-121 or
to no card. They are not pinned here.

## Consequences

- The GREEN inherits a type-correct RED: with throwaway stubs at the exact
  intended paths, `npx tsc -p apps/web/tsconfig.json --noEmit` exits `0` and
  every case fails at assertion level (unit `24 failed | 5 passed (29)`;
  integration `26 failed (26)`, each an assertion diff of the shape
  `expected 500 to be 201`, `expected 500 to be 404` or
  `expected 500 to be 400`). The stubs were deleted before handoff;
  `git status` shows the one edited spec file only.
- **The five unit cases that pass against the stub are not vacuous**: they pin
  the sha256 equality, the determinism and "the hash never contains the token",
  the 43-character base64url width, the `unknown_kind` refusal and the
  by-hash lookup filter — each fails under a plausible wrong implementation
  (salted or upper-case digest, the token echoed as its own hash, a hex or
  padded identifier, a permissive kind switch, a filter keyed on the raw
  token), and the stub satisfies them by construction (it returns
  `sha256Hex`, a fixed 43-character token, `unknown_kind` for every input and
  `{ tokenHash: sha256Hex(raw) }`).
- The lane owes the README pool cell move to `0680`+ and the two catalogue
  error codes; both are flagged above rather than silently assumed.
- **Hotspot:** `docs/adr/README.md` is the contended file in this repo; this
  lane's hunk is one table row, one cell and one prose note.
