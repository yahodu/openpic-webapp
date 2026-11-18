# ADR-0282 — OP-101 RED: the tenant-members listing must survive a membership with no usable `joinedAt`

- **Status:** Accepted · **Date:** 2026-11-18
- **Card:** OP-101 TEST (RED, `t_19b89cbb`) · **GREEN successor:** `t_2e0b8f30` (gated on this card) · **Land card:** `t_1d41c1e4`
- **Branch:** `OP-101-task-tenant-members-defensive-restore` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op101-members-restore`
- **Spec sources:** API contract §2.2 (tenant members — the `Member` DTO and its `joinedAt`); schema §13.4 (`tenantMembers`, `joinedAt` typed as a date); §13.1 (`user`). The wire shape is re-stated executably in `@/server/tenancy/member-schema` (`joinedAt: isoDateTimeSchema`, i.e. `offset: false`, `precision: 3`, **non-nullable**).
- **Relates to:** [ADR-0280](ADR-0280-op101-tenant-members-red.md) (the RED contract for this endpoint), [ADR-0281](ADR-0281-op101-tenant-members-green.md) (the GREEN that shipped `projectMember`), [ADR-0644](ADR-0644-op119-review-round1-green.md) (the events-module total-read precedent), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Consumers:** `apps/web/src/test/unit/tenant-members-joined-at.test.ts`, `apps/web/src/test/integration/tenant-members.test.ts`

## Context

`GET /api/v1/tenants/{tenantId}/members` (contract §2.2) joins `tenantMembers`,
the Better Auth `user` collection and `userProfiles`, then projects every row
through `projectMember()` in `apps/web/src/server/tenancy/members.ts`. The
projection read the join instant like this (line 76 at the base tree):

```ts
joinedAt: new Date(membership.joinedAt as string | number | Date).toISOString(),
```

`new Date(undefined).toISOString()`, `new Date("nope").toISOString()` and
`new Date(Number.NaN).toISOString()` all throw `RangeError: Invalid time value`.
`projectMember` runs inside the `map` over the whole result set, the route has no
per-row recovery, and `defineRoute` maps any escaped error onto the generic
`500` envelope — so **one** malformed or absent `joinedAt` on **one**
`tenantMembers` row turns the workspace member listing into a `5xx` for **every**
caller of that workspace. A read that one corrupt row can deny to everyone is the
defect; the contract fixes the DTO but says nothing about how an undatable stored
instant must be served, so this record decides it.

The row is reachable without a schema violation: `tenantMembers` carries no
MongoDB validator in this codebase (`@/server/db/collections` only names the
collection), so a row written by an older code path, a migration, or a manual
repair can hold `undefined`, `null`, `NaN` or an unparseable string.

**Why this card exists at all.** PR **#272**
(`OP-101-task-tenant-members-green-restore`) carried a fix, but it is a **draft**
whose head is a snapshot commit with **no merge base** against `main` (663
commits behind), is `CONFLICTING`/`DIRTY`, and its `audit-dev` check is
`FAILURE`. The backlog triage (`t_2ed653c2`, decision record comment 1721 on
`t_72d33d02`) quarantined it and routed the behaviour here instead. Nothing was
cherry-picked, rebased or copied from that tree: every assertion below was
re-derived against the current `main` and is proven RED there.

**Base.** The card measured the defect at `origin/main` `88d65749`. This branch
is cut from `origin/main` `f9257747` (eight trunk commits later) because the
defective production file and the spec harness are byte-identical across that
range:

```
$ git diff --stat 88d65749..f9257747 -- apps/web/src/server/tenancy/ \
    apps/web/src/test/integration/tenant-members.test.ts
