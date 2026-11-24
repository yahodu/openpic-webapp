# ADR-0288 — OP-101 TEST: the tenant-member residuals the stale PR #272 carried get fresh pins — the listing's total order, the two mutation audit entries, the dangling joins, the malformed target id and the anchor-less path

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** OP-101 TEST `t_788e4b9a` (openpic-webapp-testcase-writer) · **Parent:** the open-PR sweep `t_319a105a`, which closed PR [#272](https://github.com/yahodu/openpic-webapp/pull/272) (`OP-101-task-tenant-members-green-restore`, base `67feedeb`, 2026-10-24) unmerged under [ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md)
- **Branch:** `OP-101-task-tenant-members-residual-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op101-residual-pins`
- **Base:** `origin/main` `b8c0f1c6` (the card was reconciled against `2d2f2530`; the branch was rebased onto the trunk head before this record was written)
- **Spec sources:** API contract §2.2 (tenant members — the `Member` DTO, the owner-only mutations, the `joinedAt` order), §0.4 (tenancy in URLs, the uniform `404`), §0.13 (masked contact), §0.15 (never-return rules), Appendix A.5 (`cannot_demote_owner`, `409`); schema §13.1 (`user`), §13.2 (`userProfiles`), §13.4 (`tenantMembers`)
- **Relates to:** [ADR-0280](ADR-0280-op101-tenant-members-red.md) (§D3 — the owner protection is `cannot_demote_owner` on both verbs), [ADR-0281](ADR-0281-op101-tenant-members-green.md) (the shipped surface), [ADR-0283](ADR-0283-op101-tenant-members-defensive-restore.md) (the §D2 "one corrupt row never denies the listing" policy these dangling-join pins extend), [ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md) (§Consequences — an absent assertion gets a fresh pin, never a merge of the stale branch), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Consumers:** `apps/web/src/test/integration/tenant-members.test.ts`

## Context

The sweep that closed PR #272 proved, by the ADR-0304 §Decision-3 test-inventory
check, that the branch's **production** intent reached the trunk through other
PRs and that the branch must not be merged. It also proved that six clusters the
branch carried are **genuinely absent from `main`**: five assertion clusters, and
one production difference that is still live.

Measured at the base `b8c0f1c6` (and at the card's reconciliation trunk
`2d2f2530`, which differs only in docs):

- `apps/web/src/server/tenancy/members.ts:167` sorts the listing by
  `.sort((left, right) => left.joinedAt.localeCompare(right.joinedAt))` — one key,
  no tie-break. PR #272's `d5be9af4` carried
  `.localeCompare(...) || left.userId.localeCompare(right.userId)`. `Array#sort`
  is stable, so two memberships sharing an instant come back in whatever order
  the storage read produced.
- `apps/web/src/app/api/v1/tenants/[tenantId]/members/[userId]/route.ts:107` and
  `:133` emit `member.role_changed` and `member.removed`. `grep` over the whole
  test tree finds **no** case asserting either event: the emitters exist and
  nothing watches them.
- `projectMember` reads `maskEmail(user?.email ?? "")` and
  `profile?.displayName ?? ""` (`members.ts:117-118`), so a membership whose
  `user` or `userProfiles` document is gone degrades instead of throwing — and no
  case seeds that state.
- `targetUserIdFromRequest` validates `{userId}` against
  `^[0-9a-f]{24}$/i` and throws `appError("not_found")` (`route.ts:36`, `:48`), so
  a malformed id is a `404` rather than a `500` from `new ObjectId()` — unpinned on
  either verb.
- `tenantIdFromRequest` returns
  `segments[segments.indexOf("tenants") + 1] ?? ""` (`route-stage.ts:118-121`).
  For a path with **no** `tenants` anchor, `indexOf` is `-1`, so the function
  returns `segments[0]` (`"api"`), not the `""` its own doc comment claims. The
  stage denies either way, so the observable is the same; the comment is not.

## Decision

### D1 — six clusters, ten appended cases, one new `describe`

All pins land in `apps/web/src/test/integration/tenant-members.test.ts`, in one
appended `describe` block. Nothing shipped is edited: the 30 existing cases, every
helper, every fixture and every constant above the block are byte-identical. The
file's import list gains the logger port's names (`createLogger`, `getLogger`,
`memoryTransport`, `setLogger` and three types) and `afterEach` — an additive
import edit, no assertion touched.

### D2 — R1 is the only RED, and it declines to depend on the storage read order

The order case seeds four memberships in one workspace: the owner, one member at
an earlier instant, and a **tie pair** at the same instant. The three
non-owner ids are fixed hex (`…ff00`, `…ff01`, `…0001`) rather than
`new ObjectId()`, and they are chosen so that **both** halves of the rule bite:

| Row      | `joinedAt`            | `userId`           | Expected position |
| -------- | --------------------- | ------------------ | ----------------- |
| earliest | `2026-01-01`          | `…ff00` (largest)  | 1st               |
| tie      | `2026-02-02`          | `…0001` (smallest) | 2nd               |
| tie      | `2026-02-02`          | `…ff01`            | 3rd               |
| owner    | `2026-03-03` (latest) | random             | 4th               |

A `userId`-only sort would answer `[…]0001, …ff00, …ff01]`; a `joinedAt`-only sort
over the storage read order answers `[…ff01, …0001]` for the tie pair, because the
pair is **inserted in descending id order**. Only `joinedAt` ascending with ties
broken by ascending `userId` produces the expected list, so the case discriminates
whether or not the driver's natural order is insertion order — and it is: measured
on the base, the received order is `[…ff00, …ff01, …0001, owner]`, i.e. the tie
pair exactly swapped.

The fixed ids name memberships whose `user`/`userProfiles` documents do not exist.
That is deliberate and it is not a hidden assumption: R3 and R4 pin that a
dangling join leaves the row listed, so the fixture rests on a behaviour this pack
states rather than on an accident.

### D3 — R2 pins the two audit emits and both refusal arms

Four cases, using the `memoryTransport()` + `setLogger()` seam the tree already
uses (`event-invitation-decisions.test.ts:1892`, `attendee-sessions.test.ts:907`):
the sink is installed **after** the fixture is seeded, so sign-in and provisioning
lines cannot satisfy a pin, and it is restored in an `afterEach` because
`@/server/logging` has no `resetLogger`.

- a successful `PATCH` emits exactly one `member.role_changed` carrying
  `tenantId`, `userId` and the **new** `role`, and no `member.removed`;
- a successful `DELETE` emits exactly one `member.removed` carrying `tenantId` and
  `userId`, and no `member.role_changed`;
- a refused non-owner (`403` on both verbs) emits neither;
- a refused owner removal (`409`) emits no `member.removed`.

The two positive cases are the control that stops the two absence cases being
vacuous: they prove the sink does receive these events on the happy path.

### D4 — R3/R4 pin the degraded projection, not the mechanism

A membership whose `user` document is deleted stays listed with
`emailMasked === "•••"` (what `maskEmail("")` returns: the fixed three-bullet
run) and its profile's `displayName` intact; a membership whose `userProfiles`
document is deleted stays listed with `displayName === ""` and its contact
masked as `m•••@example.com`. Both cases assert the full `Member` key set, so a
projection that dropped a field to "handle" the missing join also reds. Neither
asserts **how** the degradation happens — a `??` default, a `try`, or a
pre-filtered read all pass.

### D5 — R5 pins the observable, on both verbs

`PATCH` with `{userId}` = `not-an-object-id` and `DELETE` with a 23-hex id both
answer `404 not_found`. The 23-hex arm is the load-bearing one: it satisfies a
lookup by length alone, so only the shape check stands between it and a `500`
from `new ObjectId()`.

### D6 — R6 pins the `404`, and reports the doc/code mismatch instead of pinning it

`GET /api/v1/tenants/{tenantId}/members` invoked on the anchor-less path
`/api/v1/members` answers `404 not_found`, echoes **no** `X-Tenant-Id`, and logs
exactly one `tenancy.access_denied` at `warn`. The case deliberately does **not**
assert what `tenantIdFromRequest` returns, so either repair of the comment — or of
the code — keeps it green.

### D7 — scope: test-only, additive, and the trunk is unchanged

Two files plus this record and its ledger row. No production file, schema,
route, fixture or helper changes. `apps/web/src/server/tenancy/members.ts`
(`sha256 07debc66…`) and the `[userId]` route (`sha256 7d565c0f…`) hash
identically before and after every probe below.

## Evidence

`0288` is the OP-101 lane's `Next free` cell in `docs/adr/README.md`, re-read on a
fresh `origin/main` `b8c0f1c6` immediately before writing this record; the lane
range is `0280`–`0299` ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md))
and `0280`–`0287` were already consumed. The number is free across every ref: no
`.worktrees/*/docs/adr/ADR-0288*` path exists, and `gh pr list --state open`
returns `[]`. This record advances the cell to `0289`.

