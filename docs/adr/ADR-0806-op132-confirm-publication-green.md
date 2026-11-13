# ADR-0806 — OP-132 GREEN: the confirmation publishes once, counts the new matches, and recovers a late worker result

- **Status:** Accepted
- **Consumers:**
  `apps/web/src/app/api/v1/p/events/[slug]/selfies/[selfieId]/confirm/route.ts` —
  the handler's `newMatches` / `dedupeKey` / `willPublish` block and the
  docblock paragraph that names this record.
- **Lane:** the shared attendee block `0780`–`0798` (row
  `OP-129 attendee identity lane`) is **exhausted**: [ADR-0799](ADR-0799-op133-preview-url-selfie-summary-pins.md)
  through [ADR-0805](ADR-0805-op132-confirm-publication-pins.md) drew from the
  `unallocated (future lanes)` pool and advanced both cells to `0806`. At this
  head the sweep was **empty**: no worktree under `.worktrees/` carries an
  `ADR-0806*` file, no local branch mentions `0806` in `docs/adr`, the trunk's
  newest record is `0804`, and the three open PRs that touch `docs/adr`
  (556, 545, 539) add no `0806` file. This record draws **`0806`** and both
  cells advance to `0807`. No new lane row is minted.
- **Amends:** [ADR-0805](ADR-0805-op132-confirm-publication-pins.md) (the pins
  this GREEN makes true) and, through it, [ADR-0792](ADR-0792-op132-liveness-selfie-green.md)
  — the confirmation half of the selfie contract, which pinned exactly one
  confirm and never a repeat.
- **Consumes:** `0806`.

## Context

Review finding **F3** (Medium) of `t_3b8151c3` / PR #543. The parent TEST card
`t_ab2af8f3` pinned three behaviours in
`apps/web/src/test/integration/selfie-confirm-publication.test.ts` and measured
them red on the trunk: a repeat confirm inserted a **second**
`attendee.matches.new` row, the second selfie's delivery carried the profile's
**total** (`count: 5`) instead of its own new matches (`2`), and a worker result
that landed after the activation was published only by a second confirm which
then inserted a **second** row.

The route had three separate defects behind that list:

1. no identity for the delivery, so every call emitted;
2. `payload.count` was `countDocuments({ profileId })` — the §6.4 total;
3. `firstMatchNotifiedAt` (schema §15.3) was never written, so nothing recorded
   that a delivery had happened.

## Decision

### 1. The confirmation is the only publisher; a late result's publisher is OPEN

The worker does **not** publish, because the pin forbids it: after the worker
writes the embedding and the matches for an already-active row,
`matchesNewRows()` is still empty, so a worker-side publisher would fail case 3
of `selfie-confirm-publication`. Nothing else in the shipped app emits
`attendee.matches.new` either — the confirm route is the only emitter in `apps/`
— and the confirm's own `200` body points the client at
`pollUrl: /api/v1/p/events/{slug}/me`, which is **read-only**: `GET …/me` never
emits a domain event, and contract §6.4 calls it the single polling endpoint. So
no shipped path re-issues the confirm after the worker finishes.

