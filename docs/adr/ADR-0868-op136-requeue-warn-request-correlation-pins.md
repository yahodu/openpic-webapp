# ADR-0868 — OP-136 follow-up: pins for the requeue enqueue warn and its request correlation through both reprocess routes

- **Status:** Accepted (TEST, Pin B RED by design) · **Date:** 2026-11-20
- **Card:** OP-136 TEST (Low) `t_76021c6a` (finding **F2** and the RED half of
  **F1** of the review of `t_0924f321`; that card's PR #667 squash-merged as
  `268c842e`; branch `OP-136-task-requeue-warn-pins`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_0924f321`, cut from the current
  trunk `origin/main` `5790a785`). Test-only: no production file is in the diff.
- **Implements:** contract §18.1 (a refused enqueue is a `warn`, never a failed
  request), §4.4 (reprocess); schema §18.1/§18.2.
- **Consumes:** [ADR-0865](ADR-0865-op136-requeue-enqueue-warn.md) (the shipped
  `logger: input.logger` pass-through these pins characterize),
  [ADR-0864](ADR-0864-op136-sweep-observability-pins.md) (the sibling call sites'
  pins and the `recordingLogger()` harness this file reuses),
  [ADR-0863](ADR-0863-op136-sweep-ack-grace-and-entitlement-cache.md) §1.
- **Consumers:** `apps/web/src/test/integration/image-requeue-enqueue-warn-pins.test.ts`
  (the four pins), and the three modules they constrain,
  `apps/web/src/server/images/requeue.ts`,
  `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/images:reprocess-failed/route.ts`
  and `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/images/[imageId]/reprocess/route.ts`.
- **Number allocation:** the `OP-136 jobs lane` row's `Next free` cell and the
  `unallocated (future lanes)` cursor both read `` `0882` `` at this base
  (`5790a785`) and still read `` `0882` `` on the trunk (`acade549`), raised by
  later draws. The sweep immediately before minting (2026-11-20, trunk
  `acade549`) found **no** `ADR-0868` anywhere: the trunk's own rows skip it
  (`0867` → `0869`), no `.worktrees/*/docs/adr` tree carries one (this card's
  own untracked file is the only candidate and it is on no branch), and
  `git rev-list --objects --all -- docs/adr` contains no `ADR-0868` while
  stopping at `ADR-0883`. The in-flight heads that hold numbers above this one
  are PR #746 (`0883`), PR #745 (`0882`), PR #743 (`0875`) and PR #272 (`0283`);
  none of them mints `0868`. The trunk ledger already records `ADR-0868` **as in
  flight in this worktree** — ADR-0869's and ADR-0876's rows both name it — so
  `0868` is this card's reservation, and it is the last number of the lane's
  range `0849`–`0868`. No cell is lowered and no cell moves for this draw: the
  consumed count `0882` already sits above `0868`. No frozen record is edited.

## Context

ADR-0865 made `requeueImages` forward its caller's logger into `enqueueWork`, so a
refused reprocess enqueue now prints the §18.1 `queue.enqueue_failed` warn. Two
gaps were left, both measured by the reviewer of PR #667 and re-measured here:

- **The observable was unpinned (F2).** `grep -rn enqueue_failed
apps/web/src/test` returned only ADR-0864's sweep pins and the queue-adapter
  spec. Deleting the one `logger: input.logger` line left the whole suite green:
  the refused arm's `warnCount` went `1 → 0` with no test failing, so the shipped
  pass-through could be removed silently.
- **The warn was uncorrelated with the request (F1).** Both routes pass
  `getLogger()` — the _process_ logger. Measured inside a request scope,
  `getLogger()` emits the field set `["event"]`, while
  `requestLogger(request, { route })` emits `["requestId", "route", "event"]`
  with `requestId: "req_probe_scope"`. §18.1 makes this warn the operator's only
  signal, and today it cannot say which request lost the enqueue. The sibling
  seam does it right: `apps/web/src/app/api/v1/p/events/[slug]/selfies/route.ts`
  passes `logger: requestLogger(ctx.request, { route: ctx.route })` into
  `enqueueSelfie`.

`defineRoute` already binds `route` on the context and exposes it to the handler
(`apps/web/src/server/http/define-route.ts`), and `requestLogger` resolves the
correlation id from the live request context first, then the inbound
`x-request-id` header — so the fix is a two-line call-site change, and the pins
must describe that outcome without prescribing it.

## Decision

### 1. One new integration spec, four cases, additive only

`apps/web/src/test/integration/image-requeue-enqueue-warn-pins.test.ts` (new; no
existing spec, fixture, helper, factory or frozen record touched):

- **A1 — the healthy control.** The same seed on an accepting broker prints
  **zero** `queue.enqueue_failed` entries, stores the accepted pointer
  `{ queueKey: "q:image", provider: "memory", messageId: "memory-1" }` on the
  row, leaves it `queued`, and puts exactly one envelope on the wire with
  `kind: "event_image"` and `traceId` = the caller's `requestId`. Without this
  arm, A2 would also pass on a `requeueImages` that warns on every call.
- **A2 — the refused arm (F2).** A broker whose `enqueue` rejects yields
  **exactly one** `queue.enqueue_failed`, `level: "warn"`, `fields.kind ===
"event_image"`, `fields.queueKey === "q:image"`; the row is left
  `processing.status: "queued"` with `attempts: 0`, `lastError: null` and
  `processing.queueRef: null`, and nothing reaches the outbox. The pre-enqueue
  state is read **from inside the refusal** (`refuseEnqueue(onRefusal)`), which
  is the only instant that shows the reset write preceded the enqueue.
- **B1 / B2 — the request correlation (F1, RED on arrival).** One case per route
  (`…/images:reprocess-failed`, `…/images/{imageId}/reprocess`), each sending an
  `x-request-id` that satisfies `/^[A-Za-z0-9_-]{8,64}$/` and asserting the
  emitted warn's `fields.requestId` equals it and `fields.route` equals the
  matched template. Each case asserts the **missing field** first and the
  contract's `202` / body after, so today's failure is
  `expected undefined to be 'req_pin_0001'`, never a status assertion: a refused
  enqueue is not a failed request (§18.1). `tenantId`/`userId` bindings are
  deliberately **not** asserted, because `requestLogger` binds only what it is
  given.

Each route is its own case so a single case cannot redden only on its first
failing arm, and each restores the process logger and the broker in a `finally`
(`@/server/logging` has no reset, so a leaked recorder would silence every later
case in the file).

### 2. Both halves are proven: one is load-bearing, the other is satisfiable

The probes were applied **in the lane worktree** — one mutation at a time, over
the committed `HEAD` (`5790a785`), each reverted with `git checkout -- <path>`
and re-hashed to its committed bytes before the next ran, so no lane file was
ever left mutated and nothing uncommitted survived a probe. (A detached throwaway
worktree cannot resolve this pnpm workspace's `node_modules` without a fresh
install, so the mutation was done in place and the bytes were proven equal
instead; `git status --short` after the last probe shows only the three files of
this delivery — the new spec, this record and the ledger.)

| Mutation                                                                   | Result                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logger: input.logger` deleted from `requeue.ts`                           | `Tests 3 failed \| 1 passed (4)` — A2 reads `expected [] to have a length of 1 but got +0`, B1/B2 red on the same count, so the F2 observable is load-bearing                                |
| Both routes switched to `requestLogger(ctx.request, { route: ctx.route })` | `Tests 4 passed (4)` — Pin B is satisfiable, and the two call-site edits are the whole fix                                                                                                   |
| Only the single-image route switched (bulk left on `getLogger()`)          | `Tests 1 failed \| 3 passed (4)` — B1 alone red with `expected undefined to be 'req_pin_0001'` and B2 green, so the two route cases are independent and neither hides behind the other's arm |

`tsc -p apps/web/tsconfig.json --noEmit` exits `0` on the switched routes, so
the GREEN shape the pins ask for type-checks as written. `requeue.ts`
(`sha256 55a3fe16…54a20a`), the bulk route (`sha256 d10261ad…436dfe1`) and the
single route (`sha256 8eda28f8…040e642`) hashed back to those exact values after
every probe.

## Evidence

- At the head (`5790a785`): `Test Files 1 failed (1)` / `Tests 2 failed | 2
passed (4)` — A1 and A2 green, B1 and B2 red with
  `expected undefined to be 'req_pin_0001'` and `… 'req_pin_0002'`.
- Full `integration` project at the head: **148 files**, `Test Files 1 failed |
147 passed (148)`, `Tests 2 failed | 1549 passed (1551)` — the two failures are
  B1 and B2 in this file and nothing else reddens.
- With the near-fix (`requestLogger` at both call sites): `Tests 4 passed (4)`;
  with it at one call site only: `Tests 1 failed | 3 passed (4)`.
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` 0 issues on the new
  file; `prettier --check` clean on the new file, this record and
  `docs/adr/README.md`.
- The six `adr-*` guard specs green: `6 passed (6)` files, `236 passed (236)`
  tests (numbering, lane ranges, consumers, record links, inline code spans,
  source references).
- The PR is a **draft** and is not merged: Pin B fails on the trunk, so a merge
  would redden `main`'s unit/integration job (the OP-93 / ADR-0306
  RED-by-design carve-out, as with ADR-0864's sibling pins). The GREEN card
  `t_9e0979c4` carries this file unchanged and closes the draft.
- The trunk advanced four commits while this card ran — `bffcc881` (the `next`
  15.5.29 bump), `b3f63308` (the indexed-check poison-row containment and its
  pins), `bba5f943` (the 1.67.0 release) and `acade549` (the ADR-0872 review),
  now `acade549` — touching `apps/web/package.json`, `pnpm-lock.yaml`,
  `package.json`, `CHANGELOG.md`,
  `apps/web/src/server/jobs/pipeline-indexed-check.ts`, its spec and
  `docs/adr/` (ADR-0871, ADR-0872, the ledger). Per the card, `origin/main` is
  **not** merged into this branch: the base stays `5790a785`. None of those
  commits touches a file in this diff except `docs/adr/README.md`, where the
  trunk appends rows above and below this record's insertion point (no `0868`
  row, cells still `0882`) — a plain union on merge.

## Consequences and known limits

- **Pin B pins the field, not the logger mechanism.** Any implementation whose
  warn carries the request's `requestId` and the matched `route` satisfies it — a
  `requestLogger` child, an explicit `getLogger().child(...)` — which is the
  intent; a process logger does not.
- **The `route` assertion is per template.** It is asserted on both routes, so a
  fix that hard-codes one template reds the other case.
- **A1's `memory-1` is the memory adapter's first mint.** It is stable because A1
  is the file's first enqueue over a per-file module graph; a future case that
  enqueues ahead of it must be placed after A1 or the pointer assertion updated.
- **Out of scope, unpinned:** the `traceId`/`requestId` agreement between the
  envelope and the log line beyond A1's single `traceId` assertion, and the
  volume of the warn under a persistent outage.
