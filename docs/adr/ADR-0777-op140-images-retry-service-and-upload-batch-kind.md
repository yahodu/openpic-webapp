# ADR-0777 — OP-140 precondition TEST: `retryFailedEventImages` with the admission inside, and an `upload_batch` emit kind

- **Status:** Accepted (RED pin — the service module and the emit change are the GREEN's)
- **Date:** 2026-11-23
- **Ticket:** OP-140 — _notification actions on the feed_, precondition for the contract §7.3 row
  `upload_batch × retry_failed`; owner lane: images (OP-127, continuing the OP-126 uploads lane
  range)
- **Card:** `t_9d80fb7f` (TEST, Low), worktree
  `/root/openpic/openpic-webapp/.worktrees/op140-precondition-images-retry`, branch
  `OP-140-task-precondition-images-retry-failed`, cut from `origin/main` `61579449` (the card named `da4e24cc`; PR #824 landed
  after the card was written, and every file:line it names still holds)
- **Consumes:** **ADR-0777** — this record is the draw. It consumes ADR-0942 §2 (the §7.3 row
  recorded as deferred, with `POST …/images:reprocess-failed` as the delegate), ADR-0942 §4.5 (the
  action kind is the emit's `subjectRef.kind`; the fan-out has no type→kind table), ADR-0762 and
  ADR-0763 (the OP-127 bulk retry route and its `{ requeuedCount }` answer), ADR-0760 (the OP-126
  batch summary and its `subjectRef`), and ADR-0300 / ADR-0302 (the lane-range ledger and the guard
  contract)
- **Supersedes:** nothing. ADR-0942, ADR-0760, ADR-0762 and ADR-0763 are not edited; `docs/API
Contract.md` is unchanged
- **GREEN:** `t_9d80fb7f`'s sibling card, the GREEN card `t_f8de2e20`, `Consumes: 0778`, carrying these specs byte-identically and
  the production change only

## Context

ADR-0942 §2 records the contract §7.3 row `upload_batch × retry_failed` as **deferred**. Two
preconditions are missing on the trunk, and they are of different kinds.

**The service.** `@/server/images/requeue` `requeueImages` (`requeue.ts:47`) resets rows a caller has
already loaded and admitted and re-enqueues each one; it takes `rows`, not a query, so it is not
something a delegate can call. Everything a delegate _would_ need lives in the route
(`images:reprocess-failed/route.ts`): the `eventActorAdmission(2)` **middleware** on line 37 and the
`find({ eventId, deletedAt: null, "processing.status": "failed" })` → `getPlatformSettings` →
`requeueImages` → `202 { requeuedCount }` handler on lines 38–63. A §7.3 delegate has no HTTP
request, so there is no middleware to run against it and no stage to throw the refusal for it.

**The emit.** `checkUploadBatchTransition` (`batch-notifications.ts:299`) emits
`upload.batch.completed*` with `subjectRef: { kind: "user", id: uploader }`. Under ADR-0942 §4.5 the
action kind comes from the emit — there is no type→kind table in the fan-out — so that row can never
carry `actionTarget.kind: "upload_batch"`, whatever the catalogue says. (`:362` is
`upload.blocked.quota`, a different key; out of scope.)

Both preconditions are production changes, so this card delivers the **specs** and the GREEN delivers
the code.

## Decision

### D1 — the service is `retryFailedEventImages` in `@/server/images/retry-failed`

```
module  apps/web/src/server/images/retry-failed.ts

interface RetryFailedEventImagesInput {
  readonly db: Db;
  readonly tenantId: ObjectId;    // the event's workspace
  readonly eventId: ObjectId;
  readonly actorUserId: string;   // the caller's Better Auth id (hex)
  readonly spaceKey: string;      // platformSettings.face.activeSpaceKey
  readonly requestId: string;
  readonly now: Date;
  readonly logger?: Logger;
}

retryFailedEventImages(input): Promise<{ readonly requeuedCount: number }>
```

`tenantId` is an `ObjectId`, not the route context's hex string: the service is the seam a delegate
calls, and `tenantId.toHexString()` is the one conversion the service owns. `now` and `spaceKey` are
inputs rather than reads, exactly as `requeueImages` already takes them, so the service never reads a
clock and a case can assert the stamped instant. The answer is the route's answer today, so the route
can become a thin delegate without its wire contract moving.

The bulk reset and the enqueue are `requeueImages`' — the service must not duplicate the
`updateOne`/`enqueueWork` pair, so the reset keeps that module's contract (`attempts` zeroed,
`maxAttempts`/`priority`/`modelKeys` kept, run state cleared, `queuedAt = now`) instead of acquiring a
second copy of it that can drift.

### D2 — the admission is re-checked inside, as the _same_ rule, and refuses the _same_ `404`

`admitEventActor` (`access.ts:95`) is middleware-shaped: it takes a request and the stage's `deny`,
which throws `appError("not_found")` (`route-stage.ts:145`). A service cannot call it. What it makes
is two checks, and **both are already exported seams**:

1. the tenant-scoped `events` read — `tenantRepo(tenantKey).collection(events).findOne({ _id: eventId })`
   — which is simultaneously the existence check and the workspace check, so another workspace's
   event is the uniform `404` (§0.4, never an oracle);
2. `resolveEventActorRole(db, eventId, tenantKey, userId)` — the ladder: an `event_organizers` row
   with role `organizer` or `co_organizer` and `revokedAt: null`, else an active `tenantMembers` row
   of the event's workspace.

The service composes those two and throws `appError("not_found")` on either miss. This is what the
card's "call the same rule the middleware calls" means in practice: **reuse, do not re-implement**. A
service that re-wrote the role test would drift from `admitEventActor` the first time that ladder
changes; a service that skipped the re-check would hand every caller who can reach the delegation
their own bulk reset over another organizer's event.

The spec pins the ladder positively and negatively, with no HTTP layer at all: a co-organizer holding
no `tenantMembers` row and an active tenant member are admitted; a caller with no relationship, a
revoked organizer, a member of another workspace, an event of another workspace and an event that
does not exist all throw `{ status: 404, code: "not_found" }` **and** leave every row where it was and
the broker's ledger unchanged.

### D3 — the emit's `subjectRef` becomes `{ kind: "upload_batch", id: eventId.toHexString() }`

`subjectRef.id` is the **event's** ObjectId hex, not the `batchId`. Three measured reasons:

1. `apps/web/src/app/api/v1/me/notifications/[id]/actions/[actionKey]/route.ts:118-127` refuses an
   `actionTarget.id` that is not 24 hex, so a target the endpoint cannot address is not a target;
2. a batch has **no document of its own** — only `upload_sessions` rows share a `batchId`, and
   `batch-notifications.ts:107` `batchMatch` accepts a `string` _or_ an `ObjectId`, so `batchId` is
   not reliably 24-hex at all;
3. the §7.3 delegate is the **event-scoped** route, so the event is the id the action needs.

`actorRef` stays the uploader (it already is), and `data.batchId` stays in the payload for display and
for the delegate arm to resolve the batch. The dedupe key is untouched: one summary per
`(batch, uploader)` is still what the emitted set contains, so the pin reads the **actor** when it
asserts the per-uploader split.

### D4 — the pin reads the outbox row, never the feed row

`upload.batch.completed*` is not `actionable` yet, so `fan-out.ts:456` builds no `actionTarget` and a
feed-level assertion would pass on Today's tree — it would pin nothing. The two new cases read
`domain_events` (`subjectRef.kind` + `subjectRef.id`), which is where the decision lives.

### D5 — the nine OP-136 pins of the same field move with the contract

The emit change reddens **eight** cases in
`apps/web/src/test/integration/job-pipeline-indexed-check.test.ts`, which pins the same outbox
`subjectRef` of the same emitter at nine sites (`I7`, `I9`, `I10`, `I14`, `I17`, `I20`, `I23`, `I28`).
This is a scope consequence the card did not predict, and it is resolved here rather than left to the
GREEN: the GREEN "carries the spec byte-identically (no test edits)", so a pin the contract moves and
that neither card owns would land red and stall the lane's merge gate.

Each of the nine sites is retargeted **mechanically and intent-preservingly**: the `subjectRef`
assertion becomes `{ kind: "upload_batch", id: <the seeded event>.toHexString() }`, and the uploader
the original line pinned moves to `actorRef` — `{ kind: "user", id: <the same uploader> }` — so the
original intent ("the summary is addressed to the batch's uploader") is still asserted, not dropped.
`OutboxRow` in that spec gains the `actorRef` field it now reads. No case is added, removed, renamed
or weakened, and no other case body is touched.

### D6 — the route's delegation is the GREEN's, and its wire contract is already pinned

The route becomes a thin delegate (`tenantId` → `ObjectId`, no `find`, no `requeueImages`). Its
observable contract — the admitted callers, the `202 { requeuedCount }`, the eligible rows
(`deletedAt: null`, `processing.status: "failed"`, this event only) — is pinned by
`event-images-management.test.ts` (`I4` and the `X1`–`X3` ladder), which this card does not edit and
which measures **27 passed (27)** on this branch. So no new route-level pin is added here; a delegated
route that changes the wire reddens a reviewed case rather than passing silently.

## Number allocation

`0777` is drawn from the **OP-126 uploads lane** row of `docs/adr/README.md` (`Reserved range`
`0760`–`0779`), whose `Next free` cell read `0777` at this branch cut. The cell advances to `0779`:
this record consumes `0777`, the GREEN sibling consumes `0778` and writes no ledger row, and `0779` is
the row's **range end** — so the next draw by an uploads-lane card after that goes to the
allocator-owned pool (`unallocated (future lanes)`), not back into `0760`–`0779`.

Swept before minting: no `ADR-0777`, `ADR-0778` or `ADR-0779` file exists in the trunk's
`docs/adr`, in any `.worktrees/*/docs/adr` tree, in `git rev-list --objects --all -- docs/adr`, or on
an open PR head; and no non-done card body reserves one. The highest number present inside
`0760`–`0779` anywhere is `0776`.

## Evidence (measured on this branch)

**RED at the branch point — the import arm.**

```
FAIL  |integration| apps/web/src/test/integration/event-images-retry-service.test.ts
Error: Cannot find package '@/server/images/retry-failed' imported from
  …/event-images-retry-service.test.ts
 Test Files  1 failed (1)
      Tests  no tests
```

**RED at the branch point — the emit arm.**

```
AssertionError: expected { kind: 'user', …(1) } to deeply equal { kind: 'upload_batch', …(1) }
 uploads-batch-status.test.ts        Tests  5 failed | 7 passed (12)
 job-pipeline-indexed-check.test.ts  Tests  8 failed | 24 passed (32)
```

**The admission arm, measured against a throwaway near-fix that implements the requeue and drops the
re-check.** Five of ten cases red, each on its own assertion — this is the measurement the card
demands, because the import failure alone says nothing about the admission:

```
AssertionError: expected null to deeply equal { "code": "not_found", "status": 404 }
  · refuses 404 not_found for a caller with no relationship to the event, writing nothing
  · refuses 404 not_found once the organizer's row is revoked, writing nothing
  · refuses 404 not_found for a member of another workspace, writing nothing
  · refuses 404 not_found when the event belongs to another workspace, writing nothing
  · refuses 404 not_found when the event does not exist, writing nothing
 Tests  5 failed | 5 passed (10)
```

`refusalOf` returning `null` is the honest shape of the failure: the call **resolved**, which is
exactly what a service without the re-check does — it also reports that the rows moved.

**The near-fix that adds the two seams turns the whole spec green: `Tests 10 passed (10)`.** Both
near-fixes are deleted before the commit; `git status --short` shows only the three specs and this
record.

**The emit near-fix** (one line, `subjectRef.kind: "upload_batch"` and `id: input.eventId.toHexString()`)
turns both suites green: `uploads-batch-status.test.ts` **12 passed (12)** and
`job-pipeline-indexed-check.test.ts` **32 passed (32)**, with the nine retargeted pins passing
alongside the two new ones. Reverting the line reddens exactly the five and the eight.

**Neighbouring suites.** `event-images-management.test.ts` **27 passed (27)** — the route contract
this card must not move. `notification-fan-out.test.ts`, `notification-recipients.test.ts` and
`notification-feed.test.ts` **all green** under the emit near-fix, so the audience does not depend on
the subject being a user for this type (`ORGANIZERS` is the audience; the uploader is an organizer).

## Consequences

- The GREEN's production change is small and confined: one new module, one route handler rewritten to
  delegate, one `subjectRef` line. Nothing in `notification-actions.ts`, the actions route,
  `fan-out.ts` or `notification-types.values.ts` moves — those are the later OP-140 card's.
- `upload.batch.completed*`'s feed row is unchanged in audience and content today: the type is not
  `actionable`, `subjectUserId` becomes `null` (`fan-out.ts:1239`), and the uploader is still an
  `ORGANIZERS` recipient. Once the type becomes actionable, `actionTarget` appears with the
  `upload_batch` kind and the event's id — which is the point.
- The nine OP-136 pins now assert the actor and the subject separately, so a future emit that loses
  either the uploader or the event reddens a named case instead of passing.
- **Open item O1.** The `upload_batch × retry_failed` arm still answers `{ outcome: "unavailable" }`
  (`route.ts:163-165`) until the catalogue flip and the delegate arm land. This record unblocks that
  work; it does not do it.
- **Open item O2.** `event x extend_upload_window` remains parked on its contract decision
  (ADR-0942 §2, §4.7) — untouched here.

## Reversal condition

> When this service exists with the admission re-checked inside it and the `upload.batch.completed*`
> emit names the `upload_batch` kind, the OP-140 `upload_batch × retry_failed` arm can call it (owner:
> OP-140 notifications lane; that arm resolves the batch's event from the row's own payload).

## Round-1 review (TEST card t_9d80fb7f, draft PR #829)

- **Verdict — approved as delivered.** The spec set was reviewed at `1e769a7b` and approved, with the two findings below routed rather than fixed here. The RED is **by design** (ADR-0306): PR #829 stays a draft and is never merged, and this record reaches the trunk through the GREEN's PR (#854, squash `61fa3eec`). An open draft on #829 is therefore a signed-off pin delivery, not an abandoned one.
- **Independently re-measured, not transcribed.** At `1e769a7b` the focused integration set read `13 failed | 31 passed (44)`: 8 failures in `job-pipeline-indexed-check.test.ts`, 5 in `uploads-batch-status.test.ts`, and one file-level `Cannot find package '@/server/images/retry-failed'` import failure in the new `event-images-retry-service.test.ts` (0 tests collected). `tsc -p apps/web --noEmit` reported exactly one diagnostic, the `TS2307` for that specifier. The ADR guards read `248 passed (248)` across the seven files present at that head — the family has since grown to eight files and `280 passed (280)` at the base this section lands on. `event-images-management.test.ts` read `27 passed (27)`, `prettier --check` was clean on all five changed paths, and the diff carried no `@ts-ignore`, `eslint-disable`, `console.*`, `TODO` or `.skip(`.
- **Satisfiability proved independently.** A throwaway faithful implementation, built in a detached probe worktree from D1/D2/D4 and the two admission seams only, turned the whole set green: `54 passed (54)` across the three files. Deleting the two admission throws from that same implementation reddened **exactly** the five refusal cases, `5 failed | 5 passed (10)`. That is the load-bearing result: the set is not satisfiable by a service that skips the re-check, so the admission arm is pinned rather than merely present.
- **D5 reviewed and accepted.** The nine OP-136 pins in `job-pipeline-indexed-check.test.ts` were retargeted by this lane although the card gave the implementer no other spec. The review measured the retarget as mechanical and intent-preserving: `subjectRef` becomes `{ kind: "upload_batch", id: <event hex> }`, the uploader the old line pinned moves to `actorRef`, the case count is unchanged at 32, and the new pair is strictly stronger than the single assertion it replaced. No case was weakened. It was accepted rather than bounced because the alternative was eight red cases left on the GREEN's merge gate with no card owning them.
- **F1 (Low, observability) routed, not fixed here.** The service refuses with `appError("not_found")` and logs nothing, while the HTTP middleware it mirrors logs `logger.warn("tenant access denied", { event: "tenancy.access_denied", reason })` at `apps/web/src/server/tenancy/route-stage.ts:147-150` (the `warn` on `:148`, the `throw` on `:149`) before throwing the same error — so a refused delegate-path retry is invisible to security monitoring. The gap is routed to TEST card `t_f17bed7b`, cited by id rather than by an ADR number because that card may renumber while its PR is open.
- **Nothing in §D1–§D6 is retracted.** This section records what the round-1 review verified and what it routed; it revises no decision.
