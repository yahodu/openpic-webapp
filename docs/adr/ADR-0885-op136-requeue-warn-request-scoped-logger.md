# ADR-0885 — OP-136 GREEN: both reprocess routes hand the requeue enqueue warn the _request's_ logger

- **Status:** Accepted (GREEN) · **Date:** 2026-11-20
- **Card:** OP-136 GREEN (Low) `t_9e0979c4` (finding **F1** of the review of
  `t_0924f321`, whose PR #667 squash-merged as `268c842e`; branch
  `OP-136-task-requeue-warn-request-logger`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_0924f321`, cut from the pins branch
  `OP-136-task-requeue-warn-pins` head `927be16` and carrying its spec
  byte-identically).
- **Implements:** contract §18.1 (a refused enqueue is a `warn`, never a failed
  request), §4.4 (reprocess); schema §18.1/§18.2.
- **Consumes:** [ADR-0868](ADR-0868-op136-requeue-warn-request-correlation-pins.md)
  (the four pins this change turns green, carried unedited),
  [ADR-0865](ADR-0865-op136-requeue-enqueue-warn.md) (the shipped
  `logger: input.logger` pass-through whose two call sites this record corrects).
- **Consumers:** `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/images:reprocess-failed/route.ts`
  and `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/images/[imageId]/reprocess/route.ts`
  (both switched), and `apps/web/src/test/integration/image-requeue-enqueue-warn-pins.test.ts`
  (Pin B asserts the switch).
- **Number allocation:** the card reserved `0867`, which is stale: `0866`,
  `0867` and `0868` all exist on the base (`0868` is the pins record this card
  carries). At mint time (2026-11-20, `origin/main` `41aec3b0`, merged into the
  branch) both `Next free` cells read `` `0883` ``; the sweep found the highest
  consumed number anywhere is `0884` — `ADR-0884-op136-multi-row-containment-pins.md`
  on the local branch `OP-136-task-multi-row-containment-pins`, which has no
  worktree and no PR head, and no `ADR-0884` file in any `.worktrees/*/docs/adr`
  tree or on any fetched PR head. `git rev-list --objects --all -- docs/adr`
  stops at `0884`; PR #746's head holds `0883`, PR #743's `0881`, PR #747's
  `0881` and #272's `0306`; no record holds `0885`. The block `0849`–`0868` is
  exhausted, so this is a **pool draw** under ADR-0300 §11 item 18: it draws
  `0885` and advances **both** the `OP-136 jobs lane` cell and the
  `unallocated (future lanes)` cursor to `0886` — one above this record, so
  neither can re-mint it. No range is re-cut.

## Context

ADR-0865 plumbed a logger from both reprocess routes into
`requeueImages` → `enqueueWork`, so a refused enqueue now prints the §18.1
`queue.enqueue_failed` warn instead of nothing. Both routes passed
`getLogger()` — the **process** logger. Measured inside a request scope:
`getLogger()` emits the keys `["event"]`; `requestLogger(request, { route })`
emits `["requestId", "route", "event"]` with `requestId: "req_probe_scope"`.
So the one log line §18.1 makes the operator's only signal could not be tied to
the request that lost the enqueue, while the sibling seam
(`apps/web/src/app/api/v1/p/events/[slug]/selfies/route.ts`, `enqueueSelfie`)
already passes `requestLogger(ctx.request, { route: ctx.route })`.

ADR-0865's §3 heading says "Both routes pass `logger: getLogger()`", its prose
calls that "the request's logger", and its Consequences bullet calls it "the
process request logger, so it carries the logger's bindings". The last two are
wrong: the process logger carries only `service`/`env`. This record supersedes
that wording with the measured field sets above; nothing else in ADR-0865 is
retracted — the pass-through, the optional field and the `EnqueueWorkOptions`
type widening all shipped and are correct.

## Decision

1. Both routes pass `logger: requestLogger(ctx.request, { route: ctx.route })`
   into `requeueImages`, the exact shape the selfies route uses. The now-unused
   `getLogger` import is dropped from each file; `requestLogger` comes from the
   same `@/server/logging` barrel.
2. Nothing else changes. The durable `queued` reset write still precedes the
   enqueue (§18.1), `requeueImages` and `enqueueWork` are untouched (envelope,
   `priority` derivation and the `{ enqueued }` return), and both routes keep
   `202` + `{ requeuedCount }` (bulk) and `202` + the §4.4 item (single). A
   refused enqueue is still a `warn`, never a failed request.
3. The pin spec and ADR-0868 are carried **byte-identically** from the pins head
   `927be16`; no case, fixture, helper or assertion is edited.

## Evidence

- Pins at the pin head `927be16`: `Tests 2 failed | 2 passed (4)`, reddening
  `expected undefined to be 'req_pin_0001'` and `… 'req_pin_0002'`. With this
  change: `Tests 4 passed (4)` — Pin A (both arms, unchanged) plus Pin B (both
  routes carrying the request's `requestId` and matched `route`).
- `image-requeue-enqueue-warn-pins.test.ts` + `event-images-management.test.ts`:
  `Test Files 2 passed (2)`, `Tests 31 passed (31)` — so
  `event-images-management` still reads `27 passed (27)`.
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` 0 on both touched
  routes; `prettier --check` clean on both; the six `adr-*` guards green.
- The pins were proven load-bearing by their own card, not re-probed here: the
  independent route cases were shown to red alone and the fix shape shown to
  turn the file `4 passed (4)` (ADR-0868 §Evidence).

## Consequences and known limits

- **The warn now carries `requestId` and `route` from the logger's bindings, not
  from the payload.** Any future caller of `requeueImages` that passes the
  process logger again re-opens the silent-correlation gap; the pins on the two
  routes are the guard for these two seams only.
- **A broker refusal is still not a failed request.** The routes answer `202`
  with the durable `queued` row and a null `queueRef`; the sweep owns the retry,
  as §18.1 requires.
- Out of scope, unpinned: the volume of the warn under a persistent outage.

## Alternatives

- **Keep `getLogger()` and add `requestId` to the `enqueueWork` payload.** It
  would duplicate a field the logger seam already carries and would change the
  envelope ADR-0865 froze; rejected.
- **A `getLogger().child({ requestId, route })` at each route.** It satisfies
  Pin B, but it re-implements `requestLogger`, which is the house helper for
  exactly this and already owned by `@/server/logging`; rejected.
