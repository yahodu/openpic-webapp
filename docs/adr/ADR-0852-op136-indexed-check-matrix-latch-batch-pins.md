# ADR-0852 — OP-136 TEST: the indexed check derives from the status table, latches per event, and carries the OP-126 batch arm

- **Status:** Accepted (RED) · **Date:** 2026-11-17
- **Card:** OP-136 TEST `t_7e31328b` (High; branch `wt/t_7e31328b`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_7e31328b`, cut from `origin/main`
  `7d986972`, release 1.65.0). GREEN sibling `t_16239628`; the findings come from
  the review of the GREEN `t_d18a6e9e` (PR #625, squash `c7628400`).
- **Implements:** contract §10.2 (the `pipeline-indexed-check` row — "Events where
  all queued images reached a terminal state → mark indexed", notification
  "`pipeline.event.indexed` (email on first completion per event only)"), §4.1
  (the pipeline-status table), notification design §4.7 (the
  `pipeline.event.indexed` line: "Email on first completion per event only"),
  schema §15.1 (`events`), §16.2 (`upload_sessions`), §16.3 (`event_images`).
- **Consumes:** [ADR-0849](ADR-0849-op136-jobs-red.md) §1 (the `defineCronJob`
  declarations and the `SweepJobRunOptions` seam),
  [ADR-0850](ADR-0850-op136-jobs-green.md) (the job shipped and left unpinned,
  plus its "coverage gaps" list), [ADR-0760](ADR-0760-op126-batch-status-notifications-red.md)
  §A1 (this cron is named as the caller of `checkUploadBatchTransition`),
  [ADR-0029](ADR-0029-domain-events-outbox.md) (the outbox and
  `FORBIDDEN_PAYLOAD_KEYS`).
- **Number allocation:** the lane row `OP-136 jobs lane` read `0852` and no
  `ADR-0852*` existed on any surface — `git ls-tree` on `origin/main` and on
  `git rev-list --objects --all -- docs/adr` both stop at `0851`, every
  `.worktrees/*/docs/adr` holds `0850`/`0851` only, and no open PR adds one — so
  this record takes `0852` and advances that cell to `0853`. The two
  `unallocated (future lanes)` cells stay `0869`. No number outside `0849`–`0868`
  is consumed.

## Context

`apps/web/src/server/jobs/pipeline-indexed-check.ts` decided "indexed" with
`processedImageCount + failedImageCount >= imageCount`, which collapses the §4.1
status table: `indexed`, `delayed` and `partial_failure` all satisfy it. The
notification's own copy is "Event is fully searchable", so an event whose photos
**all failed** was announced as searchable. Measured at `c7628400` with four
seeded events, one run, and `derivePipelineStatus` as the oracle:

```
{"affected":3,"shapes":[
  {"name":"allProcessed","derived":"indexed","announced":true},
  {"name":"allFailed","derived":"delayed","announced":true},
  {"name":"partial","derived":"partial_failure","announced":true},
  {"name":"stillRunning","derived":"indexing","announced":false}]}
```

The job also never latched. Its dedupe key carried an absolute six-hour bucket
and its candidate query was only `counters.imageCount > 0`, so every terminal
event re-announced once per bucket for ever. Measured over an already-terminal
event, two runs 7 h apart:

```
{"rowsAfterFirst":1,"rowsAfterSecond":2,
 "keys":["pipeline.event.indexed:<eventId>:83097","pipeline.event.indexed:<eventId>:83098"]}
```

§10.2 says "→ mark indexed" and §4.7 says the email goes "on first completion per
event only", yet no marker was written and the payload (`{eventId, images}`)
carried no first-completion discriminator at all.

Third, the OP-136 card's own §3 scope note ("plus batch transition check from
OP-126") was not wired: `checkUploadBatchTransition` was reachable only from the
completion route, so a batch whose images the **worker** settled never emitted
its §4.7 summary — although
[ADR-0760](ADR-0760-op126-batch-status-notifications-red.md) §A1 names this cron
as its caller.

The job had no spec at all;
[ADR-0850](ADR-0850-op136-jobs-green.md)'s "Out of scope / coverage gaps"
recorded that, and this card deliberately covers only the two findings above (the
other three unpinned jobs keep their own cards).

## Decision

### 1. The oracle is the shipped status table, not a local arithmetic

The new spec (`apps/web/src/test/integration/job-pipeline-indexed-check.test.ts`,
eight appended cases, no production file touched) imports
`derivePipelineStatus` from `@/server/events/pipeline` and asserts the four
seeded shapes derive `indexed`, `delayed`, `partial_failure`, `indexing` before
any announcement is counted. The pin is then "exactly one `pipeline.event.indexed`
row, and it belongs to the derived-`indexed` event", so a future change to the
table moves the pin with it and a re-implementation of the arithmetic cannot
silently diverge from the state `GET …/events/{id}` serves.

- `I1` — four shapes, one run: one row for the clean event, none for the
  all-failed, partial and still-running ones, `details.indexed` 1.
- `I2` — an all-failed event (`delayed`) is not announced.
- `I3` — a partly-failed event (`partial_failure`) is not announced.

`I2`/`I3` duplicate two assertions of `I1` on purpose: a single case reds only on
its first failing shape, and the acceptance for this card names both shapes.

### 2. The latch is pinned as an absence, not as a field name

The card asked for "a second run 7 h later adds no row for the same event", so
`I4` never names a marker. Whether the GREEN latches with a field on the event
row, a marker collection or a bucket-free dedupe key is its decision; the pin is
the observable — one event, one announcement — and a re-run reports
`details.indexed: 0`. The marker name is deliberately left to the GREEN card,
which records it in its own ADR.

### 3. The first-completion discriminator is `notifyByEmail: true`

`I5` asserts the first announcement's payload carries `notifyByEmail: true`
(plus `eventId` and `images`); `I6` grows the event with two more photos, lets
the worker finish them, runs again in the next bucket, and asserts **exactly one**
row for that event carries `true`. A later completion may therefore be announced
or be suppressed — the pin tolerates both — but it can never send the email
again.

The name is agreed with GREEN `t_16239628` in a card comment (that card proposed
it as its example): the flag cannot be called `email`, because
`FORBIDDEN_PAYLOAD_KEYS` refuses that key anywhere in a payload at any depth.
Read the _presence and value_, never "some unasserted key exists": `I6`'s filter
is `payload.notifyByEmail === true`, so a `false` or an absent key both fail the
lifted flag.

### 4. The OP-126 batch arm is pinned through the outbox

`I7` seeds what the completion route would have produced — two `upload_sessions`
already `completed` and two `event_images` already `done`, both carrying one
`batchId` — and never calls the route. After one indexed run exactly one
`upload.batch.completed` row must exist, addressed to the batch's uploader, with
`payload.batchId` and `payload.fileCount` 2 and **no**
`upload.batch.completed_with_errors` row. `I8` runs the next bucket and asserts
the count is still one, so the summary is idempotent whichever run observes the
settled batch.

## Evidence

All eight cases are RED at this head for the reasons above, and every failure is
assertion level — no load or harness error:

```
I1  expected [ { …(10) } ] to have a length of +0 but got 1        (all-failed)
I2  expected [ { …(10) } ] to have a length of +0 but got 1        (delayed)
I3  expected [ { …(10) } ] to have a length of +0 but got 1        (partial_failure)
I4  expected [ { …(10) }, { …(10) } ] to have a length of 1 but got 2
I5  expected true, received undefined                              (no discriminator)
I6  expected [] to have a length of 1 but got +0
I7  expected [] to have a length of 1 but got +0                   (zero summaries)
I8  expected [] to have a length of 1 but got +0                   (zero summaries)
Test Files  1 failed (1) · Tests  8 failed (8)
```

Satisfiability and discrimination, measured in a throwaway near-fix of the job
(`derivePipelineStatus`, a per-event marker, the flag, and a bounded
`checkUploadBatchTransition` call per candidate batch), deleted afterwards:

| Probe                                   | Result                     | Reddened   |
| --------------------------------------- | -------------------------- | ---------- |
| faithful near-fix                       | `8 passed (8)`             | —          |
| the trunk's collapsed criterion         | `3 failed \| 5 passed (8)` | I1, I2, I3 |
| no latch, absolute 6-hour bucket in key | `1 failed \| 7 passed (8)` | I4         |
| the flag never raised                   | `2 failed \| 6 passed (8)` | I5, I6     |
| the batch arm finds no batch            | `2 failed \| 6 passed (8)` | I7, I8     |

`apps/web/src/server/jobs/pipeline-indexed-check.ts` was restored
byte-identically after each probe (`sha256`
`adc3e08eae007191cc65fa55e99183be22cadd4098f062d7f11bbc21eed7d2ad` before and
after; `git status --short` shows only the new spec).
`tsc -p apps/web/tsconfig.json --noEmit` exit `0`, `prettier --check` clean and
`eslint` 0 errors / 0 warnings on the spec.

## Assumptions

- **A1** — a `state: "done"` worker result is the state `checkUploadBatchTransition`
  reads for a settled batch, so the batch fixtures never need a live storage
  call (`readBatchSnapshot` only calls the provider for the 24-hour stalled
  sweep, which is out of this job's scope).
- **A2** — the batch arm is reached for an event on the run that completes it;
  the pins seed the event already indexed and never rely on a second run to
  discover the batch.
- **A3** — "later completion" means the event's counters grew after the first
  announcement (a second upload batch), which is the only way §4.1 can return
  `indexed` twice for one event.

## Out of scope / coverage gaps

- Which batch key the arm reads (`event_images.uploadBatchId` distinct, or
  `upload_sessions.batchId`): both are seeded, so either discovery route
  satisfies `I7`. The bound on how many batches one run may check, and the
  `details` counter that reports it, are unnamed in the contract and unpinned.
- A batch that settles as `complete_with_errors` (a failed image) inside a
  `delayed` event: the card scopes the arm to the settled-batch happy path, so
  only `upload.batch.completed` is pinned, and its negative twin is asserted.
- `upload-session-sweep`, `attendee-no-match-check` and `retention-warnings`
  remain unpinned — their own cards own them
  ([ADR-0850](ADR-0850-op136-jobs-green.md)'s coverage-gap list).
- The emit's failure path (a broken outbox) and the run's `errors` counter are
  not pinned here; `checkUploadBatchTransition`'s own `safeEmit` is pinned in
  the OP-126 spec.

## Consequences

- GREEN `t_16239628` can make every pin true with the three changes it already
  carries in its body (the table, the latch, the batch arm); no pin needs a
  production shape the card did not ask for.
- The pins forbid the "fully searchable" announcement for a `delayed` or
  `partial_failure` event, so a future job that widens the criterion reds `I1`,
  `I2` and `I3` at once.
- The first-completion flag is now a named payload contract (`notifyByEmail`),
  so the fan-out's §4.7 email gate has an input to read; wiring that gate is not
  part of this card and is not pinned here.
- `docs/adr/README.md` is the shared-ledger hotspot: this lane row, this note
  and the index row merge as a union keeping the higher cell (`0853` lane,
  `0869` pool). The index table carries rows for `0849` and `0852` in this lane
  segment only — `0850`/`0851` minted without one, which this card leaves as it
  found them.

## Review sign-off (OP-136 TEST t_7e31328b, round 1 — artifact + execution lens)

Reviewed at head `228df183` against the review base `origin/main` `7d986972`: the
diff is three files, +766/−1 (the new spec, this record and the ledger's lane
note), and no production file.

- **Verdict: APPROVED WITH FINDINGS.** The reviewer edited no pin. The spec blob
  the delivery carries (`b4d77678…`) is the spec blob of `228df183` _and_ of the
  GREEN's squash `b62256b8`, and this record's own blob (`2111f767…`) is the same
  blob at the reviewed head, at that squash and on today's trunk, so the pins
  landed byte-identically. At the reviewed head
  `apps/web/src/server/jobs/pipeline-indexed-check.ts` is byte-identical to the
  review base's job (`sha256 adc3e08e…`): the delivery touched no production
  file, and the `5eb913d4…` the trunk carries today is the GREEN's own change to
  that job, not the delivery's.
- **Criteria restated, then matched.**
  1. _Every pin RED at `7d986972`, each for its own reason._ Re-measured by the
     reviewer from the delivered spec blob on the review base: `Tests 8 failed (8)`,
     every failure at assertion level — `I1`, `I2` and `I3` with
     `expected [ { …(10) } ] to have a length of +0 but got 1` (the all-failed
     and the partial event are announced), `I4` with
     `expected [ { …(10) }, { …(10) } ] to have a length of 1 but got 2` (the
     second row), `I5` with
     `expected { …(2) } to match object { notifyByEmail: true, …(2) }` (the
     missing flag), and `I6`, `I7`, `I8` with
     `expected [] to have a length of 1 but got +0` (zero rows).
  2. _The static gates._ `tsc -p apps/web/tsconfig.json --noEmit` exit `0`;
     `prettier --check` clean on the three touched paths; `eslint` exit `0` on
     the spec, 0 errors and 0 warnings.
  3. _The ADR guards._ The six `adr-*` specs, `6 files` and `236 passed (236)`
     at this head.
  4. _The ledger._ `ADR-0852` is unique on the tree at this head, and the
     `OP-136 jobs lane` `Next free` cell reads `` `0853` ``.

### The reviewer's independent probes

One throwaway worktree, since deleted, detached at the review base with the
delivered spec blob in place; the job is mutated and the spec never is, and the
job is restored after every run. The near-fix is the reviewer's own, not the
GREEN's: the shipped status table, a per-event latch on the event row, the
first-completion flag derived from whether that event already has an
announcement, and `checkUploadBatchTransition` for each candidate event's
batches.

- Faithful near-fix → `8 passed (8)`, nothing reddened.
- The batch arm removed → `2 failed | 6 passed (8)`: `I7` and `I8` only.
- The latch removed, the bucketed dedupe key kept → `1 failed | 7 passed (8)`:
  `I4` only.
- The latch removed **and** the flag raised on every announcement →
  `2 failed | 6 passed (8)`: `I4` and, additionally, `I6`.

This is what proves each pin family **load-bearing**: the status-table family
(`I1`–`I3`), the latch (`I4`) and the first-completion flag (`I5`, `I6`) redden
only when their own mechanism is removed, so no pin is satisfied by a sibling's
mechanism, and the batch family (`I7`, `I8`) is the only thing the arm answers.
The near-fix also shows **satisfiability**: a plausible shape the card never
prescribed makes all eight green, so the pins do not encode the GREEN's
implementation.

### Findings, graded and routed

- **F1 — Low, coverage gap.** The batch arm is pinned only for the derived
  `indexed` event, while the job card's all-terminal scope also covers
  `partial_failure` and `delayed`. Routed to card `t_71729b5e`, made a child of
  the GREEN `t_16239628` so it could not run before the GREEN landed. It has
  since closed the gap: PR #644 (squash `ca8925f9`) pins the non-indexed terminal
  events, three cases, and its own record carries them.
- **F2 — Low, docs accuracy.** This record's own §Decision 1 reads "eight
  appended cases", which describes an append to an existing spec; the spec is
  new, so the eight cases are its whole content and nothing was appended to
  anything. Corrected here, in this section, because the frozen sections are not
  edited: the delivery adds
  `apps/web/src/test/integration/job-pipeline-indexed-check.test.ts` whole.
- **F3 — Info, test quality.** The batch fixture dates its rows from
  `Date.now()` (line 233 of the spec) while the run is driven by `fixedClock`,
  and `readBatchSnapshot` reads `systemClock.now()`. Recorded, no card: the pin
  reads a six-hour bucket, so the drift cannot red it today, but a future pin on
  the age boundary would be time-dependent.
- **F4 — Info, ledger.** At the reviewed head the sibling pin card `t_535ab5d2`
  shaped the same cell: its PR #629 held `ADR-0853` and moved that cell to
  `` `0854` `` while this record took `` `0853` ``. That is a same-cell mint
  resolved by the index-only union the lane's merge rule prescribes, not a
  renumber. Recorded, no card; the record has since landed with PR #636.

### What this append does not retract

Nothing in §Context, §Decision, §Consequences or §Alternatives is retracted. This
section is an append: the two findings that needed movement were carried by their
own cards, and those cards' own records document what followed.
