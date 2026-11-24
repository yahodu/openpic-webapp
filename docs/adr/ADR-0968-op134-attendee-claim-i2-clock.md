# ADR-0968 — OP-134: decide the claim's lapsed-session arm on the clock, never on the TTL monitor's timing

- **Status:** Accepted (test-determinism repair; the assertion it pins is unchanged)
- **Consumers:** `apps/web/src/test/integration/attendee-claim.test.ts` (case `I2: a
lapsed session is refused with 401 attendee_session_expired` and its in-file
  `claimWithClockAt` helper) and `apps/web/src/test/helpers/attendee-claim-flow.ts`
  (`lapseSession`, which now demands the instant it re-stamps). The behaviour it
  pins is owned by [`ADR-0818`](ADR-0818-op134-claim-endpoint-arms-pins.md) and
  [`ADR-0814`](ADR-0814-op134-attendee-claim-red.md)/[`ADR-0815`](ADR-0815-op134-attendee-claim-green.md);
  this record cites them and edits neither.
- **Amends:** nothing. **Amended by:** nothing yet.
- **Consumes:** `0968` — a **pool draw**. The OP-129 / OP-134 / OP-132 lanes hold
  no reserved row of their own (the OP-134 lane's numbers have been pool draws
  since [`ADR-0818`](ADR-0818-op134-claim-endpoint-arms-pins.md)), so ADR-0300
  §11 item 18 sends the record to the `unallocated (future lanes)` cursor, which
  [`ADR-0967`](ADR-0967-merged-lane-local-branch-deletion.md) left at `0968` on
  `origin/main` `6642110d`. The sweep at this branch cut (`origin/main`
  `340524bc`) read: highest record on the trunk `0967`; every
  `/root/openpic/openpic-webapp/.worktrees/*/docs/adr` tree highest `0967`
  (`.worktrees/op101-local-head-hygiene-impl`, `.worktrees/t_84e8d0ed`,
  `.worktrees/t_d152cac9`); **zero** open PR heads (`gh pr list --state open` →
  `[]`); `git rev-list --objects --all -- docs/adr` highest `0967`; and the
  board's nine non-terminal cards, of which only this card
  (`t_f553e539`) mentions `0968`. Nothing holds `0968`, so this record takes it
  and advances the four cells that read it — `unallocated (future lanes)`,
  `OP-129 attendee identity lane`, `OP-136 jobs lane` and
  `board-wide / process` — to `0969`. No cell is lowered and no range is re-cut.
