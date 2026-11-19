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

## Review — the landed drain verified at the merged head

- **Reviewer:** `openpic-webapp-reviewer`, card `t_68888596` (Medium), the review
  leg behind this GREEN.
- **Heads verified:** the squash `b3b1e68d` (PR #732, merged
  2026-11-19T14:18:51Z) and the trunk `ba17e839`, from which this sign-off was
  cut. `git diff b3b1e68d origin/main` over the three job modules, the spec and
  `sweep-decisions.ts` is **empty**, so every `file:line` below holds at both.
- **Scope:** documentation only. This section adds no product code, mints no ADR
  number, and leaves every `Next free` cell byte-identical (`0881`).
- **Verdict:** **APPROVED WITH FINDINGS.** No pin was weakened, no dedupe key,
  `emitDomainEvent`, `verificationNudgePoint` or `hasMore` changed, the latch is
  stamped on every evaluated candidate (a deduped emit included), and the three
  emit-only sweeps drain their page.

### §1 `attendee-no-match-check.ts` — the candidate gate and the latch

| fact                                                                                                       | evidence                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the candidate class is pinned on the match inputs                                                          | `:76-78` `status: "ready"`, `matchCount: 0`, `lastMatchRunAt: { $ne: null }`                                                                                    |
| a missing disposition is accepted                                                                          | `:81` `{ $eq: [{ $type: "$noMatchNotifiedFor" }, "missing"] }`                                                                                                  |
| a moved input re-opens the row                                                                             | `:83` `matchRunAt` vs `$lastMatchRunAt`; `:85` `matchCount` vs `$matchCount`                                                                                    |
| a stored disposition that matches **both** live inputs fails all three arms, so the row is not a candidate | `:79-87` — `$or` of three `$ne`/`missing` terms, no fourth arm                                                                                                  |
| an explicit `null` disposition is a candidate                                                              | `:83`/`:85` `$ifNull` → `null`, `$ne` true; `$type` is `"null"`, not `"missing"`                                                                                |
| the page is ordered before it is cut                                                                       | `:89` `.sort({ _id: 1 })`, `:90` `.limit(limit)`                                                                                                                |
| the latch is stamped for **every** evaluated row, deduped or not                                           | `:114-121` — the `updateOne` has no `result.deduped` guard; it sits after the emit `:100-110`; `:122` `noneFound += result.deduped ? 0 : 1` is the counter only |
| the dedupe key is profile-terminal and unchanged                                                           | `:107` `attendee.matches.none_found:${profileId}`                                                                                                               |
| `hasMore` is unchanged                                                                                     | `:132` `scanned >= limit`                                                                                                                                       |

**The re-open wedge is pinned, not asserted.** A single-anchor mutation made the
latch conditional on `!result.deduped` (the exact S2 failure mode): `1 failed |
4 passed (5)` on `job-sweep-drain.test.ts`, the re-opened-profile case **alone**,
`the re-opened profile gives its scan slot back: both later profiles are reached
in one page: expected 1 to be 2`. Restored byte-identically; the module's
sha256 reads `9a726f47…b2aa5f` before and after and `git status --porcelain` is
empty. The pin therefore fails if a deduped emit stops re-stamping — a
disposition written only on a non-deduped emit is a red case, not a review
opinion.

### §2 `upload-session-sweep.ts` — the terminal latch

| fact                                                                       | evidence                                                                                |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| the filter admits only an unstamped row                                    | `:77` `stallNotifiedAt: null`                                                           |
| the idle threshold is unchanged                                            | `:75` `updatedAt: { $lt: addDays(now, -IDLE_LIMIT_DAYS) }`, `:32` `IDLE_LIMIT_DAYS = 1` |
| the part predicate is unchanged                                            | `:76` `"externalRefs.kind": "multipart_upload"`                                         |
| the latch is stamped after the emit, for every emitted row                 | `:95-109` emit, `:112` `$set: { stallNotifiedAt: now }`, no `deduped` guard             |
| the unannounceable row is still skipped before its emit and is not stamped | `:91-94`                                                                                |
| the page is ordered before it is cut                                       | `:79` `.sort({ _id: 1 })`, `:80` `.limit(limit)`                                        |
| the dedupe key and `hasMore` are unchanged                                 | `:106` `upload.session.stalled:${sessionId}`, `:123` `scanned >= limit`                 |

