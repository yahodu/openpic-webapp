# ADR-0783 — OP-129 GREEN: the attendee resolver as the guard's default, and the cookie→header fall-through

- **Status:** Accepted (implementation of the ADR-0782 pins)
- **Card:** OP-129 round-1 review follow-up GREEN (`t_a909e641`) · **Branch:** `OP-129-task-attendee-session-resolver-default` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_a909e641`
- **Consumers:** `@/server/auth/guards`, `@/server/attendee/session-resolver`, `@/api/v1/p/attendee-sessions/current`
- **Lane:** OP-129 (epic Attendee Identity). Reserved range `0769`–`0788`, `Next free = 0783` → this record takes `0783`, cell advances to `0784`.
- **Relates to:** [ADR-0769](ADR-0769-op129-anonymous-attendee-sessions-red.md) (the RED contract), [ADR-0770](ADR-0770-op129-anonymous-attendee-sessions-green.md) (the resolver this record re-wires), [ADR-0782](ADR-0782-op129-attendee-session-edge-pins.md) (the pins F3/F4 that demanded both changes)
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
  F3/F4; ADR-0770 §3 already records the re-read as the cheaper trade.

## Evidence

- F3: `auth-guards.test.ts` 17/17 (the four pins — principal, admission, lapsed expiry, unknown
  token refusal). F4: `attendee-sessions.test.ts` 18/18 (fall-through plus the lapsed-cookie
  companion).
- Full suite counts and gates are recorded in the card handoff.
