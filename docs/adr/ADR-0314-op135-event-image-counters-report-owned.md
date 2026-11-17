# ADR-0314 — the worker report owns `events.counters.processedImageCount`/`failedImageCount`, and both attendee readers share one drained predicate

- **Status:** Accepted · **Date:** 2026-11-17
- **Card:** OP-135 TEST (Medium, F5) `t_0c7de7eb` · **Branch:** `OP-135-task-report-counter-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_ca95e452`
- **Lane:** board-wide / process (orchestrator), reserved range `0300`–`0319` · **Consumes:** `0314`
- **Relates to:** [ADR-0829](ADR-0829-op135-internal-worker-endpoints-red.md) §6 and [ADR-0830](ADR-0830-op135-internal-worker-endpoints-green.md) §9 (the deferral this record supersedes), [ADR-0762](ADR-0762-op127-event-images-management-red.md), [ADR-0763](ADR-0763-op127-event-images-management-green.md) and [ADR-0764](ADR-0764-op127-event-images-followup-pins.md) (the two counters left to the nightly `counter-reconcile`), [ADR-0793](ADR-0793-op133-attendee-gallery-red.md) §10 and [ADR-0794](ADR-0794-op133-attendee-gallery-green.md) §1 (the predicate this record corrects), [ADR-0784](ADR-0784-op130-public-event-resolution-red.md) §5 (the `+ failed` rule it adopts), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 (the exhausted-block clause added by this record)
- **Consumers:** `apps/web/src/app/api/v1/internal/worker/report/route.ts`, `apps/web/src/server/attendee/poll-policy.ts`, `apps/web/src/server/repos/cross-tenant.ts`, `apps/web/src/test/integration/event-indexing-counters.test.ts` and `apps/web/src/test/unit/attendee-poll-policy.test.ts`
- **Schema:** `docs/Notification and Database Design.md` §15.1 `events.counters` — read, no shape change · **Contract:** §6.4 (the flag keeps its documented meaning) and §10.3.2 (the report's answer is unchanged)

## Context

Every figure below is measured on `origin/main` `78b70894`.

**Two writers of `counters.*` exist, and neither writes the processing counters.**

| writer                                                                                  | line   | write                                                                   |
| --------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| `apps/web/src/server/uploads/registration.ts`                                           | `:124` | `$inc { "counters.imageCount": 1, "counters.storageBytes": <bytes> }`   |
| `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/images/[imageId]/route.ts` | `:194` | `$inc { "counters.imageCount": -1, "counters.storageBytes": -<bytes> }` |

Event creation seeds the third field to `0`
(`apps/web/src/app/api/v1/tenants/[tenantId]/events/route.ts:329-330`), and
`processedImageCount`/`failedImageCount` are never advanced anywhere in `apps/`
or `packages/`. Every other hit of the two names is a reader or a test fixture.

**Six readers consume the two counters that never move.**

| reader                                                                        | line       | rule                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/server/attendee/poll-policy.ts` `eventIndexingComplete`         | `:78`      | `counters.processedImageCount >= counters.imageCount`                                                                                                                  |
| `apps/web/src/app/api/v1/p/events/[slug]/me/route.ts`                         | `:236`     | calls `eventIndexingComplete` → `indexingComplete`, then `pollIntervalMs` (`poll-policy.ts:46`: `15_000` while indexing, `60_000` once complete)                       |
| `apps/web/src/app/api/v1/p/events/[slug]/gallery/route.ts`                    | `:354`     | calls `eventIndexingComplete`                                                                                                                                          |
| `apps/web/src/app/api/v1/p/events/[slug]/route.ts`                            | `:373-375` | `counters.processedImageCount + counters.failedImageCount >= counters.imageCount` — **a different rule**                                                               |
| `apps/web/src/server/events/pipeline.ts` `derivePipelineStatus`               | `:41-52`   | `processed + failed < imageCount` → `indexing`; `processed === 0` → `delayed`                                                                                          |
| `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/images/route.ts` | `:133`     | `done = counters.processedImageCount`, `failed = counters.failedImageCount`; `queued`/`processing` are counted from source, so the summary carries `approximate: true` |

**The state this produces for an attendee.** `indexingComplete` is `false` for
every event that has ever had an image (`0 >= imageCount`), so `/me` keeps
`pollIntervalMs: 15000` and the gallery's "still indexing" state never settles,
until the nightly `counter-reconcile` runs (`docs/API Contract.md:3322`). The
failed arm is also missing from `poll-policy.ts:78`, so an event whose remaining
images are permanently failed never settles at all: `4 + 1 >= 5` is never
`4 >= 5`. And the two attendee-facing reads disagree whenever
`failedImageCount > 0`, because `GET /api/v1/p/events/{slug}` already counts the
failed images (`p/events/[slug]/route.ts:373-375`, ADR-0784 §5) while `/me` does not.

**Four records deferred the fact rather than decide it.** [ADR-0829](ADR-0829-op135-internal-worker-endpoints-red.md)
§6 left "the `events.counters` update" out of the OP-135 pins because "the
authority on counters is OP-136's `counter-reconcile`"; [ADR-0830](ADR-0830-op135-internal-worker-endpoints-green.md)
§9 repeated that deferral as deliberately-not-implemented; [ADR-0762](ADR-0762-op127-event-images-management-red.md)
and [ADR-0763](ADR-0763-op127-event-images-management-green.md) left the two
counters to the nightly job; [ADR-0764](ADR-0764-op127-event-images-followup-pins.md)
noted that they stay stale after a delete. Review finding F5 of the OP-135 GREEN
(`t_4a280d94`) showed what that deferral costs: the one component that knows the
fact — the worker report — writes the `event_images` row and no event document
(`apps/web/src/app/api/v1/internal/worker/report/route.ts:197-206`), and the only
component that repairs the event document runs once a day.

The decision was taken on card `t_949d96c2` and is recorded here without
re-deciding it. This card writes the pins.

## Decision

**Option (b): the report owns the two counters.** The whole normative content is
these six items.

1. **The fact is set where it is produced.** After the report route has applied
   its items, for **each distinct event that had at least one applied
   `event_image` item**, the route recomputes and writes the two counters from
   source:

   ```ts
   processedImageCount = countDocuments({ eventId, deletedAt: null, "processing.status": "done" });
   failedImageCount = countDocuments({ eventId, deletedAt: null, "processing.status": "failed" });
   ```

   `$set` both onto `events.counters`. The `{ eventId, deletedAt: null }` base
   clause is the organizer images list's own base clause
   (`images/route.ts:128-134`), so the counter and the list's `done` figure count
   the same rows.

2. **A recount, never a blind `$inc`.** An increment on the terminal transition
   double-counts across a reprocess re-entry: `resetProcessingForReprocess`
   returns the row to `processing.status: "queued"`
   (`apps/web/src/server/images/reprocess.ts:49-66`), so `indexingComplete` can
   read `true` while an image is still queued — the worst failure available here,
   because the attendee is told the gallery is complete and photos are missing
   from it. The recount is idempotent: a duplicate, retried or replayed report
   cannot move the counter twice, and a reprocess self-corrects at its next
   terminal report.

3. **Cost is per event per batch, not per item.** At most two counts per distinct
   event in a batch. `event_images_event_asset_unique`
   (`apps/web/src/server/db/indexes.ts:317-323`) serves the `{ eventId }` prefix,
   and `deletedAt`/`processing.status` are fetched and filtered — the same shape
   the organizer images list already runs twice per request
   (`images/route.ts:128-129`).

4. **Ownership stays split.** `imageCount`/`storageBytes` remain owned by upload
   registration and the image delete, both transactional; the report never writes
   them (P1 pins it). `processedImageCount`/`failedImageCount` become
   report-owned, and `counter-reconcile` remains **the repair for drift** — a
   crash between the item writes and the recount, a delete with no later report,
   a direct database write. It runs the same two counts across all events.

5. **The predicate is one.** `eventIndexingComplete` becomes
   `processedImageCount + failedImageCount >= imageCount` — the rule
   `p/events/[slug]/route.ts:373-375` and `derivePipelineStatus` already use, so the
   two attendee-facing readers stop disagreeing. This supersedes the arithmetic
   in ADR-0793 §10 / ADR-0794 §1. Their intent — "the event's progress, not the
   attendee's" — is unchanged; the failed arm is added. A permanently failed
   image drains the event: `partial_failure`/`delayed` is a pipeline _state_, not
   "still indexing".

6. **`indexingComplete` keeps its §6.4 meaning.** §6.4 documents the flag and
   the cadence it selects (`2000`/`15000`/`60000`,
   `docs/API Contract.md:2306`) and fixes no arithmetic, so this record changes
   no contract text: the flag stays the event's own progress (the reading
   ADR-0793 §10 records), and after this it follows the worker's own
   done-reports within one poll instead of up to 24 hours.

**Rejected — option (a), accepting the lag.** It would make §6.4's
`indexingComplete` mean "reconciled", not "processed": an attendee whose photos
are ready would be told "still indexing" for up to a day, polling every 15 s,
while the only component that knows the truth has already reported it. It also
freezes two shipped predicates that disagree with each other.

## Consequences

- **Attendee-visible.** The first report that drains an event flips
  `indexingComplete` to `true`, so `/me` moves `pollIntervalMs` from `15_000` to
  `60_000` at the next poll. The gallery summary's "still indexing" state settles
  on the same fact. The organizer images list's `done`/`failed` figures and
  `derivePipelineStatus` follow the same counters, so a `partial_failure` event
  becomes `partial_failure` at the report instead of after the nightly job.
- **`imageCount`/`storageBytes` are untouched**, and upload registration and the
  image delete keep their transactional ownership.
- **`counter-reconcile` is demoted to repair.** It is no longer the producer of
  the fact; it is the component that closes drift.
- **Residual drift windows stay, and each has a closing path.** A crash between
  the item writes and the recount leaves a stale counter; the next report for
  that event, or the nightly repair, corrects it. A delete with no later report
  leaves `processedImageCount` high until the next report or the nightly repair.
- **The soft-delete case is safe in the direction that matters.** A deleted
  `done` image stays in the recount only until `deletedAt` is set, so the count
  can read high for a while; `processed >= imageCount` keeps `indexingComplete`
  true, so no attendee is stranded in the indexing cadence.
- **Cost.** Two extra counts per distinct event per batch, on an index prefix the
  organizer list already uses. The report's item writes are unchanged, and the
  recount stays outside any item transaction so it cannot widen one over two
  collections for a cache.

## §2 — the exhausted block, and the ledger rule it needs

On the merged trunk the `OP-129 attendee identity lane` row reads
`Next free 0869`, outside its own `0780`–`0798` range and equal to the
`unallocated (future lanes)` cursor. The card that created this one measured the
same symptom at `0849` (`origin/main` `a5f06c85`); between that base and this
head the paired cell was advanced `0849` → `0869` by card `t_4ba209d5` under the
twin-cell practice this ledger records, so the value moved and the symptom did
not. Measured facts, not edits:

- The cursor `0869` is **correct**: it is `max(closed range end) + 1` over the
  reserved table (the OP-135 lane's `0848` and the OP-136 lane's `0868` are the
  highest closed ends), which is ADR-0300 §10 item 16.
- The OP-129 cell was **already** out of range before this lane drew: it read
  `0829` on `origin/main` `da0310f3`, as the OP-135 lane's own ledger note
  (ADR-0829 §7) recorded. OP-135 did not introduce it.
- The `adr-numbering` guard is green because `lane-range-overlap` compares
  reserved **ranges**, never cells (ADR-0300 §10 item 17). A cell is invisible to
  the guard.
- `0780`–`0798` is **exhausted**. Drawing from the pool is already the recorded
  practice (ADR-0799, ADR-0800, ADR-0811, ADR-0818), but no normative clause
  existed. ADR-0300 §11 now states it, with four items numbered `18`–`21`,
  written by this card.
- **No number, cell or row outside this card's own lane entry is edited.** The
  OP-129 row stays exactly as it is; the repair of a foreign cell is out of
  policy (ADR-0300 §11 item 20).

## Evidence — the six pins are RED at this head

Measured at the pin head (`OP-135-task-report-counter-pins`, base `78b70894`),
`npx vitest run --project integration apps/web/src/test/integration/event-indexing-counters.test.ts`:

```text
 × > when a done report lands for one of the event's images (P1) > recounts processedImageCount from source and leaves imageCount alone
   → expected +0 to be 1 // Object.is equality
 × > when the same report is delivered twice (P2) > refuses the replay as leaseLost and keeps processedImageCount at one
   → expected +0 to be 1 // Object.is equality
 × > when a done image is reprocessed and reported done again (P3) > keeps processedImageCount at the live done rows, never two
   → expected +0 to be 1 // Object.is equality
 × > when the last outstanding image fails permanently (P4) > advances failedImageCount and drains the event
   → expected +0 to be 1 // Object.is equality
 × > when both attendee readers read the same drained event (P5) > answers one indexingComplete for /me and the public landing page
   → expected false to be true // Object.is equality
 × > when one batch carries two done items of the same event (P6) > recounts the event once and reports both rows as processed
   → expected +0 to be 2 // Object.is equality
 Test Files  1 failed (1)
      Tests  6 failed (6)
```

and `npx vitest run --project unit apps/web/src/test/unit/attendee-poll-policy.test.ts`:

```text
 FAIL > eventIndexingComplete — the drained predicate (ADR-0314 §5) > answers { imageCount: 5, processedImageCount: 4, failedImageCount: 1 } with true
   → expected false to be true // Object.is equality
 FAIL > eventIndexingComplete — the drained predicate (ADR-0314 §5) > drains an event whose only remaining image failed, so the gallery settles
   → expected false to be true // Object.is equality
 Test Files  1 failed (1)
      Tests  2 failed | 22 passed (24)
```

Each failure is the pin's own assertion, not a load error: the integration cases
reach the route, get `200`, and read the stored `events` document; the two unit
cases call the shipped predicate and receive the old answer. In the P5 case the
**public** reader already answers `true` and `/me` answers `false` — the
disagreement this record removes.

**Discrimination.** The pins are shaped so that the rejected mechanisms each fail
a specific case: a per-item `$set` of that item's own contribution fails P6
(`1` not `2`); a `$inc` fails P3 (`2` not `1`) even when the lease filter prevents
a replay from moving it (P2 alone cannot separate the two mechanisms, and its
comment says so); leaving `poll-policy.ts:78` unchanged fails P5 and the two unit
cases. The GREEN records the matching revert probes in its own section.

## Open items handed to the GREEN (`t_b00de76e`)

- `findWorkItemById`'s projection must carry `eventId`
  (`apps/web/src/server/repos/cross-tenant.ts:537` projects `tenantId`,
  `profileId` and `processing` only), and `OwnedWorkItemRow` gains the field.
- `EventIndexingCounters` gains `failedImageCount`, and the two attendee route
  projection types widen with it (`me/route.ts:236`, `gallery/route.ts:354`). The
  wire shapes do not change.
- This record's `Consumers:` field must gain every source file that cites
  `ADR-0314` after the GREEN lands; the `adr-consumers` guard compares the field
  against the tree and reddens on a missing name.

## Implementation (GREEN)

Measured at the GREEN head, branch `OP-135-task-report-counter-recount`, whose
base is the pin head `d3e48ad9` merged with `origin/main` `e04d07d6`. The pin
card's two spec files are byte-identical at this head
(`git diff d3e48ad9 -- apps/web/src/test/integration/event-indexing-counters.test.ts apps/web/src/test/unit/attendee-poll-policy.test.ts`
is empty); `docs/adr/README.md` is byte-identical against the pin head, because
the ledger moved once, in the pin card.

### The four changes, and why each file

| file                                                                             | change                                                                                                                                                                          | why                                                                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/server/repos/cross-tenant.ts`                                      | `OwnedWorkItemRow` gains `eventId`, and `findWorkItemById` projects `eventId: 1`                                                                                                | the recount is keyed by the event a reported image belongs to; the projection carried `tenantId`, `profileId` and `processing` only |
| `apps/web/src/app/api/v1/internal/worker/report/route.ts`                        | a `Map` collects each distinct `(tenantId, eventId)` whose `event_image` write matched the lease; after the item loop, two counts and one `$set` per entry                      | §Decision item 1 — the fact is written where it is produced                                                                         |
| `apps/web/src/server/attendee/poll-policy.ts`                                    | `EventIndexingCounters` gains `failedImageCount`; the predicate becomes `processedImageCount + failedImageCount >= imageCount`; the TSDoc says "every image has left the queue" | §Decision item 5 — one drained predicate for both attendee readers                                                                  |
| `apps/web/src/app/api/v1/p/events/[slug]/me/route.ts` and `.../gallery/route.ts` | the projected `counters` type gains `failedImageCount`, and the empty-fallback object carries `failedImageCount: 0`                                                             | the two readers call the widened predicate; the wire shapes are unchanged                                                           |

The item loop's per-item semantics are untouched: the lease filter, the
`reduceReportItem` decision, the selfie arm's transaction and the
`applied`/`leaseLost`/`rejected` bookkeeping are byte-identical to the pin
head. The `Map` is filled only after an `event_image` write matched the lease,
so a rejected or lease-lost item contributes no event to the recount — "each
distinct event that had at least one **applied** `event_image` item", verbatim.

### The recount

```ts
for (const { tenantId, eventId } of recounted.values()) {
  const tenant = tenantRepo(tenantId, db);
  const images = tenant.collection(COLLECTIONS.eventImages);
  const [done, failed] = await Promise.all([
    images.countDocuments({ eventId, deletedAt: null, "processing.status": "done" }),
    images.countDocuments({ eventId, deletedAt: null, "processing.status": "failed" }),
  ]);
  await tenant
    .collection(COLLECTIONS.events)
    .updateOne(
      { _id: eventId },
      { $set: { "counters.processedImageCount": done, "counters.failedImageCount": failed } }
    );
}
```

**Per distinct event per batch, after the items, never per item and never an
increment.** The loop runs once per map entry, so two done items of one event in
one batch cost one recount (P6), and a replay or a reprocess re-entry rewrites
the same figure instead of moving it (P2, P3). `counters.imageCount` and
`counters.storageBytes` are never written here (P1).

**Outside every transaction.** The `event_image` arm has no transaction of its
own, and the selfie arm's `withTransaction` stays scoped to the selfie and
profile rows. The recount therefore runs after the batch, not inside an item
transaction: widening one over `event_images` and `events` to protect a cache
would make every report a two-collection transaction. A crash between the item
writes and the recount leaves a stale counter, and the next report for that
event or the nightly `counter-reconcile` repairs it (§Consequences, "Residual
drift windows stay").

### Cost — two counts per distinct event, on the `{ eventId }` prefix

`explain` on a throwaway `mongod` (7.0.24) seeded with 50 events × 200
`event_images` rows and the shipped index (`event_images_event_asset_unique`,
`{ eventId: 1, assetId: 1 }`, unique). The report's own query, `verbosity:
"queryPlanner"`, for the `done` arm:

```text
COUNT → FETCH (filter: deletedAt {$eq: null}, processing.status {$eq: "done"})
      → IXSCAN indexName: "event_images_event_asset_unique"
               keyPattern: { eventId: 1, assetId: 1 }
               indexBounds.eventId: ["[ObjectId('6afc84c5…'), ObjectId('6afc84c5…')]"]
               indexBounds.assetId: ["[MinKey, MaxKey]"]
```

and the `failed` arm is the same plan with `processing.status {$eq: "failed"}` in
the filter. So each count is one index seek on the event's own prefix, then the
event's rows are fetched and filtered on `deletedAt`/`processing.status` — the
shape the organizer images list already runs twice per request
(`images/route.ts:128-129`, this record's §Decision item 3), and the counts
agreed with the seeded data (`count(done) = 160`, `count(failed) = 20` for the
sampled event).

### P1–P6 — green

`npx vitest run --project integration apps/web/src/test/integration/event-indexing-counters.test.ts`:

```text
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

and `npx vitest run --project unit apps/web/src/test/unit/attendee-poll-policy.test.ts`:

```text
 Test Files  1 passed (1)
      Tests  24 passed (24)
```

### Revert probes — one per mechanism

Each probe was applied to the GREEN head, run, and then undone with
`git checkout -- <file>`; after every probe `git status --short` printed
nothing, so the tree was byte-identical before the next one.

**1. Drop the recount (delete the post-loop block).** Pasted:

```text
 × (P1) recounts processedImageCount from source and leaves imageCount alone
   AssertionError: expected +0 to be 1 // Object.is equality
 × (P2) refuses the replay as leaseLost and keeps processedImageCount at one
   AssertionError: expected +0 to be 1 // Object.is equality
 × (P3) keeps processedImageCount at the live done rows, never two
   AssertionError: expected +0 to be 1 // Object.is equality
 × (P4) advances failedImageCount and drains the event
   AssertionError: expected +0 to be 1 // Object.is equality
 × (P6) recounts the event once and reports both rows as processed
   AssertionError: expected +0 to be 2 // Object.is equality
      Tests  5 failed | 1 passed (6)
```

Wider than the pin's own discrimination note ("P1/P4/P6 red"): P2 and P3 also
start from a report that no longer writes anything, so they redden too. P5 stays
green because it seeds `events.counters` directly and reads the predicate.

**2. Swap the recount for a bare `$inc` of the item's own status.** Pasted:

```text
 × (P3) keeps processedImageCount at the live done rows, never two
   AssertionError: expected 2 to be 1 // Object.is equality
      Tests  1 failed | 5 passed (6)
```

Only P3 reddens, exactly as this record predicts: P1, P2, P4 and P6 hold the
same total under an increment, and the reprocess re-entry is the case that
separates the two mechanisms.

**3. Restore `poll-policy.ts:78` to `processedImageCount >= imageCount`.** Pasted:

```text
 × (P4) advances failedImageCount and drains the event
   AssertionError: expected false to be true // Object.is equality
 × (P5) answers one indexingComplete for /me and the public landing page
   AssertionError: expected false to be true // Object.is equality
      Tests  2 failed | 4 passed (6)

 × eventIndexingComplete > answers { imageCount: 5, processedImageCount: 4, failedImageCount: 1 } with true
   AssertionError: expected false to be true // Object.is equality
 × eventIndexingComplete > drains an event whose only remaining image failed, so the gallery settles
   AssertionError: expected false to be true // Object.is equality
      Tests  2 failed | 22 passed (24)
```

P4 reddens as well as P5, because P4 ends by calling `eventIndexingComplete` on
the counters it just read — the unit cases are the same mechanism twice.

**4. Recount per item instead of per event.** Two shapes were measured, and the
card's stated outcome holds for the second one only:

- **A faithful per-item recount** (the same two event-scoped counts, moved
  inside the `event_image` arm after each item's write): `Tests  6 passed (6)`.
  It does not redden P6 — after the second item's write the event's done count
  is already `2`, so a per-item recount converges on the same figure. The cost
  is what differs (two counts per item, not per event), not the result.
- **A per-item `$set` of that item's own contribution** (the count scoped to
  the reported row instead of the event, which is the shape P6's own comment
  names): pasted

  ```text
   × (P4) advances failedImageCount and drains the event
     AssertionError: expected +0 to be 1 // Object.is equality
   × (P6) recounts the event once and reports both rows as processed
     AssertionError: expected 1 to be 2 // Object.is equality
        Tests  2 failed | 4 passed (6)
  ```

  P6 reddens with `1` where the event has `2` done rows, which is the
  under-report the case exists for; P4 reddens because the row-scoped failed
  count overwrites the event's processed figure with `0`. The per-item
  contribution is the mechanism P6 discriminates, and the recorded premise
  "recount per item → P6 red" is imprecise about which of the two shapes it
  means — this record states the measured answer for both.

### Guard results at this head

`tsc -p apps/web/tsconfig.json --noEmit` exit `0`, `eslint` on the five changed
files `no issues found`, `prettier --check` clean, and the six `adr-*` guards
(`adr-numbering`, `adr-record-links`, `adr-consumers`, `adr-source-references`,
`adr-inline-code-spans`, `adr-lane-ranges`) green. This record's `Consumers:`
field now names all five files that cite `ADR-0314`: the three source files
above and the pin card's two specs.
