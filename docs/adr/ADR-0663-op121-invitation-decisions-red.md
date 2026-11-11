# ADR-0663 — OP-121 RED: accept/reject across channels and member removal pinned

- **Status:** Accepted
- **Date:** 2026-11-11
- **Ticket:** OP-121 (Collaboration epic, phase 3 — Events & Collaboration)
- **Card:** `t_108cd476` (tdd_stage RED, test-author)
- **Branch:** `OP-121-task-invitation-decisions-red` (worktree
  `/root/openpic/openpic-webapp/.worktrees/t_108cd476`, off `origin/main`
  `3678c57`, the OP-120 squash merge)
- **Range:** `0663` (the `OP-120 invitations lane` block `0660`–`0679`; the cell
  advances to `0664`. `0660`/`0661` are on `main` and `0662` is held by the
  in-flight sibling `t_b91b009e` — `ADR-0662-op120-gap-pins.md` on
  `origin/OP-120-task-invitation-gap-pins-2` — so this record takes the next free
  number in the lane and no number outside the block is touched)
- **Gated GREEN:** `t_2b7da57f` (`openpic-webapp-backend-coder`) — **must base its
  branch on this pins branch**, not bare `origin/main`.

## Context

Contract §2.3 makes the invitation the _single owner of the terminal decision_,
and its four "non-negotiable" rules are the whole of this card:

1. every terminal transition is **one** conditional `findOneAndUpdate` filtered
   on `status: "pending"` **and** `expiresAt: { $gt: now }`;
2. a write that matches nothing reads the row and answers its **current** state
   — `200` for `accepted`/`rejected` (with `alreadyResolved: true` and the
   channel that originally won), `410` for `revoked`/`expired` — and **never
   `409`**;
3. the transition runs `notifications.updateMany` over
   `{"actionTarget.kind": "invitation", "actionTarget.id": inviteId}` setting
   `actions.$[].state = "unavailable"`, `actionTarget.state = "resolved"`,
   `actionResolvedVia`, `actionResolvedAt` — closing the affordance in every
   channel and on every device;
4. `revoked`/`expired` are structurally unacceptable, because the filter can
   never match — there is no permission check to forget.

OP-120 shipped the surface the decisions are taken _on_ (create, list, preview,
revoke, the `tokenHash`-only row, the `coorganizers.per_event` seat), and the
`/api/v1/me/invitations`, `/api/v1/invitations/{token}/accept|reject` and
`…/events/{eventId}/members/{userId}` families do not exist on the trunk at all.

### Three facts measured on the trunk before the pins were written

Each one changed the shape of a pin, so they are recorded rather than assumed:

- **The in-app affordance for a `user`-kind invitee is real and observable.**
  Creating a user invitation and draining the outbox with the cron's own
  composition writes a `notifications` row whose
  `actionTarget` is `{ kind: "invitation", id, state: "open" }` and whose
  `actions` are `[accept (available), reject (available)]`. Measured with a
  throwaway probe spec against `origin/main` `3678c57`, then deleted. This is why
  I11 pins `actions[].state`/`actionResolvedVia` on the **feed** and not a
  private field.
