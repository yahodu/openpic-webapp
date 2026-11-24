# ADR-0879 — OP-136 TEST: the drain of the three emit-only sweeps, and the decision of record for it

- **Status:** Accepted (RED pins + decision of record) · **Date:** 2026-11-19
- **Card:** the decision card OP-136 `t_c32ed838` (Medium) and the TEST card
  `t_957106bc` (Medium) that carries these pins and this record. Branch
  `OP-136-task-sweep-drain-shapes`, worktree
  `/root/openpic/openpic-webapp/.worktrees/op136-sweep-drain`. The decision was
  taken at `origin/main` `78b70894`; the pins were rebased onto the trunk
  `61d7e947` before minting this number (see §Number allocation), and the three
  job modules are **byte-identical** between the two bases
  (`git diff --stat 78b70894 61d7e947 -- apps/web/src/server/jobs/<job>.ts` is
  empty for all three; the only `jobs/` paths that moved are
  `pipeline-indexed-check.ts`, `pipeline-sweep.ts` and `usage-threshold-check.ts`).
- **Implements:** contract §10.2 (the `attendee-no-match-check`,
  `upload-session-sweep` and `verification-nudge` cron rows — the per-run
  `limit`, `hasMore` and idempotence rules), §6.4 (the cached `matchCount`), §5.5
  (the verification ladder) and §1.4 (profile readiness); schema §15.3
  (`attendeeEventProfiles`) and §16.2 (`upload_sessions`), with §22 for the
  retention of both.
- **Consumes:** [ADR-0860](ADR-0860-op136-indexed-check-scan-drain-shape.md) §1
  (the decided page shape for the same class of query — a deterministic
  `.sort({ _id: 1 }).limit(limit)` over a class whose rows must be able to leave,
  and the input-copy `$expr` latch on `pipeline-indexed-check`); the
  [ADR-0861](ADR-0861-op136-indexed-check-scan-window-drain-green.md) GREEN that
  implemented §1 in that file; [ADR-0856](ADR-0856-op136-sweep-failure-windows-resume.md)
  §2 (**emit first, marker second** — the ordering every marker below follows);
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 (number
  allocation) and [ADR-0306](ADR-0306-op101-stale-branch-deletion.md) (a RED pin
  PR is a draft and is never squash-merged).
