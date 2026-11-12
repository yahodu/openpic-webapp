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

## Round-1 land review sign-off (2026-11-12)

**What landed, and at which bytes.** PR #415 squash-merged to `main` as
`93e43184817c6b771b8ce1822d48862c6b511ee0`; the reviewed head was
`780a62fc5abc7945f365efa0eda4b4f8cf7bce17`. The squash tree OID and the reviewed
head tree OID are the same object, `97421365818a9582464cc4b1045ec8aace40b5ad`, so the
merged bytes are the reviewed bytes: nothing was amended, rebased or repaired between
the review and the merge.

**The renumber.** This lane's RED record was written under `ADR-0663`, but OP-120's
delivery-failure log pin landed that number on `main` first (`9fe6ff4`, PR #414). A
merged record is never renumbered, so the unmerged record moved above this lane's
highest consumed number (`0664`) and is now
[ADR-0665](ADR-0665-op121-invitation-decisions-red.md); the lane `Next free` cell reads
`0666`. The honest history lives in ADR-0665's own `Range:` block and in the two README
lane paragraphs that record the RED and the GREEN — no row is added here, and
`docs/adr/README.md` is untouched by this sign-off.

**The `main` fold and its one decision.** The fold base was `741b607`; `main` had moved
to `9219d03` by the landing pass (the OP-123 uploads land plus the OP-129
attendee-session fix), so the fold was committed on the lane as the merge commit
`780a62f`. `docs/adr/README.md` auto-merged as an index-only union: rows `0660`–`0665`
then `0680`–`0701` ascending, cell `0666`, both sides' prose kept. The one hand-resolved
surface was `apps/web/src/server/events/access.ts`. Main (ADR-0701) had parameterised the
seam (`admitEventActor(ctx, segmentFromEnd = 2)` plus `eventActorAdmission(n)` for the
upload routes) while this lane had switched the lookup to the `events` anchor, because
`GET …/events/{eventId}` carries no suffix and `2` from the end reads the literal `events`
segment there. Resolution: main's signature and helper are kept and the offset is made
**optional** — an explicit offset still reads
`eventIdFromRequest(request, { segmentFromEnd })`, identical for every upload route, and an
omitted offset reads `eventIdAfterEventsSegment`, identical for `…/members` and correct for
the detail read. Both sides' suites stayed green on the merged tree.

**Verification reproduced by the landing pass, on that tree.** Unit `162 files / 2601
passed | 3 skipped (2604)`; integration `106 files / 1095 passed (1095)`; focused ADR
guards `54/54`, invitation unit `35/35`, invitation-decisions plus uploads integration
`111/111`; `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `prettier --check` clean; the
trunk's own gates `14/14` green, including the aggregate `ci` job (typecheck, lint, unit,
integration, coverage, build, Playwright E2E). Post-merge on `origin/main`: `287` ADR
files, no duplicate `ADR-` prefix, `ADR-0663` resolving to the OP-120 record only (three
references), exactly one `ADR-0665-op121-invitation-decisions-red.md`, cell `0666`, ADR
guard `54/54`.

**Findings, by card id only.** F1 (member removal performs its organizer revoke,
invitation revoke and two domain emits without a transaction, unlike the accept path) and
F2 (the reject branch's status write is not paired with its affordance closure and its
`collab.invite.rejected` emit) are both **Low**, outside this record's pinned contract, and
are routed to the characterization-pin card `t_c27c7855`. F3 (`conflict` after three lost
races while the comment says "never a 409", unreachable in practice) is Info and carries no
card. No follow-up's ADR number is cited here, because a number can move while its PR is
open.

**Nothing in the sections above is retracted.** No decision is re-pinned, no code changes
with this sign-off, and the follow-up cards' own records document what followed.

## Follow-up GREEN review sign-off (round 1, artifact lens — card `t_1238ed16`, 2026-11-12)

**What landed, and at which bytes.** PR #489 squash-merged to `main` as
`c125b9f45e8f35ee612c3aa8df33b5aa3eb6468a`; the reviewed head was
`5c6060d3f0f013dd516799cc2df9a9e726d44a9d` (branch tip `ee31e56` plus one `origin/main` merge,
`65af89c`). The branch tree OID and the squash tree OID are the same object,
`b020b26d031645b5f4bedc37f85a5b5367b3f813`, so the merged bytes are the reviewed bytes. The PR carried
the parent pin branch unchanged — `route.ts` plus `+121` lines of pins in
`event-invitation-decisions.test.ts` — and no pin case was edited: that spec's blob is the same object
(`65ae1d414b736a0a0745cbbae9bd417905f8499b`) at the pin head `69af42d`, at the branch tip `ee31e56`, at
the reviewed head and at the squash.

**What the fix is.** The `event member removed` info line (message, level and the
`event`/`tenantId`/`eventId`/`userId` fields unchanged) is now gated on the winner flag the transaction
returns (`false` on `matchedCount === 0`), and the pre-transaction lookup resolves the row by identity only
(`revokedAt: null` dropped), so a repeat answers `204` per decision card `t_df7d6c3b`. The in-transaction
`updateOne({ _id, revokedAt: null })` predicate, the emit pair, the invitation revoke, the `409` arm and the
`204` shape are untouched.

**RED → GREEN, measured.** RED at the pin head `69af42d`: `2 failed | 45 passed (47)` — P2
`expected 404 to be 204`, P3 `expected [ …(2) ] to have a length of 1 but got 2`. GREEN at the reviewed
head and on the merged tree: focused `47 passed (47)`, three consecutive runs; ADR guards `92/92` at
`ee31e56` and `112/112` on the merged tree; `tsc` exit `0`; `prettier --check` and `eslint` clean on the
touched file; trunk gates `14/14` at `5c6060d`.

**Finding, by card id only.** A repeat `DELETE` on a member who was removed and then re-invited without
accepting answers `204` and leaves that invitation `pending` and re-acceptable — probe
`{"secondStatus":204,"invitationBefore":"pending","invitationAfter":"pending","memberStatus":"removed","revocations":1,"acceptAfterRemoval":200}`.
That is the decided arm — `404` only when no membership row exists — and the in-transaction predicate was
not to be touched, so it is **Low**, outside this record's pinned contract, and routed to the
characterization-pin card `t_accf2ac8`, which also carries the product question of whether the repeat
should revoke a pending invitation. Info only, no card: a committed-then-retried transaction could in
principle cross the flag boundary and skip the winning log line — unreachable with this wrapper's
`session.withTransaction`, because a retry implies an abort. The §2.3 contract paragraph is DOCS card
`t_3a19b2e2`.

**Nothing in the sections above is retracted.** No decision in the lane's earlier sections is re-pinned,
no code changes come with this sign-off, and no ADR number of a still-unmerged follow-up is cited.

## Amendment — the concurrent-removal retry budget (2026-11-12)

**Why this amendment exists instead of a new record.** Card `t_d3a3c553` (review finding F1 of card
`t_2849a4ca`, severity High) repairs a pre-existing flake on the removal route. No ADR number was
minted: the repository sweep in `adr-numbering.test.ts` pins the tree's population exactly
(`checkedLinks: 881, scannedRecords: 292`), so a new record — or a new link inside any record —
reddens that ratchet, and editing a test is outside an implementer's lane. This section therefore
carries the decision with no new file and no new link, and the lane's `Next free` cell is untouched.

**The failure, measured.** `DELETE …/members/{userId}` decides the winner with
`members.updateOne({ _id, revokedAt: null }, …)` inside `withTransaction`, whose budget is three
attempts. The concurrent cases of `event-invitation-decisions.test.ts` answered `500` instead of `204`
at random: trunk `f9d3a62` (run `43294038554`, job `ci`, `expected 500 to be 204`) and the docs-only
`14b456d` (first `test_coverage` attempt, `expected [ 500, 204 ] to deeply equal [ 204, 204 ]`), both
green on a rerun of the identical commit. Two probes on the harness — both deleted, neither a pin —
established the mechanism rather than assuming it:

1. two transactions racing the same `updateOne`: the loser spent the whole budget in **19 ms** as
   `TransactionRetryLimitError` from the wrapper's own guard (not the driver), **while the winner's
   transaction was still open**, and the member row still read `revokedAt: null` at that moment —
   the winner's flip is invisible until it commits;
2. the real route with a rival transaction holding the document lock and committing 250 ms later:
   **3/3 rounds `500 internal_error`** before the fix and **3/3 `204`** with **zero** loser
   `event member removed` lines after it.

The driver's transient retries carry no delay, so three attempts span a few milliseconds — shorter
than the winner's transaction (a member flip, an invitation revoke and two outbox emits) whenever the
runner is loaded. The route did not handle the exhausted-budget signal, so the pipeline mapped it to
`500`.

**What the fix is.** `DELETE` catches `isTransactionRetryLimitError` (already exported by the wrapper,
already used this way by the access-links rotation) and answers the same settled `204` the ordinary
loser answers (contract §0.7); nothing of the loser's attempt was written, since the callback aborted.
It does **not** re-read once: probe 1 shows the row still reads `revokedAt: null` at that instant, so a
single re-read would answer `500` again. It polls the member row instead — 25 ms interval, 1 s ceiling
— until the winner's commit is visible. A removal that never lands still surfaces the original error
as `500`, so no client is told a seat was removed when it was not. The retry budget stays at three, the
in-transaction predicate, the emit pair, the invitation revoke, the `409` arm, the `204` shape and the
single-log-line rule are untouched.

**Alternatives rejected.** Raising the budget at this call site (the retries are immediate, so a wider
guess at the same race, and a deliberate bound is weakened for nothing); retrying the whole transaction
in a second round (re-runs three writes and two emits to learn what one read answers); splitting the
member flip out of the transaction (forbidden by the failing-emit pin, which requires the flip, the
invitation revoke and both emits to roll back together); and editing the spec to serialize the pair
(the flake is real product behaviour under a double click, not a test artifact).

**Residual risk, named.** The 1 s ceiling is a fixed bound, not the winner's own duration: a removal
transaction longer than 1 s under extreme load still answers `500`. Upgrade to a shared per-member
removal lock if that is ever observed. Handed to the Test Author as a gap: the retry-limit branch has
no deterministic committed pin — the existing concurrent cases exercise it only probabilistically, and
this lane could not add one.

**Nothing in the sections above is retracted.** No decision of the lane's earlier sections is
re-pinned, and no code changes come with this amendment.

## Amendment — the retry-limit branch, pinned deterministically (2026-11-12)

**Why this is an amendment and not a new record.** Card `t_a29a9e7c` (review finding M-1 of
`t_d3a3c553`) closes the gap the previous amendment handed to the Test Author: the retry-limit branch
had no deterministic committed pin. The repository sweep in `adr-numbering.test.ts` pins the tree's
population exactly (`checkedLinks: 881, scannedRecords: 292`), so a new record — or a new link inside
any record — reddens that ratchet, and editing the guard is outside a test-authoring lane. Same route
as before: no new file, no new link, the README and the lane's `Next free` cell untouched.

**What was missing.** The concurrent cases (`F1: two concurrent removals …`, `P3: a double removal
writes exactly one … log line`) reach the branch only when the race actually spends the loser's
budget, which is the flake itself. With the `.catch` replaced by an immediate rethrow in a probe
worktree at `e2a4806`, the focused spec stayed 48/48 green over three serial runs: deleting the repair
was invisible until CI flaked again.

**The committed pin.** Two additive cases in `event-invitation-decisions.test.ts`, in a new describe
below the F1 block, both on the file's own `seedEvent` / `addEventMember` / accepted-invitation
fixture family:

- **R1** — a rival `withTransaction` performs the winner's three writes (the `event_organizers` flip,
  the invitation revoke and both `collab.member.removed` emits) on the same row, then holds the write
  lock. The route's own `DELETE` is fired unawaited; its three immediate attempts all conflict and the
  wrapper throws its own `TransactionRetryLimitError` while the rival is still open. The case releases
  the rival and asserts `204`, an empty body, exactly one `collab.member.removed` and one `.ack`
  outbox row, a `removed` row with `revokedAt`, a `revoked` invitation, and **zero**
  `event member removed` lines.
- **R2** — the same collision, but the rival commits a write that is not the removal. Nothing was
  removed, so the bounded wait runs out and the loser rethrows: `500 internal_error`, zero outbox
  rows, the member still `active` with a null `revokedAt`, the invitation still `accepted`, zero
  removal lines. This is the arm that pins the rethrow, not only the `204`.

**Determinism, measured.** The cases do not race the clock the way the flake does: they wait for the
wrapper's own two `db.transaction.retry` lines (one per retry, so the third and last attempt was
already started), allow 150 ms for that attempt's conflict round-trip (measured: three attempts in
about 19 ms), then release the rival. The retry-line gate throws with a named message when the budget
is never spent, and each case asserts exactly two retry lines, so neither can pass because the route
won the row instead.

**The pin bites, measured (throwaway probe; the route restored byte-identically afterwards, sha256
`8498443674b5865c4d546f3cf10af5d13e6e8254bfcc1c7d90298846e1437a5a`):**

- delete the `.catch` (immediate rethrow): R1 red, `expected 500 to be 204`; R2 stays green, which is
  what the second arm is for;
- make `rivalRemovalCommitted` answer `true` without ever seeing a removal: R2 red,
  `expected 204 to be 500`;
- leave the removal log line unguarded: R1 red, `expected [ { service: 'openpic-web', …(8) } ] to have
a length of +0 but got 1`.

Green on arrival at `e2a4806` (trunk `3e268a0`): focused spec 50/50, and the two new cases 2/2 over
three serial runs.

**Residual risk, named.** The 1 s ceiling is unchanged: a removal transaction longer than the ceiling
still answers `500`, and R2 is the honest arm for that shape. The 150 ms grace is a margin, not the
rendezvous — the retry-line gate is the rendezvous, and it fails loudly rather than passing vacuously.

**Nothing in the sections above is retracted.** No earlier decision of this record is re-pinned, and no
production code changes come with this amendment.