- **An email invitee who signs up later never gets an in-app row.** The OP-89
  lazy-invite hook does link the row (`invitee.userId` is stamped — measured),
  but its re-emit of `collab.invite.sent` is deduped by the create-time
  `collab.invite.sent:<invitationId>` key, so the fan-out never inserts an in-app
  notification for the new account. `GET /me/invitations` — the invitee's own
  pending list, the discovery surface — **does not exist on the trunk** either
  (an OP-120 gap, out of this card's scope). E1 therefore reads the invitation id
  from the **organizer's** list and performs the accept with the invitee's own
  session; the in-app _accept_ is fully pinned, the in-app _discovery_ is not
  pretended to exist.
- **The OP-120 revoke closes the affordance the wrong way.** It writes
  `actionTarget.state: "closed"` and `actions: []`, while §2.3 says a revocation
  "marks the invitee's in-app actions `unavailable`". The I11 revocation pin
  fails on `origin/main` for exactly that reason — a real behavioural RED, not a
  missing module.

## Decision

### Unit contract (U1, U2)

- **`@/server/collaboration/invitation-decision`** (new)
  - `decideTerminalOutcome(row, now): TerminalOutcome`, where
    `TerminalOutcome` is
    `{ kind: "pending" }` (a live pending row — the writer lost a race, re-read,
    never `409`) |
    `{ kind: "already_resolved", status: "accepted"|"rejected", resolvedVia, resolvedAt }` |
    `{ kind: "revoked", revokedAt: Date|null }` |
    `{ kind: "expired", expiredAt: Date|null }`.
  - Pure: the store and the instant are arguments, so the email path, the SMS
    path and the in-app path share one answer to "what does a second click mean".
- **`@/server/collaboration/invitee-identity`** (new)
  - `matchInvitee(invitee, account): { matched: false } | { matched: true, contactVerified }`.
  - `user` ids match case-insensitively; emails match case-insensitively and
    trim; phones match on E.164 digits after stripping the separators a person
    types; a national-format number is never guessed into E.164. `contactVerified`
    is what turns `matchInvitee` into the I9 refusal.

### Route contract (I1–I11, E1)

- `me/invitations/[invitationId]/accept|reject/route.ts` → `POST`, `userAuth()`.
- `invitations/[token]/accept|reject/route.ts` → `POST`, **public** route that
  reads the session itself (no `401` stage) because §2.3 needs
  `401 authentication_required` **with** `details.loginUrl` and
  `details.inviteePreview.emailMasked` and the token **not** consumed.
- `tenants/[tenantId]/events/[eventId]/members/[userId]/route.ts` → `DELETE`,
  organizer only (I-A4: `204`, empty body).
- Every decision answers the §2.3 body `{ id, status, resolvedAt, resolvedVia,
alreadyResolved }` plus `membership: { eventId, role: "co_organizer" }` and
  `redirectUrl` on an accept, and **nothing else** (a closed key set, so a
  decision body cannot leak a contact, a token, a userId or a tenant).
- `resolvedVia` is `"in_app"` on the `/me` path, `"email"` on the token path and
  `"sms"` with `?via=sms`.
- Accept inserts the `event_organizers` row (`role: "co_organizer"`,
  `status: "active"`, `revokedAt: null`) in the same transaction as the
  transition and emits `collab.invite.accepted` **once per invitation**; reject
  inserts nothing and emits `collab.invite.rejected`.
- Removal sets `status: "removed"` **and** `revokedAt` (the admission seam
  filters on `revokedAt: null`; one without the other leaves access open) and
  revokes the originating invitation, so a re-accept is `410 invitation_revoked`.

### Production changes this card needs beyond its six GREEN sections

- **The event detail read must admit an event actor.** `GET
…/events/{eventId}` runs plain `tenantStage()`, which denies a caller without a
  `tenantMembers` row; a co-organizer normally has none (§4.3). Without the
  `admitEventActor` seam (ADR-0644, already used by the member list and the
  invitation list) neither E1's "GET event succeeds as co_organizer" nor I8's
  "access lost after removal" can mean anything — the removed member would be
  refused _before_ the removal too. Pinned as a positive control
  (`a co-organizer reads the event after accepting` → `200`) plus the negative
  one (`a removed co-organizer can no longer read the event` → `404`).
- **The revoke route must mark the in-app actions unavailable** (§2.3) instead of
  emptying `actions`.
- **Four catalogue appends** (Appendix A.5 rows the executable catalogue lacks):
  `invitation_revoked` (`410`), `invitation_expired` (`410`),
  `invitation_not_for_you` (`403`), `cannot_remove_organizer` (`409`).

### Assumptions (each is pinned by a named case, so a disagreement fails loudly)

- **U1-A1** — an `accepted`/`rejected` row without `resolvedVia` reads as
  `"in_app"`; a channel the mapper does not know is echoed, never coerced.
- **U1-A2** — a resolved row without `resolvedAt` reads as the asked `now`, so a
  replay body always renders an instant.
- **U1-A3** — the expiry boundary is strict (`expiresAt > now`): a row whose
  deadline **is** `now` reads as `expired`.
- **U1-A4** — a `pending` row whose `expiresAt` is missing or unreadable is
  `expired` (fail closed).
- **U1-A5** — a status outside the five §13.6 values is corrupt data: the mapper
  throws and the route answers `500`, rather than inventing a decision.
- **U2-A1** — a `user`-kind invitation is `contactVerified: true` by definition
  (it names an account, not a contact).
- **U2-A2** — an email/phone invitation that also carries the lazy-invite
  `invitee.userId` matches that account **or** the contact, but the verification
  requirement follows the contact.
- **U2-A3** — a missing `emailVerified`/`phoneNumberVerified` flag is
  **unverified**.
- **U2-A4** — only the separators a person types are stripped; a number without
  a leading `+` is not guessed into E.164.
- **I-A1** — a non-invitee presenting a known invitation id on the `/me` path is
  `403 invitation_not_for_you` (the same refusal the token path documents); an
  id naming no row is the uniform `404`. The card fixes only "a wrong user ->
  403".
- **I-A2** — an unverified matching contact is `403 account_incomplete`, the
  **shipped** auth-guard code ("Your account setup is incomplete"). Appendix A.5
  has no code for it, so this ADR reuses the existing `403` rather than appending
  a near-synonym.
- **I-A3** — the event detail read admits an event actor (see above).
- **I-A4** — `DELETE …/members/{userId}` answers `204` with an empty body,
  mirroring the tenant-member removal (§2.2); §2.3 names no status.
- **I-A5** — the §7.3 notification-action route
  (`POST /me/notifications/{id}/actions/{actionKey}`) does not exist on the trunk
  and is not part of this card's surface, so "the in-app action returns 410" is
  pinned on `POST /me/invitations/{id}/accept`, the endpoint that owns the
  transition (I-A5 is the one place this card reads the card's wording).
- **E1-A1** — the e2e learns the invitation id from the organizer's list (see
  Context: the invitee's own discovery surface is an OP-120 gap).

### Deliberately out of scope

`GET /me/invitations` (OP-120 gap), the hourly expiry sweeper, `collab.invite.expired`
emission, the invitation reminder cron, the §7.3 action-delegation route, the
20/min rate limits of the decision paths, and the email/SMS copy of
`collab.invite.accepted|rejected|member.removed` (the feed/outbox facts are
pinned; the rendered copy is not).

## Consequences

- **Evidence with throwaway stubs** at the exact intended paths (deleted before
  handoff; `git status` shows the four test files only):
  `npx tsc -p apps/web/tsconfig.json --noEmit` exits `0`, unit runs
  `25 failed | 10 passed (35)` and integration `37 failed (37)`, every case
  assertion-level — `expected 500 to be 200` (×20), `… to be 410` (×4), `… to be
403` (×4), `… to be 404` (×3), `… to be 401` (×3), `… to be 409`, and
  `expected [500, 500] to deeply equal [200, 200]` for the concurrency pin.
- **The single non-stub RED is the revocation affordance**:
  `expected [] to deeply equal [ [ 'accept', 'unavailable' ], [ 'reject',
'unavailable' ] ]` — the measured OP-120 revoke behaviour, not a missing
  module.
- **The ten unit cases that pass against the stubs are not vacuous**: they pin
  the refusals (`different id`, `different domain`, `no email`, `national-format
phone`, `unknown kind`, `missing contact`) and the "no invitee contact at all"
  arms, which the stub satisfies because it answers `{ matched: false }` for
  every input. Each fails under a plausible wrong matcher (a case-sensitive
  compare, a suffix/substring email match, a country-code guess, a throw on an
  unsupported kind).
- **At handoff the suite is red as four missing modules** (the OP-93/ADR-0306
  posture), which is the honest RED for a new surface: `vitest --project unit`
  on the two new specs reports `Cannot find package
'@/server/collaboration/invitation-decision'` and
  `'@/server/collaboration/invitee-identity'`; the full unit project is
  otherwise untouched (`145 passed (147)` files, `2334 passed | 3 skipped`
  tests — the two new files are the only failures).
- **The e2e spec is RED-by-design** in the OP-93 sense: `next build`
  typechecks the project, so a branch that imports a missing module cannot
  produce the standalone server the `api` project runs (ADR-0306). It was
  `--list`ed to prove it compiles into the config, and it executes in the
  GREEN's PR.
- **Hotspot:** `docs/adr/README.md` — this lane's hunk is one cell (`0663` →
  `0664`) and one appended prose note; the in-flight sibling
  `OP-120-task-invitation-gap-pins-2` holds `0662` and the same cell, and the
  union merge must keep the **highest** value (`0664`).
