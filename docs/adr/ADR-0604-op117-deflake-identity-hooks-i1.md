# ADR-0604 — OP-117 CI flake (TEST): the `identity-hooks` I1 sign-up case gets a file-scoped test budget

- **Status:** Accepted · **Date:** 2026-11-03
- **Card:** OP-117 CI FLAKE TEST (`t_f5245b6c`), follow-up finding **F6** of the docs-only round-1 review sign-off (`t_b021255c`, PR #392 merged as `85dfa0a`) · **Branch:** `OP-117-bug-deflake-identity-hooks-i1` (cut from `origin/main` `85dfa0a`) · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_f5245b6c`
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation), [ADR-0037](ADR-0037-integration-spec-ci-readiness-budget.md) (cold database cost is paid in a hook, never inside a timed spec), `apps/web/src/test/integration/notification-seed.test.ts` (the file-scoped `vi.setConfig` precedent)
- **Contract:** none — this changes no production behaviour and pins no new contract.

## Context

`pnpm test:coverage` (workflow **PR Checks** → job `test_coverage`) is a
required check. On the docs-only PR #392 it failed with

```
FAIL  integration  apps/web/src/test/integration/identity-hooks.test.ts
  > handleUserCreated — profile, preferences and lazy invites
  > I1: sign-up through the auth surface creates exactly one profile and one preferences doc
Error: Test timed out in 5000ms.
```

at `apps/web/src/test/integration/identity-hooks.test.ts:267` (job
`126195109870`, head `372e783`). The **identical** commit passed on rerun (job
`126198070224`), and the same job had flaked on PR #391 and passed on #390/#393:
a non-deterministic, trunk-level flake, not a regression in any PR.

### Diagnosis (measured, not inferred)

The card hypothesised a slow await in the sign-up path (auth sign-up + ReplSet
transaction + profile/preferences/invite writes). Measurement contradicts that:

- A temporary `performance.now()` probe of the I1 body decomposed it as
  `ensureIndexes` **768 ms**, `POST …/send-verification-otp` **75 ms**,
  `POST …/sign-in/email-otp` **95 ms** (test total 1 056 ms). The slow part is
  the harness, not the auth surface: every case calls `withTestDb`, which builds
  a fresh database and runs ~50 sequential `createIndex` round trips through
  `ensureIndexes`.
- There is no unbounded poll and no missing `await`: `otpInbox.take` is
  synchronous, `authPost` is a single `auth.handler(request)` call, and
  `waitForMongoReady` already keeps the cold connection out of every timed spec
  (ADR-0037). So the card's option 2 "unbounded polling helper" and "no await on
  a settle" do **not** apply.
- Local durations are stable and well under the default budget:
  I1 **~1.03–1.14 s** across runs, both uninstrumented and under `--coverage`
  (the single-file coverage pass added ≈0 to the test body). The full file is
  ~31 s locally.
- In the failing CI run the file's line reads
  `identity-hooks.test.ts (34 tests | 1 failed) 25517ms`. Subtracting the 5 000 ms
  timeout leaves ≈20.5 s for the other 33 cases — i.e. ~620 ms each, **faster**
  than locally. So the CI runner is not uniformly slow: I1 alone stalled past
  5 s while its siblings ran at ~0.6 s. The decisive feature of I1 is that it is
  the **first** timed case in the file, so it — and only it — absorbs the
  process-cold database/index build on a loaded runner. That is a tail-latency
  outlier against a 5 000 ms budget with little headroom left (normal case
  ~1 s), not a deterministic overrun.

### Why not the alternatives

- **Bumping the global `testTimeout`** (vitest.config.ts) would weaken every
  project's budget to cover one cold-first-case outlier; the card forbids it.
