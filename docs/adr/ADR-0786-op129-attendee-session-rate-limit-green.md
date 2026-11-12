# ADR-0786 — OP-129 follow-up: the `attendee.session` limit is enforced on the create route

- **Status:** Accepted (implementation of [ADR-0787](ADR-0787-op129-attendee-session-rate-limit-pin.md))
- **Consumers:** `apps/web/src/app/api/v1/p/attendee-sessions/route.ts`,
  `apps/web/src/server/rate-limit/classes.ts`; pinned by
  `apps/web/src/server/rate-limit/classes.test.ts` and
  `apps/web/src/test/integration/attendee-sessions.test.ts`
- **Lane:** OP-129 (epic Attendee Identity). Reserved range `0780`–`0798`; see
  §Number allocation — this record takes `0786`, not the cell's `0783`.
- **Supersedes:** nothing. **Amends:** ADR-0787 §3–§4 (it declared the change; this
  record makes it).

## Context

ADR-0787 pinned the class and the stage but touched no production file, so
`POST /api/v1/p/attendee-sessions` still answered an unlimited number of `201`s: one
30-day `attendeeSessions` row per call, each a bearer credential to someone's photos.
Round-1 review finding **F1 (High)**.

## Decision

### 1. The class table gains one row, and one policy entry

`apps/web/src/server/rate-limit/classes.ts`:

```
"attendee.session": [{ scope: "ip", limit: 60, windowSeconds: 3600 }]
```

added to the `RateLimitClass` union, `RATE_LIMIT_CLASSES` and `FAIL_CLOSED_CLASSES`.
`classes.test.ts` pins the three literally, so the row, the union member and the
policy entry are one change and cannot drift.

### 2. The stage is declared on the route, and nothing else in the route moves

`apps/web/src/app/api/v1/p/attendee-sessions/route.ts` gains, on its existing
`defineRoute` options:

```ts
rateLimit: rateLimitStage({
  classKey: "attendee.session",
  limiter: createRateLimiter(),
  salt: getRateLimitConfig().salt,
}),
```

the `plans` route's shape. `createRateLimiter()` stays the **memoised** accessor,
because the fail-closed pin rejects on `createRateLimiter().limit` and a per-request
limiter would make the `503` case unreachable. The token, the TTL read, the
`eventSlug` binding and the `201` body are byte-identical.

### 3. The IP comes from the shared stage, so the trust model is unchanged

No route-local `resolveClientIp` call was added. `rateLimitStage` already derives its
facts through `resolveClientIp(request.headers, getTrustedClientIpHeader())`
(`rate-limit/stage.ts:108`) — the same pair the route's `deviceFingerprint()` uses
(ADR-0024). A forged `x-forwarded-for` therefore cannot pick a bucket where
`TRUSTED_CLIENT_IP_HEADER` is set, and the dev/e2e first-hop fallback is untouched.
Re-plumbing the IP into a `facts` option would have added a second resolver for no
behavioural change.

### 4. A `201` carries `RateLimit-*` — intended

