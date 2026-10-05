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
