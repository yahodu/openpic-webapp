# ADR-0880 — OP-136 GREEN: the three emit-only sweeps drain, and the branch lands

- **Status:** Accepted (GREEN) · **Date:** 2026-11-19
- **Card:** OP-136 GREEN `t_4b75e4ba` (Medium), the successor of the RED card
  `t_957106bc` (ADR-0879) and of the decision card `t_c32ed838`. Branch
  `OP-136-task-sweep-drain-shapes`, worktree
  `/root/openpic/openpic-webapp/.worktrees/op136-sweep-drain`, PR #732 (the
  ticket's single PR). The RED pins were minted at the branch base `61d7e947`
  and this record ships beside them unchanged.
- **Implements:** contract §10.2 (the `attendee-no-match-check`,
  `upload-session-sweep` and `verification-nudge` cron rows — `limit`,
  `hasMore`, idempotence), §6.4 (the cached `matchCount`), §5.5 (the
  verification ladder) and §1.4 (profile readiness); schema §15.3
  (`attendeeEventProfiles`) and §16.2 (`uploadSessions`).
- **Consumes:** [ADR-0879](ADR-0879-op136-sweep-drain-shapes.md) §1–§3 (the
  decision of record, verified unchanged), [ADR-0860](ADR-0860-op136-indexed-check-scan-drain-shape.md)
  §1 (the `$expr` input-copy gate and the `.sort({ _id: 1 })` page this change
  mirrors), [ADR-0856](ADR-0856-op136-sweep-failure-windows-resume.md) §2
  (**emit first, marker second**), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md)
  §11 (number allocation).
- **Consumers:** `apps/web/src/server/jobs/attendee-no-match-check.ts`,
  `apps/web/src/server/jobs/upload-session-sweep.ts` and
  `apps/web/src/server/jobs/verification-nudge.ts`.
- **Number allocation:** `0880`, a **pool draw**. The RED record drew `0879` and
  advanced both the `OP-136 jobs lane` cell and the `unallocated (future lanes)`
  cursor to `0881`. The sweep immediately before minting, on the trunk
  `ef44796d`, found: the trunk's highest record is `0878` with an empty
  `uniq -d`; `git rev-list --objects --all -- docs/adr` tops out at `0879`
  (this branch); every `.worktrees/*/docs/adr` tree tops out at `0878`, plus
  this branch's `0879`; and the four open PR heads — #732, #729, #690, #272 —
  carry no `ADR-088x`. No cell moves: both already read `0881`.

## Context

[ADR-0879](ADR-0879-op136-sweep-drain-shapes.md) measured the defect: the three
jobs select a fixed first-`limit` page (`find(...).limit(limit)`, no `.sort()`)
over a class their loop never leaves, so every row past the page is never
examined while `hasMore: scanned >= limit` reports a backlog that cannot drain.
The decision there is implemented here without re-deciding it; only the three
candidate queries and one disposition per job changed.

## Decision — as shipped

### §1 `attendee-no-match-check` — input-copy latch, self-re-opening

`NoMatchProfileRow` (`:28-51`) now narrows `lastMatchRunAt` (a `Date`) and
`matchCount` (a `number`) beside the three ids it already read, so the loop can
copy that row's own inputs. The candidate query (`:73-86`) keeps
`{ status: "ready", matchCount: 0, lastMatchRunAt: { $ne: null } }` and adds:

```ts
$expr: {
  $or: [
    { $eq: [{ $type: "$noMatchNotifiedFor" }, "missing"] },
    { $ne: [{ $ifNull: ["$noMatchNotifiedFor.matchRunAt", null] }, "$lastMatchRunAt"] },
    { $ne: [{ $ifNull: ["$noMatchNotifiedFor.matchCount", null] }, "$matchCount"] },
  ];
}
```

plus `.sort({ _id: 1 }).limit(limit)`. After `emitDomainEvent` **and for every
evaluated candidate**, deduped or not (`:114-120`), one `updateOne` writes
`{ $set: { noMatchNotifiedFor: { matchRunAt: row.lastMatchRunAt, matchCount: row.matchCount } } }`.
`hasMore` and the profile-terminal dedupe key are untouched.

### §2 `upload-session-sweep` — terminal latch

The filter adds `stallNotifiedAt: null` (Mongo matches missing and explicit
null) and `.sort({ _id: 1 })` (`:72-81`); after the emit, and for every emitted
candidate deduped or not, one `updateOne` writes `{ $set: { stallNotifiedAt: now } }`
(`:112`). The idle threshold, the `externalRefs.kind` predicate, the
`tenantId === ""` skip and the session-terminal dedupe key are unchanged. The
`tenantId === ""` row is skipped before its emit, so it is not stamped — visible,
unannounceable, and outside this change.