- **Warming the cold path in `beforeAll`** was considered (ADR-0037's pattern)
  but rejected: it adds a throwaway database create/drop per run without a
  proven benefit, because the cold component is a per-runner disk/scheduler
  effect that cannot be reproduced locally (local I1 is only ~70 ms slower than
  its siblings).
- **Rewriting the file harness** to build indexes once and reset data between
  cases would cut the real cost, but it rewrites the fresh-database-per-case
  isolation convention used across every integration spec, a Medium-severity
  flake does not justify that blast radius, and it risks introducing a new
  cross-case dependency.

## Decision

Give `apps/web/src/test/integration/identity-hooks.test.ts` a **file-scoped**
test budget of 30 000 ms, exactly mirroring the existing precedent in
`notification-seed.test.ts`:

```ts
const INTEGRATION_TEST_TIMEOUT_MS = 30_000;
vi.setConfig({ testTimeout: INTEGRATION_TEST_TIMEOUT_MS });
```

`vi.setConfig` is scoped to the file, so the 5 000 ms default is replaced for
this file only and no other project, file or spec is affected. No assertion is
touched, no `await` is added, no poll is bounded, and no production file changes.
The budget is an explicit ceiling for a slow-but-correct cold run, not a licence
for a hang: a genuine hang still fails, just later, and `waitForMongoReady`
(in `beforeAll`) keeps a cold connection out of every timed spec.

## Evidence

- Mutation probe proving the ceiling is really applied: lowering the constant to
  `300` makes I1 fail with `Test timed out in 300ms` (the new value, not the
  5 000 ms default); the spec is then restored **byte-identically**
  (`sha256` unchanged, `git diff` clean).
- Focused file: `34 passed (34)`; 12 consecutive runs green (see the card's
  handoff for the run log).
- `npx tsc -p apps/web/tsconfig.json --noEmit` exit `0`; ESLint 0 problems and
  `prettier --check` clean on the spec.

## Ledger note (OP-117 lane, `0600`–`0619`)

This record takes the lane's next free number, `0604`. The card body carried no
`Consumes:` line, so the number was resolved by enumerating the lane's
in-flight reservations per CONVENTIONS §11 rule B: `0600`–`0603` are landed on
`main` (ADR-0600/0601/0602/0603) and no live worktree or remote `OP-117*` ref
holds `0604`. Per the card's boundary, `docs/adr/README.md` is **not** touched;
the lane's `Next free` cell must be advanced to `0605` by the next
ledger-touching card. No number outside `0604` is consumed.

## Review — round 1 (artifact lens, card `t_f5245b6c`)

| Field         | Value                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Reviewed head | `cd19936` on `OP-117-bug-deflake-identity-hooks-i1`                                                                         |
| Landed        | PR #394, squash-merged as `e395fdf` (origin/main)                                                                           |
| Verdict       | **APPROVED WITH FINDINGS** — every pinned criterion holds; the one Medium finding is outside the pinned criteria (§Routing) |

### What was verified

The reviewer's own measurements on the reviewed head, not the implementer's numbers.

| Check                                                                      | Result                                                                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Bytes landed = bytes reviewed (`git diff cd19936 e395fdf -- <both paths>`) | **empty**; squash is 2 files, +127/−1 — **no production file**                                                                      |
| Focused `identity-hooks.test.ts` integration run                           | **34 passed (34)**, 5 consecutive green, 32–34 s wall each                                                                          |
| Mutation probe (constant `30_000` → `300`)                                 | all 34 cases fail `Test timed out in 300ms` — the file budget is really applied, not the 5 s default                                |
| `vitest run --project unit --project integration --coverage`               | **234 files, 3084 passed                                                                                                            | 3 skipped (3087), exit 0** (127 s) |
| Coverage                                                                   | statements 91.63 %, branches 80.26 %, functions 95.37 %, lines 91.93 %                                                              |
| `adr-numbering` guard                                                      | **29 passed (29)**; no duplicate `ADR-NNNN` under `docs/adr/`                                                                       |
| `prettier --check` on the spec and `docs/adr/**/*.md`                      | clean                                                                                                                               |
| Honesty audit                                                              | no `process.env`/`.only`/`.skip`/`.todo` branch in the spec; the diff adds only the constant, its TSDoc and the `vi.setConfig` call |
| PR #394 checks                                                             | 15 pass / 0 fail, incl. `test_coverage`, `ci`, `audit`, `secret-scan`                                                               |

### Findings

- **F1 (Medium) — ADR ledger drift.** `docs/adr/README.md` still reads the OP-117
  lane's `Next free = 0604` although `0604` is consumed on `main`, and the index
  table has no row for `ADR-0604`. The card boundary forbade touching
  `README.md`, so this was correct implementer behaviour, but the obligation needs
  an owner → routed to the follow-up DOCS card `t_41698149`.
- **F2 (Low) — the budget is file-scoped, not case-scoped.** All 34 cases in the
  file now have a 30 s ceiling, so a future genuine hang in any of them fails at
  30 s instead of 5 s. Accepted as-is: it mirrors the `notification-seed.test.ts`
  precedent, and the alternative (`it(..., { timeout: 30_000 })` on I1 alone) would
  only re-mask the same class if a different case becomes first in a filtered run.
- **F3 (Info) — the real cost is the harness.** `withTestDb` calls `ensureIndexes`
  (~50 sequential `createIndex` round trips, ~768 ms) inside every timed body.
  Parallelising it (`Promise.all`) would cut real cost rather than raise a budget.
  Out of scope for this card; recorded, no card.

### Routing

- F1 → `t_41698149` (DOCS ledger card: advance the lane cell `0604` → `0605` and
  add the `ADR-0604` index row). Distinct from this sign-off card: the two touch
  different files (`README.md` vs `ADR-0604`) and are serialised by the task graph.
- F2/F3 → recorded here, no card.
- Nothing in the reviewed delivery is retracted; no Critical or High finding.
