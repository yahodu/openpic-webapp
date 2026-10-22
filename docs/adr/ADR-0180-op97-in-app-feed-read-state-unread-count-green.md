# ADR-0180 — OP-97 GREEN: in-app feed, read state and the unread-count hot path

- **Status:** Accepted · **Date:** 2026-10-21
- **Card:** OP-97 phase 1 (GREEN, `t_58825ec3`) · **Depends on:** OP-94 (ADR-0090/0092/0106), OP-83 (ADR-0007 `platformSettings`), OP-82/OP-86/OP-87 (auth labels, ADR-0025/0028), OP-81 (rate-limit classes)
- **Contract:** ADR-0131 (`docs/adr/ADR-0131-op97-in-app-feed-read-state-unread-count-red.md`) · RED review: ADR-0132 · **Supersedes / amends:** none (ADR-0131 stays authoritative for behaviour; this ADR records the implementation and the decisions the implementation had to make)
- **Number:** drawn from the OP-97 lane's reserved range `0180`–`0199` (ADR-0300, `docs/adr/README.md` § "ADR number allocation"). This record was first drafted as `0135` under the retired "lowest free number" rule and renumbered to `0180` once the per-lane range policy landed on `main` (`23c236d`).
- **Worktree / branch:** `/root/openpic/openpic-webapp/.worktrees/t_58825ec3` · `OP-97-task-in-app-feed-read-state-green` (cut from the renumbered RED tip `0de60e0`; carries the RED pins, per the OP-92/93/94 precedent)

## Context

ADR-0131 pinned the feed, the read-state mutations and the unread-count hot path
with failing tests (`feed.test.ts`, `unread-count.test.ts`, three integration
suites, `me-notifications.spec.ts` E1) and one behavioural defect (`PRE-1`).
This ADR records the GREEN implementation, the two behaviours the pins turned
out to require beyond ADR-0131's prose, and the two ADR-0131 statements that the
tests contradicted.

## Decision

### Modules and routes

- `@/server/notifications/feed` — `resolveFeedWindow`, `type FeedFilter`,
  `feedCategoryFor`, `feedTypeKeysForCategories`, `EXCLUDED_FEED_TYPE_KEYS`,
  `projectFeedItem` (`StoredFeedRow`/`FeedItem`) and `feedResponseSchema`
  (`data`/`page`/`summary`, with the eighteen §7.1 item keys declared as a
  Zod object so the shared serializer validates each item strictly).
- `@/server/notifications/unread-count` — `highestSeverity`,
  `composeUnreadEtag`, `buildUnreadCountFilter`, and `summarizeUnread`: the one
  aggregation the unread-count route, the feed `summary` and `read-all`'s
  post-mutation count all share, so the three surfaces can never disagree about
  "how many unread do I have".
- `@/app/api/v1/me/notifications/route` (`GET`), `.../unread-count/route`
  (`GET`), `.../read-all/route` (`POST`), `.../[id]/read/route` (`POST`),
  `.../[id]/route` (`DELETE`) — all guarded with the `user` label on
  `defineRoute`. `{id}` is read from the request URL (`{id}/read` uses the
  second-to-last segment) via `app/api/v1/me/notifications/_lib/notification-id`,
  mirroring `me/sessions/{sessionId}`. A malformed, unknown or foreign id is
  `404 not_found` for all three.

### Feed projection and filters

Rows are projected to exactly the eighteen §7.1 keys; `_id`, `titleKey` and
`expireAt` never reach the wire, and `title`/`body` are returned verbatim.
`category` is denormalised from the **compile-time** seed catalogue (the stored
row carries `severity` but not `category`), so the read needs no extra database
round-trip and `?category=` is served by translating the category back to its
`typeKey` set. An unknown `typeKey` falls back to a prefix-derived category and
then `platform_ops`, so a type shipped without a client deploy still renders.

Two details ADR-0131's prose did not pin, but the tests did:

1. **`filter=unread` also restricts to `readAt: null`.** ADR-0131 says the four
   filters differ "only [by] the `createdAt` band" — but I1's unread band must
   exclude a _read_ row inside the 90-day horizon. The unread band is therefore
   the horizon **restricted to unread rows**; `active`/`all`/`archived` stay
   read-state-agnostic.
2. **The OTP exclusion is the whole `in_app:false` set, not just the two
   `auth.otp.*` keys.** ADR-0131 derives it from
   `channelGroups.in_app.enabled === false` and then claims that "yields the two
   `auth.otp.*` keys today"; the seed actually yields **five** types
   (`auth.otp.email.requested`, `auth.otp.mobile.requested`,
   `account.deletion.completed`, `privacy.erasure.completed`,
   `attendee.consent.receipt`). The derivation is implemented as declared — a
   type with no in-app channel is not a type the feed can legitimately hold — so
   the ADR's parenthetical is what is inaccurate, not the implementation. No
   test distinguishes the two readings; I7 pins only the OTP keys.

The four explicit fallbacks are implemented as recorded: a non-positive or
non-numeric `limit` → `20`, a larger `limit` → `50`, an unknown `filter` →
`active`, a `window` > 90 → 90 and ignored for `archived`/non-positive.
`eventId` and `cursor` are the two values with no recorded fallback: a malformed
`eventId` is `422 validation_failed` and a malformed `cursor` is `400
invalid_cursor` (the shared codec's behaviour), both conventional boundary
responses and neither exercised by the suite.

### The badge path (ETag/304)

The `ETag` cannot come from the `etagStage` resolver (it depends on the counted
rows), so the handler composes it after the aggregation and evaluates
`If-None-Match` with the shared weak comparison. `epochSeconds` is the greatest
`updatedAt` among the counted rows, in whole seconds, and `0` when nothing is
counted — so any mutation of the unread set changes the token without a version
counter. `Cache-Control: no-store` is the pipeline's default header; the count
runs the exact `buildUnreadCountFilter` predicate (partial-index supported) plus
the `in_app:false` exclusion, and the aggregation returns the count, the
per-category breakdown and the severities in one round trip.

### PRE-1 — quiet hours never suppress the in-app badge

The fan-out's in-app branch now writes the feed row for a `send`, `digest`
**or** `defer` decision, so a quiet-hours deferral still defers the email half
(one `deferred` dispatch row, released by the cron) while the badge is written
immediately.

The pin also exposed a second, unrecorded defect: the `account.welcome` emit
sets `actorRef === subjectRef === the new user`, and `resolveRecipients` drops
the actor — including when the actor is the subject (pinned by the fan-out unit
spec U2). Every recipient therefore resolved to **nobody**, so the welcome
produced no feed row at all (provable independently of quiet hours). The
consumer now re-adds the subject after `resolveRecipients`: the subject of an
event always hears about it, while audience-derived recipients keep the actor
exclusion.

This is deliberately a consumer-level rule rather than a change to
`resolveRecipients`, whose actor-exclusion is pinned by U2 and by I2b. The two
tests describe different layers: U2 pins the _audience resolver_'s behaviour,
PRE-1/E1 pin the _consumer_'s. **The tension is real and is flagged to the Test
Author** (see Consequences) — ADR-0131's PRE-1 justification checked only the
channel matrix and missed that the fixture's actor/subject collapse yields an
empty recipient set.

The re-add is scoped to a type with **no `dedupe` key**. E1 forces this: a
fresh sign-up emits both `account.welcome` _and_ `auth.signin.new_device`
(contract §1.1's session-created hook), both with `actorRef === subjectRef`, and
the spec asserts the badge is exactly `1` — the welcome. A dedupe-carrying type
is a repeated external alert (`auth.signin.new_device` carries
`{typeKey}:{deviceId}`; design §4.1) that the actor's own action produced, and
its badge is left to the resolved audience, while a one-off account event is
always surfaced to its subject. Whether the new-device alert _should_ appear in
the bell is a genuine product question — design §4.1 lists the audience as
`user` and the alert carries the "not you?" action — so this rule is recorded as
an **assumption for the Test Author to confirm** rather than an invented
contract: PRE-1 and E1 cannot both hold without either this distinction or an
explicit re-pin of one of them.

### E1 and the e2e-environment gap

E1 signs a fresh account up over the deployed HTTP surface and asserts the badge
goes `1 → 0`. ADR-0131 offered two ways to close the empty-catalogue gap; this
lane took the **second**: the e2e boot provisions the catalogue.

`apps/web/src/instrumentation.ts` seeds `notificationTypes` and
`notificationTemplates` at boot when `APP_ENV === "e2e"` **and** `MONGODB_URI`
is set, via the existing create-or-reconcile `seedNotificationTypes` /
`seedNotificationTemplates`. This is behaviour-neutral for every other
environment (the production/flavoured boot never enters the branch, and the
boot-guard unit spec runs it without a `MONGODB_URI`) and mirrors the test-only
OTP reader route's posture.

The first option — extend the seed fallback to the emit gate
(`getEnabledNotificationTypeKeys`) — was rejected: the emit gate's
"empty catalogue ⇒ `dispatch.notifications = "skipped"`" behaviour is pinned by
the `emitDomainEvent` unit spec U4 and by the I5 staleness case, so a
non-production fallback on an empty catalogue would break both. Provisioning
leaves the production write path (emit gate, fan-out resolution) untouched.

### Dispute — E1's read POST cannot pass the pinned CSRF gate (test defect)

E1 is **red for one reason that is not the implementation's**: its read step
sends the session cookie and an `Origin` but **no `X-Requested-With:
XMLHttpRequest`**, so `src/middleware.ts` stops it before any route handler runs.

This is a test defect, not a missing behaviour:

- `docs/API Contract.md` §0.9: every cookie-authenticated state-changing request
  (`POST`/`PATCH`/`PUT`/`DELETE`) must carry `X-Requested-With: XMLHttpRequest`
  **and** originate from an allow-listed `Origin`; violations are
  `403 csrf_failed`.
- The gate is pinned at both layers: `security/csrf.test.ts` U1 denies a POST
  with an allowlisted Origin but no `X-Requested-With`, and the
  `middleware-csrf.spec.ts` e2e pair proves it is wired into the real server.
- Every other e2e spec that POSTs with a session cookie sends the header
  (`me-deletion.spec.ts`, `me-current-user.spec.ts`); E1 is the only one that
  does not.

Reproduced directly against the deployed `APP_ENV=e2e` server (this worktree's
`.next/standalone`, fresh sign-up):

| request                                                   | status | body                                                               |
| --------------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| `POST …/{id}/read` (cookie + origin, as E1 sends it)      | `403`  | `csrf_failed` — "The request is missing the required CSRF header." |
| `POST …/{id}/read` (cookie + origin + `x-requested-with`) | `204`  | — (the badge then reports `unreadCount: 0`)                        |

Everything else in the journey already passes on the deployed server: the fresh
sign-up raises the badge to exactly `1` (`account.welcome`), the feed returns
exactly that one row, and the read clears it to `0` once the CSRF header is
present.

The two honest ways to make E1 green are both **out of this lane's hands**:

1. the spec adds `"x-requested-with": "XMLHttpRequest"` to the read request
   (a test change — owned by the Test Author); or
2. the CSRF gate stops requiring the header for `/api/v1/me/notifications/**`
   (a security regression that contradicts the pinned contract and the two CSRF
   suites above).

Option 2 is a quiet workaround and was **not** taken; the endpoint keeps the
project-wide CSRF posture. The test is left red and this dispute is handed back
to the Test Author via the GREEN card.

**Routing (recorded 2026-10-22).** Per the board's instruction to spin the fix
off as a gated parent rather than keep the GREEN card parked on a disputed red,
the one-line spec change is owned by follow-up card **`t_6f2430cb`** (assignee
`openpic-webapp-testcase-writer`, worktree `.worktrees/t_08538ff6` on branch
`OP-97-task-in-app-feed-read-state-red`). That card is linked as a **parent of
the OP-97 GREEN card `t_58825ec3`**, so the GREEN card is dependency-parked and
auto-resumes when the header lands: it then merges the RED tip forward into the
GREEN branch, re-runs the full suite and requests review. Option 1 is the
correction; option 2 remains rejected.

**Resolution (recorded 2026-10-22).** Card `t_6f2430cb` landed option 1 on the
RED branch: commit `97257f5` adds `"x-requested-with": "XMLHttpRequest"` to E1's
read POST headers — a test-only change, with no CSRF-gate exemption and no other
spec or production file touched. The GREEN branch then merged the RED tip
(`dcb1472`) and `origin/main` (`a094b86`), and the disputed red is closed: E1
passes and the whole suite is green (unit 88 files / 1530 tests, integration 61
files / 399 tests, `playwright --project=api` 16/16, coverage
92.41 / 80.74 / 96.14 / 93.07).

## Consequences

- The feed, the read-state mutations and the badge are implemented to ADR-0131's
  contract; `apps/web/src/test/**` is unmodified apart from the renumbering
  comments the RED branch already carried (merged in `0de60e0`).
- **E1 was the one red test, and it was disputed** (see the Dispute section): the
  spec's read POST omitted the CSRF header the pinned gate requires, so it was
  `403` before the route ran. The Test Author's follow-up card `t_6f2430cb` added
  the header (RED commit `97257f5`, merged in `dcb1472`), and E1 is now green
  alongside the rest of the suite (unit 1530, integration 399, e2e api 16/16).
- The badge path is index-supported, cacheable and never counts OTP or
  unexpired rows; the feed never lists an `auth.otp.*` row even if one is stored.
- **Open, for the Test Author:** (1) PRE-1's fixture collapses actor and subject,
  which the pinned `resolveRecipients` (U2) maps to an empty recipient set — the
  GREEN lane satisfies the pin by re-adding the subject at the consumer, scoped
  to dedupe-free types so E1's fresh-signup badge stays at exactly one row; both
  the actor/subject layer split and the dedupe scoping are assumptions the Test
  Author should confirm or re-pin. (2) ADR-0131's OTP-exclusion
  parenthetical ("exactly the two `auth.otp.*` keys") does not match the seed's
  five `in_app:false` types. (3) `filter=unread`'s `readAt: null` restriction is
  pinned only implicitly by I1 and is not stated in ADR-0131's window table.
- The rate-class bindings (`read.normal`, `read.hot`, `write.normal`) remain
  asserted by reference only (ADR-0132 F6 — `defineRoute` exposes no inspectable
  route metadata), so this lane adds no binding assertion either.

## Alternatives

- **Emit-gate seed fallback (ADR-0131's preferred option).** Rejected — it
  contradicts the pinned U4 empty-catalogue behaviour; see above.
- **Changing `resolveRecipients` to keep a subject who is also the actor.**
  Rejected — it breaks the pinned U2 case and I2b; the consumer-level rule keeps
  both layers consistent with their own specs.
- **Filtering the feed's `unread` band by read state inside `resolveFeedWindow`.**
  Rejected — the window helper is pure and pinned to date bounds only; read state
  is a query predicate the route composes, keeping `resolveFeedWindow` free of
  `readAt` concerns.
- **A precompute/counter document for the badge.** Rejected in ADR-0131
  (consistency window for a query the partial index already answers); unchanged.
- **Re-rendering `title`/`body` from `typeKey` + `data`.** Rejected in ADR-0131
  (design §19.4: the stored strings are authoritative); unchanged.
