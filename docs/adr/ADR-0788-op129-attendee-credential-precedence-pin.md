# ADR-0788 — OP-129 pin: a valid `op_att` cookie outranks a valid `X-Attendee-Session` header

- **Status:** Accepted (characterization pin; **no production change**, no new contract)
- **Card:** OP-129 round-1 review follow-up TEST — finding F3 (`t_296d24bd`) · **Branch:** `OP-129-task-attendee-credentials-precedence-pin` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_a909e641`
- **Consumers:** `apps/web/src/test/integration/attendee-sessions.test.ts` only
- **Lane:** OP-129 (epic Attendee Identity). Reserved range `0780`–`0798` (re-cut from the lane's first pool draw, which overlapped the OP-126 uploads lane; recorded in `docs/adr/README.md`); the base's cell read `Next free = 0784` (stale), the sweep found `0782` (edge pins), `0783` (resolver default), `0784`/`0785` (OP-130 public-event lane), `0786` (rate-limit GREEN) and `0787` (rate-limit record, renumbered in flight by `t_f4da0ad2`) already taken — this record takes `0788`, the cell advances to `0789`, and `0789`–`0798` remain free for this lane.
- **Relates to:** [ADR-0770](ADR-0770-op129-anonymous-attendee-sessions-green.md) (the resolver), [ADR-0782](ADR-0782-op129-attendee-session-edge-pins.md) (the F4 fall-through pins), [ADR-0783](ADR-0783-op129-attendee-resolver-default.md) (decides the cookie-first order this record pins)
- **Contract:** §0.2 (`attendee` label — cookie **or** header) · §1.5 (`GET /p/attendee-sessions/current`) · §0.15 (a raw token is returned by its issuance only)

## Context

ADR-0783 §2 made `findRequestAttendeeSession` fall through from an **unknown** cookie to the
`X-Attendee-Session` header. That change turned the **order** of the two credentials into load-bearing
behaviour, and nothing observed it. The four neighbouring cases are all blind to the order:

| Case                       | Why it cannot discriminate the order                       |
| -------------------------- | ---------------------------------------------------------- |
| `I2` cookie-only           | one credential presented                                   |
| `I3` header-only           | one credential presented                                   |
| `F4` stale cookie → header | the cookie must match **no** row for the header to be read |
| `F4` lapsed cookie → `401` | answered before the header is read                         |

An implementation that preferred the header **when both tokens name live rows** therefore passed every
one of them. That is the gap this record closes.

## Decision

One characterisation case, `F3: a valid op_att cookie wins over a valid X-Attendee-Session header`, in
the existing `describe("GET /api/v1/p/attendee-sessions/current — cookie vs header precedence (§0.2)")`
block. It seeds **two distinct** sessions with the file's `createdSession()` helper, asserts their stored
`_id`s differ (a fixture guard: one row would make "the cookie's id" meaningless), then sends both
credentials on one request:

```ts
{ cookie: `op_att=${a.sessionToken}`, "x-attendee-session": b.sessionToken }
```

and asserts `200`, `id` = **A's** stored `_id`, `kind: "anonymous"`, `expiresAt` = A's, and that
**neither** raw token appears in the body.

This states no new contract. ADR-0783 §2 already fixes cookie-first precedence; §0.2 spells the
credentials in that order. The record documents only the pin upgrade and the mutation that proves it
bites.

Rejected alternatives:

- **Assert the status only.** Both an `A` answer and a `B` answer are `200`; a status-only pin is
  satisfied by the very implementation it is meant to catch.
- **Also assert `eventSlugs`.** It would need two seeded events and would pin the projection that
  `F2` already covers, widening a one-behaviour case.
- **Age one session so only the cookie could match.** That collapses into the stale-cookie case and
  stops testing precedence between two _valid_ credentials.
- **Send two cookies or two headers.** Defines no precedence question the contract asks.

## Evidence

- Shipped code (`e9eceef`): the file is **19 passed (19)** including the new case — the pin is a
  characterisation, it **passes on first run**, so no GREEN sibling is needed.
- Mutation probe in a throwaway worktree of this head (`git worktree add --detach`, `node_modules`
  symlinked from the lane worktree, `TMPDIR=/root/tmp-mongo`): `findRequestAttendeeSession` changed to
  prefer the header **when both credentials name live rows** (the cookie is still evaluated first, so
  the lapsed-cookie `401` is preserved) produced **1 failed | 18 passed (19)** — exactly this case,
  failing at `AssertionError: expected '6af583ffdc505803dde05b52' to be '6af583ffdc505803dde05b51'`
  (B's id where A's was required). The other 18 cases stayed green, which is the proof that only this
  case discriminates the order.
- The probe's `session-resolver.ts` was restored byte-identically
  (`sha256 0acdd15e…dad83e`, equal to the lane worktree's untouched file) and the worktree removed with
  `git worktree remove --force`; the lane worktree never held a production edit (`git status` shows the
  spec file only).
- The file's other 18 cases are unchanged (byte-identical) — the new case is appended inside the
  existing block, not woven into it.

## Consequences

- A future refactor that reverses the credential order, or that reorders `attendeeTokenFrom`, now
  breaks one named case with a self-explaining message instead of silently changing which session a
  browser reports.
- This record is the highest **consumed** number in the lane's reserved range `0780`–`0798`, so the
  lane's cell now reads `0789` and **`0789`–`0798` remain free for OP-129**. ADR-0300 §10 makes a
  reserved range exclusive **including its unconsumed gaps**, so the next OP-129 card continues this
  range and must **not** draw a fresh block from the allocator's `unallocated (future lanes)` pool
  (whose head `0799`+ belongs to lanes that own no range); the merge of this branch and the in-flight
  `t_f4da0ad2` repair reconciles the cell as a union keeping the highest value (`0789`).
- `docs/adr/README.md` remains the shared-ledger hotspot: the lane row, the cell and the pool row merge
  as a union keeping the highest value.
