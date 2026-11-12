# ADR-0782 — OP-129 attendee-session edges: the `eventSlug` binding, cookie-vs-header precedence, and a user on `current`

- **Status:** Accepted · **Date:** 2026-11-12
- **Card:** OP-129 round-1 review follow-up TEST (`t_a377ab74`) · **Branch:** `OP-129-task-attendee-session-edge-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_a377ab74`
- **Relates to:** [ADR-0769](ADR-0769-op129-anonymous-attendee-sessions-red.md) (the RED contract), [ADR-0770](ADR-0770-op129-anonymous-attendee-sessions-green.md) (the GREEN whose `eventIdsFor()` / `eventSlugsFor()` / resolver are pinned here), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation), ADR-0780/ADR-0781 (the same two records after the ledger repair)
- **Contract:** §1.5 (`POST /p/attendee-sessions`, `GET /p/attendee-sessions/current`) · §0.2 (`attendee` label, cookie **or** header) · **Schema:** §13.5, §15.1

## Context

The round-1 artifact review of the OP-129 GREEN (`t_d0f1944d`, PR #446, reviewed head `675d7dd`,
folded into `OP-129-task-anonymous-attendee-sessions-red-fix` as `2793f02`) returned
**APPROVED WITH FINDINGS**. Five findings; this card carries F2, F3, F4 and F5 — every one of
them a behaviour the shipped code already has (or, for F3/F4, a behaviour the shipped code gets
**wrong**) with no spec observing it:

- **F2** — the whole `eventSlug` path was unpinned: `eventIdsFor()` reads `events.accessLinks[].slug`,
  answers `404 not_found` for a slug that matches nothing, and `current`'s `eventSlugsFor()` projects
  `eventIds` back to the slugs. No case seeded an event, so a refactor could drop the binding, drop
  the 404, or **insert the session row before validating the slug** and the suite stayed green.
- **F3** — `createAttendeeSessionResolver()` is injected by `…/attendee-sessions/current/route.ts`
  only. Every other `attendee`-labelled route reaches the guard through
  `requireAuth("attendee", { auth, database })` with no `attendeeResolver`, so it falls back to the
  OP-86 `noAttendeeSessions` stub, resolves `null` and answers `401 authentication_required` to a
  real attendee. Fails closed, so it is not a security hole — it is a broken label.
- **F4** — `attendeeTokenFrom()` returns the cookie first (`cookieToken(request) ?? header`), so a
  **stale** `op_att` cookie shadows a valid `X-Attendee-Session` header, although §0.2 says cookie
  **or** header.
- **F5** — the `attendee` label admits a **user** principal (`evaluateAuth`), and `current` then
  answers `401 authentication_required` because §1.5 defines only the anonymous body. ADR-0770 §4
  records the behaviour; nothing pinned it.

This card is **test-only**: two specs extended, no production file, no fixture, no existing case
changed. F2 and F5 are **characterization pins** (green on `2793f02`). F3 and F4 are **RED by
design** — the review comment on the card corrected the original body, which had described F4 as a
characterization: the contract owner's stated intent is the fall-through, so the pins state the
intended answer and the gated GREEN (`t_a909e641`) satisfies them.

## Decisions

### 1. F2 — three pins, and the no-write half is the one that matters

`apps/web/src/test/integration/attendee-sessions.test.ts` gains a seeded `events` row
(`seedEventWithSlug()`, one active `accessLinks[0]` entry, schema §15.1) and three cases:

1. **binding** — `POST { eventSlug }` → `201`, the stored row's `eventIds` is **exactly**
   `[event._id]` (read through the existing `tokenHash` scanner, not a named collection), and
   `GET .../current` with the same token answers `eventSlugs: [slug]`, `kind: "anonymous"`.
2. **unknown slug** — `POST { eventSlug: "op129edge-no-such-event" }` → `404` `not_found` **and**
   zero new rows. The assertion is a new collection-agnostic helper, `sessionRowTags()`, which
   scans **every** collection for documents carrying a `tokenHash` and compares the sorted
   `collection:hash` list before and after the request. A status-only pin cannot see the defect the
   card names: a refactor that inserts the row first and validates the slug second answers `404`
   all the same while leaving a bearer credential's row behind. Mutation evidence in §Evidence.
3. **a different event** — two events seeded; the session binds only the one whose slug was sent,
   and `current` projects only that slug (`not.toContain` the other one, so a "first event wins"
   query is named in the failure).

The `eventSlug`-absent case (`eventIds: []`) stays where it already was — I1's exact-key pin.

### 2. F3 — the guard's **default** must authenticate a real attendee (RED by design)

