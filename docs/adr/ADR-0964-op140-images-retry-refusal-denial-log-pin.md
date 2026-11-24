# ADR-0964 — OP-140: a refused `retryFailedEventImages` logs the tenancy denial through its logger seam

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** `t_f17bed7b` (OP-140 TEST, Low, phase 6-M2M · epic Notifications) — finding **F1** of the round-1 review `t_9d80fb7f` of [ADR-0777](ADR-0777-op140-images-retry-service-and-upload-batch-kind.md) (draft PR [#829](https://github.com/yahodu/openpic-webapp/pull/829))
- **Lane:** `OP-126 uploads lane` (`0760`–`0779`) — **exhausted**: `0779` is the range end (ADR-0777 §Number allocation). This record is therefore a **pool draw** per ADR-0300 §11 item 18, and the `unallocated (future lanes)` cursor read `0964` at this branch head.
- **Branch:** `OP-140-task-images-retry-refusal-log-pin` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op140-images-retry-refusal-log-pin` (cut from `origin/main` `a96e19d0`, i.e. after the GREEN `t_f8de2e20` merged as `61fa3eec`, then folded with `origin/main` `8666932e` — the ADR-0777 sign-off (#856) merge, `+11/−2` on `docs/adr/ADR-0777-…md` only, so no record, cell or ledger row moved under it)
- **ADR number:** `0964` — swept before minting: `origin/main` `a96e19d0`, re-read as `8666932e` after the sign-off merge (highest record `ADR-0963` on both), every `.worktrees/*/docs/adr` tree (highest `0963`), the nine open PR heads (#857, #856, #852 → `0963`; #832 → `0962`; #829 → `0944`; #828 → `0944`; #755, #743 and #272 hold no `09xx`; highest `0963`), `git rev-list --objects --all -- docs/adr` (highest `0963`) and every non-`done` card body on the active board (`$HERMES_KANBAN_DB`; the only literal at or above `0940` is the placeholder `9999` of `t_7ac40bd9`, which is not an allocation) — none of which holds `0964`.
- **Consumes:** `0964` (this record). The GREEN sibling takes **no** number and writes **no** ledger row, so the `unallocated (future lanes)` cursor, the `OP-129 attendee identity lane` cell and the `OP-136 jobs lane` mirror cell all advance `0964` → `0965`.
- **Consumers:** `apps/web/src/test/integration/event-images-retry-service.test.ts`
- **Touches:** one **test-only** file (two appended cases; the ten shipped cases, every helper and the harness stay byte-identical), this record, its index row, three ledger cells and one ledger note. **No production code** — the `warn` is the GREEN's.

## Context

`retryFailedEventImages` (`apps/web/src/server/images/retry-failed.ts`, ADR-0777 D1/D2) is the service the `upload_batch × retry_failed` delegate will call instead of `POST …/events/{eventId}/images:reprocess-failed`. It re-checks the caller itself, because a delegate has no `Request` to run a stage against: it reads the tenant-scoped `events` row and then asks `resolveEventActorRole`, refusing both times with `appError("not_found")`.

The route it replaces refuses through `tenantStage`'s `deny` (`apps/web/src/server/tenancy/route-stage.ts:147-149`), which **logs and throws**:

```ts
const deny: (reason: string) => never = (reason) => {
  logger.warn("tenant access denied", { event: "tenancy.access_denied", reason });
  throw appError("not_found");
};
```

The block sits at `route-stage.ts:147-149` — `const deny` on `:147`, the `warn` on `:148`, the `throw` on `:149`, measured on `8666932e`. The routing card's `139-146` is the JSDoc comment above it, not a different file: the blob is unchanged on the trunk.

`admitEventActor` (`apps/web/src/server/events/access.ts:95`) calls `deny` twice, with the only two reasons a refused event-actor admission has:

| Cause                                   | `reason`               |
| --------------------------------------- | ---------------------- |
| the tenant-scoped `events` read missed  | `"event_not_found"`    |
| `resolveEventActorRole` answered `null` | `"not_an_event_actor"` |

Measured on the base this record was written against (`a96e19d0`, `retry-failed.ts` `sha256 1ad1cefc…e53a71`): the service throws `appError("not_found")` at both admissions with **no `warn` at all**. The asymmetry that creates is the finding — the identical refusal is visible to security monitoring over HTTP and invisible on the delegate path, so a refusal of a bulk retry that never went through a middleware leaves no trace. The service already carries the seam a log line needs: the optional `logger?: Logger` input ADR-0777 D1 reserves and forwards to `requeueImages`. Nothing about the signature, the status, the code or the rows is missing; only the entry is.

## Decision

### 1. The denial entry is emitted through the service's own `logger` input

The pins pass a **real** `Logger` (`createLogger` over `memoryTransport`, the shape `apps/web/src/test/integration/auth-guards.test.ts:589-601` already uses) through the `logger` input, not a global one. Two reasons:

- The seam is already in the contract: ADR-0777 D1 gave the service `logger?: Logger` and it forwards that exact object to `requeueImages`, so the request logger the route would pass is the same object the denial line must reach. A pin that installed a global with `setLogger` would measure a seam the service does not use and would leave every other component's logger replaced for the duration of the case.
- A per-call sink makes "exactly one" meaningful: nothing outside the call under test can write to it, so the case needs no `beforeEach` clear and no `finally` restore.

`retry-failed.ts` therefore emits, before each of the two `throw appError("not_found")`:

```ts
input.logger?.warn("tenant access denied", { event: "tenancy.access_denied", reason: <cause> });
```

`input.logger?.` and not `getLogger()`: the service is a seam a delegate calls with the request's logger, exactly as `requeueImages` is. `route-stage.ts`, `access.ts`, the route and the notification files are untouched — the stage keeps its own line.

### 2. The reasons are the middleware's two strings, verbatim

`"event_not_found"` and `"not_an_event_actor"` are the strings `admitEventActor` passes to `deny`, and they are the values security monitoring already groups by. A second vocabulary (`"event_missing"`, `"not_actor"`) would split one signal into two. The pins assert the pair `event` + `reason` and deliberately not the message text: the message is `"tenant access denied"` today, but the field pair is what a query reads.

### 3. One RED case, and one declared control

The appended `describe` holds two cases:

- **RED on arrival — "logs exactly one tenancy.access_denied warn for each refusal cause".** It refuses twice, once per cause, each with its own sink, and asserts `denialsIn(sink)` equals exactly one `{ level: "warn", event: "tenancy.access_denied", reason: <that cause> }`. On the base the sink is empty. It also re-reads the first sink afterwards, so a fix that logs both causes into whichever sink is handy — or logs twice — fails here rather than passing on the second arm.
- **Green on arrival (control) — "logs no denial line when the call is admitted".** The owner's successful retry of one failed row answers `{ requeuedCount: 1 }` and leaves `denialsIn(sink)` empty. A service that never logs satisfies it by construction, so it is a control, not a pin: it exists to red a fix that logs the denial on the admitted path too (an unconditional `warn` at the top of the function), and it filters by the `event` field so a requeue's own `warn` cannot be mistaken for a denial.

Both pass a `level: "trace"` logger timed at the case's `NOW`, so the entry is deterministic and no level the service might use is filtered out.

### 4. Number allocation and ledger bookkeeping

- The record takes **`0964`** (sweep above). The `OP-126 uploads lane` block `0760`–`0779` was exhausted by ADR-0777, and ADR-0300 §11 item 18 sends an exhausted block to the pool cursor.
- `unallocated (future lanes)` cursor: `0964` → **`0965`**.
- `OP-129 attendee identity lane` cell and the `OP-136 jobs lane` mirror cell: `0964` → **`0965`**, together with the pool cursor — both cells already mirrored that cursor (ADR-0962 advanced all three), so they move with it and not on their own account.
- No cell is lowered, no range is re-cut, and the OP-140 lane's `0942`–`0961` block is untouched.

## Evidence

Red by design on `a96e19d0`, and red for the reason this record names — the sink is empty, not the module missing:

```
vitest run --project integration event-images-retry-service.test.ts

FAIL  event-images-retry-service.test.ts > retryFailedEventImages — the tenancy denial
      reaches the injected logger (§18.1) > logs exactly one tenancy.access_denied warn
      for each refusal cause
AssertionError: expected [] to deeply equal [ { level: 'warn', …(2) } ]

- Expected
+ Received

- [
-   {
-     "event": "tenancy.access_denied",
-     "level": "warn",
-     "reason": "event_not_found",
-   },
- ]
+ []

 Test Files  1 failed (1)
      Tests  1 failed | 11 passed (12)
```

The eleven passes are the ten shipped cases plus the control; the control is green on arrival by construction and is declared as such in §3, in the spec's block doc and in the handoff — it is not claimed as RED evidence.

Three near-fixes and one anti-fix, each restored byte-identically afterwards (`retry-failed.ts` `sha256 1ad1cefc9afdfef576b8973e626f954a35a9e119ffc74f88a4fb08d490e53a71` before and after, `git status --short` naming only the spec and the record):

| Arm                        | Near-fix                                                                     | Result                                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — satisfiability         | both `warn` lines, as §1 states                                              | `Tests 12 passed (12)` — the pack is satisfiable and the ten shipped cases stay green                                                                                     |
| B — the actor half         | only the `event_not_found` line (the `resolveEventActorRole` refusal silent) | `Tests 1 failed \| 11 passed (12)`, `reason: "not_an_event_actor"` expected against `[]` — the second assertion carries its own weight                                    |
| C — the missing-event half | only the `not_an_event_actor` line (the `events`-read refusal silent)        | `Tests 1 failed \| 11 passed (12)`, `reason: "event_not_found"` expected against `[]` — the first assertion carries its own weight                                        |
| D — the control            | both lines **plus** an unconditional denial `warn` after the admissions      | `Tests 1 failed \| 11 passed (12)`, and the failing case is **only** the admitted one: `expected [ { level: 'warn', reason: 'probe_admitted_line' } ] to deeply equal []` |

Arm D is the point of the control: a fix that logs on the admitted path passes the RED case and fails the control, so the pair discriminates both halves of the finding.

`pnpm typecheck` exit `0`, `pnpm lint` exit `0`, `pnpm format:check` clean; the eight `adr-*` guards green; `event-images-management.test.ts` `27 passed (27)`, and the three emit suites unchanged (`uploads-batch-status.test.ts` `12 passed (12)`, `job-pipeline-indexed-check.test.ts` `32 passed (32)`, and the notification matrix/types unit specs `passed`).

## Reversal condition

> When `retryFailedEventImages` refuses for `event_not_found` or `not_an_event_actor`, the logger it was given carries one `tenancy.access_denied` `warn` with that `reason`, and an admitted call carries none — the delegate path is as observable as the middleware it replaces, and these cases can be deleted only together with the logger seam itself.

## Consequences

- **The delegate path becomes monitorable.** A refused `upload_batch × retry_failed` retry now produces the same alarm-shaped entry as the HTTP route, so one `event: "tenancy.access_denied"` query covers both readers of the rule.
- **The service owns the line, not the middleware.** `retry-failed.ts` repeats the message and the field pair rather than calling `admitEventActor`, which needs a `Request`. The two reasons are the contract's two; a third refusal cause added to the service owes its own `reason` string and its own pin.
- **A silent refusal is now a test failure, not a monitoring gap.** Arm B and arm C above measure that each cause is separately load-bearing, so a fix that logs only the path it remembered reddens exactly one assertion.
- **The pins do not constrain the message text or the level-writer.** An implementation that emits through `input.logger?.child({...})` passes: the sink sees the merged entry. Only the `event`/`reason` pair and the case's own `level: "warn"` are asserted.
- **The GREEN needs no interface change and no test edit.** The pins are satisfied by two `input.logger?.warn(…)` lines and nothing else; the existing ten cases, the route's wire contract and `event-images-management.test.ts`'s `27` are unaffected.

## Alternatives

- **Install a global logger with `setLogger` and read it from a module-level sink.** Rejected: the service takes a logger as an input and forwards it to `requeueImages`; a global pin would measure a seam the service does not read, and restoring the previous logger in a `finally` adds a failure mode (a leaked global on an unexpected throw) for no gain.
- **Assert the message text `"tenant access denied"`.** Rejected: monitoring groups by `event` and `reason`, and the middleware's own line is the string a future edit might reword. Pinning the pair is the durable observable.
- **Assert the whole entry (ts, service, env, version).** Rejected: those are the logger's bindings, which the service neither sets nor owns; asserting them would red the pins on any logging-config change.
- **Change `admitEventActor` to accept a logger and call it from the service.** Rejected as out of scope and wrong in shape: `admitEventActor` takes a `Request` and the stage's `deny`, which a delegate has neither of, and the card walls `access.ts` and `route-stage.ts` off.
- **Fold the admitted-call case into the refusal case.** Rejected: the two measure opposite consequences of the same fix, and arm D shows the control is the only arm that reddens an over-logging fix.
- **Draw a number from the OP-140 lane's own block (`0942`–`0961`).** Rejected: the block is the notifications lane's, this card is the images lane's and its own range (`0760`–`0779`, the `OP-126 uploads lane`) is exhausted, so ADR-0300 §11 item 18 points at the pool cursor.
