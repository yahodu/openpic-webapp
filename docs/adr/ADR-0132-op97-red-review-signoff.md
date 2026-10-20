# ADR-0132 — OP-97 RED review sign-off: contract verified, one integration merge, five routed pins

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-97 phase 1 (RED, `t_08538ff6`), review lane round 1 · **Reviewed:** PR #215 (draft), branch `OP-97-task-in-app-feed-read-state-red`, head `9930a17`
- **Reviews:** ADR-0131 (the RED contract of record) · **Unblocks:** `t_58825ec3` (GREEN, backend-coder), now gated behind the RED-pin card `t_321f6091`
- **Verdict:** Approved with findings (the GREEN lane may proceed; the pins below land before it)

## Context

OP-97 phase 1 delivered a test-only RED suite for the in-app feed, the read-state
mutations and the unread-count hot path (ADR-0131). The review lane had to answer
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
| F1  | Medium   | The I6 never-return pin is weaker than ADR-0131 claims. `findForbiddenFields(body, "default")` only flags `ALWAYS_FORBIDDEN_KEYS` (…, `_id`) plus `sessionToken`/`rawPayload`/`similarity`; `titleKey` and `expireAt` — which the fixture deliberately stores and the ADR lists as never-return — are **not** detected. The projection assertion uses `toMatchObject`, which is non-exhaustive, so a projection leaking any extra key passes every test in the lane. | RED-pin card `t_321f6091` → GREEN    |
| F2  | Low      | `read-all`'s `before` and `eventId` scoping is unpinned (contract §7.1: "all optional, all AND-ed"); only `category` is exercised.                                                                                                                                                                                                                                                                                                                                   | RED-pin card `t_321f6091`            |
| F3  | Low      | The cursor's `_id` tie-break is unpinned — the pagination case uses distinct `createdAt` values only, so a `createdAt`-only cursor would pass.                                                                                                                                                                                                                                                                                                                       | RED-pin card `t_321f6091`            |
| F4  | Low      | `limit`/`filter` boundary values are unpinned: only default 20 and the clamp to 50 are asserted (no 0, negative, non-numeric, or unknown-`filter` case).                                                                                                                                                                                                                                                                                                             | RED-pin card `t_321f6091`            |
| F5  | Low      | I4's `explain` assertion is plan-dependent by construction; with a 34-document collection the multi-plan runner could in principle prefer a `COLLSCAN`, so the pin carries a flake risk even though it reproduces today.                                                                                                                                                                                                                                             | RED-pin card `t_321f6091` (advisory) |
| F6  | Info     | The rate classes (`read.normal`, `read.hot`, `write.normal`) are asserted by reference only; no test in the lane binds a route to its class. ADR-0131 defers the numeric budget to the rate-limit suite, which does not cover the binding either.                                                                                                                                                                                                                    | RED-pin card `t_321f6091` (optional) |
| F7  | Info     | ADR-0131's header still names the pre-rename worktree branch (`wt/t_08538ff6`), and its never-return claim should be restated to match F1's fix.                                                                                                                                                                                                                                                                                                                     | RED-pin card `t_321f6091` (docs)     |

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

## Round 2 — follow-up RED pins review (card `t_321f6091`)

- **Status:** Accepted · **Date:** 2026-10-20 · **Lens:** artifact (round 1 of
  this card's review; no prior `changes_requested`)
- **Reviewed:** PR #215 (still draft), branch
  `OP-97-task-in-app-feed-read-state-red`, base `9b3b83e`, head `9c98fef`
- **Verdict:** Approved with findings — no changes requested, no test file edited
  by the reviewer. One Medium finding routed as the new card `t_bd74e9bf`, which
  is linked as a third parent of the GREEN card `t_58825ec3` so the contract is
  settled before implementation.

### Independently reproduced on `9c98fef`

- The three touched suites red at import — the right reason:
  `Cannot find package '@/app/api/v1/me/notifications/…'` (feed),
  `'…/[id]/route'` (read-state), `'…/unread-count/route'` — `Test Files 3
failed (3) · Tests no tests`.
- `vitest run --project unit` → 87 files, **1477/1477 passed**; the only two red
  files are the new unit specs at import. Identical to the `9b3b83e` baseline.
- `vitest run --project integration` → 50 files, 46 passed / 4 failed,
  **347 passed / 1 failed**. The four red files are the three pinned suites at
  import plus the intended `notification-fan-out` PRE-1 pin
  (`expected [] to have a length of 1 but got +0`) — identical to the baseline,
  so the new pins added no regression.
- Playwright `--project=api` on `me-notifications.spec.ts` → E1 red at
  `expect(probe.status()).toBe(200)`, received `404`; the route is still missing.
- `prettier --check` clean and `eslint` exit 0 on the three specs;
  `tsc -p apps/web/tsconfig.json` reports only the expected `TS2307`
  missing-module errors on the touched specs.
- The diff is test-only + docs: three integration specs and ADR-0131, no
  production file created or edited. Local head == `origin/…` head at the
  reviewed SHA.

### Pin-by-pin verification

- **F1** — `FEED_ITEM_KEYS` (18) is emitted in default lexicographic order, so it
  compares equal to `Object.keys(item).sort()`; it pins the exact §7.1 set in both
  the projection case and the feed I6 case, and `UNREAD_COUNT_KEYS` (5) does the
  same for §7.2. Cross-checked against `ALWAYS_FORBIDDEN_KEYS` in
  `packages/contracts/src/security/neverReturn.ts`: `titleKey`/`expireAt` are
  indeed outside the scanner's set (only `embedding`, `vectors`, `queryVector`,
  `tokenHash`, `objectKey`, `locationKey`, `bucket`, `externalRefs`,
  `providerCode`, `_id` plus the profile keys `sessionToken`/`rawPayload`/
  `similarity`), so the exact-key pin is what makes the never-return claim real.
  `findForbiddenFields` is retained as the shared scanner.