| Spec                                                   | Base `b8c0f1c6`  | After these pins             |
| ------------------------------------------------------ | ---------------- | ---------------------------- |
| `apps/web/src/test/integration/tenant-members.test.ts` | `30 passed` (30) | `39 passed \| 1 failed` (40) |

### The one red, verbatim

```text
FAIL  |integration| apps/web/src/test/integration/tenant-members.test.ts > OP-101
tenant-member residuals (ADR-0304 fresh pins, ADR-0288) > GET
/api/v1/tenants/{tenantId}/members — the total order > orders by joinedAt
ascending and breaks an equal instant by ascending userId
AssertionError: expected [ 'ffffffffffffffffffffff00', …(3) ] to deeply equal [ 'ffffffffffffffffffffff00', …(3) ]

- Expected
+ Received

  [
    "ffffffffffffffffffffff00",
-   "000000000000000000000001",
    "ffffffffffffffffffffff01",
+   "000000000000000000000001",
    "6b055aa846c30f11676631a2",
  ]
```

The failure is exactly the tie pair: the earliest row and the owner's last position
are already right, so the red names the missing tie-break and nothing else. The
case is expected RED at the trunk (D2), and the GREEN is the one-line
`.localeCompare(...) || left.userId.localeCompare(right.userId)` shape that
PR #272's `d5be9af4` carried.

