# ADR-0818 — OP-134 TEST (F1/F2, Medium): the claim endpoint's concurrent-claim and body-omitted arms

- **Status:** Accepted (RED pin record — the GREEN is owed)
- **Consumers:** `apps/web/src/test/integration/attendee-claim-endpoint-arms.test.ts`
  (the pins), and the two files they constrain —
  `apps/web/src/server/attendee/claim.ts` (`claim.ts:148`, `claim.ts:182`) and
  `apps/web/src/app/api/v1/me/attendee-sessions:claim/route.ts`
  (`body: claimBodySchema` at `route.ts:75`) — plus the contracts they make
  true ([ADR-0814](ADR-0814-op134-attendee-claim-red.md),
  [ADR-0815](ADR-0815-op134-attendee-claim-green.md)).
- **Amends:** nothing. **Amended by:** nothing yet.
- **Consumes:** `0818` (both `Next free` cells advance to `0819`).
- **Base:** `origin/main` `7021cdf`, which contains the OP-134 GREEN squash
  `0d57e95` (tree `6afce2f5…`, identical to the reviewed head `967d928`); the
  branch then merged `origin/main` `fdff81c` (the OP-132 retention gate
  `442e01a` + release `1.63.1`) before the PR opened, and the four pins were
  re-measured on that merged tree.
- **Card:** `t_08232689` (parent `t_135c11ae`, OP-134 GREEN round-1 review,
  findings **F1** and **F2**).

## Context

