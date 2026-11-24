# ADR-0973 — OP-134: the four remaining real-past `expireAt` fixtures on `attendee_sessions` decide on the clock

- **Status:** Accepted (test-determinism repair; every pinned answer is unchanged)
- **Consumers:** `apps/web/src/test/helpers/clock.ts` (the one `withClockAt` seam this
  record adds), `apps/web/src/test/helpers/attendee-claim-flow.ts`
  (`stampSessionExpiry`), `apps/web/src/test/integration/attendee-claim.test.ts`,
  `apps/web/src/test/integration/attendee-sessions.test.ts`,
  `apps/web/src/test/integration/auth-guards.test.ts` and
  `apps/web/src/test/integration/public-event-resolution.test.ts`. The behaviour
  these specs pin is owned by [`ADR-0780`](ADR-0780-op129-anonymous-attendee-sessions-red.md),
  [`ADR-0784`](ADR-0784-op130-public-event-resolution-red.md) and
  [`ADR-0818`](ADR-0818-op134-claim-endpoint-arms-pins.md); this record cites them
  and edits none.
- **Amends:** [`ADR-0968`](ADR-0968-op134-attendee-claim-i2-clock.md)'s §Consequences
  disclosure that "the same fixture shape in any other suite is still a latent
  member of the class". **Amended by:** nothing yet.
- **Consumes:** `0973` — a **pool draw**. The OP-134 lane holds no reserved row
  (its numbers have been pool draws since [`ADR-0818`](ADR-0818-op134-claim-endpoint-arms-pins.md)),
  so ADR-0300 §11 item 18 sends the record to the `unallocated (future lanes)`
  cursor. The card proposed `0969`; four surfaces swept at this branch cut
  (`origin/main` `5565eec9`) show `0969` **already held**, so this record takes the
  next free number above the highest in-flight reservation and records why (below).
- **Card:** `t_6ee47a21` (OP-134 follow-up, TEST, Low — findings F1/F2/F3 of the
  round-1 review of [`ADR-0968`](ADR-0968-op134-attendee-claim-i2-clock.md)).
- **Branch:** `OP-134-task-attendee-sessions-ttl-regressions` · **Worktree:**
  `/root/openpic/openpic-webapp/.worktrees/op134-attendee-claim-i2-ttl`
- **Touches:** four case arms (two in `attendee-sessions.test.ts`, one in
  `auth-guards.test.ts`, one in `public-event-resolution.test.ts`), one new shared
  helper (`test/helpers/clock.ts`), the two pre-existing fake-`Date` sites moved
  onto it (`attendee-claim.test.ts`'s in-file `claimWithClockAt` and
  `attendee-sessions.test.ts`'s `I4: the clock decides expiry` arm, assertions
  unchanged), one rename with its call site and doc comment
  (`lapseSession` → `stampSessionExpiry`), this record, its index row, four
  `Next free` cells and one ledger paragraph. **No production file, schema, index,
  retention value, mock or factory.** `attendee-claim.test.ts`'s `I2` arm is
  byte-identical; no other case in any of the four specs is modified.

## Number allocation (the sweep the card asked for)

`0969` is not free at this cut. The four surfaces:

