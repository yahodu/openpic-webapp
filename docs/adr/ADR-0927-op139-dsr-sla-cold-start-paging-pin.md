# ADR-0927 — OP-139 TEST: the DSR SLA paging exclusion is pinned across a cold start

- **Status:** Accepted (TEST; characterization pin — green on arrival) · **Date:** 2026-11-23
- **Card:** `t_88ee8e84` (OP-139 TEST, Medium — finding **F1** of the round-1 review of the F3 pin
  card `t_3f90448c` / [ADR-0925](ADR-0925-op139-dsr-sla-budget-paging-pins.md); the landed GREEN is
  `t_4f24b078` / [ADR-0926](ADR-0926-op139-dsr-sla-paging-green.md))
- **Branch:** `OP-139-task-dsr-sla-coldstart-pin`, cut from `origin/main` `ac075316` **after** the
  GREEN landed, so `apps/web/src/server/jobs/dsr-sla-check.ts` carries the persisted exclusion.
  **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_88ee8e84`
- **Touches:** one spec file (`apps/web/src/test/integration/dsr-sla-check.test.ts`: `vi` added to the
  vitest import, one appended `describe` with one case, one file-local helper `runCheckOnAColdModule`),
  this record and its ledger rows. **No production file, factory, fixture or helper is in the diff**;
  the shipped four `I5` cases, the two F3 cases and every shipped helper are byte-identical.
- **ADR number:** `0927` — the OP-139 lane's `Next free` cell inside its `0918`–`0937` block,
  advanced to `0928`. The sweep is §6.
- **Consumes:** ADR-0925 (the F3 pins and the single-module-instance blind spot they leave),
  ADR-0926 §4 item 1 (the in-process `Map<dateKey, Set<requestId>>` cursor that was rejected for
  exactly this reason), ADR-0919 §4 (the delivered per-day `dedupeKey` and read), contract §10.2 (the
  job's per-run budget) and ADR-0300 §12 item 23 (the number sweep).
- **Consumers:** `apps/web/src/test/integration/dsr-sla-check.test.ts` only — the appended JSDoc
  cites this record. No production file cites it.

## 1. The pin

One case, appended in its own `describe` after the two F3 cases:

```ts
vi.resetModules();
const coldModule = await import("@/server/jobs/dsr-sla-check");
await coldModule.dsrSlaCheckJob.run({
  requestedLimit,
  clock: fixedClock(at),
  logger: recordingLogger(),
});
```

`runCheckOnAColdModule(at, requestedLimit)` does the three steps above. The case seeds one live tenant
and three open requests inside the 48-hour window (40 h / 44 h / 47 h, via the shipped
`seedThreeAtRiskRequests`), runs the check **three times at `ACTIVITY_AT` with `requestedLimit: "1"`**
— each run on a freshly evaluated module — and then asserts that the sorted `payload.requestId`s of
the day's `admin.dsr.sla_risk` rows equal the three ids.

The property: the per-run budget must page onto the whole at-risk queue **across invocations**, which
is only possible if the exclusion is persisted (the shape ADR-0926 §1 shipped: the day's outbox rows,
read back under `dayWindowUtc(dateKey, "Asia/Kolkata")`). Nothing else in the file observes it.

## 2. Why the shipped pack could not see it

`dsrSlaCheckJob` is imported once at the top of the spec, so every run in every shipped case drives
**one module instance** — the F3 cases included. An implementation that keeps the warned ids in module
scope therefore passes the whole pack while paging nothing in production: each cron invocation is a
fresh serverless function (`apps/web/vercel.json` → `/api/v1/internal/cron/dsr-sla-check`,
`45 2 * * *`), so the map is empty at the start of every real run and the tail is never warned.

The reviewer measured this on the pins head `bc442bf7` by adding a module-level
`const WARNED_IN_PROCESS = new Map<string, Set<string>>()`, reading it in place of the day's rows,
adding `_id: {$nin: …}` when it was non-empty and `warnedToday.add(requestId)` after the emit: the
delivered pack reported `6 passed (6)`. The same variant reds this pin (§3).

`vi.resetModules()` is what makes the module instance observable, and it is safe here for a measured
reason: the Mongo client is **not** module state — `@/server/db/mongo` keeps it on
`globalThis.__openpicMongoClient` — so the re-imported module graph still reads the one test database
(`startTestApp`'s). Re-importing also re-reads `MONGODB_URI` from `process.env`, which the harness set.

## 3. Measurement

| State                                          | Result                                                    |
| ---------------------------------------------- | --------------------------------------------------------- |
| focused `dsr-sla-check` spec on arrival        | `7 passed (7)` — the shipped six and this case (expected) |
| focused spec under the in-process variant (§2) | `1 failed \| 6 passed (7)` — the shipped six stay green   |
| whole `unit` project                           | `194` files, `3261 passed \| 3 skipped (3264)`            |
| whole `integration` project                    | `158` files, `1688 passed (1688)` — the shipped `+1`      |
| seven `adr-*` guards                           | `7` files, `248 passed (248)`                             |
| `tsc -p apps/web/tsconfig.json`                | exit `0`                                                  |
| `eslint`                                       | 0 errors                                                  |
| `prettier --check` (touched files and repo)    | clean                                                     |

The discriminating run's failure is the whole point of the card, so it is quoted verbatim:

```text
× F1: three cold-start runs with a budget of one still warn each of the three at-risk requests exactly once
AssertionError: expected [ '6b0449d2433ad1c19c10054b' ] to deeply equal [ '6b0449d2433ad1c19c10054b', …(2) ]
 ❯ apps/web/src/test/integration/dsr-sla-check.test.ts:456:47
