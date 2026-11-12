# ADR-0787 — OP-129 follow-up: the `attendee.session` class (60 / hour / IP, fail-closed)

- **Status:** Accepted (pins only — the implementation is the gated GREEN `t_08f03b5e`)
- **Consumers:** `apps/web/src/server/rate-limit/classes.test.ts` (contract §0.11 table +
  failure policy), `apps/web/src/test/integration/attendee-sessions.test.ts` (F1 pins),
  `docs/API Contract.md` §0.11 + §1.5
- **Lane:** OP-129 (epic Attendee Identity). Reserved range `0780`–`0798`; see
  §Number allocation — this record takes `0787` (minted as `0782`, renumbered by
  card `t_f4da0ad2`), not the cell's `0771`.
- **Supersedes:** nothing. **Amends:** [ADR-0770](ADR-0770-op129-anonymous-attendee-sessions-green.md)
  §4 (its deferred rate-limit item), by pinning the class and its policy.

## Context

Contract §1.5 declares `POST /api/v1/p/attendee-sessions` as **public, 60 / hour / IP**.
The shipped route (ADR-0770) has no rate-limit stage, so an unauthenticated caller can mint
`attendeeSessions` rows without limit — one row per call, each with a 30-day TTL, each a
bearer credential to someone's photos. The round-1 review of the GREEN raised this as
finding **F1 (High)**.

ADR-0770 §4 deferred the limit because the executable class table had no row for it, and
`classes.test.ts` pins `Object.keys(RATE_LIMIT_CLASSES)` to **exactly** the contract §0.11
class list. A class therefore cannot be added to the route alone: the contract table, the
executable table, the failure policy and the route stage are one change.

This record is **test + contract doc + ADR only**. No production file is touched.

## Decision

### 1. The class is `attendee.session`, keyed on the client IP alone

```
"attendee.session": [{ scope: "ip", limit: 60, windowSeconds: 3600 }]
```

The endpoint is public and runs **before** a session exists, so:

- there is no principal — `{scope: "user"}` would have no identity;
- there is no contact in the body — `{scope: "contact"}` would have no identity;
- the `attendee` scope is keyed from a **resolved** session identity, which is exactly what
  this route creates, so keying on it would either skip the rule or let a caller mint a new
  bucket with every call.

An IP-only rule is thus the only scope the contract's "60 / hour / IP" can mean here, and it
is also the one abuse signal available to an unauthenticated write. `evaluateRateLimit`
skips a rule whose identity is absent and reports zero usable identities as `unavailable`
(never as an unlimited allow), so a request that carries no resolvable address fails closed
under the policy below instead of bypassing the limit.

### 2. The failure policy is **fail-closed**

`rateLimitFailurePolicy("attendee.session") === "fail-closed"`.

**Reason:** the class is unauthenticated and every allowed call writes a durable,
credential-shaped row (30-day TTL), so an unavailable limiter must not degrade into an
unbounded mint — the same argument that puts `auth.otp`, `auth.verify`, `selfie.submit` and
`liveness.challenge` in `FAIL_CLOSED_CLASSES`. The observable is `503 service_unavailable`
with no session row and no `Set-Cookie`, pinned in the integration spec.

The class list is exhaustive on both sides: `FAIL_CLOSED` + `FAIL_OPEN` must equal the
contract class list, so a class can never be added without a policy.

### 3. The stage is declared on the route's own `defineRoute` options

The GREEN adds, in `apps/web/src/app/api/v1/p/attendee-sessions/route.ts`:

```ts
rateLimit: rateLimitStage({
  classKey: "attendee.session",
  limiter: createRateLimiter(),
  salt: getRateLimitConfig().salt,
}),
```

mirroring `apps/web/src/app/api/v1/plans/route.ts:46`. `createRateLimiter()` is memoised, so
the memory provider accumulates a real window across calls — which is why the pins drive the
**real** route handler and the real limiter, not a stub: a rule of `600` rather than `60`, or
a rule keyed on a scope a public request cannot supply, reddens them.

Nothing else in the route changes: the token, the TTL read, the `eventSlug` binding and the
`201` body stay byte-identical.

