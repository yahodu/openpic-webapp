# ADR-0130 — OP-97 RED review sign-off: contract verified, one integration merge, five routed pins

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-97 phase 1 (RED, `t_08538ff6`), review lane round 1 · **Reviewed:** PR #215 (draft), branch `OP-97-task-in-app-feed-read-state-red`, head `9930a17`
- **Reviews:** ADR-0129 (the RED contract of record) · **Unblocks:** `t_58825ec3` (GREEN, backend-coder), now gated behind the RED-pin card `t_321f6091`
- **Verdict:** Approved with findings (the GREEN lane may proceed; the pins below land before it)

## Context

OP-97 phase 1 delivered a test-only RED suite for the in-app feed, the read-state
mutations and the unread-count hot path (ADR-0129). The review lane had to answer
three questions: does the contract the tests pin match the repository it will be
implemented in, is every suite red for the _right_ reason, and does the diff
contain anything that only exists to satisfy a fixture.

## Decision

### 1. The contract was checked against the code it will bind

The unit and integration specs are coherent with the shipped notification
machinery, so the GREEN lane is not being asked for anything unbuildable:

- Every seeded `typeKey` exists in the compile-time seed catalogue
  (`notification-types.values.ts`) with the category the tests assert:
  `account.welcome → account`, `attendee.matches.new → matching`,
  `collab.invite.sent → collaboration`, `event.details.updated → event`,
  `billing.payment.failed → billing`, `auth.otp.email.requested →
authentication`. `summary.unreadByCategory`'s `{account: 1, collaboration: 1}`
  is therefore reachable.
- `channels` is documented as `[in_app, email, mobile]`, so both `auth.otp.*`
  keys carry `in_app: false` — the ADR's OTP exclusion set
  (`channelGroups.in_app.enabled === false`) is exactly the two keys the tests
  name, and no other type is caught by it.
- `insertFeedRow` is shaped to the real `FeedRow` interface in `fan-out.ts`,
  including `titleKey` (a never-return field, deliberately present so I6 has
  something to catch) and the deliberate absence of `category`, which the read
  path must denormalise.
- PRE-1 is satisfiable as written: `account.welcome` is `channels [true, true,
false]` with `severity: informational`, so quiet hours defer the email while
  the in-app row must still be written — and `fanOutToRecipient` already handles
  only `send`/`digest` for `in_app` and never writes an in-app dispatch, which is
  why the pin's "exactly one dispatch row, channel `email`, status `deferred`" is
  consistent rather than contradictory.
- `SINGLETON_ID === "singleton"`, so the unread-count suite's settings override
  (a non-default 45 s cadence, seeded precisely so a hard-coded 30 fails) lands.
- ADR `0129` is the next free number above `origin/main`'s high-water mark
  `0128`; no collision.

### 2. The branch was two commits behind `origin/main`

The handoff described `notification-fan-out.test.ts` I5 (`expected 'pending'`) as
a pre-existing red "owned by `t_a4cdff8f`, untouched here". That was true when
the branch was cut, but PR #214 (`3958213`) had already landed the I5 flip on
`main`, so the red was stale branch drift rather than an outstanding dispute.

`origin/main` was merged into the RED branch (clean; the only auto-merge was the
fan-out spec, where main's I5 flip and this lane's PRE-1 append touch different
regions) and pushed as `9930a17`. After the merge the fan-out suite is **9 passed
/ 1 failed**, the single failure being the intended PRE-1 pin.