- **Consumers:** `apps/web/src/test/integration/job-sweep-drain.test.ts` (the new
  spec's header cites this record for the shape it pins).
- **Number allocation:** `0879`, a **pool draw**. The `OP-136 jobs lane` block
  `0849`–`0868` is exhausted and keeps its range (§11 items 18–21), so both the
  lane cell and the `unallocated (future lanes)` cursor are drawn. The sweep
  immediately before minting, on the trunk `61d7e947`, found: **both cells read
  `0879`**; the highest record on the trunk is `0878`; `git rev-list --objects
--all -- docs/adr` carries no `ADR-0879`/`ADR-0880` path and tops out at
  `0878`; every live `.worktrees/*/docs/adr` tree tops out at `0878` (or at
  `0876`/`0305` in the older trees); the four open PR heads — #731 `249a3c96`,
  #729 `50d7dbc1`, #690 `7cc2b270`, #272 `d5be9af4` — top out at `0878`, `0878`,
  `0876` and `0305`; and no non-`done` board card names `0879` or `0880` as a
  `Consumes` value. Both cells therefore advance to **`0881`**, one above this
  record and the GREEN reservation below it, so neither cell can re-mint
  `0879`. The GREEN card `t_4b75e4ba` draws **`0880`**; row `0880` landed in that
  later docs card, and
  [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) now requires the
  row with the record.
  **Deviation recorded:** the allocator's last instruction named `0873`/`0874`
  with both cells at `0875`. `0873` is free on every surface, but it is now
  _below_ both the trunk cursor (`0879`) and the highest in-flight number
  (`0878`, reached by `ADR-0875`–`ADR-0878` landing after that instruction), so
  taking it would (a) violate §11 rule B — the number must be the next free one
  _above the highest in-flight number_, never a value from a snapshot — and
  (b) require **lowering** both cells from `0879` to `0875`, which the same
  instruction forbids and §11 forbids outright. The draw is therefore the cursor
  the sweep actually read.

## Context — the defect, measured at `78b70894`

The three jobs are documented as sweeps, but their loops only **emit**. No write
in the loop changes a state that the candidate query reads, so a row that is
never resolved keeps its slot in the page for ever — the same fixed-page
starvation [ADR-0860](ADR-0860-op136-indexed-check-scan-drain-shape.md) fixed for
`pipeline-indexed-check`, on the same class of query.

| Job                                                   | Candidate query (`78b70894`)                                                                                                                                   | Does the loop write state the query reads?                                                                                                                                                                                      |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/server/jobs/attendee-no-match-check.ts` | `:56` `find({ status: "ready", matchCount: 0, lastMatchRunAt: { $ne: null } })`, `.limit(limit)` `:57`, no `.sort()`                                           | **No.** `:67-79` calls `emitDomainEvent` only; `grep -nE "updateOne\|updateMany\|findOneAndUpdate\|insertOne\|deleteOne\|bulkWrite\|\$set\|\$inc"` on the file returns **nothing**.                                             |
| `apps/web/src/server/jobs/upload-session-sweep.ts`    | `:67-72` `find({ status: "in_progress", updatedAt: { $lt: addDays(now, -1) }, "externalRefs.kind": "multipart_upload" })`, `.limit(limit)` `:72`, no `.sort()` | **No.** `:87-103` emits only; the same write-op grep returns **nothing**.                                                                                                                                                       |
| `apps/web/src/server/jobs/verification-nudge.ts`      | `:93` `find({ emailVerified: { $ne: true }, createdAt: { $lte: addMilliseconds(now, -MIN_AGE_MS) } })`, `.limit(limit)` `:94`, no `.sort()`                    | **Only on another collection.** `:141` `updateOne(… { $inc: { verificationNudges: 1 } })` writes `COLLECTIONS.userProfiles`, while the candidate query reads Better Auth's `user` collection, so the filter **cannot** read it. |

The dedupe keys (`attendee.matches.none_found:<profileId>` `:74`,
`upload.session.stalled:<sessionId>` `:98`,
`account.verification.incomplete:<userId>:<point>` `:132`) stop a second
_emission_. They do not remove the residency. Each query is therefore a fixed
prefix of its class: every row ordered past the first `limit` is never examined,
while `hasMore: scanned >= limit` (`:88`, `:112`, `:152`) reports a backlog that
can never drain.

The residency is permanent or long in each case, and that asymmetry is what the
three dispositions below answer:

- **`attendeeEventProfiles`: no TTL and no index spec.** §22 of
  `docs/Notification and Database Design.md` lists the collection under the
  **application purge job** only (events that carry `retentionExpiresAt`), and
  `INDEX_SPECS` in `apps/web/src/server/db/indexes.ts` carries **no**
  `attendeeEventProfiles` entry (`grep -c attendeeEventProfiles` → `0`). For an
  event with `retentionExpiresAt: null` the row lives for ever.
- **`upload_sessions`: TTL-reaped at five days.** `indexes.ts:107-112` declares
  `upload_sessions_expire_at_ttl` on `expireAt` with `expireAfterSeconds: 0`
  (§16.2 and §22 both state five days), so that residency is bounded to ≤5 d —
  at most four days of starvation after the one-day idle threshold.
- **`user`: never reaped.** Better Auth's own table, absent from §22, so an
  account that never verifies holds a slot for ever. The ladder itself is finite
  and time-keyed: `NUDGE_RUNGS` is `t+24h` and `t+72h` (`sweep-decisions.ts:55-58`),
  capped at two, walked by count; `verificationNudgePoint`
  (`sweep-decisions.ts:209-224`) returns `null` as soon as
  `nudgesSent >= NUDGE_RUNGS.length` (`:215`), so a capped row is skipped on every
  run for ever **and keeps its slot**.

## Decision

All three candidate queries gain a deterministic page —
`.sort({ _id: 1 }).limit(limit)`, exactly as
[ADR-0860](ADR-0860-op136-indexed-check-scan-drain-shape.md) §1 did. `hasMore`
stays `scanned >= limit`, and no dedupe key changes. Each job then gains **one**
disposition that lets a row leave the window, chosen from the shape of its own
residency and its own dedupe contract.

### §1 `attendee-no-match-check` — an input-copy latch that re-opens by itself

After the emit, the loop stores a copy of the two inputs its candidate class
depends on:

```ts
// written after emitDomainEvent (emit first, marker second — ADR-0856 §2)
{ $set: { noMatchNotifiedFor: { matchRunAt: row.lastMatchRunAt, matchCount: 0 } } }
```

and the candidate filter compares that copy with the live values:

```ts
{
  status: "ready",
  matchCount: 0,
  lastMatchRunAt: { $ne: null },
  $expr: { $or: [
    { $eq: [{ $type: "$noMatchNotifiedFor" }, "missing"] },
    { $ne: [{ $ifNull: ["$noMatchNotifiedFor.matchRunAt", null] }, "$lastMatchRunAt"] },
    { $ne: [{ $ifNull: ["$noMatchNotifiedFor.matchCount", null] }, "$matchCount"] },
  ] },
}
```

A row leaves the window when it is stamped and **re-opens by itself** when a
later match run advances `lastMatchRunAt` (the watermark write is
`pipeline-sweep.ts:288-295` at `78b70894`) or when `matchCount` moves — the exact
analogue of ADR-0860 §1's counter triple. It is deliberately **not** a terminal
disposition: a terminal marker would suppress the re-evaluation of a profile
whose inputs move, and the field must never be shared with — nor gate —
`firstMatchNotifiedAt`, the separate once-only latch for
`attendee.matches.ready` (§15.3). No write is added to the match path, so a
future rewrite of that path cannot silently break the notice. A re-opened row's
re-emission is deduped by the profile-terminal key, so its only observable is one
wasted scan slot, never a second notification.

**Rejected:** a terminal `noMatchNotifiedAt` stamp. It is cheaper and it drains,
but it suppresses the notice for the exact case the notice exists for — a
profile that is re-matched later and still finds nothing — and it would have to
be cleared by the match path, re-coupling the two modules that this shape
deliberately keeps apart.

### §2 `upload-session-sweep` — a terminal latch, aligned with the session-terminal key

```ts
// filter: adds stallNotifiedAt: null  (Mongo matches missing or null)
{ status: "in_progress", updatedAt: { $lt: addDays(now, -IDLE_LIMIT_DAYS) },
  "externalRefs.kind": "multipart_upload", stallNotifiedAt: null }
// written after the emit:
{ $set: { stallNotifiedAt: now } }
```

Terminal is correct **here** because the contract's own dedupe key is
session-terminal ("once per session", the module's `:12-22` docblock and §10.2):
re-opening a resumed-then-restalled session could never emit again — the key is
still spent — so re-opening it would only re-take a slot. The row is TTL-reaped
within five days anyway, so a terminal marker cannot hide a live condition for
long.

**Rejected:** the input-copy latch of §1. `updatedAt` moves on every resume, so
an input-copy latch would re-admit every resumed session on every idle cycle for
no observable benefit.

### §3 `verification-nudge` — a clock-keyed window, no marker and no schema change

```ts
// MIN_AGE_MS stays 1 day; the upper bound is the ladder's own last rung plus one cadence day
createdAt: {
  $lte: addMilliseconds(now, -MIN_AGE_MS),                       // >= 24 h old (unchanged)
  $gt:  addMilliseconds(now, -MAX_CANDIDATE_AGE_MS),              // <= 96 h old (72 h + 24 h)
}
```

Why this drains and does not lose a rung: the ladder is **finite and
time-bounded by construction** — rungs at 24 h and 72 h, cap two, walked by
count — so once an account is older than `72 h + one cadence day` it has no rung
left (`verificationNudgePoint` returns `null` at `nudgesSent >= 2`, and the last
offset has long passed) and it is not a candidate _by the feature's definition_,
not by a heuristic. The extra 24 h of grace is exactly one hourly-cadence day, so
a single missed run cannot silently drop the `t+72h` rung. Rows therefore leave
the window **by the clock** — the shape this card's own list calls genuinely
draining (`retention-warnings`). No field is added to Better Auth's `user` table,
and `verificationNudgePoint` is **not** touched: the count-walked ladder stays
the single oracle.

**Rejected:** a candidate query driven by `userProfiles`
(`verificationNudges: { $lt: 2 }`). That collection holds neither `createdAt` nor
`emailVerified`, the missing counter needs an `$exists` disjunction, and a
verified user whose `accountCompletedAt` is null would re-create the residency
this change exists to remove. Also rejected: stamping a `nudgeWindowDone` field
on Better Auth's `user` table — a schema change to a table this application does
not own, for a fact the clock already knows.

## Accepted residual

A row that misses **both** rungs by more than a day each (a cron outage longer
than 24 h spanning the second rung) leaves the window un-nudged rather than
nudged late. This is stated, not widened: the bound is the ladder's own last rung
plus one cadence day, and widening it silently would trade a measurable
starvation bound for an unbounded window. The pin `S5` encodes it as an
executable expectation (`pastLadder` → `0`), so a future widening reds a case.

## Severity (decided)

| Job                       | Severity   | Why                                                                                                                                                  |
| ------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attendee-no-match-check` | **Medium** | Unbounded residency on a never-TTL'd collection, and the contract-mandated empty-gallery notice is silently skipped for every profile past the page. |
| `upload-session-sweep`    | **Low**    | Residency capped by the five-day TTL; only more than `limit` stalls inside a ~4-day window bite.                                                     |
| `verification-nudge`      | **Medium** | Unbounded residency on a never-reaped table; the ladder is time-bounded, so the fix is exact.                                                        |

One GREEN card (`t_4b75e4ba`) covers all three: same directory, same test
family, three filter-plus-marker edits — three branches would triple CI and
review cost for no isolation benefit.

## Pin inventory

New spec: `apps/web/src/test/integration/job-sweep-drain.test.ts` (+551/−0).
Neither `attendee-no-match-check` nor `upload-session-sweep` had any coverage at
`78b70894` (`grep -rn "attendeeNoMatchCheck\|uploadSessionSweep" apps/web/src/test`
was empty), so the file adds coverage rather than editing an assertion; no
existing spec, helper, fixture or frozen ADR-0849/0852/0853/0856 case is edited.

- **S1 — the attendee window drains.** Three `ready` profiles, `matchCount: 0`,
  `lastMatchRunAt` set, `activeSelfieId: null`; `requestedLimit: 2`, two runs.
  Run 2 must reach the third profile: one `attendee.matches.none_found` per
  profile, three rows in total, and run 2's `details.noneFound` is `1`.
- **S2 — a re-opened row does not wedge the page.** After run 1 (page of two),
  the _first_ profile's `lastMatchRunAt` advances; a second run must stamp and
  reach the one still-unstamped profile, the re-opened profile must still have
  **exactly one** outbox row, and a third run must report `details.noneFound: 0`.
- **S3 — the stall window drains, once per session.** Three `in_progress`
  sessions older than the idle limit, each with a `multipart_upload` external
  ref and a `tenantId`; `requestedLimit: 2`, two runs. Run 2 must reach the third
  session, each session ends with exactly one `upload.session.stalled`, and
  `details.stalled` is `1` on run 2. Then the first session's `updatedAt` is
  advanced (a resume) and a third run adds no row for it and gives it no slot.
- **S4 — the nudge page is not spent on a ladder-exhausted account.** A `user`
  created 120 h ago whose `userProfiles` row carries `verificationNudges: 2` is
  inserted **first**; behind it three unverified users at 30/40/50 h with
  `verificationNudges: 0`. One run with `requestedLimit: 2` must nudge **two**
  of the eligible accounts, and the exhausted row gets none.
- **S5 — the window's edges are the ladder's own.** A 20 h-old unverified user is
  not nudged (first rung not due); a 30 h-old one with `verificationNudges: 0` is
  nudged at `t+24h`; an 80 h-old one with `verificationNudges: 1` **is** nudged at
  `t+72h` (the upper bound keeps a last-rung-due row reachable); a 120 h-old one
  with `verificationNudges: 0` is **not** nudged (the accepted residual above).

**The no-marker rule (ADR-0860 §4 vocabulary).** A pin asserts observables, not
mechanism. No case names a marker field, a constant, an `$expr`, a sort key or a
`scanned`/`hasMore` value: a correct implementation with a different field name, a
different window bound inside the stated margins, or an ordered cursor must pass.
The assertions are the outbox rows (event key, subject, count, `payload`) and the
`details` counters the jobs already publish (`noneFound`, `stalled`, `nudged`) —
never `scanned` or `hasMore`, which a draining window and a starved one report
identically.

**One correction to the card, measured not assumed.** The card's `S4` asked that
"run 2 must reach the third eligible account" from three accounts at 30/40/50 h
with a page of two. With a _clock_ window that is not satisfiable: a row nudged
at `t+24h` stays inside the window (and keeps its slot) until its age passes the
upper bound, so a page of two over 30/40/50 h re-reads 30/40 h on the second run
(a near-fix probe of the decided shape measured `run 1 nudged 2, run 2 nudged 0`).
Pinning the card's wording would have handed the GREEN card an unsatisfiable
assertion, so `S4` pins what the change actually does — the ladder-exhausted row
must not spend a page slot — and `S5` carries the upper edge and the accepted
residual. The correction is in the spec's own header too.

## Evidence at the pin head

Base `61d7e947` (the trunk immediately before this record). RED, quoted from
`vitest run --project integration apps/web/src/test/integration/job-sweep-drain.test.ts`:

```
Tests  5 failed (5)
run 2 must reach the profile its first page left behind: no seeded row changed, so a re-examined prefix announces nothing: expected +0 to be 1
run 2 must reach the third profile: the re-opened one shares the page but its notice is deduped: expected +0 to be 1
run 2 must reach the session its first page left behind: no seeded row changed, so a re-examined prefix announces nothing: expected +0 to be 1
the page is two candidates: an account with no rung left must not spend one of them: expected 1 to be 2
a 20-hour account is too young, a 30-hour one is due its first rung, an 80-hour one its last, and an account past the whole ladder is not a candidate at all: "pastLadder": 0 expected, 1 received
```

Every failure is at an assertion on an observable, not at a missing import or a
`undefined` read. Load-bearing was measured with a temporary near-fix of the
decided shape (the three filter/marker edits written in place, then the three
files restored and re-hashed byte-identically): `5 passed (5)`.

## Out of scope

- No test coverage is added for `pipeline-indexed-check`, `pipeline-sweep`,
  `usage-threshold-check` or any other job; the ADR-0849/0852/0853/0856 families
  are untouched.
- The absence of an `attendeeEventProfiles` index in `INDEX_SPECS`, and the
  missing §16.2 `{ status, updatedAt }` partial stall index, are recorded as
  findings of the decision card, not repaired here: they are performance, not
  drain, and each belongs to its own card.
- The marker field names (`noMatchNotifiedFor`, `stallNotifiedAt`) and the exact
  `MAX_CANDIDATE_AGE_MS` value are the GREEN's implementation choices; no pin
  names them.
- A second notification on a re-opened row is not pinned: the dedupe key is
  shipped, and `S2`/`S3` assert the absence of a second outbox row instead.
