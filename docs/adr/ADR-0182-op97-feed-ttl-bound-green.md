# ADR-0182 — OP-97 follow-up GREEN: the feed list and the unread badge share one TTL predicate (`expireAt > now`)

- **Status:** Accepted · **Date:** 2026-10-22
- **Card:** OP-97 follow-up (GREEN, `t_167c48ea`) — review finding **F3** of the OP-97 GREEN review (`t_58825ec3`, [ADR-0181](ADR-0181-op97-green-review-signoff.md)) · **Depends on:** OP-97 GREEN ([ADR-0180](ADR-0180-op97-in-app-feed-read-state-unread-count-green.md)), OP-94 fan-out ([ADR-0090](ADR-0090-op94-notification-fan-out-red.md))
- **Contract:** [ADR-0131](ADR-0131-op97-in-app-feed-read-state-unread-count-red.md) (`GET /me/notifications` §7.1) · **Supersedes / amends:** none — this record narrows the feed's read predicate to the one [ADR-0180](ADR-0180-op97-in-app-feed-read-state-unread-count-green.md) §"Modules and routes" already gave `summarizeUnread`; no projection, wire shape or status code changes.
- **RED pin:** `apps/web/src/test/integration/notification-feed.test.ts` §"GET /api/v1/me/notifications — TTL-expired rows (F3)" (card `t_e9c96d6a`, branch `OP-97-task-feed-pin-followups-test`, commit `6e36953`, PR [#246](https://github.com/yahodu/openpic-webapp/pull/246)). The pin is carried into this PR by merge, is **not** edited (not even the comment), and turned green by the implementation below.
- **GREEN PR:** [#249](https://github.com/yahodu/openpic-webapp/pull/249) (branch `OP-97-task-feed-ttl-bound-green`)
- **Number:** drawn from the OP-97 lane's reserved range `0180`–`0199` ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md), `docs/adr/README.md` § "ADR number allocation"). `0180` is consumed by [ADR-0180](ADR-0180-op97-in-app-feed-read-state-unread-count-green.md) and `0181` is **allocated in-flight** to the review sign-off (`t_190f33a2`, branch `OP-97-task-green-review-signoff-docs`, PR #244 — its own README commit advances the lane cell to `0182`). Per ADR-0300 §7 the in-flight allocation counts as taken, so this record — the lane's next newly-started card — takes `0182` and the cell advances to `0183`.
- **Worktree / branch:** `/root/openpic/openpic-webapp/.worktrees/t_f3feed` · `OP-97-task-feed-ttl-bound-green` (cut from `origin/main` `6a50d8d`, then the pin branch merged in, per the OP-92/93/94/97 precedent that a GREEN PR carries its pins).

## Context

The OP-97 GREEN review ([ADR-0181](ADR-0181-op97-green-review-signoff.md)) found
that the feed panel and the bell **disagree about the same row on the same
request**. `GET /api/v1/me/notifications` bounded its read by `createdAt` only
(`route.ts`'s `createdAtFilter`, plus `readAt: null` for `?filter=unread`),
while the shared `summarizeUnread` — the badge, `GET /unread-count`, and the
feed's own `summary` — additionally requires `expireAt > now`
(`buildUnreadCountFilter`, `@/server/notifications/unread-count`).

`schema §19.4` rows carry a TTL (`expireAt = createdAt + retention.notificationDays`,
90 days) swept by a **~60 s** monitor. In the window between a row's `expireAt`
passing and the sweep running, the row was:

- **listed** by `filter=active`, `filter=unread` and `filter=all`, and
- **not counted** by `summary.unreadCount` / `GET /unread-count`.

So a user could see an item in the panel that the bell does not count — and
`?filter=unread` could return a row while `summary.unreadCount` for the same
response said there were fewer unread than the list it accompanied.

The finding was routed to a TEST card (`t_e9c96d6a`, finding F3), which pinned
the intended behaviour RED against `main`: a row seeded with `createdAt` 1 day
ago and `expireAt` 1 day ago must be absent from all three bands, while a live
sibling row stays present in all three and `summary.unreadCount === 1`.

## Decision

**The feed list reads exactly the TTL predicate the unread count reads, and the
predicate lives in one exported builder.**

1. `@/server/notifications/unread-count` exports
   `buildLiveNotificationFilter(now: Date): Document`, returning
   `{ expireAt: { $gt: now } }`.
2. `buildUnreadCountFilter` is now composed from it —
   `{ userId, readAt: null, ...buildLiveNotificationFilter(now) }` — so the
   count's predicate is **byte-for-byte** what it was (no behaviour change on
   the badge path, and `readAt: null` still selects the partial index
   `idx_user_unread`).
3. The feed route spreads the same builder into its `match`:
   `{ userId, typeKey, createdAt, ...buildLiveNotificationFilter(now) }`.

The alternative — re-spelling `{ expireAt: { $gt: now } }` in `route.ts` — was
rejected: two copies of the predicate is exactly the drift that produced this
finding, and the extraction is free (the count path keeps its single
matching query).

Scope is deliberately narrow: **only the read predicate changes.** The four
`filter` bands keep their `createdAt` windows, the `?filter=unread` band keeps
its documented `readAt: null` restriction, the §7.1 projection is untouched
(`expireAt` stays excluded from the wire — `FEED_ITEM_KEYS` already pins that),
and no status code, cursor, `limit`/`window` fallback or `summary` shape moves.

## Consequences

- The panel and the bell agree about a row the TTL monitor has not swept yet:
  a TTL-expired row is neither listed nor counted, on any band.
- `?filter=unread`'s result set is now a **subset of its own `summary`**: the
  list and the count it returns are computed from the same predicate, so the
  band can no longer show more unread than the badge counts.
- The predicate now has one source of truth; a future TTL change (a new
  retention field, a soft-delete flag) edits one function.
- The feed's `find` gains an `expireAt` field in its filter. It is a
  non-selective predicate (it removes at most the not-yet-swept tail) evaluated
  alongside the existing `userId`/`createdAt` range, so the row-selection
  driving index is unchanged; the count path's `explain` pin (I4) is unaffected.
- `filter=archived` (the 30–90 day band) can only ever contain live rows — a
  row of that age has its own 90-day TTL horizon as its upper bound — so the
  TTL bound does not empty that band.
- Any read path that lists stored rows without binding `expireAt` is now a
  **defect by construction** rather than a per-route judgement call.

## Evidence

- RED before the fix (pin branch `6e36953`, unmodified tree):
  `FAIL … F3: never lists a row whose expireAt has already passed …`
  `expected [ '6ad9c329f14d54dd57a263cf', …(1) ] to deeply equal [ '6ad9c329f14d54dd57a263ce' ]`
  (`notification-feed.test.ts:513`); `1 failed | 13 passed` in that spec.
- GREEN after the fix — see the card handoff for the full-suite counts
  (`vitest run --project integration` 61 files / 402 passed, `--project unit`
  89 files / 1565 passed). The pin file itself is 14/14.

## Alternatives

- **(b) Re-spell `expireAt: { $gt: now }` in the feed route** — rejected: two
  copies of one predicate is the drift this ADR exists to end, and the next TTL
  change would have to find both.
- **(c) Filter expired rows out in the projection / response layer** — rejected:
  it would still fetch them, would not fix `summary.unreadCount`'s
  non-agreement at the source, and would leave `hasMore`/`nextCursor` counting
  rows the caller can never see.
- **(d) Rely on the TTL monitor alone (no read bound)** — rejected: the ~60 s
  sweep window is exactly the observed divergence; a read path must not depend
  on a background job's latency for correctness.
- **(e) Bind `expireAt` on the count only (status quo) and change the badge to
  match the list** — rejected: it would count rows that are already dead, which
  is the opposite of the contract's "TTL-expired rows no longer exist".