(no output)
```

so the pins run against exactly the production code the card names.

## Decision

### D1 — the pins are the contract, and they named no new module

| Spec                                                      | Exercises                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `apps/web/src/test/unit/tenant-members-joined-at.test.ts` | `projectMember(membership, user, profile): Member` — the projection itself  |
| `apps/web/src/test/integration/tenant-members.test.ts`    | `GET` from `@/app/api/v1/tenants/[tenantId]/members/route` — the real route |

The unit spec imports the **existing** export `projectMember` and the existing
`MembershipDocument` type from `@/server/tenancy/members`; it asks for no new
module, no new export and no new dependency. The integration spec appends one
`describe` block to the spec ADR-0280 created, reusing its harness
(`startTestApp`, `seedWorkspace`, `listRequest`) so the 5xx is measured through
the route a user calls, not only at the projector. How the reading is factored
inside `members.ts` — inline guard, local helper, or shared reader — is **not**
pinned.

### D2 — an unusable `joinedAt` degrades to the epoch sentinel, not to `null`

Contract §2.2 is silent on an absent instant. This is the explicit choice:

**A membership whose `joinedAt` cannot name an instant is projected as
`1970-01-01T00:00:00.000Z`.** The row keeps its place in the listing, and the
listing answers `200` with the §2.2 envelope.

`null` — the alternative the card proposed — is **rejected**, on three measured
grounds, not on taste:

1. It is not on the wire. §2.2 shows `joinedAt` as a string instant and
   `memberSchema` types it as `isoDateTimeSchema`, which is non-nullable; a
   `null` fails `serializeResponse`, which in a non-production environment
   **throws** and in production **strips** then re-throws when the body cannot be
   parsed — either way the caller still receives a `5xx`, only with a different
   trace.
2. It breaks the listing's own ordering. `listWorkspaceMembers` sorts with
   `left.joinedAt.localeCompare(right.joinedAt)`; a `null` makes the comparator
   throw `TypeError`, so the fix would convert one `RangeError` into another.
3. It would require a contract and schema change (nullable `joinedAt`, §2.2
   prose, `memberSchema`) to serve a corruption the contract never contemplates.
   A DTO field the contract requires may not become nullable because storage
   drifted.

The epoch is chosen over the other degradation shapes considered in
§ Alternatives: it is a real, schema-valid, totally ordered instant, it sorts
first deterministically, and it **cannot be mistaken for a real join time** by a
reader or an operator. The pins assert the literal string, so a GREEN that
degrades to any other value fails loudly.

Two consequences are accepted: a member whose row lacks the instant renders as
"joined 1970" in the workspace UI (visibly wrong, therefore actionable), and the
listing's order puts such a row first. Both are corrections an operator can
make; a `5xx` is not.

### D3 — only a `Date`, a string or a number can name an instant

The stored value is read as `unknown`. A `Date` names an instant when its
`getTime()` is finite; a string when it parses to a finite instant; a number when
it is finite epoch milliseconds. Everything else — absent, `null`, `NaN`, an
unparseable string, an invalid `Date`, an empty string, a boolean, an object —
cannot name an instant and degrades per D2.

The **boolean** case is a RED case at the base tree for a reason worth recording:
`new Date(true)` is **not** invalid — it is `1` millisecond — so the defect
silently served `1970-01-01T00:00:00.001Z` for a `joinedAt: true` row
(measured: `AssertionError: expected '1970-01-01T00:00:00.001Z' to be
'1970-01-01T00:00:00.000Z'`). "It did not throw" is not "it read the value
correctly", so the pins constrain the accepted **kinds**, not merely the absence
of a throw.

`null` is worth one more note: it is **green at the base tree**, because
`new Date(null)` is the epoch. It stays in the pin set as a characterization
guard — the degradation `null` receives by accident today is the degradation it
must keep — so the RED file has four passing cases (three valid-path controls
plus `null`) and the rest failing.

### D4 — the events-module `instantMillis`/`toObjectId` precedent is duplicated in spirit, rejected in policy, and not imported

`apps/web/src/server/events/members.ts` already reads stored instants
defensively (ADR-0644) with `instantMillis(value)` and `toObjectId(value)`. This
record **rejects reusing that code** and **rejects its policy**, for reasons that
are specific and testable:

- The helpers are **module-private** (`function instantMillis`, no `export`), and
  the module exports only `listEventMembers`. Importing them would require
  widening a public surface of another bounded context solely to borrow 8 lines,
  which is exactly the coupling the module boundary exists to prevent.
- Their **policy is the opposite** of what this endpoint needs. The events read
  is _total_ by **skipping** a row that cannot be dated (`if (userId === null ||
joinedAtMillis === null) continue`), because an `event_organizers` row that
  cannot be dated cannot be attributed and the listing is an attribution view.
  The workspace listing is the **authority on who is in the workspace**: skipping
  a member would hide them from the owner, make them unmanageable through
  `PATCH`/`DELETE /members/{userId}`, and silently change the payload's
  membership — a worse outcome than a visibly-degraded instant.
- Their **fallback is rejected too**: the events read falls back to the insertion
  instant encoded in the row's `_id` (`getTimestamp()`). For `tenantMembers` that
  would fabricate a plausible join time that is indistinguishable from real data
  in the payload, and §13.4 does not say `_id` is the join time, and a
  hand-written row may carry no `_id` at all.

What **is** reused is the shape of the decision — accept the documented kinds,
reject everything else, never throw — duplicated as the local reading of one
field. If a third module needs the same reader, that is the point to factor it
into a shared helper with a shared policy; two modules with opposite policies are
not that point.

### D5 — deliberately out of scope

- **Listing order.** `main` sorts by `joinedAt` alone. PR #272 additionally
  broke ties by `userId`; that is not in §2.2, it is a separate behaviour, and it
  is not pinned here, so the GREEN may keep the single-key sort. The pins assert
  the **set** of listed members, never their order.
- **`user` / `userProfiles` absence.** `main` already serves an absent user as a
  fully-masked contact (`maskEmail("")`) and an absent profile as `""`. The pins
  do not re-assert those arms; they only require that a row degraded by D2 keeps
  every §2.2 key.
- **`tenantIdFromRequest`.** The positional-segment fix landed with ADR-0281 and
  is present at the base tree; PR #272's extra `segments.length` guard is a
  different defect and is not pinned.
- **`removed` members and status filtering.** Unchanged by this card (ADR-0280
  A5 already records that the list carries every row; the pins seed only the rows
  they name).
- **`schema §13.4` enforcement.** No validator exists and none is added; the
  contract decision is about reading, not writing.

## Evidence — the RED run at `f9257747`

Both specs were run against the untouched production tree (`git diff
origin/main` contained only the two spec files at this point).

`pnpm vitest run --project unit apps/web/src/test/unit/tenant-members-joined-at.test.ts`
— exit `1`:

```
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 8 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |unit| apps/web/src/test/unit/tenant-members-joined-at.test.ts > projectMember — an unusable `joinedAt` degrades instead of throwing > degrades an absent `joinedAt` to the epoch sentinel
 FAIL  |unit| apps/web/src/test/unit/tenant-members-joined-at.test.ts > projectMember — an unusable `joinedAt` degrades instead of throwing > degrades a NaN `joinedAt` to the epoch sentinel
 FAIL  |unit| apps/web/src/test/unit/tenant-members-joined-at.test.ts > projectMember — an unusable `joinedAt` degrades instead of throwing > degrades an unparseable string `joinedAt` to the epoch sentinel
 FAIL  |unit| apps/web/src/test/unit/tenant-members-joined-at.test.ts > projectMember — an unusable `joinedAt` degrades instead of throwing > degrades an invalid Date instance `joinedAt` to the epoch sentinel
 FAIL  |unit| apps/web/src/test/unit/tenant-members-joined-at.test.ts > projectMember — an unusable `joinedAt` degrades instead of throwing > degrades an empty string `joinedAt` to the epoch sentinel
 FAIL  |unit| apps/web/src/test/unit/tenant-members-joined-at.test.ts > projectMember — an unusable `joinedAt` degrades instead of throwing > degrades an object `joinedAt` to the epoch sentinel