### 4. A `201` now carries `RateLimit-*`, and a `429` carries `Retry-After`

Accepted as a side effect of the shared stage: the three `RateLimit-*` headers are always
present (they describe the caller's window, not the response), and a denial adds
`Retry-After` equal to the window reset. The `429` body is the shared `rate_limited`
envelope (`error.retryable === true`), it mints no session, and it sets no cookie.

## Pins delivered

| File                                                      | Pin                                                                                                                                | State on this branch |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `apps/web/src/server/rate-limit/classes.test.ts`          | `attendee.session` present in `RATE_LIMIT_CLASSES` and in no extra class                                                           | RED                  |
| same                                                      | `attendee.session` configured with exactly `{scope:"ip", limit:60, windowSeconds:3600}`                                            | RED                  |
| same                                                      | `attendee.session` fails closed; the `FAIL_CLOSED`/`FAIL_OPEN` partition stays exact                                               | RED                  |
| `apps/web/src/test/integration/attendee-sessions.test.ts` | 60 creates from one IP answer `201`, the 61st answers `429 rate_limited` with `RateLimit-*` + `Retry-After`, no cookie, no new row | RED                  |
| same                                                      | a second IP is unaffected and its `201` carries `RateLimit-Limit: 60`, `RateLimit-Remaining: 59`                                   | RED                  |
| same                                                      | an unavailable limiter answers `503 service_unavailable` and mints no session                                                      | RED                  |
| `docs/API Contract.md`                                    | §0.11 row for `attendee.session`; §1.5 line names the class                                                                        | GREEN (docs)         |

`CONTRACT_CLASSES`, `FAIL_CLOSED` and `FAIL_OPEN` are typed `readonly string[]` **on
purpose**: naming a class the `RateLimitClass` union does not yet have would otherwise need a
cast that becomes `@typescript-eslint/no-unnecessary-type-assertion` the moment the GREEN
widens the union. Once the member exists the GREEN may retype the three arrays to
`readonly RateLimitClass[]`; the assertions do not change. The lane row lives in
`LANE_RULES` (typed by name) rather than in `CONTRACT_RULES` (typed `[RateLimitClass, …]`)
for the same reason, with an identical exact `toEqual` assertion.

## Evidence

All commands run in `/root/openpic/openpic-webapp/.worktrees/t_4f95a931` on
`OP-129-task-attendee-session-rate-limit-pins`, based on
`origin/OP-129-task-anonymous-attendee-sessions-red-fix` (`2793f02`) because
`apps/web/src/server/attendee/session-token.ts` is **not** on `origin/main` (`ced39b6`).

1. `classes.test.ts` — RED for the right reason, **3 failed | 37 passed (40)**:

   ```
   AssertionError: expected [ 'admin', 'auth.otp', …(13) ] to deeply equal [ 'admin', 'attendee.session', …(14) ]
   Error: contract §0.11 class attendee.session is missing from RATE_LIMIT_CLASSES
   AssertionError: expected 'fail-open' to be 'fail-closed'
   ```

2. `attendee-sessions.test.ts` — the twelve shipped pins stay green, the three new F1 pins
   are RED, **3 failed | 12 passed (15)**:

   ```
   AssertionError: expected 201 to be 429          // the 61st create is not limited
   AssertionError: expected null to be '60'        // no RateLimit-Limit on a 201
   AssertionError: expected 201 to be 503          // an unavailable limiter mints a session
   ```

3. Satisfiability probe (throwaway, never committed): the minimal GREEN change —
   union member, table row, `FAIL_CLOSED_CLASSES` entry and the route's `rateLimit` option —
   turns **classes.test.ts 40 passed (40)** and **attendee-sessions.test.ts 15 passed (15)**.
   Both production files were then restored and verified byte-identical (sha256) with
   `git diff` empty, so the pins are green-able by the change this ADR describes and by
   nothing more.

4. `npx vitest run --project unit apps/web/src/test/unit/adr-numbering.test.ts` — see the
   card handoff for the run on the committed head.

## Assumptions

1. **IP trust model is unchanged.** The stage reads the IP through the same
   `resolveClientIp` + `getTrustedClientIpHeader()` pair the route's `deviceFingerprint()`
   already uses (ADR-0024). Where `TRUSTED_CLIENT_IP_HEADER` is set, a forged
   `x-forwarded-for` cannot choose its bucket; where it is unset, the dev/e2e fallback to the
   first hop applies. This ADR does not change that model and no pin asserts a spoofing
   defence.
2. **`Retry-After` equals `RateLimit-Reset`.** Both are `result.resetSeconds` by
   construction (`rateLimitHeaders`), and the pin asserts the equality plus an upper bound of
   one class window (3600 s) rather than an exact value, which would depend on wall-clock
   position inside a fixed window.
3. **The integration loop of 61 requests is cheap** (~0.3 s measured) and stays inside the
   project's default 5 s per-test budget, so no file-scoped `vi.setConfig` bump is needed.
4. **The failure-policy observable is `503 service_unavailable`**, the shape the shared stage
   already renders for a fail-closed class (`rate-limit-route.test.ts` pins it for
   `auth.otp`). The integration pin reaches it by rejecting on the **memoised** limiter's
   `limit`, i.e. through the same accessor the route calls.
5. **Contract §0.11 keeps one row per class**; `attendee.session` is inserted next to
   `selfie.submit`/`liveness.challenge` because those are the attendee-facing classes.

## Open questions (for the GREEN, not resolved here)

1. Whether the `201` response should keep emitting `RateLimit-*` (this ADR says yes: the
   stage is shared and the headers describe the window) or suppress them on a create.
2. Whether `platformSettings` should later override the class's numbers. The table is config
   by design (ADR for §0.11), but no pin in this card asks for a runtime override.
3. Whether a `contact`/`attendee` secondary bucket is wanted once the session exists. Out of
   scope here: §0.11 documents one scope for this class.

## Out of scope

- No e2e pin. The limit is a server-side counter and the Playwright journey (E1) creates one
  session; a 61-request browser loop would add minutes to CI for no new signal.
- No `eventSlug` interaction, no `lastSeenAt` write, no change to the `current` route.
- No spoofing pin for `x-forwarded-for` (see Assumption 1).

## Number allocation

The lane's cell read `Next free = 0771` on this base, but `0771` is **held in flight** by the
OP-128 uploads lane (`ADR-0771-op128-signed-url-fallback-pins.md`, open PR #447) and `0770`
already collides with `ADR-0770-op128-account-status-gate-green.md` (the ledger repair card
`t_95e7ed1e` is renumbering this lane's `0769`/`0770` to `0780`/`0781`). Minting `0771` here
would collide twice at merge, so this record was first minted as **`0782`** and the cell
advanced to `0783`.

That mint was read against a stale ledger. The OP-129 lane mints `0782` **twice** in flight:
`0782` is held by the edge-pins record
(`ADR-0782-op129-attendee-session-edge-pins.md`, PR #449, the earlier mint), `0783` by the
resolver-default record (`ADR-0783-op129-attendee-resolver-default.md`, card `t_a909e641`) and
`0784`/`0785` by the OP-130 public-event lane. A second `0782` reddens the repo's own guard —
`checkAdrDirectory("docs/adr")` returns `{ ok: false, code: "duplicate" }` and
`adr-numbering.test.ts` fails — the moment the two records share a tree.

This record therefore takes **`0787`** (card `t_f4da0ad2`, review finding **F1**): inside the
lane's reserved `0780`–`0798` range, above the two records the `0780`/`0781` repair re-cut and
above every number in flight. The lane cell advances to `0788`. A sweep of every open PR head
(`git ls-tree -r <ref> -- docs/adr`) plus `ls docs/adr` taken immediately before the push shows
no `ADR-0787` and no `ADR-0788` anywhere in flight, so `0787` is free. The reasoning that got
here is unchanged: a record takes the next number above the in-flight high-water mark, and a
number is consumed once and never reissued — `0782` stays the edge-pins record's number and the
gap `0784`/`0785` stays reserved to the OP-130 lane rather than being back-filled.