- **Card:** `t_f553e539` (OP-134 TEST, Low — trunk flake that reddened an
  unrelated docs-only PR's `ci`).
- **Branch:** `OP-134-task-attendee-claim-i2-ttl` · **Worktree:**
  `/root/openpic/openpic-webapp/.worktrees/op134-attendee-claim-i2-ttl`
- **Touches:** one integration case's arm plus one in-file helper
  (`attendee-claim.test.ts`), one fixture helper (`attendee-claim-flow.ts`: the
  `lapseSession` signature and its doc comment), this record, its index row, four
  `Next free` cells of the reserved-range ledger and one ledger paragraph.
  **No production code, schema, index, retention setting, mock or factory.** The
  other eight cases in the file and every other spec are byte-identical.

## Context

PR [#876](https://github.com/yahodu/openpic-webapp/pull/876) was docs-only
(`docs/adr/` only) and its first `ci` attempt at 12:20:37Z failed the
`integration` job on a file the diff cannot reach:

```
FAIL  integration  apps/web/src/test/integration/attendee-claim.test.ts > when a session is already spoken for
      > I2: a lapsed session is refused with 401 attendee_session_expired
AssertionError: expected 404 to be 401
 Test Files  1 failed | 164 passed (165)
      Tests  1 failed | 1779 passed (1780)
```

The same tree was green locally (`9 passed (9)`) and green on the re-run. The
case is the third member of the class [`ADR-0938`](ADR-0938-op136-retention-purge-i11-fixture-ttl.md),
[`ADR-0939`](ADR-0939-op136-usage-invitations-fixture-ttl.md) and
[`ADR-0940`](ADR-0940-op136-sweep-specs-fixture-ttl.md) closed elsewhere, and
the first one in a spec nobody had repaired: a **fixture born TTL-expired**.

## Diagnosis — the row's presence, not the clock, decided the answer

`I2` seeded a bound anonymous session, moved its `expireAt` 60 s into the past
(`lapseSession`) and asserted the claim answers `401 attendee_session_expired`,
with a comment stating the assumption: _"past the 30-day TTL (§13.5); the TTL
monitor has not swept it yet."_ That assumption is the flake.

The collection carries the shipped TTL index (`apps/web/src/server/db/indexes.ts`,
the `attendee_sessions` block), measured live from the test server at this cut:

```
P0_INDEXES [{"v":2,"key":{"expireAt":1},
             "name":"attendee_sessions_expire_at_ttl","expireAfterSeconds":0}]
```

mongod evaluates that key against the **real** wall clock on a 60-second monitor
pass, so a row whose `expireAt` is in the real past is a row the monitor may
delete at any moment after the write. The two answers then come from different
places:

- `findAttendeeSession` (`apps/web/src/server/attendee/session-resolver.ts`)
  throws `attendee_session_expired` — the `401` the case pins — only for a row
  it **read** and found lapsed: `if ((options.clock ?? systemClock).now().getTime() >= row.expireAt.getTime())`,
  inclusive, matching the monitor;
- `claimAttendeeSession` (`apps/web/src/server/attendee/claim.ts`) throws
  `not_found` — `404` — when that lookup returns `null`.

So the status is decided by whether a monitor pass landed between the lapse and
the request: nothing the case controls, and no retry can make it a fact.

### Mechanism forced, on the pre-change shape

Throwaway probe on the pre-change tree (one `MongoMemoryReplSet`, deleted before
commit): seed the case's fixture, call the old `lapseSession` (an `expireAt`
60 s in the real past), poll the row, then call the route exactly as `I2` does.

```
P1_SWEEP {"bornExpireAt":"2026-12-24T12:45:55.671Z",      (the mint's 30-day TTL)
          "lapsedExpireAt":"2026-11-24T12:44:55.688Z",    (the case's re-stamp)
          "realNowAtLapse":"2026-11-24T12:46:51.512Z",
          "polls":111,"deletedAfterMs":55778,"rowGone":true}
P1_CLAIM {"status":404,"code":"not_found"}
AssertionError: expected 404 to be 401
```

The sweep took **55.778 s** — one monitor pass at the default cadence — and the
claim then answered `404 not_found`: the CI text, reproduced deterministically.
Note the window: a fixture lapsed at an arbitrary moment loses the race whenever
the next pass lands before the request, i.e. with probability `t / 60 s` against
a focused file's ~0.1 s gap, but a **full** `integration` run keeps one replset
alive for seven to eight minutes, which is why CI reddened while every focused
local run stayed green.

## Decision — move the clock, never the row's existence

`I2` now keeps `expireAt` in the **real future** (60 s ahead of the write, so the
TTL monitor cannot select it) and moves the **process clock** onto that instant
for the request:

```ts
const expiresAt = new Date(Date.now() + 60_000);
await lapseSession(app, session.token, expiresAt);          // the instant, in the real future
expect(expiresAt.getTime()).toBeGreaterThan(Date.now());    // the monitor cannot select it
expect((await readSessionRow(app, session.token)).expireAt).toEqual(expiresAt); // present at the act
const response = await claimWithClockAt(expiresAt, { … });  // fake Date only, restore in `finally`
```

`claimWithClockAt` is `vi.useFakeTimers({ toFake: ["Date"] })` +
`vi.setSystemTime(instant)` around the call, with `vi.useRealTimers()` in a
`finally`. Faking **only** `Date` moves `systemClock.now()` (`new Date()` per
call) and leaves timers, the driver's heartbeats and the readiness polls on real
scheduling — the seam `attendee-sessions.test.ts` already uses for the same
resolver (`I4: the clock decides expiry — 1 ms before expireAt is 200, at
expireAt is 401`), and the class shape [`ADR-0148`](ADR-0148-integration-fixture-clock-anchor.md)
established.

Measured on the repaired arm, same probe:

```
P3_CLOCK {"expireAt":"2026-11-24T12:51:34.736Z",       (real future)
          "realNowAfter":"2026-11-24T12:50:34.758Z",
          "status":401,"code":"attendee_session_expired"}
```

The row never leaves the collection, so no monitor pass can change the answer;
the answer is a function of one clock read. The fixture helper's old two-argument
form — the generator of the past instant — is gone: `lapseSession(app, token,
expireAt)` now requires the instant, so the same defect cannot be re-created by
calling it the old way.

### Rejected: an injectable clock threaded through the route

Measured unavailable without a production change. The route calls
`claimAttendeeSession({ db: getDb(), userId: principal, token })` — no clock —
and the service forwards none into the lookup:
`findAttendeeSession({ database: db }, options.token)` (`claim.ts`), so the
expiry comparison always reads `systemClock`. The service's own
`options.clock` reaches only the `claimedAt` stamp. Measured directly: with a
`fixedClock` **one minute past** the row's expiry, the service still answered
`claimed`.

```
P2_CLOCK {"expireAt":"2026-12-24T12:50:34.502Z","measured":"claimed"}
```

Rejected because it would require editing `claim.ts` (and possibly the route) to
thread a clock the card's scope forbids — and because the process-clock form
above already reaches the same read without touching production code.

### Rejected: a row-existence control with a bounded re-seed

Read the row back between the lapse and the act; if it is gone, re-seed and
re-run, three attempts, then fail with the reason. Rejected on measurement: the
loss is not a glitch but a **scheduled** event (`P1_SWEEP`: 55.778 s per pass,
`expireAfterSeconds: 0`), so the bound converts determinism into a probability
and the case's own failure mode hides inside it — when the sweep is quick (a
loaded host, a full-suite run) all three attempts can lose to the same pass,
and when it is slow the case passes for a reason unrelated to the clock. It also
leaves the arm unable to distinguish "the monitor was late" from "the resolver
stopped checking expiry", which is exactly the regression the case exists to
catch.

