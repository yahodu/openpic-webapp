# ADR-0037 — Integration-spec CI budget: deterministic Mongo readiness + explicit timeout

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-testcase-writer`
- **Card:** `t_f4aacfdb` (OP-85 follow-up, review finding #3) · **Origin:** PR [#147](https://github.com/yahodu/openpic-webapp/pull/147), CI job `test_coverage`
- **Scope:** test-only hardening — no production behaviour change, no assertion relaxed

## Context

On PR #147 CI run `37316023293` the integration spec
`apps/web/src/test/integration/notification-seed.test.ts > seedNotificationTypes
idempotency > I1: seeding twice leaves exactly the 81 contract types, one
document per key` failed with `Test timed out in 5000ms.` It then passed on the
prior run, on the next rerun, and locally — an intermittent timing flake that
can redden a PR unrelated to the change.

Root cause: `seedNotificationTypes` reconciles each of the 81 contract types
with its own atomic aggregation-pipeline upsert, so the first I1 spec issues
~162 sequential round trips (seeding twice) plus a read and a database drop.
The integration `globalSetup` starts a `MongoMemoryReplSet`, but
`MongoMemoryReplSet.create()` resolves once the set is _initiated_, not once a
primary has been elected, and the shared client in `server/db/mongo.ts`
connects lazily on first use. On a loaded CI runner the first spec to touch the
driver therefore pays TCP connect, handshake, replica-set discovery and primary
election **inside** Vitest's default 5 000 ms test budget. All of this is
latency in _test setup_, not a defect in the seed.

## Decision

Harden the spec file against CI timing with a deterministic readiness wait and
an explicit budget, changing nothing about what is asserted or how the seed
behaves:

1. **Readiness wait in `beforeAll`** (`waitForMongoReady`): probe the shared
   client with `admin.command({ ping: 1 })`, retrying every 250 ms until it
   answers or a 30 s budget is exhausted, then fail loudly. This keeps
   cold-connection cost out of every timed spec. It is a real readiness check,
   not a fixed sleep.
2. **Explicit hook budget** on `beforeAll` (`MONGO_READY_TIMEOUT_MS + 5 000`)
   so the wait cannot itself race Vitest's hook timeout.
3. **Explicit per-test budget** (`INTEGRATION_TEST_TIMEOUT_MS = 30_000`) on all
   four `it(...)` specs in the file — an explicit ceiling for a
   slow-but-correct run, replacing the default 5 000 ms.
4. **Test-only pool override** `MONGODB_SERVER_SELECTION_TIMEOUT_MS = 30_000`
   via the env fixture, so the client waits for a busy runner's primary rather
   than throwing after the production-default 5 s server-selection window. This
   is process-local test wiring; no production default (`config/env.ts`) is
   touched.
5. **No assertion weakening.** The "exactly 81 contract types, one document per
   key" contract and every version-bump assertion are byte-identical to the
   pre-hardening spec.

The wait is scoped to this file. Sibling integration suites share the same
latency profile but were not red; broadening the helper into
`test/helpers/db.ts` is a deliberate follow-up, not part of this card.

## Consequences

- A cold replica set can no longer consume a timed spec's budget; the first
  spec starts only once the driver has answered a ping.
- A genuinely unreachable database still fails loudly ("MongoDB replica set did
  not become ready within 30 000 ms") after the budget, rather than hanging.
- The 30 s ceiling is ~25× the locally observed per-spec time (~0.5–1.3 s); it
  is a ceiling for contention, not a licence for a slow implementation. A seed
  regression that makes the work genuinely slow still fails, and a routing or
  idempotency regression still fails on the unchanged assertions.
- Verified: target spec passing on every repeated run; full integration
  suite 33 files / 201 passed (`TMPDIR=/root/tmp-mongo`); `tsc` (root + contracts
  - web), `eslint` (0 errors, 20 pre-existing warnings), `prettier --check` clean.
- `vi.setConfig` file-scoping was proven with a deliberate 1 ms probe: all four
  specs timed out in 1 ms while the `beforeAll` hook budget (35 s) held, so the
  test budget is raised for this file without leaking to any other suite.

## Alternatives

- **Raise `testTimeout` in `vitest.config.ts` globally** — rejected: it masks
  the cold-connection cost for every suite and hides real hangs instead of
  removing the cause.
- **Batch the seed's upserts in production code** — rejected: out of scope for a
  test-only card, and a production change would need its own GREEN card.
- **Fixed `setTimeout` warm-up sleep** — rejected: non-deterministic and slower;
  a readiness probe is both faster and self-describing.
- **Retry the flaky spec (`retry`)** — rejected: retries hide intermittent
  latency and let a real first-attempt failure through unnoticed.

## Amendment note — ADR renumber 0035 → 0036 → 0037

This decision was authored as ADR-0035. While the branch was in review, `main`
advanced twice and claimed both numbers: `859b717` (PR #151) took ADR-0035 for
the instrumentation boot-guard pin, and `ae215ca` (PR #154) took ADR-0036 for
its review sign-off. The record was therefore renumbered to **ADR-0037** during
the merge resolutions (filename + README row). No decision content changed.

## Amendment note — the seed-lock subtlety

`seedNotificationTypes` serializes same-process runs through `runExclusive`, so
I1's two awaited seed calls are ordered, not racing. The latency is therefore
connection + round-trip volume, confirming that a readiness/budget fix (not a
concurrency fix) is the correct remedy.

## Amendment note — shared readiness guard across sibling suites (t_d025a82c)

The "scoped to this file" limitation in the Decision above was intentional for
the original card, but the reviewer filed it as a Low latent-flake risk: every
integration suite shares the same cold-connect profile, because each Vitest
worker builds its own lazily-connected `MongoClient` singleton. This note
records the follow-up that lifted the guard out of the single file. **The
decision above is unchanged** — a deterministic ping probe plus an explicit
budget, with no assertion relaxed.

- **Shared helper.** `apps/web/src/test/helpers/db.ts` now owns
  `requireMongoTestUri()`, `applyMongoTestEnv()`, `waitForMongoReady()` and
  `setupMongoTestEnv()`, plus the `MONGO_READY_HOOK_TIMEOUT_MS` hook budget.
  Every database-backed integration suite calls `setupMongoTestEnv()` (or
  `waitForMongoReady()`) from its `beforeAll`, so TCP connect, handshake,
  replica-set discovery and primary election are paid in a hook — never inside
  a timed spec.
- **Replica-set probe in `global-setup.ts`.** After
  `MongoMemoryReplSet.create()` the setup pings the set until a primary
  answers, and fails loudly after 30 s. The probe is a real `ping`, not a
  fixed sleep, and ensures workers start only against an elected primary.
- **`notification-seed.test.ts` drops its file-local duplicate** and consumes
  the shared helper. Its explicit 30 s per-test budget and the
  `MONGODB_SERVER_SELECTION_TIMEOUT_MS` override are retained — the seed still
  issues hundreds of sequential round trips, so the budget is still warranted.
- **`health-ready-unavailable.test.ts` deliberately does not call the shared
  helper.** It points `MONGODB_URI` at a sentinel and stubs the readiness probe,
  so it must never open a real connection. `check-env`, the internal-HMAC and
  the internal-cron suites likewise do not touch the driver and are untouched.
- **No assertion in any spec changed.** `notification-seed`'s 81-type and
  version-bump assertions are byte-identical to the pre-hardening spec.
- **Verified:** integration suite 33 files / 201 passed
  (`TMPDIR=/root/tmp-mongo`), run twice; `tsc` (root + contracts + web),
  `eslint` and `prettier --check` clean.
- **TDD shape:** this is test-only hardening with no production behaviour to
  drive, so the deliverable is the harness change itself, verified GREEN. The
  readiness wait is exercised by every suite's `beforeAll` on each run; the
  fail-loud timeout path is not separately spec'd (see card out-of-scope).

## Amendment note — reviewer sign-off on the shared readiness guard (t_d025a82c)

Reviewed and approved (round 1, artifact lens) on 2026-10-05 by
`openpic-webapp-reviewer`; squash-merged as `13004aa` (PR #155). **The decision
above is unchanged.**

- **No assertion drift.** Every `expect(...)` line in all 18 changed integration
  specs was diffed against `origin/main` and is byte-identical; the change set is
  imports plus `beforeAll`/`afterAll` hooks only.
- **Coverage of the finding.** Exactly the 18 integration specs that touch the
  driver route through `setupMongoTestEnv()`/`waitForMongoReady()`; the 15
  non-driver suites are intentionally untouched. `mongo-replset.test.ts` keeps its
  private client and is covered by the `global-setup.ts` primary-election probe.
- **Independently reproduced.** Integration suite 33 files / 201 passed on two
  consecutive runs (`TMPDIR=/root/tmp-mongo`); `tsc` (root + contracts + web),
  `eslint` and `prettier --check` clean; all CI checks green on head `90dd83b`.
- **Low follow-up filed.** `global-setup.ts` duplicates the retry loop and the
  `MONGO_READY_TIMEOUT_MS` / `MONGO_READY_RETRY_MS` constants that also live in
  `helpers/db.ts`; extracting a shared low-level poll helper would remove the
  drift risk. Non-blocking, tracked as a follow-up card.

## Amendment note — one shared readiness loop (OP-85 follow-up, t_14ee02fe)

The reviewer's Low follow-up above is now closed. **The decision above is
unchanged** — still a deterministic ping probe with an explicit budget, no
assertion relaxed; only the location of the shared loop moved.

- **Single source of truth.** `apps/web/src/test/helpers/poll-ready.ts` now owns
  `pollReady()` and the `MONGO_READY_TIMEOUT_MS = 30_000` /
  `MONGO_READY_RETRY_MS = 250` constants. The module imports nothing, so it is
  safe to load in the setup process (which runs before `MONGODB_URI` exists).
  Both `waitForMongoReady` (`helpers/db.ts`) and `waitForPrimary`
  (`integration/global-setup.ts`) became thin wrappers that supply their own
  ping thunk and keep their exact error strings and budgets, so a future budget
  change is made in exactly one place.
- **The private probe client is preserved.** `global-setup.ts` keeps its short
  `serverSelectionTimeoutMS = 2_000` client; only the retry loop was shared.
- **New unit contract.** `apps/web/src/test/helpers/poll-ready.test.ts` pins the
  loop's observable behaviour: immediate resolve on first success with no timer,
  retry-until-success, the configured retry delay between probes, the fail-loud
  message plus `cause` on budget exhaustion, and the shared constant values. It
  was written RED first (`Cannot find module './poll-ready'`) before the helper
  existed.
- **No assertion changed.** No integration spec was edited; every driver-touching
  suite still routes through `setupMongoTestEnv()` / `waitForMongoReady()`.
- **Verified:** integration suite 33 files / 201 passed on two consecutive runs
  (`TMPDIR=/root/tmp-mongo`); unit 64 files / 1284 passed (was 63 / 1278; +6 new
  helper specs); `tsc` (root + contracts + web) clean; `eslint` 0 errors / 20
  pre-existing warnings; `prettier --check .` clean.