- **F2** — three new `read-all` cases (`eventId`, `before`, `category` AND
  `eventId`); each asserts out-of-scope rows stay unread and that
  `markedCount`/`unreadCount` reflect the scoped mutation. The `before` operator
  is deliberately unobservable (rows at 1/3/5 days, cut at 2 days), so `$lt` and
  `$lte` give the same result.
- **F3** — three rows share one `createdAt`, leaving only the `_id`-descending
  tie-break to order them; the case asserts both pages concatenate to that
  deterministic order with no row repeated or skipped.
- **F4** — `it.each` over `?limit=0`, `?limit=-5`, `?limit=abc`, `?limit=` (empty)
  all fall back to 20, and `?filter=bogus` falls back to the `active` band; both
  fallbacks are stated in ADR-0131 §Feed projection.
- **F5** — `EXPLAIN_READ_ROWS = 200` read rows precede the four unread rows, and
  the spec docstring records the flake risk and why the size removes it. Accepted.
  Verified the I4 assertion still targets `idx_user_unread` in the winning plan.
- **F6** — deferral verified rather than taken on trust: `defineRoute` returns
  `async (request) => Response` with no route metadata, and the class exists only
  as a `rateLimit`/`rateLimitIdentity` stage option at the call site, so no spec
  can read the declared class off the handler. The recorded deferral is correct.
- **F7** — ADR-0131's header names the real branch and its never-return paragraph
  matches what F1 pins; the ADR number is unchanged.

### Findings (round 2)

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                                       | Routed to                                                                                                                               |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Medium   | The exact-key pin requires `actionResolvedVia`/`actionResolvedAt` **always** present (as `null`), but the published contract says otherwise: `docs/API Contract.md` §7.1's example shows one response whose first item omits both keys while its second carries them, and the `AppNotification` interface declares them optional (`?`). A GREEN implementer reading the contract alone can legitimately omit them and go red. | New card `t_bd74e9bf` (testcase-writer), parent of `t_58825ec3`; default resolution is to amend the contract to the stable 18-key shape |
| B   | Low      | The `read-all` `before` comparison operator (`<` vs `<=`) is unobservable by construction and is not recorded in the ADR.                                                                                                                                                                                                                                                                                                     | New card `t_bd74e9bf`, secondary item                                                                                                   |
| C   | Info     | The empty `?limit=` case is pinned as "fall back to 20"; the contract defines only the default, so this is a recorded lane choice.                                                                                                                                                                                                                                                                                            | Accepted (recorded in ADR-0131)                                                                                                         |
| D   | Info     | `EXPLAIN_READ_ROWS = 200` adds 200 sequential inserts to one case; measured full integration run is still 54 s, so the cost is acceptable.                                                                                                                                                                                                                                                                                    | Accepted                                                                                                                                |

No Critical finding. The honesty audit of the diff is clean: no
test-environment conditionals, no `@ts-ignore`/`eslint-disable`/`skip`/`TODO`, no
`console` noise, no fixture-shaped hardcoding.

### Merge posture (unchanged)

PR #215 stays a **draft and is not merged**, for the reason in §4: it is a
deliberately red-CI RED lane whose pins ship inside the OP-97 GREEN PR. The pins
reviewed here are committed to `OP-97-task-in-app-feed-read-state-red`; merging
them into `main` would redden every CI run on `main` until the implementation
lands. The worktree's reviewed head is the SHA recorded on the card, not a merge
commit.

### Consequences (round 2)

- The card's whole definition of done is met: F1–F4 are present and red for the
  right reason, F5–F7 are addressed or explicitly recorded as accepted, and
  ADR-0131 is updated in place without renumbering.
- One open contradiction remains between the pinned contract and the published
  contract document; card `t_bd74e9bf` closes it, and the GREEN card cannot start
  until it does.
- Local `main` == `origin/main` (`3958213`); nothing reviewed here touched `main`.