### §3 `verification-nudge` — clock window, no marker

`MAX_CANDIDATE_AGE_MS = 4 * MS_PER_DAY` (96 h) is a named constant whose docblock
states why: the ladder's last rung is 72 h and the walk is by count capped at
two, so past `72 h + one cadence day` no rung remains; the extra day absorbs one
missed hourly run. The filter (`:110-123`) keeps `emailVerified: { $ne: true }`
and `createdAt: { $lte: now - MIN_AGE_MS }` and adds
`createdAt: { $gt: now - MAX_CANDIDATE_AGE_MS }`, plus `.sort({ _id: 1 })`.
`verificationNudgePoint`, `NUDGE_RUNGS`, the `$inc` of
`userProfiles.verificationNudges` and the rung-scoped dedupe key are untouched:
the ladder stays the single oracle.

### Accepted residual (`verification-nudge`)

A row that misses **both** rungs by more than a day each (a cron outage longer
than 24 h spanning the second rung) leaves the window un-nudged rather than
nudged late. `S5` encodes it executably (`pastLadder` → `0`), so a future
widening reds a case.

## RED → GREEN evidence

The RED spec's own command, at the RED head `7f875b79` (three production files
byte-identical to the trunk), `Tests 5 failed (5)` — every case at an assertion
on an observable, each one matching its case comment:

```
AssertionError: run 2 must reach the profile its first page left behind: ... expected +0 to be 1
AssertionError: run 2 must reach the third profile: the re-opened one shares the page but its notice is deduped: expected +0 to be 1
AssertionError: run 2 must reach the session its first page left behind: ... expected +0 to be 1
AssertionError: the page is two candidates: an account with no rung left must not spend one of them: expected 1 to be 2
AssertionError: ... an account past the whole ladder is not a candidate at all ...: expected pastLadder 0, received 1
```

After the change, the same command: `Tests 5 passed (5)`, `Test Files 1 passed
(1)`. The neighbouring jobs are unchanged: `jobs-sweep-failure-windows.test.ts`

- `jobs-account-lifecycle.test.ts` → `2 files / 11 passed (11)`; unit
  `jobs/sweep-decisions.test.ts` → `76 passed (76)`.

## Schema rows added

- **§15.3 `attendeeEventProfiles`** —
  - `noMatchNotifiedFor` — object `{ matchRunAt, matchCount } | null` — the
    latched empty-gallery disposition: the `attendee-no-match-check` candidate
    query reads it, and it re-opens when either input moves.
- **§16.2 `uploadSessions`** —
  - `stallNotifiedAt` — `date | null` — the once-per-session stalled-upload latch
    (`upload.session.stalled`).

No production `INDEX_SPECS` entry is added (see below).

## Known limits — recorded, not fixed

`{ status: 1, createdAt: 1 }` partial index for stall detection is absent from
`INDEX_SPECS` (`apps/web/src/server/db/indexes.ts` carries only the `expireAt`
TTL `:105-112` and the `event_batch_status` compound `:113-122`), and
`INDEX_SPECS` carries **no** `attendeeEventProfiles` entry at all — so the three
candidate queries are collection scans today. The new predicates therefore cost
**per-row evaluation and not a new scan**: nothing about their indexability
changes, and adding those indexes is out of scope here.

## Finding F2 — the `matchCount` gate

The review of the RED delivery measured that the third `$expr` gate cannot
select while the filter pins `matchCount: 0`, because the writer stores `0` too.
Both options were open (drop the gate, or store the live count); the decision of
record §1 names all three gates, so the gate stays and the writer stores
`row.matchCount` rather than a literal — a future widening of the `matchCount: 0`
predicate therefore re-opens correctly without touching this module, and the
field matches the documented re-open rule ("re-opens when either input moves").
Today the gate is inert; that is recorded here, not hidden.

## Consequences

- A row that has been announced leaves the page by its own write, so `hasMore`
  becomes a true backpressure signal for these three jobs.
- `attendee-no-match-check` re-evaluates a re-matched profile on its next hour:
  one slot, one deduped emit, one re-stamp. No second notification is possible
  (profile-terminal key), and no write was added to the match path.
- `upload-session-sweep` never re-announces a resumed-then-restalled session, and
  the row is TTL-reaped within five days anyway.
- `verification-nudge` leaves a capped account out of the candidate set instead
  of letting it hold a slot for ever; the ladder is unchanged.

## Out of scope

No test, fixture, helper or frozen pin is edited; `ADR-0879` is untouched. No
dedupe key changed, `emitDomainEvent` is unchanged, `verificationNudgePoint`
and `NUDGE_RUNGS` are unchanged, and `hasMore` keeps `scanned >= limit`. No index
specs are added.
