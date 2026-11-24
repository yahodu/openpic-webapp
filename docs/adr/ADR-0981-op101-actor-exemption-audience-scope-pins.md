# ADR-0981 — OP-101: the billing-contact actor exemption is pinned as **audience-scoped**, and the `billing.plan.upgraded` side effect with it

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** OP-101 TEST (Medium, review finding F1) `t_dd0046f3` (openpic-webapp-testcase-writer) · **Branch:** `OP-101-task-downgrade-actor-scope-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_dd0046f3`
- **Lane:** OP-101 follow-up (request-side billing record) · **Consumes:** `0981` — a **pool draw** ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18: the board-wide block `0300`–`0319` is exhausted and the OP-101 lane holds no reserved row), verified by the four-surface sweep below; the four pool-mirror cells read `0981` and advance to `0982`
- **Spec sources:** contract §3.3 (`POST …/billing/upgrade`); schema §18.3 (`domainEvents`), §19.1 (`notificationTypes`), §19.4 (`notifications`), §19.5 (`notificationDispatches`); notification design §2 (audiences), §4.3 (the payer is the recipient, with no actor exclusion), §4.5 (event-lifecycle audiences carry "minus the actor"), §5 (fan-out)
- **Consumers:** `apps/web/src/test/integration/billing-plan-upgraded-delivery.test.ts` (new, 2 cases)
- **Relates to:** [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) (§D3, the decision this pack makes executable), [ADR-0980](ADR-0980-op101-downgrade-scheduled-event-green.md) (§D4 implemented it; §Consequences names the side effect), [ADR-0979](ADR-0979-op101-downgrade-scheduled-event-pins.md) (the sibling pack whose `D1`–`D3` cannot discriminate the rule), [ADR-0460](ADR-0460-op109-plan-change-red.md) (the upgrade fixture and its vendor stubs), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the pool-draw rule), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)

## Context

[ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) §D3 decided that `resolveRecipients` must not
remove an id the `billing_contact` audience resolved, and said why in one sentence: _the rule is
audience-scoped, not `typeKey`-scoped_. [ADR-0980](ADR-0980-op101-downgrade-scheduled-event-green.md) §D4
shipped it — `apps/web/src/server/notifications/fan-out.ts:403-408` fills a `payers` set in the
`billing_contact` arm and `:425` skips the actor exclusion for an id in that set.

The review card `t_a24b1dc1` then measured that the pins cannot tell the decision from the rule it
rejects. A `typeKey`-scoped variant of the same splice

```ts
const typeKeyScoped = typeRow.typeKey === "billing.plan.downgrade_scheduled";
if (actorUserId !== null && !(typeKeyScoped && payers.has(actorUserId))) {
```

still read `15 passed (15)` on `apps/web/src/test/integration/billing-downgrade-scheduled-event.test.ts`
at `e91cfed7` — by construction, because every delivery case in that file uses the one type a
`typeKey`-scoped rule would spare.

Two further gaps were routed to the same card, both re-measured below and neither landed as a pin:
the absent-`currentPeriodEnd` repeat (ADR-0978 §D2's `dedupeKey` carries the instant, which the route
mints per request) and the concurrent double-submit (ADR-0980 §Consequences records a `500` for it).

`billing.plan.upgraded` is the narrowest discriminating case: it is the only other `BILLING`-audience
type emitted with a **user** actor today (`upgrade/route.ts:389-391`), its audience is
`billing_contact` alone (`notification-types.values.ts:405-412`), and `provisioning.ts:162` makes the
owner the contact — so under the shipped rule the owner receives it, and under the rejected rule the
actor is spliced out and the event reaches nobody. [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md)
§Consequences and [ADR-0980](ADR-0980-op101-downgrade-scheduled-event-green.md) §D4 both name that
delivery as a **side effect** of the decision, and `billing-plan-change.test.ts` `F1` pins only the
outbox row, never delivery.

## Decision

**One new focused integration spec carries the discriminator, and no production file changes.**
`apps/web/src/test/integration/billing-plan-upgraded-delivery.test.ts` — two cases, driven through
`POST …/billing/upgrade`, the real `runNotificationFanOut`, the real seeded catalogue and the real
`mongoRecipientRepository`; only the outbound transport is in memory.

**D1 — a new file, not an appended `describe` in `billing-plan-change.test.ts`.** That file has the
upgrade fixture and the vendor stubs, but it seeds no notification catalogue and has no drain, no
recipient preferences and no in-memory transport; reusing it would make a 30-case payments spec boot
the notification consumer's dependencies too. The card allowed the new file expressly for that reason.
The duplicated fixtures are the file-local ones the sibling downgrade spec already keeps its own copy
of (tenant, workspace, live subscription) — the same shape, one plan-change route over.