### 3. Findings routed

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Routed to                            |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| F1  | Medium   | The I6 never-return pin is weaker than ADR-0129 claims. `findForbiddenFields(body, "default")` only flags `ALWAYS_FORBIDDEN_KEYS` (…, `_id`) plus `sessionToken`/`rawPayload`/`similarity`; `titleKey` and `expireAt` — which the fixture deliberately stores and the ADR lists as never-return — are **not** detected. The projection assertion uses `toMatchObject`, which is non-exhaustive, so a projection leaking any extra key passes every test in the lane. | RED-pin card `t_321f6091` → GREEN    |
| F2  | Low      | `read-all`'s `before` and `eventId` scoping is unpinned (contract §7.1: "all optional, all AND-ed"); only `category` is exercised.                                                                                                                                                                                                                                                                                                                                   | RED-pin card `t_321f6091`            |
| F3  | Low      | The cursor's `_id` tie-break is unpinned — the pagination case uses distinct `createdAt` values only, so a `createdAt`-only cursor would pass.                                                                                                                                                                                                                                                                                                                       | RED-pin card `t_321f6091`            |
| F4  | Low      | `limit`/`filter` boundary values are unpinned: only default 20 and the clamp to 50 are asserted (no 0, negative, non-numeric, or unknown-`filter` case).                                                                                                                                                                                                                                                                                                             | RED-pin card `t_321f6091`            |
| F5  | Low      | I4's `explain` assertion is plan-dependent by construction; with a 34-document collection the multi-plan runner could in principle prefer a `COLLSCAN`, so the pin carries a flake risk even though it reproduces today.                                                                                                                                                                                                                                             | RED-pin card `t_321f6091` (advisory) |
| F6  | Info     | The rate classes (`read.normal`, `read.hot`, `write.normal`) are asserted by reference only; no test in the lane binds a route to its class. ADR-0129 defers the numeric budget to the rate-limit suite, which does not cover the binding either.                                                                                                                                                                                                                    | RED-pin card `t_321f6091` (optional) |
| F7  | Info     | ADR-0129's header still names the pre-rename worktree branch (`wt/t_08538ff6`), and its never-return claim should be restated to match F1's fix.                                                                                                                                                                                                                                                                                                                     | RED-pin card `t_321f6091` (docs)     |

No Critical finding. The honesty audit of the diff is clean: no
test-environment conditionals, no `@ts-ignore`/`eslint-disable`/`skip`/`TODO`, no
fixture-shaped hardcoding, no console noise. The new shared helpers
(`authed-app.ts`, `notification-rows.ts`) drive the real Better Auth HTTP surface
and a private database rather than writing session rows directly.

### 4. Merge posture

PR #215 stays a **draft and is not merged**. This is a deliberately red-CI RED
lane: its pins ship inside the OP-97 GREEN PR (the OP-92 / OP-93 / OP-94
precedent, where the GREEN branch carries the RED pins and turns them green). The
GREEN card `t_58825ec3` is released by this sign-off but gated behind the
RED-pin card, so the extra pins land before the implementation rather than after
it.

## Verified on the reviewed head (`9930a17`)

- `vitest run --project unit` → 87 files, **1477/1477 tests passed**; the only two
  red files are the new unit specs, failing at import
  (`Cannot find package '@/server/notifications/feed'` /
  `'…/unread-count'`).
- `vitest run --project integration` → 50 files, 46 passed / 4 failed;
  **347 tests passed / 1 failed**. The four red files are the three new suites
  (import failure: `Cannot find package '@/app/api/v1/me/notifications/…'`) and
  `notification-fan-out.test.ts`, whose single failure is the PRE-1 pin
  (`expected [] to have a length of 1 but got +0`).
- Playwright `--project=api` on `me-notifications.spec.ts` → E1 red at
  `expect(probe.status()).toBe(200)`, received `404` on
  `GET /api/v1/me/notifications/unread-count` (run against the worktree's
  existing `.next/standalone` build; the spec's sign-in and OTP capture steps
  passed, so only the missing route is asserted red).
- `prettier --check` and `eslint` clean on all ten changed files.
- `idx_user_unread` is present in the declared index set the integration
  bootstrap creates, so I4's target index exists to be planned against.

## Consequences

- The contract stands: the suite is red **only** for the intended reasons
  (two missing modules, five missing routes, one PRE-1 behaviour pin, one e2e
  journey), and nothing else in the repository regressed.
- The GREEN lane inherits a branch that is current with `main` and a suite whose
  every red is one the GREEN card is scoped to turn green.
- F1–F4 strengthen the contract before implementation; F5–F7 are advisory. None
  of them was actioned by the review lane itself, and no test file was edited by
  the reviewer.