The latch is terminal by decision (ADR-0879 §2, this record's §2) and the rows
are TTL-reaped; `S3` pins both halves — the second run reaches the session the
first page left behind, and a resumed-then-restalled session announces nothing
and takes no slot.

### §3 `verification-nudge.ts` — the clock window, no marker

| fact                                                     | evidence                                                                                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| the upper bound exists                                   | `:116` `$gt: addMilliseconds(now, -MAX_CANDIDATE_AGE_MS)` beside `:115` `$lte` → window `(now − 96 h, now − 24 h]`                                  |
| it is a named constant                                   | `:44` `const MAX_CANDIDATE_AGE_MS = 4 * MS_PER_DAY`                                                                                                 |
| its docblock ties it to the ladder plus one cadence day  | `:33-43` — last rung 72 h, walk by count capped at two, one cadence day absorbs one missed run; the residual is stated as a `shortcut:`             |
| the ladder is byte-identical to `78b70894`               | `git diff 78b70894 b3b1e68d -- apps/web/src/server/jobs/sweep-decisions.ts` is **empty** → `NUDGE_RUNGS` `:55`, `verificationNudgePoint` `:209-218` |
| the `$inc` is unchanged and still runs on a deduped emit | `:162-167`                                                                                                                                          |
| the dedupe key is unchanged and rung-scoped              | `:158` `account.verification.incomplete:${userId}:${point}`                                                                                         |
| the page is ordered before it is cut                     | `:119` `.sort({ _id: 1 })`, `:120` `.limit(limit)`                                                                                                  |
| `hasMore` is unchanged                                   | `:178` `scanned >= limit`                                                                                                                           |

### §4 The diff — what shipped

`git show --stat b3b1e68d` = **8 files, +1155/−19**: the three job modules, the
new spec `job-sweep-drain.test.ts`, `docs/Notification and Database Design.md`,
`ADR-0879`, `ADR-0880` and `docs/adr/README.md`. That is exactly the set this
change is allowed to touch; nothing unrelated is in it.

The card's own baseline `78b70894` cannot be used for this check:
`git diff --stat 78b70894 b3b1e68d` spans **103 files** (`+21807/−1554`) because
that base predates other merged lanes (entitlements, internal-worker, OP-101,
OP-104, OP-135). The scoped diff is the squash commit, and it is clean.

### §5 Schema and ledger

- `docs/Notification and Database Design.md:1231` carries the §15.3
  `noMatchNotifiedFor` row (`object — { matchRunAt, matchCount } | null`) and
  `:1349` the §16.2 `stallNotifiedAt` row (`date \| null`).
- The known limit is true as recorded: `apps/web/src/server/db/indexes.ts`
  declares only `upload_sessions_expire_at_ttl` (`:105-112`) and
  `upload_sessions_event_batch_status` (`:113-122`) on that collection, and
  **no** `attendeeEventProfiles` entry at all, so the three candidate queries
  are collection scans today. The accepted `verification-nudge` residual is
  stated above and pinned by `S5`.
- `docs/adr/README.md:76-77`: `OP-136 jobs lane` `0849`–`0868`, next free
  **`0881`**; `unallocated (future lanes)` **`0881`**. `:75` `OP-135 worker
interface lane` `0847` and `:74` `OP-129 attendee identity lane` `0869`
  (item 19's exhausted-block encoding) are the trunk's values, untouched.
  Rows `0879` (`:530`) and `0880` (`:531`) are present, ascending, adjacent, and
  their relative links resolve.
- `0868` is absent from the trunk. That is a **gap inside the block**, which the
  allocation policy allows and never reissues; `0868` is held by another card.
  No `ADR-NNNN` prefix is duplicated: `uniq -d` over the `402` record basenames
  prints nothing.

### §6 Tests, measured at the heads above

| run                                                                                      | result                                               |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `vitest run --project integration apps/web/src/test/integration/job-sweep-drain.test.ts` | `Test Files 1 passed (1)` / **`Tests 5 passed (5)`** |
| `vitest run --project unit apps/web/src/test/unit/adr-numbering.test.ts`                 | **`Tests 29 passed (29)`**                           |
| `job-sweep-failure-windows.test.ts` + `job-account-lifecycle.test.ts`                    | `Test Files 2 passed (2)` / `Tests 11 passed (11)`   |
| `vitest run --project unit …/jobs/sweep-decisions.test.ts`                               | `Tests 76 passed (76)`                               |
| `prettier --check` on the eight touched paths                                            | `All matched files use Prettier code style!`         |
| duplicate `ADR-NNNN` scan over `docs/adr/`                                               | no output (`uniq -d` empty)                          |

The pins name no marker field, no constant, no sort key and no `scanned` /
`hasMore` value (`job-sweep-drain.test.ts:70-85` states it and the five cases
honour it); `S2` is the only case that exercises a deduped emit, and it reds if
the re-stamp goes away.

### Findings

**R1 — Low (record accuracy), routed to a follow-up docs card.** This record's
§Known limits (`:129`) names `{status: 1, createdAt: 1}` as the absent stall
index. The schema documents `{status:1, updatedAt:1}` partial on `in_progress`
(`docs/Notification and Database Design.md:1351`) and the job's predicate reads
`updatedAt` (`upload-session-sweep.ts:75`). The substance of the limit — that
`INDEX_SPECS` serves none of these predicates — is **correct and verified**; only
the field name is wrong. An accepted record is not edited for it; a follow-up
card corrects the citation so a later index card does not add the wrong field.

**R2 — Info, the card's baselines were stale.** The card named `0861`/`0862`,
the cell `0863` and the pool cursor `0869`. The landed values are `0879` and
`0880`, both cells `0881`. The allocator's notes on `t_68888596` (`t_3072cd38`,
`t_f21a0110`) and ADR-0300 §11 item 18 (a pool draw, the block being exhausted)
are the authority; this sign-off consumes no number.

**R3 — Info, `hasMore` stays a weak signal.** `scanned >= limit` is still true
for a page that drained its class exactly. The semantics are unchanged on
purpose — it is not this change's to alter — and the spec says so at `:76-80`.
Recorded so a later card does not read `hasMore` as a backlog measure.

**R4 — Info, the third gate is inert today.** `attendee-no-match-check.ts:85`
cannot select while `:77` pins `matchCount: 0` and `:118` stores the live count.
This is this record's own §Finding F2; the verification confirms it and confirms
that the writer stores `row.matchCount`, so a widened predicate re-opens
correctly.

**Honesty audit.** The three modules carry no fixture-specific hardcoding, no
test-environment conditional, no `@ts-ignore`, `eslint-disable` or
`console.*`, and the squash adds no dependency. The spec's only
implementation-shaped literals are the §15.3/§16.2 field defaults a seed needs.

No assertion was loosened, no case skipped or `.only`-ed, and no test file other
than the new spec is in the squash. **APPROVED WITH FINDINGS.**

## Amendment — the absent stall index reads `updatedAt`

§Known limits above names `{ status: 1, createdAt: 1 }` as the partial index the
stall sweep is missing. The field is **`updatedAt`**, not `createdAt`. The pair
the sweep reads is `status` + `updatedAt`: the candidate predicate pins
`status: "in_progress"` (`apps/web/src/server/jobs/upload-session-sweep.ts:74`)
and bounds `updatedAt` (`:75` — `updatedAt: { $lt: addDays(now,
-IDLE_LIMIT_DAYS) }`), and §16.2 of the design document lists exactly
`{status:1, updatedAt:1}` partial on `in_progress` as the index for
`upload.session.stalled` detection
(`docs/Notification and Database Design.md:1351`). `createdAt` is in neither
surface.

The recorded conclusion is unchanged: that index is absent from `INDEX_SPECS`, so
the candidate queries are collection scans.
`apps/web/src/server/db/indexes.ts` still declares only
`upload_sessions_expire_at_ttl` and `upload_sessions_event_batch_status` on
`uploadSessions`, and still carries **no** `attendeeEventProfiles` entry. This
note corrects the citation only — it adds no index spec and changes no code — so
a later card that adds the index adds `{ status: 1, updatedAt: 1 }` partial on
`in_progress`. Raised as finding **R1** by the review recorded above; amended by
card `t_47f104cb`.