## Round 3 — follow-up settlement review (card `t_bd74e9bf`)

- **Status:** Accepted · **Date:** 2026-10-20 · **Lens:** execution (round 2 of
  this card's review; round 1 requested one change and it has landed)
- **Reviewed:** PR #215 (still draft), branch
  `OP-97-task-in-app-feed-read-state-red`, base `9c98fef`, head `62bcbc2`
  (`git ls-remote` == local head)
- **Verdict:** Approved — no changes requested, no test or production file edited
  by the reviewer. Findings A and B from round 2 are closed; the contract
  document, ADR-0131 and the specs now tell the same story.

### What closed the round-1 change request

Round 1 of this card found that §7.1's **second** example item
(`collab.invite.sent`) still carried 16 keys, omitting `eventId` and `tenantId`.
Commit `62bcbc2` adds both after `"readAt": null`, matching item 1's order.

Verified programmatically rather than by eye (a script parsed the §7.1 JSON
block, `FEED_ITEM_KEYS`, and the `AppNotification` declaration):

- item 0 (`attendee.matches.new`) — 18 keys; item 1 (`collab.invite.sent`) —
  18 keys; the two key sets are **equal**;
- both equal `FEED_ITEM_KEYS` (`notification-feed.test.ts:110-129`, 18 keys);
- both equal the `AppNotification` field set (18 fields, **zero** optional);
- `actionResolvedVia: ResolvedVia | null;` / `actionResolvedAt: IsoDateTime | null;`
  are required-nullable (no `?`), `eventId: Id | null;` / `tenantId: Id | null;`
  present.

So the stable 18-key shape ADR-0131 §Feed projection declares is the only
reading left in the tree: the example, the interface, the pin and the ADR agree,
and a GREEN implementer cannot legally omit the two resolution fields.

### What closed finding B

ADR-0131 §Feed projection (line 131) now records `read-all` with `before` as
`createdAt < before` — strictly earlier — and states that a row at the cut
instant stays unread. It is also made **observable**: `notification-read-state.test.ts`
gained a boundary case that seeds one row exactly at the cut and one 1 ms earlier
and reuses the same `Date` for both the seed and the request body, so `$lte`
would mark 2 and fail `{ markedCount: 1, unreadCount: 1 }`. Unlike the original
1/3/5-day case, `$lt` and `$lte` are now distinguishable.

### Independently reproduced on `62bcbc2` (execution lens)

Re-ran the suites on the reviewed head instead of trusting the handoff:

- `vitest run --project unit` → 87 files, **1477/1477 passed**, 2 files red at
  import (`@/server/notifications/feed`, `…/unread-count`) — the new unit specs.
- `vitest run --project integration` → 50 files, 46 passed / 4 failed,
  **347 passed / 1 failed**; the four red files are the three pinned OP-97
  suites at import plus the intended PRE-1 pin at
  `notification-fan-out.test.ts:774` (`expected [] to have a length of 1 but got +0`).
- Baseline-identical to `9c98fef` and `e34c515`: no regression, and the docs-only
  commit movement cannot change posture by construction.
- `prettier --check` clean on both files touched by `62bcbc2` and on the
  read-state spec; `eslint` exit 0 on the spec.
- `git diff 9c98fef..HEAD --stat` → 4 files, test-only + docs: three integration
  specs, `docs/API Contract.md`, ADR-0131, ADR-0132. **No production file
  created or edited**, no route or module touched.
- Honesty audit clean: no `skip`/`only`, no `@ts-ignore`/`eslint-disable`, no
  `NODE_ENV`/`process.env` branch, no `console` noise, no `TODO`, and no logic
  shaped around a fixture value.
- ADR-0132's round-2 text is unchanged by the rework (`git diff 7bb2375..HEAD`
  on this file is empty) — the reviewer-owned finding record was not rewritten.
- Local `main` == `origin/main` (`3958213`); this round touched nothing on `main`.

### Merge posture (unchanged, re-affirmed)

PR #215 stays a **draft and unmerged** on head `62bcbc2`. CI is red by design
(`ci`, `unit_test`, `test_coverage` fail on the not-yet-implemented routes;
`lint`, `validate-branch-name`, `validate-pr-title`, `secret-scan`,
`env-changes` and CodeQL pass); the pins ship inside the OP-97 GREEN PR per §4.
Merging here would redden `main` until the implementation lands.

### Consequences (round 3)

- Card `t_bd74e9bf`'s whole definition of done is met; nothing remains between
  the pinned contract and the published one.
- GREEN (`t_58825ec3`) is released to implement against a settled contract: the
  projection must always emit all eighteen keys with
  `actionResolvedVia`/`actionResolvedAt` as `null` when unresolved, and
  `read-all`'s `before` comparison must be strict (`createdAt < before`).
- No new ADR number consumed; ADR-0131 stays the contract of record and is
  updated in place.
