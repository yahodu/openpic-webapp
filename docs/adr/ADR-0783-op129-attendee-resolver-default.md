# ADR-0783 — OP-129 GREEN: the attendee resolver as the guard's default, and the cookie→header fall-through

- **Status:** Accepted (implementation of the ADR-0782 pins)
- **Card:** OP-129 round-1 review follow-up GREEN (`t_a909e641`) · **Branch:** `OP-129-task-attendee-session-resolver-default` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_a909e641`
- **Consumers:** `@/server/auth/guards`, `@/server/attendee/session-resolver`, `@/api/v1/p/attendee-sessions/current`
- **Lane:** OP-129 (epic Attendee Identity). Reserved range `0769`–`0788`, `Next free = 0783` → this record takes `0783`, cell advances to `0784`.
- **Relates to:** [ADR-0780](ADR-0780-op129-anonymous-attendee-sessions-red.md) (the RED contract), [ADR-0781](ADR-0781-op129-anonymous-attendee-sessions-green.md) (the resolver this record re-wires), [ADR-0782](ADR-0782-op129-attendee-session-edge-pins.md) (the pins F3/F4 that demanded both changes)
- **Contract:** §0.2 (`attendee` label, cookie **or** header) · §1.5 (`GET /p/attendee-sessions/current`)

## Context

Two behaviours the shipped OP-129 GREEN (`2793f02`) got wrong had no spec observing them until
ADR-0782 pinned the intended answers (RED by design):

- **F3** — `createAttendeeSessionResolver()` was built only by
  `…/attendee-sessions/current/route.ts`. Every other `attendee`-labelled route reaches the guard as
  `requireAuth("attendee", { auth, database })` with no `attendeeResolver`, so it fell back to the
  OP-86 `noAttendeeSessions` stub and answered `401 authentication_required` to a real attendee.
  Fails closed, so not a security hole — a broken label.
- **F4** — `attendeeTokenFrom()` returned the cookie first, and the resolver stopped when that token
  matched no row, so a **stale** `op_att` cookie shadowed a valid `X-Attendee-Session` header,
  although §0.2 says cookie **or** header.

## Decisions

### 1. The default resolver is built in `resolveAttendee`, from the `database` the guard already has

`guards.ts` no longer exports the `noAttendeeSessions` stub. `resolveAttendee()` builds
`createAttendeeSessionResolver({ database: options.database })` when the caller injects no
`attendeeResolver`, so one wiring point serves every `attendee`-labelled route. The injection seam
stays: a route or test that passes its own port is still honoured.

The builder is called **per request, never at module scope**: `getDb()`/`getAuth()` read validated
configuration, and `next build`'s page-data collection pass runs without a configured environment,
so a module-scope `getDb()` would fail the build (the comment already carried by `current/route.ts`
now lives at the one place that matters).

`current/route.ts` drops its own factory call and passes `{ auth: getAuth(), database: getDb() }`
like every other route — the duplicate wiring that F3 named is gone, not merely shadowed.

Rejected: a `getAttendeeSessionResolver()` helper beside `getAuth()`. It would make the guard reach
for the process `getDb()` singleton, discarding the `database` handle it is given and with it the
per-spec harness seam (`startTestApp` hands the guard its own database).

### 2. The fall-through lives beside `findAttendeeSession`, and only an _unknown_ cookie falls through

`findRequestAttendeeSession(options, request)` in `session-resolver.ts`:

1. read the cookie token; if it names a row, that row is the answer;
2. otherwise read the `X-Attendee-Session` header; if absent, `null`; else look the header token up.

`findAttendeeSession` is untouched, so a **lapsed** cookie still throws
`attendee_session_expired` with `details.recreateUrl` before the header is ever read — the answer
the lapsed-cookie companion pin freezes. Only a token that matches no row falls through; the
fall-through cannot be bought by swallowing the expiry, and an unknown header token still ends in
`401 authentication_required` (the shipped blanket-admission guard).

`createAttendeeSessionResolver` and `current`'s handler both call this one function, so the label
and the body cannot disagree about which credential is in force.

## Consequences

- Every `attendee`-labelled route now admits a genuine `op_att` cookie; the change is confined to
  the guard's default, so no route file needed an edit beyond deleting the now-duplicated wiring.
- An unknown cookie costs one extra indexed `tokenHash` lookup when a header is present. The
  indexed lookup is cheap and the alternative — a single `$in` over two hashes — would change
  `findAttendeeSession`'s shape for a case no pin observes.
- `noAttendeeSessions` is gone from the public surface; nothing else imported it (grepped).

## Alternatives considered

- **Try the header first.** Violates the shipped cookie precedence and would keep §0.2's "cookie
  or header" true only by accident. Rejected.
- **Swallow the expiry and retry the header.** The lapsed-cookie companion pin answers
  `401 attendee_session_expired`; a retry would turn that into `200`. Rejected.
- **Widen `AttendeePrincipal`** to carry the row so `current` need not re-read it. Out of scope for
  F3/F4; ADR-0781 §3 already records the re-read as the cheaper trade.

## Evidence

- F3: `auth-guards.test.ts` 17/17 (the four pins — principal, admission, lapsed expiry, unknown
  token refusal). F4: `attendee-sessions.test.ts` 18/18 (fall-through plus the lapsed-cookie
  companion).
- Full suite counts and gates are recorded in the card handoff.

## Review (round 1)

**Verdict: APPROVED WITH FINDINGS.** Reviewed at head `cbe53de` and landed on the
lane trunk `OP-129-task-attendee-session-edge-pins` as the squash `e9eceef`
(PR #460, 11/11 checks green). Nothing above is retracted: §Context, §Decisions,
§Consequences, §Alternatives considered and §Evidence stand as written. The
reviewer edited no file in the reviewed delivery; the reviewed SHA is frozen and
every finding below is a card, not a push.

### The reviewed bytes are what landed

`git diff --stat cbe53de e9eceef` is **empty (0 lines)**: the tree the review read
is byte-identical to the squash, so every count below was measured on the merged
bytes.

`git diff --stat 38a7fa6..cbe53de` is **3 production files + 2 docs** — the
production files are `current/route.ts`, `session-resolver.ts` and `guards.ts`,
the docs are this record and the ledger — so the delivery edited no test.

### Gates re-run independently at `cbe53de`

- Focused pins: **35 passed (35)** — `auth-guards.test.ts` 17 plus
  `attendee-sessions.test.ts` 18.
- RED direction: with the three production files reverted to `38a7fa6` in a
  throwaway worktree the run is **4 failed | 31 passed (35)**, and the four
  failures carry exactly the expected messages — `expected 401 to be 200` (twice),
  `expected null to match object { kind: 'attendee' }`, and
  `expected 'authentication_required' to be 'attendee_session_expired'`. The
  probe worktree was removed with `git worktree remove --force` and the reviewed
  files restored byte-identically.
- Full unit: **149 files, 2390 passed | 3 skipped**.
- Full integration: **99 files, 930 passed**.
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `prettier --check` clean on
  every touched file.
- ESLint: **0 errors**, warnings **3 → 2** (the resolver's warning is removed and
  none is added).
- PR Checks: **11/11**.

### Findings (routed, not fixed here)

- **F1 (Critical, lane)** — two sibling OP-129 pin branches both mint `ADR-0782`
  (`…edge-pins.md` and `…rate-limit-pins.md`); with both files present
  `checkAdrDirectory` reports a `duplicate` issue and the guard run is
  `1 failed | 28 passed`. This is a lane-wide allocator decision, routed to the
  orchestrator card `t_1b9c21c6`. This record's own `0783` was unique across
  every open PR head and every worktree at review time.
- **F2 (Low, this record)** — the `Relates to` header line and §Alternatives
  considered cite `ADR-0769` and `ADR-0770`, which the lane repair renumbers. See
  the note below.
- **F3 (Low, test quality)** — no pin for two valid attendee credentials naming
  different sessions, where the cookie must win. Routed to TEST card
  `t_296d24bd`, which held the case on draft PR #462 at the time of writing. No
  historical section is rewritten for it.

`ADR-0769` and `ADR-0770` were renumbered to `ADR-0780` and `ADR-0781` by the lane repair (PR #444); the live references in the header and §Alternatives considered were re-pointed to those files by the docs card `t_ea46ae99`, so every link in this record now resolves. The F2 finding text above and this note keep the old numbers as history, and the `Lane` line keeps the cell this record was minted against.