RangeError: Invalid time value
 ❯ projectMember apps/web/src/server/tenancy/members.ts:76:71
     76|     joinedAt: new Date(membership.joinedAt as string | number | Date).…
       |                                                                       ^
 ❯ apps/web/src/test/unit/tenant-members-joined-at.test.ts:113:23

 FAIL  |unit| apps/web/src/test/unit/tenant-members-joined-at.test.ts > projectMember — an unusable `joinedAt` degrades instead of throwing > degrades a boolean `joinedAt` to the epoch sentinel
AssertionError: expected '1970-01-01T00:00:00.001Z' to be '1970-01-01T00:00:00.000Z' // Object.is equality

Expected: "1970-01-01T00:00:00.000Z"
Received: "1970-01-01T00:00:00.001Z"

 ❯ apps/web/src/test/unit/tenant-members-joined-at.test.ts:115:32

 FAIL  |unit| apps/web/src/test/unit/tenant-members-joined-at.test.ts > projectMember — an unusable `joinedAt` degrades instead of throwing > still projects every §2.2 field of a row whose `joinedAt` is unusable
RangeError: Invalid time value
 ❯ projectMember apps/web/src/server/tenancy/members.ts:76:71
 ❯ apps/web/src/test/unit/tenant-members-joined-at.test.ts:120:23

 Test Files  1 failed (1)
      Tests  8 failed | 4 passed (12)
```

`pnpm vitest run --project integration apps/web/src/test/integration/tenant-members.test.ts`
— exit `1`. The server log line is the 5xx a user would receive:

```
{"level":"error","service":"openpic-web","env":"test","route":"/api/v1/tenants/:tenantId/members","event":"http.error","status":500,"err":{"type":"Object","message":"Invalid time value","stack":"RangeError: Invalid time value\n    at Date.toISOString (<anonymous>)\n    at projectMember (/…/apps/web/src/server/tenancy/members.ts:76:71)\n    at /…/apps/web/src/server/tenancy/members.ts:120:14\n    at Array.map (<anonymous>)\n    at listWorkspaceMembers (/…/apps/web/src/server/tenancy/members.ts:118:6)\n    at Object.handler (/…/apps/web/src/app/api/v1/tenants/[tenantId]/members/route.ts:26:18)\n    at /…/apps/web/src/server/http/define-route.ts:343:24","name":"RangeError"},"msg":"request failed"}
```

```
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |integration| apps/web/src/test/integration/tenant-members.test.ts > GET /api/v1/tenants/{tenantId}/members — a membership with no usable `joinedAt` > still answers 200 and lists the member when one membership has no `joinedAt`
AssertionError: expected 500 to be 200 // Object.is equality