- **committed refs** — `git rev-list --objects --all -- docs/adr` reports
  `docs/adr/ADR-0969-op132-confirm-deactivation-sweep-pin.md` (OP-132's branch,
  open PR [#879](https://github.com/yahodu/openpic-webapp/pull/879)); the cut
  (`origin/main` `5565eec9`) stopped at `ADR-0968`, and `0969` then landed on the
  trunk as `8e1a0ec4` — this branch's final base — while the card ran;
- **live worktrees** — `.worktrees/t_52256cb7` holds `ADR-0969` **and** its ledger
  cells already read `0970`; `.worktrees/t_b142c5d8` (running card `t_b142c5d8`,
  branch `OP-101-task-member-mutation-audit-records`) holds an uncommitted
  `ADR-0970` whose record **reserves `Consumes: 0971`** for its serial TEST card
  and **`Consumes: 0972`** for its GREEN — that record landed on the trunk as
  `712b94d0` while this card ran, advancing the four cells to `0971`, so `0971`
  and `0972` are still spoken for and this draw steps over them;
- **open PR heads** — `gh pr list --state open` returns one PR, `#879`
  (`OP-132-task-confirm-deactivation-failure-pins`), whose head carries `0969`;
- **non-`done` cards** — the two live rows that mention `0968`/`0969`
  (`t_0904efc1`, the concurrent-pool-draw decision, and `t_a2124da9`, the ledger
  table repair) consume no number; no row reserves `0973`.

Highest in-flight reservation is therefore `0972`, and this record takes `0973`,
advancing the four cells `0970` → `0974` (`0970` on the final base `8e1a0ec4`,
`0969` on the earlier cut) — `board-wide / process`,
`OP-129 attendee identity lane`, `OP-136 jobs lane`, `unallocated (future lanes)` —
to `0974` (the next free after this draw). No cell is lowered and no range is
re-cut. A concurrent draw at `0970`–`0972` is the very collision
`t_0904efc1` is deciding, so the number moves above it rather than beside it.

## Context

PR [#880](https://github.com/yahodu/openpic-webapp/pull/880) (squash `7c2d315c`)
repaired **one** member of the fixture-vs-TTL-monitor class: `attendee-claim.test.ts`
`I2`. Its own [`ADR-0968`](ADR-0968-op134-attendee-claim-i2-clock.md) §Consequences
discloses that the shape is class-wide, and the round-1 review measured the rest
of the class still on the trunk: four cases on `attendee_sessions` stamp an
`expireAt` into the **real past** and then read an answer.

`attendee_sessions` carries the shipped TTL index (`apps/web/src/server/db/indexes.ts`),
read live from the booted test server at this cut:

```
PROBE_INDEXES [{"v":2,"key":{"expireAt":1},
                "name":"attendee_sessions_expire_at_ttl","expireAfterSeconds":0}]
```

mongod evaluates that key against the **real** wall clock on a ~60 s pass. A row
stamped into the real past is deleted at an instant no case controls, and the
answer changes with the row's existence.

## Diagnosis — the mechanism re-measured, and what each site answers when swept

The sweep latency was measured once on a throwaway spec (`startTestApp` +
`ensureIndexes`, one `attendee_sessions` row stamped 60 s into the real past, poll
every 500 ms), then deleted before the commit:

```
PROBE_SWEEP {"past":"2026-11-24T13:58:26.381Z",
             "realNowAtInsert":"2026-11-24T13:59:26.381Z",
             "polls":114,"deletedAfterMs":56805,"rowGone":true}
```

**56.805 s** — one monitor pass, reproducing ADR-0968's `55.778 s` and the
reviewer's `54.848 s`. The per-site swept answers were then forced by deleting
the aged row in a probe copy of each case (what a monitor pass does), each on its
own focused run:

| #   | Case                                                                                                              | Swept answer (measured)                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `attendee-sessions.test.ts` `I4: a session whose expireAt has passed is 401 attendee_session_expired`             | `401 authentication_required` → `AssertionError: expected 'authentication_required' to be 'attendee_session_expired'`, `1 failed \| 27 skipped (28)` |
| 2   | `attendee-sessions.test.ts` `F4: a lapsed op_att cookie is 401 attendee_session_expired even with a valid header` | `200` (the cookie falls through to the valid header) → `AssertionError: expected 200 to be 401`, `1 failed \| 27 skipped (28)`                       |
| 3   | `auth-guards.test.ts` `F3: a lapsed session with the default resolver is 401 attendee_session_expired`            | `401 authentication_required` → `AssertionError: expected 'authentication_required' to be 'attendee_session_expired'`, `1 failed \| 16 skipped (17)` |
| 4   | `public-event-resolution.test.ts` `I2: a lapsed session cookie still renders the page (§6.1 has no 401)`          | **the pinned answer**: `1 passed \| 35 skipped (36)` — the case did not discriminate at all                                                          |

Sites 1–3 were reproduced exactly as the review reported them. Site 4 was **not**
as the review's wording implies, and the card asked for the measurement rather
than the assumption. The route's own doc says why: `attendeeSessionIdFor` reads
the row and `hasProfileFor` answers `false` for a session it cannot resolve, so a
deleted row and a present row with no profile are the **same body**. Two further
probes establish the only sweep-sensitive observable the route has:

```
PROBE4A (row deleted)                    → 200, session {kind:"anonymous", hasProfile:false}   (green)
PROBE4B (lapsed row present + a profile) → 200, session {kind:"anonymous", hasProfile:true}
                                            AssertionError: expected { kind: 'anonymous', …(2) }
                                            to match object { kind: 'anonymous', hasProfile: false }
```

So the lapsed cookie is a _hint that still resolves_ (`§6.1` has no `401` and the
route deliberately does not judge expiry), and `hasProfile` is the field a sweep
flips.

## Decision

**R1 — a lapsed credential is expressed by the clock, never by a past `expireAt`.**
Sites 1–3 keep the row's `expireAt` 60 s in the **real future** (the TTL monitor
cannot select it) and move the reader's clock onto the stamp for the request, via
the one shared seam:

```ts
export async function withClockAt<T>(instant: Date, fn: () => Promise<T> | T): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(instant);
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}
```

Each repaired arm also asserts that the stamp is in the real future and — for
sites 1 and 2, where the row is the subject — that the row is still present with
that `expireAt` at the act, so a lost race fails loudly instead of silently
accepting the swept answer.

**R2 — site 4 pins what the route actually promises, and the row stays live.**
`I2` now mints a real session through `POST /p/attendee-sessions` (its own
`expireAt` ~30 days in the real future, so no monitor pass can select it), seeds
the profile that session owns, moves the clock past the session's own expiry and
asserts `200` with `session: {kind:"anonymous", hasProfile:true}`. Deleting the
row — the sweep — reddens it (`false` against `true`), which is the discrimination
the old fixture did not have.

This is a **recorded deviation from the card's literal wording**: the card says
site 4 "expects `200` with `session: {kind:"anonymous", hasProfile:false}`" and
suggests the row "simply must stay unexpired relative to the real clock". A live
row and a swept row both produce `hasProfile:false` there (PROBE4A, measured), so
the card's expectation is satisfied by the very shape the repair removes, and a
pin that both states satisfy is not a pin — AC3 of this card requires a mutation
that reddens each repaired case. Seeding the profile keeps the card's `200`/no-`401`
claim and makes `hasProfile` the sweep-sensitive assertion; nothing is relaxed.

**R3 — one seam, and only one.** `test/helpers/clock.ts` owns the fake-`Date`
pattern. `attendee-claim.test.ts`'s in-file `claimWithClockAt` now delegates to it
(its `I2` arm untouched, byte-identical) and `attendee-sessions.test.ts`'s
`I4: the clock decides expiry` arm replaced its inline `vi.useFakeTimers` /
`vi.setSystemTime` block with two `withClockAt` calls (same assertions, same
instants). The seam therefore exists once, in the helper, plus the file-scoped
`afterEach(() => vi.useRealTimers())` safety net the spec already carried.

**R4 — the mis-named helper is renamed.** `lapseSession(app, token, expireAt)`
became `stampSessionExpiry(app, token, expireAt)`; a repaired call site hands it
an instant in the **future**, so the old name described the opposite of its job
(review finding F2). One call site, one doc comment, no signature change.

### Rejected: a per-suite local helper

Three copies of six lines was finding F3 of the review; adding a fourth while
fixing F1 would have made the finding worse. The shared helper is the only place
`vi.useFakeTimers({ toFake: ["Date"] })` appears in these four suites.

### Rejected: re-seed the swept row and retry

Same reasoning as ADR-0968's §Rejected: the loss is a **scheduled** event, not a
glitch, so a bounded retry converts determinism into a probability and hides the
case's own failure mode inside it.

### Rejected: pin both honest outcomes

Asserting `401` on a case that cannot be swept **and** the swept answer on a
second case would encode a race artefact as contract: `authentication_required`
describes a token that names no row, while a lapsed session must be told to
re-create (`attendee_session_expired` + `details.recreateUrl`, ADR-0780). Where
the swept answer _is_ contractual — site 4, which has no `401` and no expiry
semantics — the case pins the resolving body instead (R2).

### Rejected: thread an injectable clock through the routes

Measured unavailable without production changes in ADR-0968 (the claim route
threads no clock and the service forwards none; a `fixedClock` one minute past
expiry still answered `claimed`). The same holds for the current-session route and
for the guard's default resolver, both of which read `systemClock` directly, and
`public-event-resolution` needs no clock at all beyond the pinned read.

## Evidence

All commands ran in
`/root/openpic/openpic-webapp/.worktrees/op134-attendee-claim-i2-ttl` on the
delivered base `origin/main` `8e1a0ec4`, with the toolchain installed by
`CI=true pnpm install --frozen-lockfile --prefer-offline`. The card cut was
`5565eec9`; `8e1a0ec4` is that cut plus [ADR-0969](ADR-0969-op132-confirm-deactivation-sweep-pin.md)
and one sibling lane's spec, none of the four files this record touches, and the
determinism, mutation and gate runs below were re-executed at `8e1a0ec4` before
the push.

### Determinism — ten consecutive focused runs per repaired case

```
run 1..10  I4 (attendee-sessions)  Tests  1 passed | 27 skipped (28)
run 1..10  F4 (attendee-sessions)  Tests  1 passed | 27 skipped (28)
run 1..10  F3 (auth-guards)        Tests  1 passed | 16 skipped (17)
run 1..10  I2 (public-event-res.)  Tests  1 passed | 35 skipped (36)
```

### The pins are load-bearing (mutation per case)

Clock move removed (nothing else), focused run, restored byte-identically:

```
I4  AssertionError: expected 200 to be 401 // Object.is equality   1 failed | 27 skipped (28)
F4  AssertionError: expected 200 to be 401 // Object.is equality   1 failed | 27 skipped (28)
F3  AssertionError: expected 200 to be 401 // Object.is equality   1 failed | 16 skipped (17)
```

Site 4, mutated the way the class fails — the monitor's sweep forced by deleting
the row:

```
I2  AssertionError: expected { kind: 'anonymous', …(2) } to match object
        { kind: 'anonymous', hasProfile: true }
    -   "hasProfile": true,
    +   "hasProfile": false,
      Tests  1 failed | 35 skipped (36)
```

`200` is the honest answer for a live, unexpired row, so only the clock produces
the `401` at sites 1–3; the deleted row is the only thing that makes site 4's
session unresolvable.

### Scope and gates

Mechanical scope proof — the diff adds and removes **no** `it(` line in the four
specs, so no case was added, removed or renamed; the four arms below keep their
names and their assertions:

```
git diff origin/main...HEAD -- 'apps/web/src/test/**' | grep -E '^[+-].*\bit\('   → (nothing)
files: A helpers/clock.ts · M helpers/attendee-claim-flow.ts ·
       M integration/{attendee-claim,attendee-sessions,auth-guards,public-event-resolution}.test.ts
```

```
pnpm typecheck                        exit 0
pnpm lint                             exit 0 (the two security/detect-object-injection
                                      warnings in the harness helpers predate this diff)
prettier --check (8 changed files)    All files formatted correctly
four focused specs                    4 files / 90 passed
--project integration (full)          165 files / 1781 passed  (334 s wall, 0 failed)
--project unit (full)                 196 files / 3354 passed | 3 skipped
eight adr-* guards                    8 files / 280 passed
```

## Consequences

- The four arms are decided by one clock read and a present row (sites 1–3) or by
  a present row alone (site 4). No monitor pass can change any of their answers at
  any cadence or host load.
- Every repaired assertion keeps its original status and `error.code`; site 4
  keeps `200` and gains the `hasProfile: true` that the sweep can flip.
- `lapseSession` is gone; a repaired call site can no longer be written as if the
  helper lapsed a row.
- The fake-`Date` seam is one function in `test/helpers/clock.ts`; a fifth
  `attendee_sessions` case that needs a lapsed credential has one obvious way to
  say so.
- Out of scope, deliberately: the inline fake-`Date` blocks in
  `entitlements-endpoints.test.ts` and `data-subject-requests.test.ts` belong to
  other lanes' specs and their fixtures are not TTL-indexed lapsed rows; the
  blank line that leaves ledger rows `0967`–`0970` outside the rendered index
  table is card `t_a2124da9`'s repair.

## Reversal condition

Re-derive these arms if any of the following stops holding: (1) the resolver or
the guard decides expiry from a **server-side** comparison (a `$expr`/query on
`expireAt`) instead of reading the row and comparing the process clock — faking
`Date` would then no longer reach the decision; (2) a route starts accepting an
injected clock the spec can supply, at which point the injected form is preferred;
(3) `vi.useFakeTimers({ toFake: ["Date"] })` stops isolating `Date` from timers,
which would put the Mongo driver's scheduling at risk; (4) `§6.1`'s landing call
starts judging session expiry, which would make site 4's `200` a different claim.

## References

- [`ADR-0968`](ADR-0968-op134-attendee-claim-i2-clock.md) — the first
  `attendee_sessions` member of the class and this repair's shape.
- [`ADR-0148`](ADR-0148-integration-fixture-clock-anchor.md) — the class and its
  exposure rule (a spec is exposed iff it persists into a TTL-indexed collection
  with a past `expireAt` **and** re-reads that document after an `await`).
- [`ADR-0938`](ADR-0938-op136-retention-purge-i11-fixture-ttl.md),
  [`ADR-0939`](ADR-0939-op136-usage-invitations-fixture-ttl.md),
  [`ADR-0940`](ADR-0940-op136-sweep-specs-fixture-ttl.md) — three earlier members.
- [`ADR-0780`](ADR-0780-op129-anonymous-attendee-sessions-red.md) — the lapsed-session
  recovery answer (`attendee_session_expired` + `recreateUrl`).
- [`ADR-0784`](ADR-0784-op130-public-event-resolution-red.md) — `§6.1`'s landing
  call and its `session` hint.
- [`ADR-0967`](ADR-0967-merged-lane-local-branch-deletion.md) — the merge-step
  ritual this card dogfoods at its own land.