```

— one request warned instead of three, i.e. the budget kept being spent on the same earliest-deadline
prefix because the exclusion died with the module. The production file was restored
byte-identically after the probe: `sha256 465dc14a18524632be8360e106702b737a6e04474232631dff0c79b5a61bf3aa`
before and after, `git diff -- apps/web/src/server/jobs/dsr-sla-check.ts` empty.

## 4. Alternatives rejected

1. **Assert the candidate query's filter or a spy on the outbox read.** That is an implementation
   detail: it would break under any legitimate refactor (a cursor document, a different projection)
   while a behaviour-preserving cold start kept working. The card's contract is the **effect** — three
   warnings after three cold runs.
2. **Run each invocation in a child process.** Truly cold, but it needs its own Mongo bootstrap, a
   serialised fixture handoff and a bespoke timeout; `vi.resetModules()` gives the same observable
   (a fresh module registry) inside the shipped harness.
3. **Keep the F3 cases as the paging proof and rely on the reviewer's probe.** Rejected: a probe that
   lives only in a PR comment does not fail when the implementation regresses to an in-process map.
4. **Probe the in-process variant by `vi.mock`-ing the job module.** MSW-style boundary mocking is
   for external HTTP; mocking the module under test would replace the production graph entirely and
   prove nothing about the shipped query.

## 5. Consequences and residuals

- This is a **characterization pin**: it is green on arrival because ADR-0926 shipped the persisted
  shape. It fails only if a future change moves the exclusion back into process memory (or drops
  paging), which is the regression the F3 review called out.
- **Residual:** the pin does not name the _storage_ of the exclusion — an outbox read, a cursor
  document or any other durable store satisfies it. That is deliberate: the durable property is what
  the reviewed defect violated, and ADR-0926 §3 already pins the day-scoped outbox read through the
  next-day arm.
- **Residual:** the pin re-evaluates the job's whole module graph three times in one case (a few
  milliseconds each on this harness). It is confined to the last case of the file, and it depends on
  the Mongo client living on the `globalThis` slot — a future move of that singleton into module
  scope would red this case for a harness reason, not a behaviour reason.
- No production file, factory, fixture, helper or other spec changes; whole `integration` moves by
  exactly one test.

## 6. Number allocation and sweep

Draws **`0927`**, the OP-139 lane's `Next free` cell (block `0918`–`0937`), and advances it to
**`0928`** — the higher of the trunk's `0927` and one past the highest number this lane consumed. No
other cell moves, no cell is lowered and no range is re-cut; the `OP-136 jobs lane` / `unallocated
(future lanes)` cursor stays at `0962`.

The sweep (ADR-0300 §12 item 23) read four surfaces immediately before minting:

- `origin/main` `ac075316`: highest record `ADR-0943` (the OP-140 lane, outside this block); no
  `ADR-0927`–`ADR-0937` path on the trunk, and the OP-139 lane cell reads `0927`;
- every `.worktrees/*/docs/adr` tree on this host: highest `ADR-0943`; no `ADR-0927` file anywhere
  (the lane's `ADR-0925`/`ADR-0926` are the only 092x records present);
- the open PR heads #818 (OP-140), #755 and #743 (OP-137), #272 (OP-101): none carries an
  `ADR-0927`–`ADR-0937` path;
- `git rev-list --objects --all -- docs/adr`: no `ADR-0927` object.

Re-swept immediately before the push: no surface resolved `ADR-0927`.