The shared stage returns its headers on success, so the create response now carries
`RateLimit-Limit: 60`, `RateLimit-Remaining: <n>` and `RateLimit-Reset`. Accepted
(ADR-0787 §4): the headers describe the caller's window, not the response, every
other stage-consuming route behaves the same way, and the integration pin asserts
them (`RateLimit-Remaining: 59` on a fresh IP's first `201`). A `429` adds
`Retry-After`, mints no row and sets no cookie; `503` does the same under
fail-closed.

## Consequences

- An IP is limited to 60 creates per rolling hour; the 61st is
  `429 rate_limited` with `Retry-After` and no session row.
- An unavailable limiter answers `503 service_unavailable` for this class instead of
  minting a session — a limiter outage costs availability, never an unbounded mint.
- An **unattributable** request — a trusted client-IP header configured but absent, so no IP
  identity can be derived — is answered `503 service_unavailable` under the fail-closed policy
  and never mints a session: `resolveClientIp` returns `undefined`, `evaluateRateLimit` reports
  `unavailable`, and the class's `fail-closed` policy denies. Measured on the real stage
  (review finding **F3**).
- The class numbers are table config, so `platformSettings` can override them later
  without touching the route (no pin asks for it yet).

## Alternatives

1. **A route-local `resolveClientIp` + explicit `facts`.** Rejected: the stage's
   default derivation is already the trusted-header one, so this is a second copy of
   the same resolver with a new way to get it wrong.
2. **Fail-open.** Rejected by ADR-0787 §2 — the write is unauthenticated and durable.
3. **An `attendee`/`contact` secondary bucket.** Impossible before the session exists,
   and §0.11 documents one scope for the class.

## Evidence

Run in `/root/openpic/openpic-webapp/.worktrees/t_08f03b5e` on
`OP-129-task-attendee-session-rate-limit`, based on the pins tip `8c78ecb`.

- `classes.test.ts` — **40 passed (40)** (was 3 failed | 37 passed).
- `attendee-sessions.test.ts` — **15 passed (15)** (was 3 failed | 12 passed), against
  a real `MongoMemoryReplSet` and the real memoised limiter. The `429` case runs 60
  `201`s then denies the 61st with `RateLimit-Limit: 60`, `RateLimit-Remaining: 0`,
  `Retry-After` equal to `RateLimit-Reset`, no `Set-Cookie` and no new row; the second
  IP's `201` reports `RateLimit-Remaining: 59`; the `503` case rejects on
  `createRateLimiter().limit`.
- `tsc --noEmit` exit `0`; ESLint 0 errors and Prettier clean on the two touched
  files; `adr-numbering.test.ts` 29/29.

## Number allocation

The lane's cell read `Next free = 0783` on this base, but `0783` is **held in flight**
by the sibling card `t_a909e641` (`OP-129-task-attendee-session-resolver-default`,
`docs/adr/ADR-0783-op129-attendee-resolver-default.md`, uncommitted in that worktree)
and `0784`/`0785` by the OP-130 public-event lane (pushed on
`origin/OP-130-task-public-event-resolution-{red,green}`). A sweep of every local and
remote ref (`git ls-tree -r <ref> -- docs/adr`) shows no `ADR-0786` anywhere, so this
record takes **`0786`** inside the lane range and above the `0780`/`0781` repair
boundary, and the cell advances to `0787`. The gap `0783`–`0785` is expected and
cheap: a number is consumed once and is never reissued.

## Review sign-off — round 1 (artifact lens)

The reviewer record for the round-1 review of this record and of the implementation it
describes. Artifact lens: the diff was read cold, before the implementer's handoff
narrative. Written by the reviewer profile (`openpic-webapp-reviewer`), which edited no
file in the reviewed delivery.

### Verdict

**APPROVED WITH FINDINGS.** Zero reviewer edits: the reviewed diff is exactly the
implementer's four files. Reviewed head `d9eab5f` (PR #459), folded into the lane branch
`OP-129-task-attendee-session-rate-limit-pins` by the squash `740652cc`. That base is the
PR's own branch, not `main` — the lane stack is still unmerged, so no trunk ancestry
exists yet. `git diff d9eab5f 740652cc` is empty (0 lines): the bytes the review read are
the bytes that landed.

### Evidence reproduced independently, not taken from the handoff

Measured at `d9eab5f`:

- `classes.test.ts` — **40 passed (40)**.
- `attendee-sessions.test.ts` — **15 passed (15)**, integration, against a real
  `MongoMemoryReplSet` and the real memoised limiter (`TMPDIR=/root/tmp-mongo`).
- `adr-numbering.test.ts` — **29 passed (29)**.
- `tsc -p apps/web/tsconfig.json --noEmit` — exit **0**.
- ESLint — **0** problems on both touched files; `prettier --check` clean on all four
  changed files.
- PR #459 checks — every node pass: `ci` (typecheck + lint + unit + integration +
  coverage + build + e2e), `lint`, `unit_test`, `test_coverage`, `secret-scan`, `audit`,
  `audit-dev`, `env-changes`, `validate-branch-name`, `validate-pr-title`, plus the
  `Assert CI evidence` and `notify-discord` nodes.
- Diff scope (`git diff --name-only 8c78ecb..d9eab5f`) — **4 files, zero test, fixture or
  contract edits**.

