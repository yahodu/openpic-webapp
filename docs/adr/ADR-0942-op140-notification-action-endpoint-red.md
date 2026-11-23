# ADR-0942 — OP-140: the delegating, idempotent notification action endpoint (RED contract)

- **Status:** Accepted (RED pin) · **Date:** 2026-11-23
- **Card:** `t_5d080821` (OP-140 RED, phase 6-M2M · epic Notifications) — the GREEN sibling is `t_39c2bf80`
- **Branch:** `wt/t_5d080821` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_5d080821` (rebase base `origin/main` `cc2496c1`)
- **ADR number:** `0942` — the OP-140 lane has **no** row in the reserved-range ledger, so this first card draws the next 20-number block from the `unallocated (future lanes)` pool: `0942`–`0961`, its own `Next free` cell set to `0943`, and **both** cells that read `0942` (`OP-136 jobs lane`, `unallocated (future lanes)`) advanced to `0962`. The delivery sweep found the highest record `ADR-0941`, no `ADR-09[4-7]` object in `git log --all -- docs/adr`, and nothing above `0941` in any `.worktrees/*/docs/adr` tree.
- **Touches:** three **test-only** files — `apps/web/src/test/unit/notification-actions.test.ts` (28 cases), `apps/web/src/test/integration/notification-actions.test.ts` (10 cases), `apps/web/e2e/notification-actions.spec.ts` (1 journey) — plus this ADR, its index row, two ledger cells, one new lane row and one ledger paragraph. **No production code, schema, index, fixture factory, mock or config.** The `@/server/notifications/notification-actions` module and the route it pins do not exist on the trunk.

## Context

Contract §7.3 and the notification design §7 describe one endpoint —
`POST /api/v1/me/notifications/{id}/actions/{actionKey}` — whose whole job is to
**not own state**. A notification in any channel is a _pointer_; the owning
document (`invitations`, `subscriptions`, `upload_batches`, `consents`, `events`,
`selfies`) holds the terminal state, and the endpoint delegates to that
document's idempotent transition. The feed row's `actions[].state` is a
denormalised convenience that §7.1 explicitly allows to be **briefly stale**, so
the write path has to re-validate and can never answer `409` for a repeated
action.

The trunk holds every dependency the card names, but not the endpoint:

| Piece                                                                                                                            | Where it lives on `origin/main`                                                                                                                                                                                                     | State             |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Invitation decision (OP-121)                                                                                                     | `@/server/collaboration/invitation-transition` — `decideInvitation` answers `200` with `alreadyResolved` + `resolvedVia`, `410` for `revoked`/`expired`, never `409`; `closeInvitationAffordance` runs the §2.3 rule-3 `updateMany` | landed (ADR-0664) |
| Billing retry (OP-110)                                                                                                           | `POST /tenants/{t}/billing/retry-charge` — `ownerOnlyTenant()` gate, `decideRetryEligibility`, one `pending` `billing_transactions` intent written **before** the provider call                                                     | landed (ADR-0480) |
| Feed actions                                                                                                                     | `@/server/notifications/fan-out` writes `actionTarget { kind, id, state }` and `actions [{ key, label, style, state }]` for the invitation rows only                                                                                | landed (OP-97)    |
| Catalogue / types                                                                                                                | `collab.invite.sent` (`actionable`, in-app + email)                                                                                                                                                                                 | landed            |
| `policy acknowledge`, `upload_batch retry_failed`, `event extend_upload_window`, `selfie retry`, `subscription complete_mandate` | the routes exist; no shared domain service is extracted for them                                                                                                                                                                    | landed            |

So the RED has two distinct halves: two **pure rules** the endpoint cannot work
without (U1/U2), and the endpoint's observable behaviour over the real delegation
(I1–I7, E1).

## Decision

### 1. One module owns the two pure rules

`@/server/notifications/notification-actions` (new; the GREEN adds it) exports:

```ts
export const NOTIFICATION_ACTION_SERVICES = [
  "invitation_decision", // invitation × accept|reject  → decideInvitation (via in_app)
  "retry_charge", //        subscription × pay_now     → the billing retry service
  "checkout_url", //        subscription × complete_mandate
  "reprocess_failed", //    upload_batch × retry_failed
  "policy_acknowledge", //  policy × acknowledge
  "extend_upload_window", // event × extend_upload_window
  "selfie_redirect", //     selfie × retry
] as const;

export type NotificationActionService = (typeof NOTIFICATION_ACTION_SERVICES)[number];

export interface NotificationActionDelegation {
  readonly service: NotificationActionService;
  readonly decision?: "accept" | "reject"; // invitation rows only
}

export function resolveActionDelegation(input: {
  readonly kind: unknown;
  readonly actionKey: unknown;
}): NotificationActionDelegation | null;

export interface DelegateResult {
  readonly outcome: "applied" | "already_resolved" | "unavailable";
  readonly targetState: string;
  readonly resolvedVia?: string;
  readonly redirectUrl?: string;
}

export interface ActionOutcomeView {
  readonly outcome: "applied" | "already_resolved" | "unavailable";
  readonly alreadyResolved: boolean;
  readonly resolvedVia: string | null;
  readonly targetState: string;
  readonly redirectUrl: string | null;
  readonly message: string;
}

export function mapActionOutcome(result: DelegateResult): ActionOutcomeView;
```

`resolveActionDelegation` covers the **seven** §7.3 rows and answers `null` for
everything else — an unlisted pair, an unknown kind, an absent or non-string
input. U1 pins each row separately (so a wrong mapping cannot hide inside an
`it.each` of the happy set), the six cross-kind pairs §7.3 does not list, and the
four malformed-input arms.

`mapActionOutcome` projects a delegated result onto the endpoint's six outcome
keys and **never invents a fact**: a result with no `resolvedVia` maps to
`null` (not to a default channel), `alreadyResolved` is `true` only for
`already_resolved`, and the view carries exactly six keys. U2 pins the three
arms, the no-invention arms, the key set, and that the first click and a replay
read differently to the user.

### 2. The endpoint's contract

`app/api/v1/me/notifications/[id]/actions/[actionKey]/route.ts`, `POST`,
auth `user`, rate `write.normal` (the rate class is **not** pinned here).

- The caller's own row is loaded first: `404 not_found` for an unknown,
  malformed or **foreign** id — never `403`, so the endpoint is not an existence
  oracle (the `me/sessions` precedent). I5 pins both the foreign id and the
  unknown id.
- `actionKey` must be one of the row's `actions[].key` **and** one of the seven
  rows the dispatch table knows (`422 validation_failed` otherwise). I6 pins both
  arms; the second is what makes `resolveActionDelegation`'s `null` reachable.
- `200` always carries exactly the nine §7.3 keys
  `{ notificationId, actionKey, outcome, alreadyResolved, resolvedVia,
targetState, actions, redirectUrl, message }`. I1 and I4 assert the **exact**
  sorted key set, so a delegated service's own fields (`id`, `status`,
  `membership`, `billingTransactionId`, `pollUrl`) cannot leak through the
  response.
- `actions` is the row **re-read after** the delegation, projected as
  `{ key, label, state }` — the same row the next `GET /me/notifications`
  serves. I1 and E1 compare the response's pairs with the feed's.
- `410` only for a `revoked`/`expired` invitation (propagated from the
  delegated service). I3 deliberately clicks an affordance whose cached
  `state` is already `"unavailable"`: the endpoint must **not** short-circuit on
  the denormalised field, or the truthful `410` becomes a `422`.
- The endpoint calls no other HTTP route. The invitation arm calls
  `decideInvitation` with `via: "in_app"`; the billing arm calls the retry
  service with an idempotency key derived from `notificationId + actionKey`.

### 3. Idempotency, measured as state as well as status

Every repeat-call pin asserts the persisted effect:

| Case                     | Status arm                                     | State arm                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I1 accept twice          | `200 applied` then `200 already_resolved`      | one `event_organizers` row, one `collab.invite.accepted`, feed + response `unavailable` after the first                                                                              |
| I2 email token then feed | `200 already_resolved`, `resolvedVia: "email"` | one membership row, one accepted event, closure stamped with the email channel                                                                                                       |
| I4 `pay_now` twice       | `applied` then `already_resolved`              | **one** `pending` charge for `pendingDueMinor`, one distinct payment provider ref (the memory provider mints its payment id from the idempotency key, so one id = one vendor charge) |
| I4 demoted owner         | `403 forbidden`                                | zero charge rows, affordance still `available`                                                                                                                                       |

### 4. Authorization is the delegated service's

A notification is not a permission. I4 demotes the workspace owner to `member`
**after** the notification was sent and pins the delegated owner gate's own
`403 forbidden` with nothing charged. The endpoint may not answer a `200`
`unavailable` for that case (a refusal is not an outcome), and it may not invent
a status: A-5.

## Alternatives considered

- **Delegate by calling the sibling HTTP routes internally.** Rejected: §7.3
  says the endpoint owns no state, and re-entering the routes would rebuild
  authentication, tenancy and idempotency stages from a fabricated request while
  losing the caller's already-admitted principal.
- **Answer `422`/`409` when the cached `actions[].state` is `unavailable`.**
  Rejected by §7.1's "may be briefly stale" rule and pinned against by I3: the
  owning document must answer (`410 invitation_revoked`).
- **Answer `applied` on a repeated `pay_now`** because the provider dedupes on
  the idempotency key. Rejected: the response would report a fresh charge the
  user must not expect twice, and the card's acceptance criterion is "never
  `409` for repeated actions" with an explicit `already_resolved` outcome. A-3.
- **Inline the billing charge in the endpoint.** Rejected: the ledger intent,
  the eligibility decision and the owner gate belong with the retry service; the
  GREEN extracts them so both the route and the endpoint share one path.
- **Put the dispatch table in the route module.** Rejected: the table is the
  §7.3 contract, and U1 must pin it without Mongo, a request or a principal.

## Consequences

- **The GREEN must extract the billing charge path into a service** that both
  `POST /tenants/{t}/billing/retry-charge` and this endpoint call, with the
  owner gate inside it (A-5's `403` has to come from there).
- **The invitation arm reuses `decideInvitation`** unchanged; the endpoint's
  only contribution is `via: "in_app"` and the projection.
- **The response schema must be strict** (the pipeline serialises through it), so
  a service field added later cannot silently widen the body; I1/I4's exact key
  set is the pin that says so.
- **A payout-class detail is frozen:** a repeated `pay_now` writes no second
  charge intent. If a later card wants one ledger row per attempt, it must
  supersede A-3 explicitly.
- **The pool cell is contested.** The in-flight OP-139 branch (`t_7da4009d`, PR
  #780) holds `0918`–`0937` and its ledger copy advances the same
  `unallocated (future lanes)` cell from `0938`. When it merges after this
  record, that hunk must **not** rewind the cell below `0962`, and the OP-139
  lane row has to be added beside ours — the merge, not this card, owns that
  reconciliation.
- **No production file is in the diff**, so the PR is a draft by design; `unit`,
  `test_coverage` and `ci` fail on the two missing modules (that is the RED).

## Assumptions

- **A-1** — the `200` body is exactly the nine keys §7.3's example documents; a
  rich delegated answer is projected onto them.
- **A-2** — a `subscription` notification's `actionTarget.id` names the
  `subscriptions` row and the row's `tenantId` names the workspace whose owner may
  act.
- **A-3** — a repeated `pay_now` is `already_resolved` and writes no second
  charge intent (the key is derived from `notificationId + actionKey`).
- **A-4** — for `pay_now`, `targetState` reports the subscription's own status
  (`past_due`): the charge is confirmed by a webhook, never by this response.
- **A-5** — a delegated refusal is propagated with its own status and code; the
  endpoint invents none.
- **A-6** — I2 seeds the invitee's feed row directly. The trunk's fan-out writes
  **no** in-app row for an **email** invitee: recipient resolution reads
  `invitee.userId`, which nothing stamps at create time, and the OP-89 lazy
  hook's re-emit reuses the create-time dedupe key. That gap is OP-89's lane; the
  row seeded here is exactly the schema §19.4 shape the feed serves, and the
  token decision plus its `updateMany` closure still run through the real
  routes.
- **A-7** — E1 invites the **`user`** channel (the id is read from the invitee's
  own `GET /me`), because that is the only channel whose fan-out writes an in-app
  row on the trunk. Measured, not assumed: the first draft of E1 invited by
  e-mail and failed at `the invitation never reached the invitee's in-app feed`
  after a 20 s poll.

## Out of scope

- `complete_mandate`, `upload_batch retry_failed`, `policy acknowledge`,
  `event extend_upload_window` and `selfie retry` are pinned **only** by U1's
  mapping. Their delegated integrations are not exercised: each needs its own
  service extraction and fixture, and none is in the card's I/E list.
- The `write.normal` rate class is not pinned (no rate harness in this file).
- The `pay_now` affordance's _closure_ in the feed is not pinned: the card's
  closure criterion is the invitation story (I1, I2, E1).
- The OP-89 e-mail-invitee in-app row gap (A-6) is routed, not repaired.

## Evidence

All commands ran in `/root/openpic/openpic-webapp/.worktrees/t_5d080821` with
`TMPDIR=/root/tmp-mongo`; the integration project boots its own
`MongoMemoryReplSet`. A throwaway probe implemented the pinned module and route
(both deleted before handoff) to prove the specs are **satisfiable and
assertion-level**:

```
npx vitest run --project unit apps/web/src/test/unit/notification-actions.test.ts
  → Test Files 1 passed (1) · Tests 28 passed (28)

npx vitest run --project integration apps/web/src/test/integration/notification-actions.test.ts
  → Test Files 1 passed (1) · Tests 10 passed (10)

TMPDIR=/root/tmp-mongo pnpm build && npx playwright test -c apps/web/playwright.config.ts \
  --project api -g "E1: an invitee accepts from the feed"
  → 1 passed (1.1s)   # the whole journey over a real next start server
```

The probe's route (`apps/web/src/app/api/v1/me/notifications/[id]/actions/[actionKey]/route.ts`)
carried `sha256 42a4b7af6c2cb1c25fa9b2a59474ff92d42117fbdcc66d44ff0fc794512ecd46`
and was restored to that hash byte-identically after each mutation.
`npx tsc -p apps/web/tsconfig.json --noEmit` and `npx eslint` on the three spec
files were clean with the probe present.

Two mutation probes prove the pins are load-bearing:

1. **Drop the owner-role check** (`membership === null || role !== "owner"` →
   `membership === null`): I4's demoted-owner case reds as
   `AssertionError: expected 200 to be 403`.
2. **Derive a per-click idempotency key** (`…:${actionKey}` →
   `…:${actionKey}:${Date.now()}`): I4's happy case reds at the replay assertion
   (`AssertionError: expected { …(9) } to match object { …(5) }` — the second
   click answers `applied` instead of `already_resolved`), so "applied exactly
   once" is measured, not assumed.

With both probe files deleted the RED is honest and module-level:

```
Error: Cannot find package '@/server/notifications/notification-actions'
  imported from …/unit/notification-actions.test.ts        → Tests no tests
Error: Cannot find package '@/app/api/v1/me/notifications/[id]/actions/[actionKey]/route'
  imported from …/integration/notification-actions.test.ts → Tests no tests
```

The e2e journey cannot run on the RED tree by design (ADR-0306): `next build`
type-checks the whole project, so a missing module leaves no standalone server to
test against. The probe run above is the evidence that the spec drives the real
path — it reached the journey's own assertions and passed them.

## GREEN — implementation (card `t_39c2bf80`)

The GREEN adds three production files and edits no test, factory, helper or
fixture. The pins were made green as written.

| File                                                                         | What it owns                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/server/notifications/notification-actions.ts`                  | The two pure rules: `NOTIFICATION_ACTION_SERVICES`, `resolveActionDelegation` (the §7.3 `Map` table — a `Map`, so a hostile `kind` such as `toString` resolves to nothing) and `mapActionOutcome` (the six-key projection).                                                                                            |
| `apps/web/src/server/billing/charge-outstanding.ts`                          | `startOutstandingCharge`: the shared charge path — owner gate, `decideRetryEligibility`, the `pending` intent written before the provider call, the E11000 replay answer and the refs. The retry-charge route now calls it too, so both "Pay now" surfaces charge through one code path (the Consequences item above). |
| `apps/web/src/app/api/v1/me/notifications/[id]/actions/[actionKey]/route.ts` | The endpoint: own-row load (`404`), row-action and §7.3 checks (`422`), delegation to `decideInvitation` / `startOutstandingCharge`, the nine-key strict `200` body with the re-read affordance, and the `info notification.action` line.                                                                              |

Decisions the GREEN settled where the RED left room:

- The `pay_now` idempotency key is `notification-action:<notificationId>:<actionKey>`.
  The ledger replay check runs **before** eligibility, so a repeat stays
  `already_resolved` even after the due is settled; the unique index still guards
  the concurrent case (E11000 → the same answer, no `5xx`).
- The five §7.3 rows with no extracted domain service answer `unavailable` (a
  documented `shortcut:` comment in the route); U1 pins their mapping and their
  integrations are the ADR's out-of-scope list.
- Client-IP-keyed rate limiting fails open (test harness) for `write.normal`,
  the same behaviour every class-keyed route shows under the vitest harness.

Measured on the GREEN head: unit `192` files `3238 passed | 3 skipped`;
integration `154` files `1650 passed`; E1 `1 passed` over a real `next start`
server; `tsc --noEmit` clean; eslint/prettier clean on the four touched
production files; the `billing-self-serve` suite `37/37` after the shared-service
refactor.

**Ledger merge.** The RED branch was behind `origin/main` (OP-139, squash
`b1cec73e`); the merge kept both lane rows ascending, set the `OP-136 jobs lane`
and `unallocated (future lanes)` cells to `0962`, kept both ledger paragraphs and
is prettier-clean with the `adr-*` guards green.

## Review — round 1 (artifact lens, card `t_39c2bf80`)

Verdict **APPROVED WITH FINDINGS**; landed by squash on PR
[#810](https://github.com/yahodu/openpic-webapp/pull/810) from the reviewed
head `03e8105c`, on the trunk tip `895d368c` (`chore(release): 1.75.0`), with
the lane ledger unioned against the OP-139 records `ADR-0921`/`ADR-0922`.

Reproduced by the reviewer rather than taken from the handoff: `unit` 194 files
`3261 passed | 3 skipped`, `integration` 158 files `1673 passed`, the focused
`28` unit and `10` integration cases of this contract, the seven `adr-*` guards
`248 passed`, the three pin files byte-identical to the RED head
(`e3a4f0af…`, `b6e61bff…`, `ca6bab98…`), the GREEN commit `03e8105c` carrying
four production files and nothing else, and 14/14 PR checks on that head
(including `ci`, which runs the Playwright suite). A diff-wide honesty scan
found no fixture-shaped constant, suppression, environment conditional or
console noise.

Findings, all beyond the pinned contract and routed rather than fixed:

- **F1 (Medium) — `pay_now` closes no affordance.** After `outcome: "applied"`
  the row still serves `actions: [{ key: "pay_now", state: "available" }]` and
  `actionTarget.state: "open"`; the closure is invitation-only. This record's
  own _Out of scope_ narrowed the acceptance criterion to the invitation
  story, so the implementation follows the accepted contract; the decision to
  keep that narrowing or supersede it is card `t_d08eeb7f`, which owns the
  TEST→GREEN fan-out. Latent today: `collab.invite.sent` is the only
  `actionable` catalogue entry.
- **F2 (Low) — five §7.3 rows answer `unavailable`** (a documented `shortcut:`
  comment). No stored checkout URL and no selfie redirect target exist on the
  trunk, so even those two rows need a design decision; `requeueImages` exists
  but needs its own adapter. Routed to `t_d08eeb7f`.
- **F3 (Low) — `I4` does not measure "the provider is asked once".** Measured
  in a throwaway worktree: a replay branch that re-issued `chargeOnce` and
  rewrote the refs stayed green, because `recordChargeRefs` `$set`s and the
  memory provider mints the payment id from the idempotency key. The extra arm
  is routed to the pre-created TEST card `t_b4c8f1d9`.

Recorded as Info, no card: the retry-charge route's default
`idempotency-key` fallback is unreachable (`required: true`), `isDuplicateKeyError`
is duplicated across four `server/` modules, `ratelimit.limiter_failed` logs
`error` and fails open on every class-keyed route under the harness, and an
`unavailable` outcome reports the cached `actionTarget.state` as its
`targetState`. Nothing in §1–§4 or the Assumptions is retracted; the follow-up
cards' own records document what followed.

## Round 2 — the closure is general; the five remaining §7.3 rows are deferred

- **Status:** Accepted (round 2) · **Date:** 2026-11-23
- **Card:** `t_b1bebbc8` (OP-140 DOCS, Low) — the decision is the orchestrator's
  (`t_d08eeb7f`), the pins are `t_b8461910`, the GREEN is `t_8d9e090c`
  ([ADR-0944](ADR-0944-op140-notification-action-affordance-closure.md)).
- **Branch:** `OP-140-task-adr0942-round2-decision` · **Worktree:**
  `/root/openpic/openpic-webapp/.worktrees/t_5d080821` (base `origin/main` `45a571ba`,
  `chore(release): 1.79.0`).
- **Touches:** this record only. `docs/adr/README.md` is **not** edited: this card mints no
  ADR number, so the `OP-140 notifications lane` cell stays `0945`.
- **Measurements:** every `file:line` below was read on the trunk at `45a571ba`. None is
  copied second-hand from a handoff.

### 1. F1 is superseded, not kept

The round-1 review of the GREEN recorded **F1 (Medium)**: after a successful `pay_now` the
feed row still served `actions[0].state: "available"`. This record's own _Out of scope_
bullet made that look sanctioned, and it is now **retracted**:

> The `pay_now` affordance's _closure_ in the feed is not pinned: the card's closure
> criterion is the invitation story (I1, I2, E1).

The narrowing contradicted two sources, and both are general, not invitation-shaped:

- ticket `t_39c2bf80` scope §4: _"After a successful transition the shared close-affordance
  helper (OP-121) runs."_
- `docs/API Contract.md` §7.3 (`:2642`): _"After any successful transition the server runs
  the `notifications.updateMany` fan-out (§2.3 rule 3), so the same decision is closed in
  every channel and on every device on the next poll."_

What landed — squash **`6a438ffa`** (PR [#818](https://github.com/yahodu/openpic-webapp/pull/818),
head `b9dce20b`, 14/14 checks on that head):

| File                                                                         | What it owns                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/server/notifications/action-affordance.ts` (new)               | `closeActionAffordance(db, {kind, id}, now, {via?, session?})` — `:26`; one `updateMany` on the pair `{"actionTarget.kind","actionTarget.id"}` (`:37`), kind-generic, session-aware |
| `apps/web/src/server/collaboration/invitation-transition.ts`                 | `closeInvitationAffordance` is a thin wrapper around the helper (`:104`) and stays inside the decision transaction                                                                  |
| `apps/web/src/app/api/v1/me/notifications/[id]/actions/[actionKey]/route.ts` | the `retry_charge` arm closes after the delegate answers `applied` or `already_resolved`, keyed on the row's own `actionTarget.kind` (`:150`)                                       |

Measured on the GREEN: focused `20 passed (20)`; `unit` `194` files `3261 passed | 3 skipped`;
`integration` `159` files `1692 passed`; `tsc` 0; `eslint` 0; `prettier --check` clean; the
seven `adr-*` guards `248 passed`. The record is **ADR-0944**, not the reserved `0943`: the
trunk consumed `0943` in flight ([ADR-0943](ADR-0943-op140-notification-action-residual-pins.md),
card `t_b4c8f1d9`), so the GREEN took the higher lane cell `0944` and advanced the cell to
`0945`. Both records stand; neither number is reused.

Two residuals that the next delegate arm must know:

- **F-B (Low) — the placement is a convention, not a pin.** At the pin head `a18502b9` the
  focused suite is `20 passed (20)` with the helper present but the route closing **inline**.
  The pins see the behaviour (the row is closed); they cannot see _which write_ closed it. The
  single shared write is therefore a rule to follow by hand, not a property the suite defends.
- **F-A (Low) — the closed literal is not pinned.** A3/A4 assert `state !== "available"`; a
  route that wrote `state: "resolved"` stayed `20 passed (20)`, because the endpoint's
  projection types `state` as `z.string()`. Routed to `t_2f8d87e5` (TEST, characterization).

### 2. The five remaining §7.3 rows: all "wait"

**Decision: none of the five is implemented in OP-140.** Each needs a precondition that does
not exist on the trunk. The table names the precondition, the file that shows it, and the lane
that owns it.

| Row                                 | Shape                                      | What is missing (measured on `45a571ba`)                                                                                                                       | Named field / file                                                                                                                                                                                                                                           | Owner lane               |
| ----------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| `subscription` × `complete_mandate` | the row must carry the value               | The **create** path writes it; the **upgrade** path mints a row without it, and no delegate can read it                                                        | `subscriptions.checkout = {url, expiresAt}` — written at `billing/checkout/route.ts:422`, absent from the `insertOne` at `billing/upgrade/route.ts:336`, whose envelope returns `mandate.checkoutUrl` inline at `:414`/`:420`                                | billing / subscriptions  |
| `upload_batch` × `retry_failed`     | wait for a service, and for the right kind | the bulk reset, the enqueue and the admission live in the route handler, not in a service; the emit's subject kind is `user`                                   | `retryFailedEventImages({db, tenantId, eventId, actorUserId, spaceKey, requestId, now})`; `server/images/requeue.ts:42` is the per-row write only; `images:reprocess-failed/route.ts:37` is the `eventActorAdmission(2)` middleware and `:38-63` the handler | images                   |
| `policy` × `acknowledge`            | wait for a service, and for a producer     | the `consents` write is inside the route (`app/api/v1/me/consents/acknowledge/route.ts`, 115 lines); `legal.terms.updated` is emitted nowhere                  | `acknowledgeConsent({db, userId, policyVersion, now})`                                                                                                                                                                                                       | consent / DSR (OP-138)   |
| `event` × `extend_upload_window`    | wait for a contract decision               | the delegated route requires a body `{additionalDays}`, §7.3 pins "action-specific, usually `{}`", and no response field carries the new window end            | `app/api/v1/events/[eventId]/upload-window:extend/route.ts:77-79`                                                                                                                                                                                            | OP-140 contract decision |
| `selfie` × `retry`                  | wait for a service, and for a producer     | the contract's answer is `{ "redirectUrl": "/e/{slug}" }`; no `server/attendee` code resolves a slug from a row; `attendee.selfie.rejected` is emitted nowhere | the only builder is `server/events/access-links.ts:76-78`                                                                                                                                                                                                    | attendee / selfie        |

**Correction to the commissioning card's premise.** The card said nothing persists the
checkout URL. Measured: `POST /billing/checkout` **does** persist it
(`checkout/route.ts:422`) and `decideExistingSubscription` reads it
(`server/services/subscriptions/checkout.ts:163`) for its `reuse` arm. The gap is narrower and
it is still a blocker: a subscription minted by `POST /billing/upgrade` carries no `checkout`,
and the delegate has no read seam. No OP-140 pin until **every** mint path writes the field.

For `upload_batch`, the row already carries `tenantId`, `eventId` and `data.batchId`
(`server/uploads/batch-notifications.ts:299-305`), so the action needs no new payload — only a
emit whose `subjectRef.kind` is `upload_batch` (see §3, fact 4).

### 3. F4 (new, measured on the trunk) — the five rows are unreachable through the feed

An implemented delegate would be production code no user can reach. Four measured facts:

1. `server/notifications/fan-out.ts:456` returns `actionTarget: null, actions: []` for any type
   whose catalogue row is not `actionable`. For an actionable type the target is
   `{kind: subjectRef.kind, id, state: "open"}` (`:458`), and `actions` is a non-empty list
   **only for `kind === "invitation"`** (`:463-469`).
2. Exactly one catalogue entry carries `actionable: true`
   (`notification-types.values.ts:635`, `collab.invite.sent`; a grep for `actionable: true`
   returns that one line).
3. The endpoint refuses every other key **before** it delegates: `422` "is not an action of
   this notification" (`route.ts:200`) when the row does not offer the key, and `422` "has no
   §7.3 delegate" (`:214`) when the table does not know it. With `actions: []` the first arm
   fires on every request, whatever the key.
4. `actionTarget.kind` is the **emit's** `subjectRef.kind` (`:458`), and the emits disagree with
   §7.3: `billing.payment.failed` emits `subscription`
   (`server/billing/webhook-projection.ts:968` — the §7.3 kind), `event.upload_window.closing`
   emits `event` (`server/jobs/event-window-sweep.ts:94` — the §7.3 kind),
   `upload.batch.completed*` emits `user` (`server/uploads/batch-notifications.ts:299` — **not**
   the §7.3 kind), and `legal.terms.updated` and `attendee.selfie.rejected` are emitted by no
   code at all.

**The authorization wrinkle.** `billing.payment.failed` reaches the `billing_contact` audience
(`notification-types.values.ts:55` `BILLING = ["billing_contact"]`, `:361-369`), and
`getBillingContactUserId` returns `tenant.billingContactUserId`
(`server/repos/notification-recipients.ts:139-145`) — a field the **owner** may set to any
active member (`server/tenancy/permissions.ts:9-38`; it defaults to the owner at
`provisioning.ts:162`). `startOutstandingCharge` refuses a non-owner with `403 forbidden`
(`charge-outstanding.ts:97-105`, call at `:134`). So an actionable `pay_now` row needs a
**recipient** decision, not only a catalogue flip.

### 4. The producer decision

**4.1 The rule.** The producer must not emit a control the delegate will refuse. §7.1 lets a
_state_ be briefly stale; it does not license a button that always answers `403`.

**4.2 Which type keys flip `actionable: true`.** Exactly one, now: `billing.payment.failed`. It
is the only §7.3 row whose emit, delegate and closure all exist on the trunk — the emit at
`webhook-projection.ts:968`, the delegate `startOutstandingCharge`, the closure
`closeActionAffordance`. Every other row fails at least one of the three, as §2 and §3 show.
No other catalogue key changes. `actionable` stays data (§19.1); it says _this type offers an
action_, not _which keys_.

**4.3 The action key set each kind emits.** The set is **derived from the one §7.3 table**,
`DISPATCH_TABLE` in `server/notifications/notification-actions.ts:46-49`, never from a second
table in `fan-out.ts` — a second copy would drift from the contract. The table says which keys
a kind has; the target's own stored state says which of them is live **now**, because §19.4
renders at write time.

| `actionTarget.kind` | Key set                                         | Live when (read at write time)                                                                                                    |
| ------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `invitation`        | `accept`, `reject`                              | unchanged: the invitation is `pending`                                                                                            |
| `subscription`      | `pay_now` **or** `complete_mandate`, never both | `pay_now`: the row is `past_due`; `complete_mandate`: the row is `incomplete` with a stored `checkout.url` inside its `expiresAt` |
| `upload_batch`      | `retry_failed`                                  | the batch has at least one `failed` image                                                                                         |
| `policy`            | `acknowledge`                                   | the recipient has no `consents` row for the live terms version                                                                    |
| `event`             | `extend_upload_window`                          | the upload window is open                                                                                                         |
| `selfie`            | `retry`                                         | the row is `rejected`                                                                                                             |

**4.4 The recipient rule.** An action goes only to a recipient the delegate will accept. For
`subscription` × `pay_now` that is the workspace **owner**; a `billing_contact` member who is
not the owner keeps the notification and gets `actionTarget: null, actions: []`. The owner is
resolved **once per fan-out run** (one `tenantMembers` read), and the target's state once per
actionable event, never per recipient.

**4.5 The kind comes from the emit.** Because `actionTarget.kind` **is** `subjectRef.kind`
(`fan-out.ts:458`), a type that should carry a §7.3 kind must be emitted with that kind. Do not
add a type→kind table to the fan-out: it would be a third copy of a mapping the catalogue and
the emit already own, and the two would disagree the first time an emit changes.

**4.6 In scope: one producer slice.** The `pay_now` row is pinned next; its TEST card is
**`t_b27b8d1a`** (created by this card, `Consumes: 0945`, lane cell advances to `0946`). The
acceptance is fixed here, so that card does not need to invent it:

> A `billing.payment.failed` in-app row for a workspace **owner** carries exactly one action,
> `pay_now`, with `actionTarget` exactly `{kind: "subscription", id: <the subscription>, state: "open"}`.
> A click on it answers `200 applied`, writes **one** pending charge, and the next
> `GET /me/notifications` serves that action `unavailable` with `actionTarget.state: "resolved"`.
> The same notification for a billing contact who is **not** the owner carries no action.

**4.7 Out of scope: the five other rows.** Each stays deferred for the reason in §2, and each
reverses on one event:

- `complete_mandate` — reverses when the upgrade path persists `subscriptions.checkout` on the
  minted row and a delegate read seam exists.
- `retry_failed` — reverses when `retryFailedEventImages` exists and the batch emit carries
  `subjectRef {kind: "upload_batch"}`.
- `acknowledge` — reverses when `acknowledgeConsent` exists and `legal.terms.updated` is emitted.
- `retry` — reverses when an event-slug resolver exists under `server/attendee` and
  `attendee.selfie.rejected` is emitted.
- `extend_upload_window` — reverses when the contract decides the body (fixed increment or
  `{additionalDays}`) and names a response field for the new window end.

The order is deliberate. The producer slice is the only one that ships a control a user can
press to a successful end today. The other four would ship a control that answers `unavailable`
at best and `422` at worst — the exact failure §4.1 forbids.

The four service preconditions are carded together as **`t_37ecac39`** (`openpic-orchestrator`:
route each one into its owner lane, `Consumes: none`). `extend_upload_window` is **not** in
that card: it needs the contract decision first.

### 5. Evidence

```
prettier --check docs/adr/ADR-0942-op140-notification-action-endpoint-red.md
  → clean

vitest run --project unit adr-
  → Test Files 7 passed (7) · Tests 248 passed (248)

git ls-tree -r --name-only HEAD -- docs/adr | grep -oE 'ADR-[0-9]{4}' | sort | uniq -d
  → empty

git diff --stat origin/main...HEAD
  → 1 file changed, +202/−0 (this record)
```

The route, the helper, the catalogue and the fan-out are **not** in this diff. This card
changes the record only; the code changes belong to the cards named in §4.6 and §4.7.