### Discrimination of the green pins

Three mutations of the production files, each reverted before the next; the two
`sha256` values above are identical before and after all three.

| Mutation                                                             | Spec                                                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| add the `d5be9af4` tie-break to `listWorkspaceMembers`               | `40 passed` (40) — **R1 alone goes green**                  |
| rename both emitted events (`member.role_changed`, `member.removed`) | `3 failed \| 37 passed` — R1 plus both positive audit cases |
| disable the `OBJECT_ID_HEX` guard                                    | `3 failed \| 37 passed` — R1 plus both malformed-id cases   |

The first row is the important one: with the tie-break present **every** pin in
this pack passes, so the other nine cases are green on arrival by design (D3–D6)
and the red is the production difference alone.

`tsc -p apps/web/tsconfig.json --noEmit` exits `0` and `eslint` reports
`errorCount: 0` on the spec.

### CI on the delivered head

PR [#866](https://github.com/yahodu/openpic-webapp/pull/866), head `37c50b62`,
draft by design:

| Check                                                                                                                                                | Result                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `lint`, `unit_test`, `audit`, `audit-dev`, `CodeQL`, `secret-scan`, `env-changes`, `validate-branch-name`, `validate-pr-title`, `Assert CI evidence` | pass                                |
| `ci` (integration project)                                                                                                                           | **fail — by design**                |
| `test_coverage`                                                                                                                                      | fail — the same integration failure |

The integration job's whole-project result is `1 failed \| 1765 passed (1766)`,
and the single red is this pack's R1 — the case titled
"orders by joinedAt ascending and breaks an equal instant by ascending userId" —
with the assertion printed in §"The one red, verbatim". No other case in the
1 766 fails, so the nine green pins hold in a full-project run and the red is not
masking a second defect.

## Consequences

- **The ordering tie-break is now a failing pin, not a note.** A GREEN that sorts
  by `joinedAt` alone reds R1 with the two ids printed in the wrong order; a
  refactor that keeps the tie-break cannot break it by accident, because the case
  controls both ids and both instants.
- **The two audit emits stop being untested.** Renaming or dropping either event
  reds exactly the case that names it (measured above), and the two refusal arms
  now say that a refusal writes no audit line.
- **A dangling join is a contract, not an accident.** Dropping a member whose
  `user` or `userProfiles` row is gone — or answering `5xx` for it — now breaks a
  named case.
- **Cost.** Ten cases in one file; the file ran `8.4 s` on the final head against
  `13.0 s` at the base — wall-clock noise between reads, both inside the
  `integration` project's 30 s per-case budget.
- **No production change is implied by nine of the ten cases.** Only R1 asks the
  trunk to change, and it is the `d5be9af4` line the card names.

## Findings (not pinned, routed to the record)

- **F1 — the card's error code is the wrong lane's.** The card asks for
  `409 cannot_remove_organizer`. That code is the **OP-121 event-member** code
  (`COLLABORATION_ERROR_CODES`, contract §7.x, `packages/contracts/src/errors.ts:342`);
  this surface's owner protection is `409 cannot_demote_owner`, the only
  owner-protection code in Appendix A.5 (ADR-0280 §D3). The case pins the
  observable the trunk actually answers, and its comment says why.
- **F2 — `tenantIdFromRequest`'s doc comment contradicts its code.** The comment
  (route-stage.ts:107-117) says an anchor-less path yields `""`; the code yields
  `segments[0]` (`"api"`). Only a string that fails the id-shape check is
  returned, so no caller misbehaves today — but the sentence is wrong and would
  mislead the next reader who trusts it. Not pinned, per D6.
- **F3 — `member.role_changed` / `member.removed` are not in the logged-event
  catalogue** that the structured-logging docs enumerate. The emitters are real
  and now pinned; whether they belong in the catalogue is a docs decision, not a
  test decision.

## Alternatives considered

- **Merge the stale branch to recover its cases** — rejected by
  [ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md) §Decision: the branch is
  not merged and its cases are re-authored against the trunk.
- **Seed the tie pair with real sign-ins** — rejected: `new ObjectId()` ids are
  random, so the case could not tell a `joinedAt`-then-`userId` sort from a
  `userId`-only one (D2).
- **Compute the expected order in the test** (`rows.sort(...)`) — rejected: that
  mirrors the implementation and would pass whatever the implementation does.
- **Assert the logger's message text** (`"member role changed"`) — rejected: the
  message is prose; the `event` field is the contract.
- **Pin `tenantIdFromRequest("")` directly** — rejected per D6: the observable is
  the `404`, and pinning an internal return value would freeze the defect F2
  describes.
- **Put the audit cases in a new spec file** — rejected: the harness the file
  already owns (one `beforeAll` `startTestApp`, one seeded workspace per case) is
  exactly what the pins need, and a new file would pay a second cold Mongo
  connect.

## ADR number allocation

`0288` is the OP-101 lane's `Next free` cell value in `docs/adr/README.md`, read
on a fresh `origin/main` `b8c0f1c6` immediately before committing. The lane range
is `0280`–`0299`; `0280`–`0287` are the tenant-members RED/GREEN pair, the
defensive-restore pins and its GREEN, and the numeric/string/`Date` instant-range
pins. This record advances the cell to `0289`. No number outside the lane range is
touched.