Re-confirmed when this sign-off was written, on the lane tip `a4be0d3` (after the two
follow-ups below): the ADR guard, `adr-numbering.test.ts` + `adr-lane-ranges.test.ts`, is
**54 passed (54)**; `classes.test.ts` + `stage.test.ts` is **51 passed (51)**;
`attendee-sessions.test.ts` is **15 passed (15)**; `tsc --noEmit` exits **0**;
`prettier --check` is clean on this record.

### The throwaway probe: the facts no shipped pin covered

The delivery's own pins asserted neither the IP trust model nor the unattributable path,
so the reviewer drove the real stage with `TRUSTED_CLIENT_IP_HEADER=x-real-ip` and
measured:

- Two requests sharing the same `x-real-ip` while carrying **different**
  `x-forwarded-for` values produced the **same** limiter key — a forged
  `x-forwarded-for` cannot choose a bucket.
- Two requests with **different** `x-real-ip` values produced different keys.
- The limiter received `{ limit: 60, windowSeconds: 3600 }` under
  `attendee.session:ip:<hash>`, and an admitted response carried `RateLimit-Limit: 60`,
  `RateLimit-Remaining: 59`, `RateLimit-Reset: 3600`.
- A request with **no** derivable IP — a trusted header configured but absent — threw
  `service_unavailable` (`503`) with the limiter **never consulted**: the class's
  fail-closed policy decided, not a limiter answer.

None of these was pinned at review time. That is finding F2 below; both
security-relevant halves are pinned now (see the post-review status).

### Findings and their routing at review time

- **F1 (High, lane)** — the lane minted one ADR number twice: the pin record and the
  edge-pins record (PR #449) both claimed `0782`, and the repo's own guard reported
  `{ code: "duplicate", number: "0782" }` on the union of the two in-flight stacks
  (`adr-numbering.test.ts` 1 failed | 28 passed). Lane-wide, so not fixable from this
  record. Routed to card `t_f4da0ad2`, delivered as PR #463.
- **F2 (Medium, coverage)** — the two properties this class rests on were unpinned: the
  spoof immunity, and the unattributable-request `503`. Routed to card `t_4eefc65c`,
  delivered as PR #468.
- **F3 (Low, this record)** — §Alternatives read "A `attendee`/`contact` secondary
  bucket", and §Consequences omitted the measured unattributable-request consequence.
  Folded into card `t_f4da0ad2` rather than edited by the reviewer, so the reviewed
  delivery keeps a single author.
- **Info** — branch coverage `80.37 %` against an `80 %` gate: thin headroom, no card.

### Post-review status when this sign-off was written

All three findings are closed on this lane branch:

- **F1 — addressed.** Card `t_f4da0ad2` renumbered the pin record to **ADR-0787** and
  repaired the ledger; landed as `e96bb57` (PR #463). On the lane tip the guard is
  `{ ok: true, issues: [] }` with 54 passed (54) across `adr-numbering.test.ts` and
  `adr-lane-ranges.test.ts`, and `ls docs/adr | grep -oE 'ADR-[0-9]{4}' | sort | uniq -d`
  is empty. The references in this record — §Status, §Amends, §Context, §4 and
  §Alternatives — now point at ADR-0787.
- **F2 — addressed.** Card `t_4eefc65c` pinned the trust model and the fail-closed `503`
  in `apps/web/src/server/rate-limit/stage.test.ts`; landed as `a4be0d3` (PR #468).
  `stage.test.ts` is 11 passed (11), five cases of it new, covering three properties: the forged
  `x-forwarded-for` immunity with its different-trusted-IP control, the `60`/`3600`
  success headers with no `Retry-After`, and the unattributable `503` with the limiter
  consulted zero times.
- **F3 — addressed** by `e96bb57` inside card `t_f4da0ad2`: §Alternatives now reads
  "An `attendee`/`contact` secondary bucket", and §Consequences carries the unattributable
  bullet.

**No earlier section of this record is retracted.** §Context, §Decision §1–§4,
§Consequences, §Alternatives, §Evidence and §Number allocation stand as written. Two
statements are superseded in place without being rewritten, and both stay true as facts
about the round-1 tree: §Evidence's counts describe the reviewed head, and §Number
allocation's "the cell advances to `0787`" describes the ledger cell read at mint time —
the lane cell has since advanced to `0788` because the renumber consumed `0787`.