The OP-134 GREEN (PR #565) shipped the claim endpoint against twenty-one unit
and seventeen integration cases. The round-1 review measured two arms of
contract §6.7 that none of those cases reach, and routed one pin card and one
GREEN card per finding. This record is the pin card.

**F1 — two accounts, one session.** The reviewer's throwaway probe, on a clean
worktree at `967d928`:

```
PROBE_RESULT {"statusA":200,"statusB":200,"claimedA":1,"claimedB":1,
              "profileSubjects":[{"kind":"user","userId":"…A"}],
              "claimedBy":"…A","linkedEvents":2}
```

One profile owned by A, B answered `200` naming an event it did not move, two
`attendee.event.linked` rows for one claim, and `claimedByUserId` decided by
write order rather than by the profile's owner. Two causes, both in
`claim.ts`: the conflict check at `claim.ts:148` is a **read** that runs before
every write, and the re-point `updateOne` at `claim.ts:182` never inspects
`matchedCount`.

**F2 — the body may be omitted.** §6.7 states the body as
`{"sessionToken": "opat_…"}` **"(or omitted, reading the `op_att` cookie)"**. A
bodyless `POST` (no `content-type`, no body) answers `415
unsupported_media_type` from `parseJsonBody` (`respond.ts:84`), before the
handler reads the cookie, and `claimedByUserId` stays `null`. The shipped RED
helper `claimSession()` always sends `{}`, which is why the omission arm was
never exercised: the existing `I4` case names the session by the cookie but
still sends a JSON body.

## Decision

### 1. One new integration spec, two pins, no existing assertion touched

`apps/web/src/test/integration/attendee-claim-endpoint-arms.test.ts` adds `I8`
(three runs) and `I9`. Nothing in `attendee-claim.test.ts`,
`attendee-claim-on-signin.test.ts`, `my-events.test.ts` or the helpers changes,
so the GREEN can carry the file unchanged into its own PR. The new file boots
its own app (`prefix: "op134-claim-arms"`) and wipes the claim's collections in
`beforeEach`, exactly as the family already does.

### 2. `I8` pins the invariant, not the answer that happens to win

Both accounts present both cookies and a body naming the same token (so `I8`
cannot fail on the bodyless arm that `I9` owns — it must fail on the double
claim). The assertions, in order:

1. exactly **one** answer is `200` with `claimed.length === 1`, and that answer
   names the seeded event;
2. the other answer is **either** `409 session_claimed_by_other_user` **or**
   `200 { claimed: [], skipped: [] }` — expressed as one
   `expect([...allowed]).toContain(<the measured shape>)`, so a failure prints
   `run 1: the losing claim answered "200 claimed=0 skipped=1"` instead of a
   bare boolean;
3. `attendee_event_profiles` holds exactly one row, its `_id` is the anonymous
   row the upload flow created (`submitted.profileId`, so a delete-and-recreate
   claim fails too), and its `subject.userId` is the account the winning answer
   named;
4. exactly one `domainEvents` row has `eventKey: "attendee.event.linked"`, and
   its `subjectRef.id` is that owner;
5. `attendeeSessions.claimedByUserId` equals that owner.

The loser is allowed to be a `200` no-op on purpose: §6.7 forbids a `200` that
**names an event it did not move**, and a fix that re-reads the session and
reuses the observation can honestly answer "nothing left to re-point". Pinning
`409` alone would fail a legitimate fix; pinning `200 {}` alone would fail the
shipped refusal the review already accepted (`I2`).

### 3. Determinism is a barrier at the claim's own seam, and it was measured

A bare `Promise.all` is a coin flip: a run in which the first claim finishes
before the second reads its session answers `409` and passes, which is not a
pin.

- The shipped technique (ADR-0803 §3, ADR-0805, `selfie-reuse-attempt-cap`)
  applies: park every racer at a shared barrier and release them together,
  bounded so a serialising fix still finishes.
- **The barrier parks at `attendee_event_profiles.findOne`** — the
  existing-profile read, the first database call after `claim.ts:148` and
  before either write. Every claim therefore returns from the park only once
  all of them have passed the conflict check against an **unclaimed** session.
- **Measured, and recorded because it changed the design:** the first version
  of the barrier parked on the _session_ read (`attendeeSessions.findOne`) and
  leaked — one `I8` run of four passed on unfixed code, because a claim can
  touch `attendeeSessions` more than once before it writes (the resolver is
  reachable from more than one stage), so the park could be satisfied by one
  claim alone and the other then read the winner's write. Moving the park to
  the profiles read removed the leak: **three consecutive whole-file runs after
  the change reported `Tests 4 failed (4)`** (three `I8` runs plus `I9`), and
  the three `I8` runs have failed on every run since.
- The hold is bounded at `1_000 ms` so a GREEN that refuses the loser **before**
  the park (the shape probe 1 takes) or serialises the pair does not hang; the
  bound is a safety valve, not the mechanism.
- The case runs three times (`it.each([1, 2, 3])`, fresh database each) so the
  invariant is required of every run, not of a lucky one.

### 4. `I9` pins the omitted body, not an empty one

The request is built by `requestFor(...)` **without** a `body` key, so it
carries no `content-type` — §6.7's documented arm. The assertions are `200`,
one claimed event (the seeded one, with the anonymous profile's id), the
surviving profile owned by the caller, and `claimedByUserId` stamped.

`POST` with `content-type: application/json` and an empty body (today `400
malformed_json`) is **deliberately not pinned**: the contract names the omitted
body, and whether an explicitly-empty JSON body is a claim or a `400` is a
choice for the GREEN. It is listed under open questions.

### 5. Failure texts measured at `7021cdf` (RED by design)

```
× I8 (run 1 of 3): only one account claims the event, and the session records its owner
AssertionError: run 1: more than one account reported a claimed event
  (…: 200 claimed=1 skipped=0 | …: 200 claimed=1 skipped=0):
  expected [ { user: { …(3) }, …(4) }, …(1) ] to have a length of 1 but got 2
× I8 (run 2 of 3) …  × I8 (run 3 of 3) …   (same assertion, same measured shape)
× I9: a bodyless claim reads the op_att cookie and claims the session
AssertionError: expected 200 from a bodyless claim, received 415:
  expected 415 to be 200 // Object.is equality
Tests  4 failed (4)
```

### 6. Satisfiability probes (production files restored byte-identically)

Each probe mutated one production file, ran the affected cases, and restored
the file; `git diff` was empty afterwards and the sha256 was compared before
and after.

| Probe | Mutation                                                                                                                                       | Result                                                                                                                                                                                                                                                                                                                  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `claim.ts`: one conditional session claim (`updateOne({_id, claimedByUserId: null})`, `matchedCount === 0 → conflict`) before the profile walk | `Tests 3 passed \| 1 skipped (4)` — **`I8` green 3/3**, so the whole invariant (winner count, one profile, one link event, session owner) is satisfiable by one atomic guard                                                                                                                                            |
| 2     | `claim.ts`: `matchedCount === 0 → continue` on the re-point only, session write still unconditional                                            | `Tests 3 passed \| 1 skipped (4)` — the loser stops claiming and, in the measured runs, the winner's session write also landed last. Recorded honestly: the **winner-count** assertion is the deterministic bite; the session-owner assertion catches the last-write-wins hazard only when the loser's write lands last |
| 3     | `route.ts`: `body: claimBodySchema` removed, the token read from an optional `ctx.body`                                                        | `Tests 1 passed \| 3 skipped (4)` — **`I9` green**, and its profile/subject assertions really executed rather than short-circuiting on the status                                                                                                                                                                       |

### 7. Number allocation

`0818`, drawn from the allocator's pool (`unallocated (future lanes)`) because
the OP-129 attendee block `0780`–`0798` is exhausted. The sweep before minting
covered `origin/main` (`0815`), every remote branch, and every
`.worktrees/*/docs/adr`: `0813` was in flight
(`OP-132-task-attendee-retention-gate-pins`, and it landed on the trunk as
`442e01a` while this card ran), `0816`
(`OP-132-task-concurrent-confirm-pin`) and `0817`
(`OP-132-task-concurrent-confirm-green`) are in flight, so the first free number
is `0818` — still `0818` after the merge of `fdff81c`, whose trunk records end at
`0815`. Both `Next free` cells advance to `0819`. If a merge takes `0818`
first, this record is renumbered on the merge commit (ADR-0300 §10).

## Consequences

- The GREEN owes two changes: an **atomic** guard on the session claim (the
  conflict check must be part of the write, and a re-point that matched no row
  must not be reported as claimed) and a **claim that accepts an absent body**.
  Nothing else — `I8` and `I9` do not constrain which mechanism is used.
- The existing seventeen integration and twenty-one unit cases must stay green;
  in particular `I2`'s `409` for a different account, `I2`'s `200` no-op for the
  owner, `I1`'s "no data moves" and `I4`'s cookie clearing are untouched and
  remain the contract for the sequential paths.
- This branch is **RED by design** and must not be merged: the GREEN card
  (`t_07786aa0`) carries this spec file into its own PR unchanged.
- The `1_000 ms` park bound is part of the test, not a suite-wide timeout; it
  adds nothing to today's runtime (both claims reach the park in milliseconds).
- **CI posture at `6ea3f0c`** (draft PR #573): `lint`, `unit_test`, `audit`,
  `audit-dev`, `secret-scan`, `env-changes`, `CodeQL`, `validate-branch-name` and
  `validate-pr-title` **pass**; `test_coverage` and `ci` **fail on the four new
  cases only** (`Test Files 1 failed | 306 passed (307)`, every failing line
  naming `attendee-claim-endpoint-arms.test.ts`). That is the intended RED
  posture — the GREEN carries the spec into its own PR where those two jobs run
  green.

## Alternatives rejected

- **Assert `statuses.sort() === [200, 409]`.** Rejected: it fails a
  re-read-and-reuse fix that legitimately answers the empty `200` no-op, and it
  would not name _which_ account won.
- **Rely on three `Promise.all` iterations without a barrier.** Rejected on
  measurement: the interleaving is not controlled, and an unfixed claim can pass
  on the run where the first claim completes first.
- **Park on the session read.** Rejected on measurement (one `I8` run of four
  passed on unfixed code); the profiles read is one call per claim and is
  strictly after the guard.
- **Pin the empty-JSON-body arm too.** Deferred — see open questions.

## Open questions (for the GREEN card `t_07786aa0`)

1. `POST` with `content-type: application/json` and an **empty** body: today
   `400 malformed_json`. §6.7 names only the omitted body; decide whether the
   empty body is also a valid cookie-only claim (and record it in §6.7).
2. Which `200`-empty shape the loser gets when the fix re-reads the session
   inside a transaction (the pin accepts both the refusal and the no-op).
3. Whether the fix also makes the **session-created identity hook** claim
   atomically — the hook calls the same service, so one guard covers both; this
   card does not drive the hook's own race.
