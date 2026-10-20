# ADR-0129 — OP-97 RED: in-app feed, read state and the unread-count hot path

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-97 phase 1 (RED, `t_08538ff6`) · **GREEN card:** `t_58825ec3` (backend-coder) · **Depends on:** OP-94 (ADR-0092 fan-out / ADR-0093), OP-81 (rate-limit classes), OP-82 (ADR-0007 `platformSettings`), OP-87 (ADR-0028 internal auth)
- **Design:** §19.4 (`notifications`), §21 (indexes), §22 (retention/TTL), §4 rule 6/7 (OTP secrecy, `in_app` never opt-outable), §20.4 (`platformSettings.notifications`) · **Contract:** §7.1 (in-app feed), §7.2 (unread count), §0.10 (ETag/304), §0.15 (never-return)
- **Supersedes / amends:** none. Implements the OP-97 feed lane and carries the `PRE-1` finding routed by ADR-0128.
- **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_08538ff6` (branch `OP-97-task-in-app-feed-read-state-red`)

## Context

OP-94 shipped the fan-out that _writes_ the `notifications` collection; OP-96
shipped the outbound crons. Nothing read the collection back: there is no feed
endpoint, no read-state mutation and no unread count, so the bell has no data
source and the collection is write-only.

Two facts shape this lane:

1. **The feed is polled, so it is a hot path.** The badge refreshes on a
   `platformSettings.notifications.pollIntervalSeconds` cadence, which is why
   §7.2 makes the index an observable requirement: the count must run against
   the _partial_ index `idx_user_unread` (`{userId:1, createdAt:-1}` where
   `readAt: null`), and an unchanged answer must be a bodyless `304`.
2. **The catalogue is not stored in every environment.** `account.welcome` is
   emitted from the account-creation hook, but `emitDomainEvent` only marks
   `dispatch.notifications` pending when the type is in the _stored_ catalogue,
   and the fan-out resolves both the type row and its templates from the
   database. The synchronous OTP path already solves this with a
   non-production seed fallback (ADR-0098 §6, ADR-0102); the asynchronous path
   does not, so in an unseeded environment (the Playwright `api` project) a
   welcome notification produces nothing at all. E1 cannot pass without closing
   that gap.

ADR-0128 (`PRE-1`) additionally routed a defect to this lane: an `in_app` group
whose resolved decision is `defer` (quiet hours) wrote **no** feed row, so a
non-critical notification arriving inside quiet hours produced no badge — and
made any end-to-end welcome assertion time-of-day dependent.

## Decision

### Module contract

| Module (specifier)                          | Exports                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@/server/notifications/feed` (new)         | `resolveFeedWindow({ filter, now, windowDays? }): { from: Date; to: Date \| null }`; type `FeedFilter = "active" \| "unread" \| "all" \| "archived"`; the feed projection helper and the `data`/`page`/`summary` response schema the route serializes through |
| `@/server/notifications/unread-count` (new) | `highestSeverity(severities: readonly string[]): NotificationSeverity \| null`; `composeUnreadEtag({ unreadCount, highestSeverity, epochSeconds }): string`; `buildUnreadCountFilter({ userId, now }): Document`                                              |

**`resolveFeedWindow`** maps the `filter` query parameter to the `createdAt`
band:

| `filter` (default `active`) | `from`    | `to`      |
| --------------------------- | --------- | --------- |
| `active`                    | `now−30d` | `null`    |
| `unread`                    | `now−90d` | `null`    |
| `all`                       | `now−90d` | `null`    |
| `archived`                  | `now−90d` | `now−30d` |

A supplied positive `windowDays` (the `window` query parameter) replaces the
filter-derived `from` with `now − min(windowDays, 90) days` and leaves `to`
untouched; it is ignored for `archived` (the band is fixed) and for a
non-positive value. The 90-day cap is the TTL horizon — nothing older exists.

**`composeUnreadEtag`** returns `weakETag(\`${unreadCount}-${highestSeverity ??
"none"}-${epochSeconds}\`)` — matching the §7.2 example
(`W/"3-important-1790086920"`). `epochSeconds`is the greatest`updatedAt`(whole seconds) among the counted rows,`0` when nothing is counted, so any
mutation of the unread set changes the token without a separate counter.

**`buildUnreadCountFilter`** returns exactly
`{ userId, readAt: null, expireAt: { $gt: now } }`. `readAt: null` is what makes
the partial index applicable; `expireAt` excludes rows the ~60 s TTL monitor has
not swept yet (I8).

`highestSeverity` ranks `critical > important > informational`, ignores unknown
values and returns `null` for an empty set.

### Routes (new)

Each exports the handler named after its HTTP verb, guarded with the `user`
label on the shared `defineRoute` pipeline:

| Route file (specifier)                             | Verb     | Status / body                                                                                                                                       |
| -------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@/app/api/v1/me/notifications/route`              | `GET`    | `200 { data, page: { nextCursor, hasMore, limit }, summary: { unreadCount, unreadByCategory } }`                                                    |
| `@/app/api/v1/me/notifications/unread-count/route` | `GET`    | `200 { unreadCount, byCategory, highestSeverity, pollIntervalSeconds, serverTime }` (+ `ETag`, `Cache-Control: no-store`), `304` on `If-None-Match` |
| `@/app/api/v1/me/notifications/{id}/read/route`    | `POST`   | `204`, idempotent                                                                                                                                   |
| `@/app/api/v1/me/notifications/read-all/route`     | `POST`   | `200 { markedCount, unreadCount }`, body `{ before?, category?, eventId? }`                                                                         |
| `@/app/api/v1/me/notifications/{id}/route`         | `DELETE` | `204`, the caller's feed row only                                                                                                                   |

The `unread-count` route declares rate class `read.hot` (§0.11) and the feed
`read.normal`; the read/delete mutations are `write.normal`.

The `{id}` routes read the path segment from the request URL (the pipeline
exposes only `(request)`), exactly like `me/sessions/{sessionId}`. A malformed,
unknown or **foreign** id is `404 not_found` for all three — never `403` — so the
endpoints are not an existence oracle.

### Feed projection

`notifications` rows are stored pre-rendered (design §19.4) but are **projected**
to the §7.1 shape; `title`/`body` are returned verbatim, never re-rendered:

```
id, typeKey, category, severity, title, body, data, groupKey, groupCount,
actionTarget, actions, actionResolvedVia, actionResolvedAt, readAt, eventId,
tenantId, createdAt, updatedAt
```

Two consequences the implementation must honour:

- `id` is the hex string of `_id`; `_id`, `titleKey`, `expireAt` and every other
  never-return field (§0.15) must not reach the wire. `serializeResponse` runs
  the response through its Zod schema strictly, and the specs additionally run
  `findForbiddenFields` over the parsed body (I6). Because
  `findForbiddenFields` does not know `titleKey`/`expireAt`, the projection and
  I6 cases also pin the **exact** key set of a returned item
  (`Object.keys(item).sort()`), so any extra key fails the suite.
- The wire key set is therefore exactly the eighteen fields above, in that
  order-agnostic set: `actionResolvedVia` and `actionResolvedAt` are always
  present and serialize as `null` when the stored row carries no resolution
  (the fixture never stores them, so the projection must default them). The
  unread-count body is pinned to exactly its five fields (§7.2) the same way.
- `category` is **denormalised from the notification catalogue** by `typeKey`
  (the stored row carries `severity` but not `category`). The seed catalogue is
  a compile-time constant, so this needs no database read.

Sort order is `createdAt` desc with `_id` descending as the tie-break; `limit`
defaults to 20 and is clamped to 50; `cursor` encodes `createdAt` + `_id`.
`summary.unreadCount` is the caller's whole unread count — the same number the
`unread-count` endpoint returns — and `summary.unreadByCategory` lists only
non-zero categories.

`read-all` with a `before` instant marks `createdAt < before` — strictly
earlier, so a row created exactly at the cut instant is **not** "created before"
and stays unread. The operator is pinned observably (a row seeded exactly at the
instant stays unread; one 1 ms earlier is marked); `before` is AND-ed with
`category` and `eventId`.

Input fallbacks are explicit: a non-positive or non-numeric `limit` falls back
to the default of 20 (never `0`, never `400`), and an unknown `filter` value
falls back to the default `active` band (never `400`).

### OTP defence in depth

`auth.otp.*` rows must never be returned and never counted, even when one is
stored directly (a fan-out bug, a migration, a manual insert). The exclusion set
is derived from the catalogue's `channelGroups.in_app.enabled === false` types
(schema §19.1), which yields the two `auth.otp.*` keys today, and the read path
must not trust the fan-out's own refusal to write them (design §4 rule 6).

### PRE-1 — quiet hours never suppress the in-app badge

The fan-out's in-app branch must write the feed row for a `send` **or** `digest`
decision and must never be suppressed by a quiet-hours `defer`. Quiet hours are a
sending concern: the outbound half still defers (leaving a `deferred` dispatch
row for the release cron), while the badge — which the user can only discover by
polling — is written immediately.

### E1 and the E1-environment gap

E1 signs up a fresh account over the deployed HTTP surface and asserts the badge
goes `1 → 0`. In the Playwright `api` project the database is empty, so
`emitDomainEvent` skips the event and the fan-out resolves nothing. Either of
these is an acceptable way to satisfy E1 (the spec asserts only the observable
journey, so the choice is the implementer's):

- **(preferred, smallest)** extend the sanctioned non-production seed fallback
  (ADR-0098 §6, ADR-0102) to the emit gate (`getEnabledNotificationTypeKeys`)
  and the asynchronous consumer's type/template resolution; or
- provision the e2e catalogue (`notificationTypes` + `notificationTemplates`)
  before the journey, gated to `test`/`e2e` like the existing test-only OTP
  reader route.

The first keeps the fallback in one place and mirrors the resolving pattern the
synchronous path already ships; the second keeps production write behaviour
untouched. The GREEN card must state which it chose.

## Follow-up RED pins (F1–F7, card `t_321f6091`)

The review of this RED lane (ADR-0130) routed seven findings; the pins below
land **before** the GREEN implementation so it builds against the complete
contract. They change no production file.

| #   | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | **Pinned.** The feed projection and its I6 case now assert the exact §7.1 key set (`FEED_ITEM_KEYS`, 18 keys), and the unread-count I6 case asserts the exact §7.2 key set (`UNREAD_COUNT_KEYS`, 5 keys). `findForbiddenFields` is kept as the shared scanner. This makes the never-return claim real for `titleKey`/`expireAt`, which the scanner does not know.                                                                                                              |
| F2  | **Pinned.** `read-all` gains cases for an `eventId` scope, a `before` scope, and `category` AND `eventId` together; each asserts the out-of-scope rows stay unread and that `markedCount`/`unreadCount` reflect the scoped mutation.                                                                                                                                                                                                                                           |
| F3  | **Pinned.** A pagination case seeds three rows sharing one `createdAt`, so only the `_id`-descending tie-break can order them; it asserts both pages concatenate to the deterministic `_id`-desc order with no row skipped or repeated.                                                                                                                                                                                                                                        |
| F4  | **Pinned.** `?limit=0`/`-5`/`abc`/`` (empty) fall back to the default `20`, and an unknown `filter` (`bogus`) falls back to the default `active` band (never `400`). Both choices are restated above.                                                                                                                                                                                                                                                                          |
| F5  | **Resolved.** The I4 `explain` seeds `EXPLAIN_READ_ROWS = 200` read rows before the four unread rows, so the partial index is the decisive plan rather than a marginal one; the spec docstring records the flake risk and why the size removes it.                                                                                                                                                                                                                             |
| F6  | **Deferred (accepted).** The rate-class binding (`read.normal` feed, `read.hot` unread-count, `write.normal` mutations) has no cheap in-suite assertion: `defineRoute` returns a plain `(request) => Promise<Response>` handler with no inspectable metadata, so a spec cannot read the declared class off the route. The numeric budget is already owned by the rate-limit suite; the binding stays asserted by reference only, and this deferral is the recorded acceptance. |
| F7  | **Done.** The header names the real branch, and the never-return claim above now matches what F1 pins. This ADR is updated in place; its number is unchanged.                                                                                                                                                                                                                                                                                                                  |

### Follow-up settlement (card `t_bd74e9bf`)

The two actionable findings of ADR-0130's round-2 review are closed here, before
GREEN (`t_58825ec3`) implements:

- **A (key set).** Resolved to the **stable 18-key shape** this ADR already
  declares. `docs/API Contract.md` §7.1's example now carries
  `"actionResolvedVia": null, "actionResolvedAt": null` on **both** items (the
  first item previously omitted them), and the `AppNotification` interface now
  declares both as required-nullable (`actionResolvedVia: ResolvedVia | null;`
  / `actionResolvedAt: IsoDateTime | null;`, no `?`). The example, the interface
  and `FEED_ITEM_KEYS` therefore tell one story: the two keys are always present
  and serialize as `null` when unresolved. The omit-when-unresolved alternative
  was **not** chosen, so the pin stays strict.
- **B (`before` operator).** Now recorded above (`createdAt < before`) and made
  observable by a boundary pin in `notification-read-state.test.ts` (a row
  exactly at the cut instant stays unread, so `$lte` would fail the case).

## Consequences

- The feed read path is fully specified: four filter bands, category/event
  scoping, cursor pagination, limit clamping and the exact §7.1 projection.
- The badge path is cheap by contract: the count is index-supported (I4 explains
  the real plan), cacheable (`ETag`/`304`) and never counts OTP or unexpired
  rows.
- The fan-out gains one small behavioural guarantee (PRE-1) that removes a
  time-of-day dependency from both E1 and the user-visible badge.
- The unseeded-environment gap is now explicit and owned, rather than a latent
  e2e flake.

## Alternatives

- **Renderer/route-side re-render of `title`/`body`.** Rejected: design §19.4
  requires the stored strings to be authoritative — a notification says what it
  said when it was sent.
- **A dedicated `unreadCounts` counter document.** Rejected: it adds a
  write-path transaction and a consistency window for a query the partial index
  already answers in one round trip.
- **Strong `ETag`.** Rejected: the badge has no `If-Match`/`PATCH` semantics, so
  the weak comparison (§0.10, `If-None-Match`) is the correct one.
- **`403` for a foreign notification id.** Rejected: it turns the endpoint into
  an existence oracle; the sessions lane already set the `404` precedent.
- **Fixing PRE-1 by making `resolveChannel` return `send` for `in_app`.** Left
  to the implementer; the contract pinned here is only the observable outcome
  (one feed row, email still deferred).