`apps/web/src/test/integration/auth-guards.test.ts` had **zero** attendee cases. A new final
`describe("attendee label (§0.3, §1.5)")` boots its own app (`startTestApp({prefix:
"op129-attendee-guard"})`) and seeds rows **through the shipped POST route** — no case invents a
document shape. The separate app is not a preference: the POST route reads the process `getDb()`
singleton, so the database the route writes and the `database` handed to the guard must be the same
handle, which is exactly what `startTestApp` binds. That also rebinds the process environment and the
Mongo client, so the block must stay **last** in the file; every earlier spec uses its own
`withHarness` database.

Four cases, all against `requireAuth("attendee", { auth, database })` / `resolvePrincipal(...)` with
**no** `attendeeResolver`:

- a real `op_att` cookie resolves to `{ kind: "attendee", sessionId: <row id>, eventId: null }`
  (RED: the stub resolves `null`);
- `requireAuth` then **admits** the request — the guard route answers `200` (RED);
- a **lapsed** row is `401 attendee_session_expired` with `details.recreateUrl` (RED today, and the
  case that stops a GREEN from wiring a raw `findOne` that forgets expiry);
- a cookie matching **no** row is still `401 authentication_required` (green today and after: the
  default must not become a blanket admission).

### 3. F4 — the fall-through is pinned RED, the lapsed answer is pinned green beside it

Two cases in the same new `describe` in `attendee-sessions.test.ts`:

- `cookie: op_att=opat_never-issued-000` **and** a valid `X-Attendee-Session` → **`200`** with that
  session's body (id, `kind`, `expiresAt`, and no raw token). RED on `2793f02` — the cookie is read
  first and `401 authentication_required` wins. If the contract owner instead keeps cookie-first
  precedence, the flip is contained in this one case: `200` → `401` plus a code assertion; the
  doc-comment on the case spells that out.
- a **lapsed** cookie plus a **valid** header → `401 attendee_session_expired` with
  `details.recreateUrl`, never a header retry. Green today and it must stay green: it is the guard
  against "fixing" F4 by swallowing the expiry throw and retrying.

### 4. F5 — a signed-in user is admissible, and the 401 comes from the handler

`GET .../current` with a real Better Auth session cookie (the `startTestApp` sign-in fixture, no
attendee token) answers `401 authentication_required`. That status alone cannot tell "the guard
admitted the user and the handler had nothing to project" from "the guard refused the user" — both
are the same envelope. So the case also captures the log with `memoryTransport()` and asserts **no**
`auth.denied` record for the request, plus that the sink observed the request at all (so the
absence is not vacuous). Mutation evidence in §Evidence: making `evaluateAuth` refuse a user on the
`attendee` label leaves the status and code untouched and reddens this case only.

## Open questions