### Rejected: pin both honest outcomes with a discriminator

Assert `401` on a case that cannot be swept and `404` on a case where the row is
deliberately absent. Rejected because the `404` is **not** contractual for a
lapsed session: contract §6.7 and schema §13.5 require the lapsed client to be
told to re-create (`attendee_session_expired` with `details.recreateUrl`, per
[`ADR-0780`](ADR-0780-op129-anonymous-attendee-sessions-red.md)), and `not_found` describes a
token that names **no** row. Pinning the swept row's `404` would encode a race as
contract, and the card forbids relaxing the assertion to accept `404` for a
session the route should consider lapsed. The discriminator is unnecessary once
the `401` arm cannot be swept.

## Evidence

All commands ran in
`/root/openpic/openpic-webapp/.worktrees/op134-attendee-claim-i2-ttl` on
`origin/main` `340524bc` with the toolchain installed by
`CI=true pnpm install --frozen-lockfile --prefer-offline`.

### The pin is load-bearing (mutation probe)

The clock move removed from `claimWithClockAt` (nothing else), focused run of the
case, then restored byte-identically:

```
FAIL  |integration| … attendee-claim.test.ts > when a session is already spoken for
      > I2: a lapsed session is refused with 401 attendee_session_expired
AssertionError: expected 200 to be 401
      Tests  1 failed | 8 skipped (9)
```

`200` — the claim succeeded — is the honest answer for the row the fixture now
builds: it is live and unexpired. Only the clock produces the `401`, so the
assertion cannot pass on a route that stopped checking expiry.

### Determinism

Ten consecutive focused runs of the file, each on its own replset:

```
run 1..10: Tests 9 passed (9)
```

Full-suite (`--project integration`) and the static gates are recorded in the
card's handoff.

## Consequences

- The `401` arm is decided by one clock read and a present row; the TTL monitor
  can no longer turn it into a `404`, at any cadence and on any host load.
- The suite still pins the **inclusive** boundary: the clock sits exactly on
  `expireAt`, which the resolver treats as lapsed (`now >= expireAt`), matching
  the monitor's own semantics.
- `I2` no longer exercises "a lapsed row that happens to still exist at one
  instant in the monitor's cycle" — that state is a race artefact, not a
  product state, and nothing is lost.
- The helper's signature change is source-incompatible: a caller that passes two
  arguments no longer compiles, which is the point.
- Nothing in production changes: the TTL index, the retention policy and the
  resolver are untouched; the same fixture shape in any other suite is still a
  latent member of the class (`ADR-0148`'s sweep rule applies).

## Reversal condition

Re-derive this arm if any of the following stops holding: (1) the resolver
decides expiry from a **server-side** comparison (an aggregation `$expr` or a
query on `expireAt`) instead of reading the row and comparing an injected
`Clock` — the process clock would then no longer reach the decision; (2) the
route starts threading a clock the spec can supply, at which point the injected
form is preferred over faking `Date`; (3) `vi.useFakeTimers({ toFake: ["Date"] })`
stops isolating `Date` from timers, which would put the driver's scheduling at
risk.

## References

- [`ADR-0148`](ADR-0148-integration-fixture-clock-anchor.md) — the fixture-clock
  anchor class this repair follows.
- [`ADR-0938`](ADR-0938-op136-retention-purge-i11-fixture-ttl.md),
  [`ADR-0939`](ADR-0939-op136-usage-invitations-fixture-ttl.md),
  [`ADR-0940`](ADR-0940-op136-sweep-specs-fixture-ttl.md) — the three earlier
  members of the class, in other lanes.
- [`ADR-0818`](ADR-0818-op134-claim-endpoint-arms-pins.md) — owns the
  neighbouring claim pins; edited by nobody here.
- [`ADR-0780`](ADR-0780-op129-anonymous-attendee-sessions-red.md) — the lapsed-session
  recovery answer (`attendee_session_expired` + `recreateUrl`).
- [`ADR-0967`](ADR-0967-merged-lane-local-branch-deletion.md) — the merge-step
  ritual this card dogfoods at its own land.
