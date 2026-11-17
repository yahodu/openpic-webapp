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

### 1. The confirmation is the only publisher **in this repo**; the pipeline owns the late result (ADR-0808)

The confirmation is the only emitter of `attendee.matches.new` that ships at
this head: a grep over `apps/` and `packages/` finds the catalogue entry and
`…/confirm/route.ts` and nothing else, and the confirm's own `200` body points
the client at `pollUrl: /api/v1/p/events/{slug}/me`, a **read-only** `GET`
(contract §6.4, "the single polling endpoint") that never emits a domain event.
A worker result that lands after the activation is therefore announced only by a
second, client-initiated confirm, and no shipped client-facing text asks for one.

**The pin does not forbid a worker-side publisher.** Case 3 reads
`matchesNewRows()` after `runWorker`, but `runWorker` → `finishSelfieWorker`
(`apps/web/src/test/helpers/selfie-flow.ts:638`) writes the embedding and the
match rows with raw driver calls on `app.db`; no production code runs between
those writes and the read, so the assertion cannot fail whatever a future
publisher does. It observed an absence, it did not constrain one — corrected in
ADR-0808 §2.

**The late result belongs to the pipeline** (`t_b0bf2ff2`, ADR-0808): the worker
runs the match, and its publication transport is the internal endpoint
`POST /api/v1/internal/domain-events` (OP-135 §1, `dedupeKey` honoured), with
the profile projection written by `POST /api/v1/internal/worker/report` (OP-135
§3) and the incremental run enqueued by `pipeline-sweep` step 4 (OP-136 §2).
Neither endpoint ships yet — `apps/web/src/app/api/v1/internal/` holds only
`cron/` — so this is the owner, not a delivered path.

**Both publishers share one identity per activation result**,
`attendee.matches.new:<eventId>:<profileId>:<selfieId>`: the confirm reads that
`dedupeKey` before it emits, so whichever publisher writes first, exactly one
row exists and the second is a no-op (pinned by case (i) of
`selfie-confirm-publication`). A later **arrival** for an already-announced
selfie is a different delivery and needs a key that carries the run; that key
belongs to the pipeline's incremental run (ADR-0808 §3).

**The DOCS card `t_a1fbb7a7` must not write a poll-driven re-confirm sentence**
— decision (a), not (b) (ADR-0808 §4).

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
  shipped issues that confirm (§1; decided in ADR-0808 §1 — the pipeline owns
  it, and that writer does not ship at this head).
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
  pipeline's own `attendee.matches.new` path (worker
  `POST /api/v1/internal/domain-events`, OP-135 §1; incremental run
  `pipeline-sweep` step 4, OP-136 §2), which **does not ship yet** — nothing in
  `apps/` emits them. `t_b0bf2ff2` (ADR-0808) assigns that publication to the
  pipeline; the confirmation's per-selfie key cannot announce a later arrival.
  `shortcut:` in code terms: one delivery per activation result; revisit if the
  pipeline is expected to leave later arrivals to the confirmation.
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
4. **A worker-side publisher.** Not adopted at this head: there was no writer to
   call — no worker application ships in this repo, and the internal API surface
   under `apps/web/src/app/api/v1/internal/` holds only `cron/` — so a
   worker-side publisher would have needed a production route that does not
   exist (the upstream worker endpoints land with OP-135/OP-136). The pin did
   not decide this: as §1 records, its emptiness read observed an absence
   rather than constraining a publisher. ADR-0808 §1 assigns the late-result
   publication to the pipeline, and §2 corrects the inference drawn from case 3.
5. **A state guard on `activeSelfieId` + `firstMatchNotifiedAt`.** Rejected: the
   watermark is per profile, not per selfie, so confirming selfie B after A was
   announced would suppress B's first delivery. `B`'s outbox row, keyed by
   selfie, has no such hole.

## Review sign-off (OP-132 GREEN F3, round 2 — execution lens)

**Verdict: APPROVED WITH FINDINGS.** The delivery is PR #557, reviewed at head
`e5af1ac` (card `t_ed3785df`) and squash-merged as `fa350d3`. The squash kept
the tree exactly: `git rev-parse e5af1ac^{tree}` == `fa350d3^{tree}` ==
`e4c656480279999acb706721f65df4d13ef8c017`, and `git diff e5af1ac fa350d3` is
empty per path, so every measurement below holds for both commits. The branch
was auto-deleted on merge and local `main` == `origin/main` == `fa350d3`. As
with the ADR-0664, ADR-0681, ADR-0781, ADR-0786 and ADR-0802 precedent, the
verdict is recorded **inside** the delivered record: no new ADR number is
consumed and the shared ledger is not touched.

