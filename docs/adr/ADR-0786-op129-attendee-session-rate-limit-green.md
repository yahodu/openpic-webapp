# ADR-0786 — OP-129 follow-up: the `attendee.session` limit is enforced on the create route

- **Status:** Accepted (implementation of [ADR-0782](ADR-0782-op129-attendee-session-rate-limit-pin.md))
- **Consumers:** `apps/web/src/app/api/v1/p/attendee-sessions/route.ts`,
  `apps/web/src/server/rate-limit/classes.ts`; pinned by
  `apps/web/src/server/rate-limit/classes.test.ts` and
  `apps/web/src/test/integration/attendee-sessions.test.ts`
- **Lane:** OP-129 (epic Attendee Identity). Reserved range `0769`–`0788`; see
  §Number allocation — this record takes `0786`, not the cell's `0783`.
- **Supersedes:** nothing. **Amends:** ADR-0782 §3–§4 (it declared the change; this
  record makes it).

## Context

ADR-0782 pinned the class and the stage but touched no production file, so
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
(ADR-0782 §4): the headers describe the caller's window, not the response, every
other stage-consuming route behaves the same way, and the integration pin asserts
them (`RateLimit-Remaining: 59` on a fresh IP's first `201`). A `429` adds
`Retry-After`, mints no row and sets no cookie; `503` does the same under
fail-closed.

## Consequences

- An IP is limited to 60 creates per rolling hour; the 61st is
  `429 rate_limited` with `Retry-After` and no session row.
- An unavailable limiter answers `503 service_unavailable` for this class instead of
  minting a session — a limiter outage costs availability, never an unbounded mint.
- The class numbers are table config, so `platformSettings` can override them later
  without touching the route (no pin asks for it yet).

## Alternatives

1. **A route-local `resolveClientIp` + explicit `facts`.** Rejected: the stage's
   default derivation is already the trusted-header one, so this is a second copy of
   the same resolver with a new way to get it wrong.
2. **Fail-open.** Rejected by ADR-0782 §2 — the write is unauthenticated and durable.
3. **A `attendee`/`contact` secondary bucket.** Impossible before the session exists,
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