**D2 — `F1D` is the discriminator: the payer who acted still receives the event.** Owner upgrades,
the workspace's `billingContactUserId` is that owner (the provisioning default), the owner is
deliverable, the outbox is drained, and the case asserts **exactly one** in-app row and **exactly one**
rendered, `sent`, non-skipped email for `billing.plan.upgraded` whose stored body is the one the
transport carried. A `typeKey`-scoped exemption reads zero of both.

**D3 — `F1D` is guarded against a vacuous pass.** The case reads the outbox row **before** the drain
and pins `dispatch.notifications: "pending"`, then pins it `"done"` **after** the drain with
`summary.failed === 0`. "Zero rows" therefore cannot pass because the consumer never ran, or because
the row was never emitted.

**D4 — `F1E` is the anti-leak half, one type over, and it does not duplicate an existing pin.** When
the billing contact is a **different** active member, the upgraded event reaches the contact and not
the owner who upgraded, though both are deliverable — the sibling of the downgrade spec's `D2`. The
non-billing half of the rule (an actor in an `organizer` / `co_organizer` / `attendee_identified`
audience is still removed) stays at `server/notifications/fan-out.test.ts:265-280` and is **not**
re-pinned here; each case's docblock names which pin covers which half.

**D5 — the two routed items were measured, reported, and not pinned.** A pin of either would freeze a
race outcome or a bug as an answer:

