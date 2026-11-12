# ADR-0664 — OP-121 GREEN: the invitation decision surface implemented

- **Status:** Accepted
- **Date:** 2026-11-11
- **Ticket:** OP-121 (Collaboration epic, phase 3 — Events & Collaboration)
- **Card:** `t_2b7da57f` (tdd_stage GREEN, implementer)
- **Branch:** `OP-121-task-invitation-decisions-green` (worktree
  `/root/openpic/openpic-webapp/.worktrees/t_108cd476`, based on the pins head
  `5bf8381` of `OP-121-task-invitation-decisions-red`, PR #413)
- **Range:** `0664` (the `OP-120 invitations lane` block `0660`–`0679`; the cell
  advances to `0665`. The sibling `t_b91b009e` landed `0662` on `main` first;
  the union merge of this cell keeps the **highest** value. The RED record was
  later renumbered to `0665`, so the lane cell now reads `0666`)
- **Supersedes nothing.** [ADR-0665](ADR-0665-op121-invitation-decisions-red.md)
  is the pinned contract this record implements.

## Context

[ADR-0665](ADR-0665-op121-invitation-decisions-red.md) pinned the decision
surface promised by contract §2.3: final and idempotent accept/reject across
email, SMS and in-app, never a `409` for a repeated decision, `revoked`/`expired`
structurally unacceptable, and the in-app affordance closing in every channel —
plus organizer member removal. The RED delivered four specs (37 integration
cases, 35 unit cases, one Playwright journey) and no production code; at its head
the honest red was four missing modules.

Two facts from the pins branch shaped the GREEN, and one trunk contradiction had
to be repaired:

- the two unit specs pin **pure, database-free** modules, so the mapper and the
  identity matcher cannot reach the database even indirectly;
- the integration and the e2e journey pin the transition **through the shared
  pipeline** (`defineRoute`, the `user` auth stage, the `tenant` stage, strict
  response serialization), so no route may hand back a key its schema omits;
- the OP-120 revoke wrote `actionTarget.state: "closed"` and `actions: []`, which
  contradicts §2.3 rule 3 — the affordance must become **unavailable**, not
  vanish.

## Decision

### 1. The transition is one conditional write, and the mapper answers the rest

`@/server/collaboration/invitation-decision` holds `decideTerminalOutcome(row,
now)`, a pure mapper: a live `pending` row is `pending` (lost race → re-read,
never `409`), `accepted`/`rejected` is `already_resolved` with the **original**
`resolvedVia` and `resolvedAt` (defaulting to `in_app` and `now` for rows written
before those fields existed), `revoked`/`expired` are the two `410` states, and a
`pending` row whose deadline is `now`, missing or unreadable is `expired` (strict
boundary, fail closed). A status outside §13.6 throws, which the pipeline answers
`500`: corrupt data must not be answered with an invented decision.

`@/server/collaboration/invitation-transition` performs the transition:

- **reject** — one `findOneAndUpdate` filtered on `_id`, `status: "pending"` and
  `expiresAt: { $gt: now }`;
- **accept** — the same conditional update **inside a transaction** with the
  `event_organizers` upsert (`role: "co_organizer"`, `status: "active"`,
  `revokedAt: null`) and the `collab.invite.accepted` emit, so a membership and
  its invitation cannot disagree (§23). The upsert is keyed on `{eventId,
userId}` and ignores the stored `role`, so a row that names `organizer` still
  yields exactly one co-organizer row (I10);
- **loser** — the row is re-read and mapped; a still-live `pending` row is
  retried a bounded three times (a concurrent writer that has not committed yet),
  which is the only arm that is neither a decision nor a `410`. Repeated and
  cross-channel decisions therefore always answer `200`.

`event_organizers.userId` is stored as the **hex string**, not an `ObjectId`: the
admission seam (`resolveEventActorRole`) and the OP-120 create route both read it
that way, and the event detail read (`GET …/events/{eventId}`) is exactly how the
story proves that the co-organizer now belongs.

### 2. One affordance closure, shared by every outcome

`closeInvitationAffordance(db, invitationId, now, via?)` runs
`notifications.updateMany` over `{actionTarget.kind: "invitation",
actionTarget.id}` setting `actions.$[].state = "unavailable"`,
`actionTarget.state = "resolved"` and — for a decision — `actionResolvedVia` /
`actionResolvedAt`. Both the decision routes and the OP-120 revoke call it, so the
feed row reads the same in all three channels. This is the repair of the trunk
contradiction: a revocation is a closure without a channel.

### 3. Authorization is one question asked by both paths

`@/server/collaboration/invitee-identity` holds `matchInvitee(invitee, account)`,
pure and total: `user` ids compare case-insensitively and need no contact proof;
`email` compares trimmed and case-insensitively; `phone` compares on its E.164
digits with only the separators a person types stripped (never a country-code
guess); an email/phone invite is only as verified as the account's matching
contact flag (absent = unverified), and a lazy-linked `userId` matches the
account while still requiring the contact proof (U2-A2).

`@/server/collaboration/invitation-decision-request` names the invitation —
by `{invitationId}` on `/me`, by `sha256(token)` on the link — then reads the
caller's Better Auth `user` document for the contact facts and asks `matchInvitee`
once. A non-invitee is `403 invitation_not_for_you` with `{inviteeMasked}`; a
matching but unverified contact is the shipped `403 account_incomplete`
(ADR-0665 I-A2). An unknown id, an unknown token and a malformed id are the
uniform `404 not_found`.

The token path deliberately has **no** auth stage: it resolves the session
itself, so an unauthenticated visitor gets `401 authentication_required` carrying
`loginUrl` (`/sign-in?next=…` — the token stays in the link, not in the body) and
`inviteePreview` (`emailMasked`, or `phoneMasked` for a phone invite), and the
token is **not** consumed. `?via=sms` records `resolvedVia: "sms"`; the default is
`email`.

### 4. Two shared seams changed, and why they had to

- **`server/http/respond.ts`** — the `401` branch overwrote **any** route-supplied
  `details.loginUrl` with the generic `${origin}/login`. The invitation contract
  requires the specific link (the invitee must return to the same token), so the
  spread order is now `{loginUrl: default, ...details}`: a route that supplies one
  wins, every other `401` is unchanged. No test pinned the generic value.
- **`server/events/access.ts`** — `admitEventActor` read the event id at a fixed
  distance from the path end (`segmentFromEnd: 2`), which is right for
  `…/events/{e}/members` and wrong for `…/events/{e}` itself. It now uses the new
  `eventIdAfterEventsSegment` (the segment after the literal `events`), so the
  event detail read can adopt `tenantStage({admission: admitEventActor})`
  (ADR-0644) without reimplementing tenancy resolution. That admission is what
  makes I8's two halves compatible: the co-organizer reads the event **after**
  accepting and stops reading it **after** removal.

### 5. Member removal revokes the seat structurally

`DELETE …/events/{eventId}/members/{userId}` is organizer-only (`403` for a
co-organizer, uniform `404` for a caller with no relationship), protects the
organizer with `409 cannot_remove_organizer` (`{transferOwnershipUrl}`), and writes
`status: "removed"` **and** `revokedAt` — the admission seam filters on
`revokedAt: null`, so one without the other would leave access open — then revokes
the accepted invitation that granted the seat (`status: "revoked"`), emits
`collab.member.removed` and `collab.member.removed.ack`, and answers `204` with no
body.

### 6. Catalogue appends

Four Appendix A.5 rows are appended to `COLLABORATION_ERROR_CODES` and to their
own transport table (never to the base `ERROR_CATALOG`): `invitation_revoked`
(`410`, `{revokedAt}`), `invitation_expired` (`410`, `{expiredAt}`),
`invitation_not_for_you` (`403`, `{inviteeMasked}`) and `cannot_remove_organizer`
(`409`, `{transferOwnershipUrl}`).

## Consequences

- A double click, a cross-channel click and a retry after a dropped response all
  answer `200` with `alreadyResolved: true` and the channel that actually won;
  the client renders "Already accepted" instead of an error toast.
- `revoked` and `expired` cannot be accepted by construction: the filter can never
  match, and the mapper refuses them — there is no permission check to forget.
- The `event_organizers` upsert means a re-invited and re-accepted member ends up
  with **one** row, not a second active row (the §15.2 partial unique index would
  otherwise refuse the write).
- The bounded retry in `decideInvitation` is the only path that is not a decision
  or a `410`; it exists for a writer that lost the race against a still-uncommitted
  transaction. If it ever exhausts, the answer is a retryable `409 conflict` — for
  a live row, never for a repeated decision.
- `GET …/events/{eventId}` now admits an event actor. A workspace member still
  reads it, a co-organizer with no `tenantMembers` row reads it, and a removed
  co-organizer does not.
- Coverage: the suite stays above the global thresholds (`lines 92.26 %`,
  `branches 80.72 %`, `functions 95.76 %`, `statements 91.99 %`) with no test
  edited.

## Alternatives rejected

- **A `409` for the loser of a race.** §2.3 rule 2 forbids it, and the whole user
  story is that a double click is not an error.
- **Reading the row first and deciding before writing.** Two readers could both
  see `pending`; the conditional write is what makes the decision terminal.
- **Inserting the membership with `insertOne`.** A re-invited member would hit the
  §15.2 partial unique index (or leave two rows), and the accept would fail after
  the invitation had already been resolved. The upsert is idempotent and keeps the
  one-active-row invariant.
- **A second auth stage on the token route.** The contract requires the `401` to
  carry the token-specific `loginUrl` and the masked invitee, and the token must
  not be consumed — a stage that denies before the handler cannot know the row.
- **Marking the revoke's actions `[]` (the trunk behaviour).** It deletes the
  affordance's audit trail and contradicts §2.3 rule 3, which says _unavailable_.

## Evidence

- Focused integration spec `event-invitation-decisions.test.ts`: **37 passed
  (37)**; the two unit specs: **35 passed (35)**; the Playwright journey
  (`collaboration-invitations.spec.ts`, E1): **1 passed** — and the full
  Playwright suite: **27 passed (27)**.
- Full unit project **147 files / 2369 passed | 3 skipped**; full integration
  project **97 files / 907 passed**; `tsc` exit `0`; ESLint `0` problems on the
  touched files; `prettier --check` clean; the ADR-numbering guard green.
- No test, mock, fixture, factory or MSW handler is edited. The diff against the
  pins head is production code, this ADR and the ledger.
