# ADR-0865 — OP-136 follow-up: `images/requeue.ts` forwards the caller's logger to its enqueue

- **Status:** Accepted · **Date:** 2026-11-17
- **Card:** OP-136 follow-up (Low) `t_0924f321` (finding **F2** of the review of
  `t_bc01c854`, PR #663; branch `OP-136-task-requeue-enqueue-warn`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_0924f321`).
- **Implements:** contract §4.4 (reprocess), §18.1 (a refused enqueue is a warn,
  never a failed request); schema §18.2.
- **Consumes:** [ADR-0863](ADR-0863-op136-sweep-ack-grace-and-entitlement-cache.md)
  §1 (the same silent seam, fixed for `pipeline-sweep`; this record closes the
  sibling module it left).
- **Consumers:** `apps/web/src/server/images/requeue.ts`,
  `apps/web/src/server/queue/enqueue-work.ts`,
  `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/images:reprocess-failed/route.ts`,
  `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/images/[imageId]/reprocess/route.ts`.
- **Number allocation:** the `OP-136 jobs lane` row read `` `0864` `` when this
  record was minted (`origin/main` `4a295db5`). The sweep found `ADR-0864*`
  (`ADR-0864-op136-sweep-observability-pins.md`) already committed on the lane's
  own sibling branch `OP-136-task-sweep-observability-pins` (worktree
  `.worktrees/t_bc01c854`) and nowhere else — the trunk, every other
  `.worktrees/*/docs/adr` tree, `git rev-list --objects --all -- docs/adr` (which
  includes it, from that branch) and all twenty open PR heads all stop at
  `0863`/`0864` — so this record takes the first number above the highest
  consumed one, `0865`, and advances **only** the `OP-136 jobs lane` cell to
  `` `0866` ``; both `unallocated (future lanes)` cells stay `0869`. No frozen
  record is edited.

## Context

`images/requeue.ts` reset each admitted row to `queued`, wrote it, and then called
`enqueueWork` — **without** a `logger`. Its own docblock promised the opposite:
"A failed enqueue is a `warn` inside `enqueueWork`, not a failed request". The
warn is the only failure line that module writes
(`options.logger?.warn("Queue enqueue failed; …", { event:
"queue.enqueue_failed", … })`), and the option is optional, so on this path a
broker refusal was **silent**: no operator signal, although §18.1 makes that warn
the signal, and the row simply sat `queued` for `pipeline-sweep` step 2.

This is the defect class ADR-0863 §1 fixed for the two `pipeline-sweep` call
sites. Both route callers of `requeueImages` had a request context available —
`…/images:reprocess-failed` and `…/images/{imageId}/reprocess` — and
`uploads/complete-upload.ts` already shipped the precedent (`logger:
getLogger()` into the same `enqueueWork`).

## Decision

### 1. `RequeueImagesInput` carries an optional `Logger`, forwarded verbatim

`requeueImages` accepts `logger?: Logger` and passes `logger: input.logger` into
the `enqueueWork` call — nothing else in the module moves. The durable `queued`
write still precedes the enqueue (§18.1), and the envelope, the `priority`
derivation and the return type are byte-identical.

The field stays **optional** so a caller with no logger still type-checks and
every existing spec, fixture and helper that drives the routes is untouched
(they are, byte-identically, on this branch).

### 2. `EnqueueWorkOptions.logger` is widened to `Logger | undefined`

The project compiles with `exactOptionalPropertyTypes: true`, under which an
optional property does not accept an explicitly `undefined` value: forwarding
`input.logger` verbatim into `logger?: Logger` is a type error even though both
sides say "optional". The options type now spells `logger?: Logger | undefined`,
which is the same runtime contract — the field is absent or a logger, and
`options.logger?.warn` is unchanged — stated so a caller that forwards its own
optional logger compiles. Type-only change; no behaviour.

Rejected alternatives:

- **A conditional spread at the call site**
  (`...(input.logger === undefined ? {} : { logger: input.logger })`) — the house
  pattern for genuinely optional payload fields, but here it encodes a type-system
  limitation as runtime noise in the middle of the enqueue call.
- **`getLogger()` inside `requeueImages`** — the module is driven directly by
  tests with an injected logger (the `CronJobContext` precedent), so the logger
  must come from the caller, not from the process singleton.
- **Making the field required** — it would force every existing construction of
  the input to change, and the card's acceptance keeps them byte-identical.

### 3. Both routes pass `logger: getLogger()`

`…/images:reprocess-failed` and `…/images/{imageId}/reprocess` pass the request's
logger, following `complete-upload.ts`. No status code, header or response shape
changes: a broker refusal still answers `202`/`{ requeuedCount }` and the item
still waits `queued` for the sweep.

## Evidence

A throwaway integration probe (deleted before the commit) refused the broker
(`(getWorkQueue() as MemoryWorkQueue).enqueue = async () => { throw new
Error("broker refused") }`) and drove `requeueImages` with a `recordingLogger()`:

- refused broker → **exactly one** `queue.enqueue_failed`, `level: "warn"`,
  `fields.kind: "event_image"`, message `Queue enqueue failed; the work item
stays queued for the sweep.`; the row is `processing.status: "queued"` with
  `processing.queueRef: null`;
- healthy broker (same seed, same logger, `clear()`ed) → **zero**
  `queue.enqueue_failed`, and `processing.queueRef` is the accepted
  `{ queueKey: "q:image", provider: "memory", messageId: "memory-1" }`;
- **negative control**: deleting the one `logger: input.logger` line reddens the
  probe with `expected [] to have a length of 1 but got +0`, so the pass-through
  is what prints the warn; the file was restored afterwards.

The existing behaviour is unchanged where it was pinned:
`apps/web/src/test/integration/event-images-management.test.ts` `27 passed (27)`
(both reprocess routes, their status codes and their response shapes).

Full `vitest run --project unit --project integration --coverage`, measured at
the merged head (which carries `origin/main`'s `internal-worker-endpoints`
spec from PR #665): `325 passed (325)` files,
`4576 passed | 3 skipped (4579)` tests, statements 91.58 %, branches 80.33 %,
functions 95.95 %, lines 91.71 %, exit `0`. The six `adr-*` guard specs:
`6 passed (6)` / `236 passed (236)`. Typecheck
(`tsc -p apps/web/tsconfig.json --noEmit`) exit `0`, `eslint` 0 on the four
touched files, `prettier --check` clean on all six paths.

## Consequences and known limits

- The logger stays optional on the input, so a **future** caller that omits it
  re-opens the silent seam. The two routes are the only callers, and both pass
  it; no guard pins that, exactly as no guard pins the two ADR-0863 call sites
  (the sibling pin card `t_8bd36a07`/ADR-0864 is what pins those).
- The warn is written through the process request logger, so it carries the
  logger's bindings; the enqueue path adds nothing to the request context.
- A broker refusal still leaves the row `queued` with no `queueRef` — the sweep
  owns recovery (§18.1); this record only makes the refusal observable.