- **F4 precedence.** §0.2 says cookie **or** header; the shipped resolver treats a _present but
  unknown_ cookie as final. This card pins the fall-through as intended; if the contract owner
  decides a stale cookie must win (so a client can distinguish "your cookie is dead" from "you sent
  nothing"), only the one case flips and the lapsed-cookie companion already covers the expired
  branch. `t_a909e641` is the GREEN for the fall-through.
- **F5 user projection.** §1.5 defines no body for a signed-in user on `current`. The shipped answer
  (`401 authentication_required`) is pinned; giving users a projection is a contract change that
  owes its own ADR and would flip that case to `200` with a user body.
- **F3 default resolver scope.** The pins state only that the label's default must resolve real
  rows from the `database` it is given, keeping the shipped expiry semantics. Whether the GREEN
  builds the resolver inside `requireAuth`, in a shared `getAttendeeSessionResolver()` composition
  root, or by widening the OP-86 port is deliberately not pinned.
- **`eventSlug` shape left alone.** Whether a slug on a _revoked_ or _inactive_ `accessLinks`
  entry binds (the shipped query ignores `active`/`revokedAt`) is not pinned here — contract §1.5
  does not say, and inventing an answer would be a contract change, not a pin.

## Alternatives considered

- **Put the F3 cases in `attendee-sessions.test.ts`** (which already boots the same app). Rejected:
  the behaviour is the **guard's**, and `auth-guards.test.ts` is where every other label's
  admission rule lives; a guard pin that lives in a route suite is found by the wrong reader. The
  cost is one extra app boot in that file, contained in a final block.
- **Seed the F3 row directly into `attendeeSessions`** instead of through POST. Rejected: a
  hand-written row proves only that the resolver's query matches a shape the test invented. The
  POST route is the shipped writer, so the seeded row is the one the product mints.
- **Pin F2's 404 with a status assertion only.** Rejected — see §1.2: the insert-before-validate
  defect is invisible to a status assertion, and that is precisely the refactor the card names.
- **Pin F5 by status/code only.** Rejected: identical to a guard refusal, so the case would pass on
  a regression that stops admitting users to the `attendee` label.
- **Pin F4's expired-cookie case with `toEqual({recreateUrl: "/p"})`.** Rejected: the value is
  ADR-0770's and already pinned by I4 as a leading-slash string; repeating the literal here would
  freeze a second copy of the same decision.

## Consequences

- **No production change.** Both mutation probes are throwaway; the touched modules were restored
  and re-hashed (`sha256` equal before and after, §Evidence).
- `attendee-sessions.test.ts` grows from 12 to **18** cases (5 new characterisation/RED pins plus
  one companion); `auth-guards.test.ts` grows from 13 to **17** (4 new). Every pre-existing case is
  unchanged — including I1's exact key set, I4's inclusive-clock pair and I5's two scans.
- The suite now seeds `events` rows, so a future `events` schema change (a new required field)
  shows up here as well as in the event suites — an intentional trade for pinning the binding
  through a real collection.
- F3's block relies on `startTestApp` rebinding the process singletons, so **new** cases must be
  added _inside_ that block (or before it), never between it and the file's end.
- ADR-0770 §4's statement "a signed-in user gets `401 authentication_required`" is now executable
  and its open half (user projection) is recorded above rather than implied.

## Evidence

Commands run in `/root/openpic/openpic-webapp/.worktrees/t_a377ab74` on branch
`OP-129-task-attendee-session-edge-pins`, based on
`origin/OP-129-task-anonymous-attendee-sessions-red-fix` `2793f02` (`origin/main` `ced39b6` does not
carry `apps/web/src/server/attendee/session-token.ts` yet, so the pins stack on the lane branch).

| Check                                                                          | Result                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx tsc -p apps/web/tsconfig.json --noEmit`                                   | exit `0`                                                                                                                                                                                                             |
| `vitest run --project integration …/attendee-sessions.test.ts`                 | **17 passed / 1 failed (18)** — the only failure is the intended F4 pin: `expected 401 to be 200`                                                                                                                    |
| `vitest run --project integration …/auth-guards.test.ts`                       | **14 passed / 3 failed (17)** — the three intended F3 reds: `expected null to match object { kind: 'attendee', … }`, `expected 401 to be 200`, `expected 'authentication_required' to be 'attendee_session_expired'` |
| mutation A: `eventIdsFor()` inserts a row before `throw appError("not_found")` | **1 failed** — `F2: a slug that matches no event is 404 not_found and writes no session row`, `expected [ Array(1) ] to deeply equal []` → `["attendeeSessions:mutant-insert-before-validate"]`                      |
| mutation B: `evaluateAuth` refuses a user on the `attendee` label              | **1 failed** — `F5: a signed-in user is admitted by the label and answered 401 authentication_required`, the captured `auth.denied` record listed                                                                    |
| the two mutated modules after each probe                                       | restored byte-identically (`sha256` `11624ba6…cd00` and `97212f51…1c32` before and after)                                                                                                                            |
| `vitest run --project unit` (full)                                             | **149 files / 2390 passed, 3 skipped** — unchanged: no unit file is touched                                                                                                                                          |
| `vitest run --project integration` (full)                                      | **99 files / 930 tests — 926 passed / 4 failed**, and the four are exactly the intended pins (1 × F4, 3 × F3); the base `2793f02` is 920 passing, so the change adds **10** cases and no pre-existing case moved     |
| `npx eslint` on both touched specs                                             | 0 errors, 1 **pre-existing** `security/detect-object-injection` warning (`requireHandler`, present on the base at line 189)                                                                                          |
| `npx prettier --check` (both specs, this ADR, `docs/adr/README.md`)            | clean                                                                                                                                                                                                                |
| `vitest run --project unit …/adr-numbering.test.ts`                            | **29 passed (29)**                                                                                                                                                                                                   |

## Number allocation

The OP-129 lane's `Next free` cell read `0771` at cut time, but the lane row is **being repaired**
(ledger finding F-L1, card `t_95e7ed1e`): `ADR-0769` → **`0780`**, `ADR-0770` → **`0781`**, the row
re-pointed to `0780`–`0798` with `Next free = 0782` ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md)
§10 supersedes the "a dependent ticket does not continue its parent's range" clause the OP-129 note
relied on). Because `0769`/`0770` sit inside the OP-126 uploads lane's `0760`–`0779`, and because the
repair's cell already names `0782` as the next free, this record takes **`0782`** — the next free
above the repaired block's two consumed numbers — and advances the cell to `0783`. No number outside
the lane's repaired range is touched, and the repair's hunk on the cell line (`0782`) and this one
(`0783`) merge as a union keeping the higher value.