- _absent `currentPeriodEnd`_ — the §14.3 field **absent** (not `null`: an explicit `null` fails the
  route's stored schema and answers `500`, `expected date, received null`) makes
  `downgrade/route.ts` schedule at `now`, and the §D2 `dedupeKey` carries that instant, so **two
  identical requests produce two events**: measured `[200, 200]`, `2` rows, keys
  `…:free:2026-11-24T21:00:03.042Z` and `…:free:2026-11-24T21:00:03.066Z`, `2` feed rows and `2` sent
  emails (probe quoted below). Whether the route should instead refuse with no period to schedule
  against (the open question `billing-plan-change.test.ts` `F5` already files) or derive a stable
  instant is a **product decision**: a behaviour change needs its own ADR, so this pack routes it;
- _concurrent double-submit_ — eight independent rounds of `Promise.all([request, request])` each
  answered `[200, 200]` with **one** event (probe quoted below), which is **not** the `500`
  [ADR-0980](ADR-0980-op101-downgrade-scheduled-event-green.md) §Consequences records as settled.
  That is a decision-level contradiction, not a pin: the outcome is a function of when the two
  transactions interleave (WriteConflict → retry → the in-transaction re-read sees the committed
  row), so any pin would be timing-dependent on one side of a race. Routed to the orchestrator with
  the measurement.

**D6 — no production file, and the sibling spec's bytes are untouched.** `fan-out.ts`,
`upgrade/route.ts` and `billing-downgrade-scheduled-event.test.ts` are not in the diff; its 15 cases
keep their assertions byte-identically, and it is re-run under the mutation below as a control.

## Consequences

- The near-miss class is closed: any future re-scoping of the exemption away from the audience — the
  exact `typeKey`-shaped refactor the review card demonstrated — now reds `F1D` on a type that has
  nothing to do with the downgrade it was written for.
- **Cost:** one 2-case integration file (~5.5 s focused). Both cases are green on the shipped tree, so
  this PR is test-only and its CI is green: it is not a RED-by-design pack.
- **The pin is a characterization of a shipped decision**, not of incidental behaviour: if the payer is
  ever deliberately excluded again, `F1D` is the case that must be renegotiated, not silently deleted.
- **Reversal condition:** a product decision to silence the payer's own actions (§4.3 re-read) — that
  ADR supersedes [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) §D3 and this pack is
  renegotiated with it, in one card.
- **Left open, on purpose:** the absent-period-end repeat and the concurrent double-submit (D5). Both
  are routed; neither has a pin that would need retracting when the decision lands.

## Numbering

The board-wide / process block `0300`–`0319` is exhausted and the OP-101 lane holds no reserved row
([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18), so this record draws from the
pool cursor. The card did not carry a number; the four-surface sweep at this cut (`origin/main`
`45a0d43d`) finds `0981` held by nothing:

```
$ git rev-parse --short origin/main                                   45a0d43d
$ ls docs/adr | grep -oE 'ADR-09(7[5-9]|8[0-9])' | sort -u
                                                                     0975 0976 0977 0978 0979 0980
$ git rev-list --objects --all | grep -oE 'ADR-09(7[5-9]|8[0-9])' | sort -u
                                                                     ADR-0975 … ADR-0980   # highest anywhere
$ for d in /root/openpic/openpic-webapp/.worktrees/*/; do ls "$d/docs/adr" | grep -oE 'ADR-09(8[0-9])'; done | sort -u
                                                                     ADR-0980 ADR-0981
  # 0981 resolves only inside this card's own worktree (.worktrees/t_dd0046f3) — no sibling holds it
$ gh pr list --state open --json number,headRefName
                                                                     909 OP-101-task-dedupe-seam
                                                                     896 OP-132-task-adr-item-section-pins
$ gh api repos/…/contents/docs/adr?ref=<each open head> | grep '^ADR-098'
                                                                     #909 → 0980 ; #896 → none
$ python3 <read-only board probe over the 7 non-done cards>
                                                                     t_dd0046f3 0980 (this card)
                                                                     t_e3a344af 0980
                                                                     no card holds 0981 in `Consumes`
```

The four cells that read `0981` — `board-wide / process`, `OP-129 attendee identity lane`, `OP-136
jobs lane`, `unallocated (future lanes)` — advance to **`0982`** (forward only; no cell is lowered and
no range is re-cut).

## Evidence

**Green on the shipped tree** (`origin/main` `45a0d43d`), focused:

```
$ TMPDIR=/root/tmp-mongo npx vitest run --project integration \
    apps/web/src/test/integration/billing-plan-upgraded-delivery.test.ts
✓ F1D: delivers one in-app row and one rendered email to the owner who is the billing contact
✓ F1E: delivers to a different billing contact and not to the owner who upgraded
Test Files  1 passed (1)
     Tests  2 passed (2)
```

**Red against the rejected rule** — the `typeKey`-scoped variant of `fan-out.ts:425` quoted in
§Context, applied to the shipped file and the two specs run together:

```
× F1D: delivers one in-app row and one rendered email to the owner who is the billing contact
    AssertionError: expected [] to have a length of 1 but got +0
✓ F1E: delivers to a different billing contact and not to the owner who upgraded
Test Files  1 failed | 1 passed (2)
     Tests  1 failed | 16 passed (17)
```

`F1E` is green under both rules by construction — with a different billing contact the actor is not in
the `payers` set either way — which is exactly why `F1D` is the discriminator and `F1E` the control. The
16 passes are `F1E` plus the downgrade spec's `15 passed (15)`, reproducing the review card's finding
on the same tree.

The probe was reverted with `git checkout -- apps/web/src/server/notifications/fan-out.ts` and the file
is byte-identical to its pre-probe state:

```
$ sha256sum apps/web/src/server/notifications/fan-out.ts     (before == after)
c6a0cd457c05d25efb1bd70fc1624901333c7158827f6b0e9484d52cc9421481  …/server/notifications/fan-out.ts
$ git status --porcelain
?? apps/web/src/test/integration/billing-plan-upgraded-delivery.test.ts
```

**The two routed measurements** (throwaway probe file, deleted before the commit; the suite's console
is silenced, so the probe appended its findings to a scratch file):

```
P2 {"statuses":[200,200],"events":2,
    "dedupeKeys":["billing.plan.downgrade_scheduled:<sub>:free:2026-11-24T21:00:03.042Z",
                  "billing.plan.downgrade_scheduled:<sub>:free:2026-11-24T21:00:03.066Z"],
    "payloads":[{"fromPlanKey":"professional","toPlanKey":"free","effectiveAt":"…:03.042Z"},
                {"fromPlanKey":"professional","toPlanKey":"free","effectiveAt":"…:03.066Z"}],
    "feed":2,"emails":2}
P3 [{"statuses":[200,200],"events":1}, … eight rounds, all {"statuses":[200,200],"events":1}]
```

`currentPeriodEnd` set to an explicit `null` rather than unset answered `500` on both requests with
`Invalid input: expected date, received null` — recorded because the finding is about the **absent**
field, and the two shapes are not interchangeable.

**Static gates on the delivery head.** Measured on the tree merged with `origin/main` `03a5fbd5`
(the head this record ships on). `pnpm typecheck` answered `0` on all three projects
(`tsconfig.json`, `packages/contracts`, `apps/web`); `npx eslint` on the new spec reported `0 errors,
0 warnings`; `npx prettier --check` on the spec, this record and the ledger is clean; the ten `adr-*`
guard files answered `10 files / 320 passed (320)`; the whole `unit` project answered
`201 files / 3401 passed | 3 skipped (3404)`, exit `0`; and the whole `integration` project answered
`167 files / 1812 passed (1812)`, exit `0` — the `166 / 1810` the trunk carried plus this file's one
file and two cases. `billing-downgrade-scheduled-event.test.ts` is byte-identical (it is not in the
diff) and its `15 passed (15)` are inside the integration count.

The discriminator was re-measured on that same merged tree and answered `2 passed (2)` focused and
`1 failed | 16 passed (17)` against the `typeKey`-scoped variant, `F1D` alone, with `fan-out.ts`
restored to `sha256 c6a0cd45…`.

## Round-1 review sign-off

- **Reviewer:** `openpic-webapp-reviewer` · **Round:** 1 (artifact lens) ·
  **Card:** `t_dd0046f3` · **Verdict: APPROVED WITH FINDINGS** — the findings are beyond the pinned
  criteria, not against them.
- **Verified on the merged artifact, not the narrative.** PR
  [#911](https://github.com/yahodu/openpic-webapp/pull/911) head `2190e25c`, squash `f0422e2e`:
  `git diff 2190e25c f0422e2e` is empty (byte-identical) and `f0422e2e` is an ancestor of
  `origin/main`; the diff against its parent is exactly three files (847 insertions, 5 deletions) —
  the new spec, this record, and the ledger, whose 8 insertions and 5 deletions are the four
  pool-mirror cells and ADR-0980's forward pointer.
- **Checks re-run by the reviewer on a detached worktree at `f0422e2e`:** focused new spec
  `2 passed (2)`; the single-key `typeKey` mutation of `fan-out.ts:425`
  `1 failed | 16 passed (17)` (`F1D` alone, `expected [] to have a length of 1 but got +0`), with
  `fan-out.ts` restored to
  `sha256 c6a0cd457c05d25efb1bd70fc1624901333c7158827f6b0e9484d52cc9421481`;
  `unit` 201 files / `3401 passed | 3 skipped (3404)`; `integration` 167 files /
  `1812 passed (1812)`; `tsc` `0` / `0` / `0` on the three projects; the ten `adr-*` guard files
  320 passed (320); prettier clean on the spec, this record and the ledger; every
  `gh pr checks 911` check `pass` (`ci`, `lint`, `test_coverage`, `secret-scan`, `audit`, CodeQL).
- **Findings routed by card id, not by ADR number** — an unmerged record may renumber before it
  lands, so the routing is the card:
  - **F1 (Low) — §Consequences' "the near-miss class is closed" holds for the single-key shape
    only.** A `typeKey` **list** variant —
    `new Set(["billing.plan.downgrade_scheduled", "billing.plan.upgraded"])` gating the splice —
    reads `17 passed (17)`: the shipped rule's own answer, so the pair does not tell a two-key
    scope from the audience scope. Routed to `t_8217bd99` (a synthetic-`typeKey` unit pin over the
    exemption).
  - **F2 (Medium) — the two §D5 items were measured but not routed.** No board card existed for the
    absent-`currentPeriodEnd` duplicate (two events, two feed rows, two emails) or for
    [ADR-0980](ADR-0980-op101-downgrade-scheduled-event-green.md) §Consequences' recorded `500`
    against the eight measured `[200, 200]` rounds. Routed to `t_cb891a2c` (orchestrator
    decision), because both are product decisions rather than pins.
- **Recorded, no card:** `F1E` is a control, not a discriminator, exactly as §Evidence says — and the
  reviewer's probe shows it is load-bearing against the "spare the actor as such" shape: adding the
  actor for every `billing_contact` type and skipping the splice reds `F1E` **and** the downgrade
  spec's `D2` (`2 failed | 15 passed (17)`). The ~250 lines of fixture helpers this pack duplicates
  from `billing-downgrade-scheduled-event.test.ts` are accepted under §D1: extracting them would
  have touched that file's bytes, which the commissioning card forbade.
- **Nothing in §D1–§D6 or §Evidence is retracted.** Every figure above stands at the merged head;
  the one sentence this review narrows is §Consequences' "closed" claim, and the narrowing is routed
  (F1) rather than re-stated here.
- **Post-review status when this section was written.** Both routings had been picked up. F1's card
  `t_8217bd99` shipped the type-key-agnostic pin as PR
  [#917](https://github.com/yahodu/openpic-webapp/pull/917) (squash `c28cc394`): a synthetic
  `billing.plan.probed` type in `fan-out.test.ts` that neither a single key nor an enumerated list can
  spare, so the narrowing above is pinned by a unit case as well as stated here. F2's card `t_cb891a2c`
  decided both §D5 behaviours — `[200, 200]` with one event for the concurrent double-submit, and a
  refusal for a live row with no `currentPeriodEnd` — and routed them to `t_9eafff78`, `t_e05af75c` and
  `t_b4d8d70e`; none of those follow-up records has landed at this head.