**Recorded as a gap, not as solved:** item 3 of the GREEN card ("a late worker
result publishes without the client calling confirm again") is **not
delivered**. A late worker result is announced only by a second,
self-initiated confirm, and nothing asks the client to send one. A single
confirm that arrives after the worker is still enough on its own — case 3 proves
that, and `status`/`matchCount` are correct from that confirm on.

Who publishes a worker result that lands after the confirm is an **open
decision**, routed to `t_b0bf2ff2` (orchestrator): (a) the pipeline publishes at
the match-insert seam, with case 3's emptiness assertion revised; (b) the client
re-confirms as the documented recovery, with a contract amendment and a
client-side POST the poll cannot send; or (c) the confirmation stays the only
publisher and the contract records the gap as a known limit. This record does
not pre-empt that choice. **The DOCS card `t_a1fbb7a7` must not write a
poll-driven re-confirm sentence** unless (b) is chosen.

### 2. The delivery counts the rows **this selfie** produced

`newMatches` is `countDocuments({ profileId, selfieId })` — the rows whose
`selfieId` is the row being activated (§17.5 carries `selfieId`; the worker
writes it on every match it finds). `attendeeEventProfiles.matchCount` stays
`countDocuments({ profileId })`, the §6.4 total, so a second selfie's delivery
carries its own `2` while the profile reports `5`.

This is the card's own sentence ("the count of matches this selfie produced
since the last notification") and it is the only candidate anchor that **cannot
tie on a timestamp**:

- a watermark of the confirm's `now` with `createdAt > watermark` silently skips
  a match written in the same millisecond — the parent record flagged exactly
  that hazard, and a recovery confirm races its own worker by definition;
- a `faceMatches.notifiedAt` stamp would be exact but adds a field §17.5 does
  not document, in a lane whose sibling card (`t_a1fbb7a7`) exists to close
  contract drift.

### 3. The outbox row is the idempotency record

The delivery carries a deterministic `dedupeKey`,
`attendee.matches.new:<eventId>:<profileId>:<selfieId>` — one identity per
activation result, the same key shape the rest of the codebase mints
(`auth.signin.new_device:<user>:<hash>`, `collab.invite.sent:<id>`). §10.3.2
already makes the outbox's unique partial index the dedupe point, so a repeat
confirm cannot insert a second row even under concurrency.

**The existence of that row is checked before the insert, not by catching the
collision.** A duplicate key inside a transaction aborts the whole transaction
(measured: `withTransaction` retried three times and the request answered
`500 internal_error` — `TransactionRetryLimitError`), so a bare `emitDomainEvent`
with a colliding key turns an idempotent repeat into a server error. The handler
therefore counts `{ dedupeKey }` on the outbox first and emits only when the
count is `0`; the unique index stays the concurrency backstop.

### 4. `firstMatchNotifiedAt` is stamped by the first delivery, in the transaction

When a delivery happens and the profile has no watermark yet, the same
transaction sets `firstMatchNotifiedAt: now` (§15.3). It is stamped only on the
first delivery and never moved, so the schema's "fires exactly once" anchor
exists for whatever owns `attendee.matches.ready`, and a crash between the emit
and the stamp cannot re-announce (both are in one transaction).

Nothing else changes: the `200` envelope keeps its seven §6.3 keys, the five
existing status codes are untouched, and a confirm whose result is not yet
published still answers `processing`.

## Consequences

- A repeat confirm updates the row and answers the same envelope, and emits
  nothing — the state arm the pin measures.
- Two selfies on one profile produce two deliveries whose counts add up to
  `matchCount` (3 + 2 = 5 in the pin).
- A late worker result publishes on the next confirm, once — but nothing
  shipped issues that confirm (§1; open on `t_b0bf2ff2`).
- **The dedupe record ages out with the outbox:** the row's
  `expireAt = occurredAt + retention.domainEventDays` (default 180), so a
  re-confirm after the row has been purged emits a second
  `attendee.matches.new` for the same selfie. `firstMatchNotifiedAt` is
  profile-level and does not cover a later selfie, so it cannot serve as the
  backstop. `shortcut:` outbox-lifetime idempotency; revisit if a permanent
  delivery ledger is ever needed.
- **Known limit, recorded deliberately:** the delivery's identity is the
  selfie, so a _re-run_ of the worker for an already-announced selfie (a new
  event photo matched later against the same selfie) cannot re-announce through
  the confirmation — the key already exists. Those arrivals belong to the
  pipeline's own `attendee.matches.new`/`attendee.matches.ready` path (§15.3),
  which is out of this route's scope. `shortcut:` in code terms: one delivery
  per activation result; revisit if the pipeline is expected to leave later
  arrivals to the confirmation.
- The outbox is read once per confirm that has new matches (one indexed lookup
  on `domain_events_dedupe_unique`); a confirm with nothing new does not query
  it.
- The mechanism is still invisible to the client: the pins assert the row count
  and the payload count, never a field name.

## Verification (this head)

| gate                                                           | result                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| the three F3 pins, `selfie-confirm-publication`                | 3 passed (3) — measured 3 failed (3) before the change |
| the eight frozen neighbour files (OP-132 + OP-131 + OP-133)    | 8 files passed, no test file modified                  |
| `tsc -p tsconfig.json`, `-p packages/contracts`, `-p apps/web` | exit `0`                                               |
| full `unit` project                                            | 175 files, 2909 passed \| 3 skipped (2912)             |
| full `integration` project                                     | 118 files, 1267 passed (1267)                          |

No test, fixture, helper or MSW handler was edited — the only changed production
file is the confirm route.

## Alternatives

1. **Watermark + delta (the parent record's near-fix).** Rejected on the
   timestamp tie it documents: it satisfies the three pins but can skip a match
   written in the watermark's millisecond.
2. **`faceMatches.notifiedAt` per row.** Rejected: exact, but an undocumented
   §17.5 field in a drift-sensitive lane.
3. **`dedupeKey` alone, letting the index swallow the collision.** Rejected on
   measurement: the collision aborts the transaction and the repeat answers
   `500`. It works only because the pre-read keeps the collision from happening.
4. **A worker-side publisher.** Rejected: the pin asserts the outbox is empty
   after the worker writes.
5. **A state guard on `activeSelfieId` + `firstMatchNotifiedAt`.** Rejected: the
   watermark is per profile, not per selfie, so confirming selfie B after A was
   announced would suppress B's first delivery. `B`'s outbox row, keyed by
   selfie, has no such hole.