- Expected
+ Received

- 200
+ 500

 ❯ apps/web/src/test/integration/tenant-members.test.ts:590:29

 FAIL  |integration| apps/web/src/test/integration/tenant-members.test.ts > GET /api/v1/tenants/{tenantId}/members — a membership with no usable `joinedAt` > still answers 200 for a membership whose `joinedAt` is NaN, degrading it to the epoch
 FAIL  |integration| apps/web/src/test/integration/tenant-members.test.ts > GET /api/v1/tenants/{tenantId}/members — a membership with no usable `joinedAt` > still answers 200 for a membership whose `joinedAt` is an unparseable string, degrading it to the epoch
AssertionError: expected 500 to be 200 // Object.is equality

 ❯ apps/web/src/test/integration/tenant-members.test.ts:629:31

 Test Files  1 failed (1)
      Tests  3 failed | 21 passed (24)
```

The four passing unit cases are the three valid-path controls (a `Date`, an RFC
3339 UTC string, epoch milliseconds) and `null` (D3). The four passing
integration cases are the three valid-path controls and `null`; the seventeen
pre-existing cases in that file stay green, so the new block regresses nothing.

**Green controls on the same tree** — the valid path is already correct and must
stay byte-identical:

```
 ✓ |unit| … > projectMember — `joinedAt` keeps the documented valid path > projects a stored Date to the same documented ISO instant
 ✓ |unit| … > projectMember — `joinedAt` keeps the documented valid path > projects an RFC 3339 UTC string to the same documented ISO instant
 ✓ |unit| … > projectMember — `joinedAt` keeps the documented valid path > projects epoch milliseconds as a number to the same documented ISO instant
```

## Consequences

- **The GREEN's surface is one production file**: `apps/web/src/server/tenancy/members.ts`
  (the `joinedAt` reading). No contract edit, no schema edit, no route edit and no
  new dependency are required; a GREEN that touches `member-schema.ts` or
  `docs/API Contract.md` has misread D2.
- **Coverage.** The degraded arms are now pinned by inputs, not by inspection:
  absent, `null`, `NaN`, unparseable string, invalid `Date`, empty string,
  boolean, object, plus the three valid kinds. Under the repository's 80 % branch
  gate those branches can be restored without dropping the threshold — which is
  exactly the trade ADR-0281 §D6 recorded when the defensive arms were trimmed.
- **The sentinel is part of the wire contract now.** A later decision to serve
  `null`, to skip the row, or to infer the instant from `_id` is a contract
  change, needs its own record, and must break these pins first.
- **The quarantined vehicle stays closed.** PR #272 and the branches
  `OP-101-task-tenant-members-green-restore` and
  `OP-101-task-tenant-members-pins` are not touched by this card; the behaviour
  they intended lands through `t_2e0b8f30` and `t_1d41c1e4` on this branch chain.

## Alternatives considered

- **`null` on the wire** — rejected in D2: `isoDateTimeSchema` is non-nullable,
  `serializeResponse` turns the violation back into a `5xx`, and the listing's
  `localeCompare` sort would throw on it.
- **Skip the row (the events-module policy, ADR-0644)** — rejected in D4: the
  workspace listing is the authority on membership, so hiding a row hides a member
  from the only surface that can manage them.
- **Fall back to the `_id` insertion instant** — rejected in D4: it fabricates a
  plausible instant that is indistinguishable from a real one, and a row may
  carry no `_id`.
- **Clamp to "now"** — rejected: it makes the payload change between two reads of
  the same row, so the listing is no longer a function of storage and a client
  cannot cache or reconcile it.
- **Drop the member from the DTO but keep a `status: "removed"` marker** —
  rejected: it invents a lifecycle state that §2.2 and §13.4 do not have, and it
  would make a live membership look revoked.
- **Serve `500` with a per-row error list** — rejected: §2.2 defines no such
  envelope, and "one unreadable field denies every caller" is the defect itself.

## ADR number allocation

`0282` is the **OP-101 CI lane-shape** cell of `docs/adr/README.md`, taken as the
card directs and re-read on `origin/main` immediately before committing; this
record advances the cell to `0283` for the GREEN card. No `ADR-0282-*.md` exists
on `origin/main` and none is on any open trunk PR. The number **is** carried by the
quarantined branch `OP-101-task-tenant-members-pins` (commit `9d1f943b`,
2026-10-24), which this chain supersedes: that branch is the vehicle PR #272's
triage closed, it never had a merge base with `main`, and it is not a merge
candidate. This record claims the number on the trunk; if that branch is deleted,
the filename `ADR-0282-op101-tenant-members-pins.md` collides with nothing. No
number outside the lane range `0280`–`0299` is touched.