Nothing in this record's §Decision sections is retracted. §1's decision — the
confirmation is the only publisher that **ships in this repo** — stands, and §2
to §4 are unchanged. What the follow-ups corrected is §1's _justification_,
which ADR-0808 §1–§2 now records. Every ADR number this section cites is on the
trunk at writing (`c62000f`); no in-flight number is referenced, and the
follow-ups that had not merged at review time are cited by card id.

### Measured on the merged trunk

| gate                                                    | result                                       |
| ------------------------------------------------------- | -------------------------------------------- |
| focused `integration`, the three confirm-adjacent specs | 3 files / 31 passed                          |
| full `unit` project                                     | 175 files, 2909 passed, 3 skipped (2912)     |
| full `integration` project                              | 118 files, 1267 passed (1267)                |
| `tsc -p apps/web --noEmit`                              | exit `0`                                     |
| `prettier --check`, the record, the route and the pin   | clean                                        |
| the five ADR guards                                     | 5 files / 218 passed (218)                   |
| PR checks at `e5af1ac`                                  | 14/14 pass                                   |
| the ledger                                              | 311 records, no duplicate, both cells `0807` |

The focused set is `selfie-confirm-publication.test.ts` (3 cases),
`liveness-selfie-submit.test.ts` (21) and `selfie-reuse.test.ts` (7), all green
with no case edited. The 14 PR-check entries are `ci`, `test_coverage`,
`unit_test`, `lint`, `audit`, `audit-dev`, `secret-scan`, `env-changes`,
`validate-branch-name`, `validate-pr-title`, the evidence guard and the three
CodeQL entries; the rollup now also carries the `notify-discord` close
side-effect run, which is not a pre-merge gate. The ledger figures are the
`docs/adr` census at `fa350d3`: 311 `ADR-NNNN` records, 311 distinct numbers, and
both `Next free` cells (`OP-129 attendee identity lane`, `unallocated (future
lanes)`) at `0807`.

### Round-1 corrections verified

The round-1 request was comment-only: no behaviour change and no test change.
All three landed:

- §1 was retitled and now records the measured facts, including that case 3's
  emptiness assertion cannot fail because `finishSelfieWorker` writes with raw
  driver calls.
- the route docblock was aligned with the record's wording.
- the §Consequences outbox-TTL sentence was added.

The pin file is untouched by that work: `selfie-confirm-publication.test.ts`
carries the blob `a1729b4ced14bb8c47a761d84617e88c1c18d92a` at `545ffb9`, at
`e5af1ac` and at `fa350d3` — one blob, three refs.

### Load-bearing probes

Each probe ran in a throwaway worktree detached at `fa350d3` (the merged tree),
mutated one production statement and was reverted byte-identically afterwards
(`git status` clean):

| mutation                                          | measured result                                       |
| ------------------------------------------------- | ----------------------------------------------------- |
| `newMatches` counts the profile total again       | 1 failed, 2 passed — only the count case reddens      |
| the dedupe pre-read is deleted                    | 2 failed, 1 passed — the repeat confirm answers `500` |
| the §15.3 `firstMatchNotifiedAt` stamp is deleted | 24 passed, 0 failed                                   |

The third row is the Low finding below: the stamp was genuinely unobserved,
which is why the pin card exists rather than a comment.

### Findings and routing

| severity         | finding                                                                                                                                                                                               | route                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Low              | the §15.3 `firstMatchNotifiedAt` stamp was unobserved — deleting it left 24 passed, 0 failed                                                                                                          | card `t_fba391ab`, pinned as ADR-0824 (PR #590)                                 |
| Low              | §1's "would fail case 3" justification and the §Consequences "the pipeline's own path" sentence were imprecise: case 3's emptiness assertion is vacuous, because `finishSelfieWorker` writes raw rows | corrected on the trunk by PR #560 / ADR-0808 §1–§2 (decision card `t_b0bf2ff2`) |
| Medium (round 1) | two simultaneous confirms answered `[200, 500]`; the loser's outbox insert collided and aborted its transaction                                                                                       | pins card `t_6e555aa3`, GREEN `t_6e62ee84` — recorded as ADR-0816 and ADR-0817  |
| Info             | item 3 of the GREEN card, a shipped recovery path for a late worker result, is not delivered by this record; the publication-ownership question it left open is decided in ADR-0808 §1                | ADR-0808 §1; the writer itself lands with OP-135/OP-136                         |

No finding was left for a later reader to infer: the two Low items each have an
owner, and the Medium one was pinned and repaired in its own pair before this
sign-off was written. The burst of more than two simultaneous confirms, which
ADR-0817 §Consequences disclosed as unpinned, was pinned separately (ADR-0821)
and given its attempt budget by ADR-0823 — that chain follows from the same
Medium finding and is documented by those records, not by this one.

This section adds no executable claim and changes no test, helper, fixture or
production file. It records a verdict, so the mechanics it describes are frozen
where they were measured: a later change to the confirm route is governed by
ADR-0808 and by the pins named here, not by this paragraph.
