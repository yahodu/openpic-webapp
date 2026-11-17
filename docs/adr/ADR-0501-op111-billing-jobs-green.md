# ADR-0501 — OP-111 GREEN: the billing cron jobs implemented — dunning, reminders, renewals, scheduled changes, reconciliation and the projection sweep

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-111 GREEN (`t_71cc5e0c`) · **Branch:** `OP-111-feature-billing-jobs-green` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_71cc5e0c` · **Base:** the pins head `9bb1aa8`
- **Relates to:** [ADR-0500](ADR-0500-op111-billing-jobs-red.md) (the RED contract implemented here, unedited), [ADR-0028](ADR-0028-internal-hmac-and-cron-framework.md) (the `defineCronJob` framework, the §10.2 envelope and the internal HMAC stage the routes are guarded by), [ADR-0443](ADR-0443-op108-concurrent-projection-ordering-green.md) (the projection this sweep re-runs), [ADR-0481](ADR-0481-op110-self-serve-billing-green.md) (the pending intent a healed `payment_succeeded` settles), [ADR-0461](ADR-0461-op109-plan-change-green.md) (the `scheduledChange` block applied here), [ADR-0074](ADR-0074-op92-message-transport-red-pins-followup.md) (the resolve-then-lint technique the C6 boundary spec drives), [ADR-0008](ADR-0008-platform-settings-green-implementation.md) (the `platformSettings.dunning` tunables), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §10.2 (the cron table, rules 1–4), §10.2.1 (the C6 code rule), §10.1 step 6 (the deferred projection the sweep re-runs), §9.10 (the settings tunables) · **Schema:** §14.3 (`subscriptions`), §18.4 (`providerWebhookEvents`) · **Doc:** `docs/Subscription flow.md` §4.3 (the no-deletion-on-downgrade promise)

## Context

OP-111's RED ([ADR-0500](ADR-0500-op111-billing-jobs-red.md)) pinned four specs and
left the module paths, the two pure functions, the C6 lint boundary and the route
wiring to this card. The suite this GREEN had to turn green:

```
apps/web/src/test/unit/dunning-reminders.test.ts              U1  14 cases
apps/web/src/test/unit/renewal-reminders.test.ts              U2  13 cases
apps/web/src/test/unit/eslint/dunning-content-import-boundary.test.ts  U3
apps/web/src/test/integration/billing-crons.test.ts           I1–I8 + the route ladder
```

Three of those assertions are structural rather than behavioural, and they shaped
most of the design: **I1** diffs _every_ collection in the database and asserts the
changed set is exactly `["domain_events", "subscriptions"]`, **I2** runs two
`dunning` jobs concurrently and asserts the `affected` sums are `1`, and **U3**
resolves the repository's real flat config and runs the core `no-restricted-imports`
rule over it. None of them can be satisfied by a plausible-looking implementation.

## Decision

### Module contract (as RED pinned it)

| Module                                                 | Exports                                                                                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `@/server/billing/jobs/run-options`                    | `BillingJobRunOptions` (`{ db?, clock?, limit }`) — the seam every runner takes                                                           |
| `@/server/billing/jobs/dunning`                        | `runDunning(...)` — **the C6-guarded module**                                                                                             |
| `@/server/billing/jobs/dunning-reminders`              | `resolveDueReminderDay(input)`, `ReminderDueInput`, `ReminderDue`, `runDunningReminders(...)`                                             |
| `@/server/billing/jobs/renewal-reminders`              | `decideRenewalReminder(input)`, `RenewalWindowInput`, `RenewalDue`, `runRenewalReminders(...)`                                            |
| `@/server/billing/jobs/scheduled-plan-changes`         | `runScheduledPlanChanges(...)`                                                                                                            |
| `@/server/billing/jobs/billing-reconcile`              | `runBillingReconcile(...)` — the only `getPaymentProvider().fetchStatus` caller                                                           |
| `@/server/billing/jobs/webhook-projection-sweep`       | `runWebhookProjectionSweep(...)` — calls the exported `projectProviderWebhookEvent` unchanged                                             |
| `@/server/billing/billing-cron-jobs`                   | `dunningJob`, `dunningRemindersJob`, `renewalRemindersJob`, `scheduledPlanChangesJob`, `billingReconcileJob`, `webhookProjectionSweepJob` |
| `app/api/v1/internal/cron/{six}/route.ts`              | `POST` behind the internal guard, answering `cronResultSchema`                                                                            |
| `app/api/v1/internal/cron/_lib/run-billing-cron-route` | `runBillingCronRoute(request, route, job)` — the shared route body                                                                        |

### One runner shape for all six jobs

Every runner reads a **bounded candidate window** (`find(...).sort(...).limit(limit)`)
and then performs one **conditional `findOneAndUpdate` (or `updateOne`) per row whose
filter carries the prior state**. Three consequences fall out, and they are exactly
what the integration suite pins:

- `scanned` is the number of candidates selected, so `hasMore = scanned === limit`
  (I6: `?limit=1` over three due rows reports `{ scanned: 1, affected: 1, hasMore: true }`,
  and the next default-limit run reports `{ affected: 2, hasMore: false }`);
- a lost race matches **zero** documents and is counted `skipped`, never a second
  write (I2: `[0, 1]`);
- the batch read never materialises a backlog larger than `limit` (§10.2 rule 2).

The runners take `{ db?, clock?, limit }` and return a `CronRunOutcome`; the
composition module closes over `getDb()` and `defineCronJob` wraps the result in the
§10.2 envelope. This is deliberately the `@/server/services/notification-cron-jobs`
shape.

### `dunning` — the C6 module

`{ status: "past_due", gracePeriodEndsAt: { $lt: now } } → { status: "downgraded",
activePlanKey: "free", statusHistory: [<one appended entry>] }`, plus one
`billing.subscription.downgraded` outbox row. Nothing else. I1's whole-database diff
admits exactly `domain_events` and `subscriptions`; a counter, a ledger row or a
content row would fail the assertion **by name**. The module imports only the
`@/server/repos` barrel (for `platformRepo`) and its own `./run-options`.

### Reminders and renewals

`resolveDueReminderDay` returns `{ day, key: "d" + day, isFinal }` where the window
opens at `gracePeriodEndsAt − settings.dunning.gracePeriodDays`, the day is the
24-hour bucket `floor((now − start) / 24 h) + 1`, and `isFinal` is the schedule's
last day (the only day §10.2 allows the `mobile` payload hint to be `true`). The
idempotency token is stored by a conditional `$push` on `dunning.remindersSent` with
`"dunning.remindersSent": { $ne: key }` in the filter, so a retry — or a concurrent
run — is a no-op (I3's `first.affected === 1` / `second.affected === 0`).

`decideRenewalReminder` is the strict future window `0 < nextChargeAt − now <= 3 d`
for `status: "active"` rows with no `cancelAt` and a `currentPeriodEnd`, keyed
`renewal:<periodEnd ISO>` — the same `dunning.remindersSent` array, one array with
two key grammars (ADR-0500 §Consequences).

### Reconcile and the sweep

`billing-reconcile` selects `incomplete`/`past_due` rows whose **`createdAt` and
`updatedAt` are both** older than one hour. The double stamp is the load-bearing
detail: I4's negative control seeds a row created 10 minutes ago but stamped
`updatedAt` a month earlier, so a window read off a single stamp would reach the
provider and fail `provider.calls() === 0`. A correction is a conditional
`updateOne` filtered on the prior `status`; a resolvable drift emits **no** domain
event (I4 asserts the tenant's outbox is empty) and logs at `warn`; the
`admin.billing.manual_review` mismatch class stays out of scope (ADR-0500
§"Open questions").

`webhook-projection-sweep` selects `processedAt: null` **and**
`receivedAt < now − 60 s` and calls the shipped `projectProviderWebhookEvent(id,
{ db, clock })` — the very seam the route defers through — then re-reads the row:
`processedAt instanceof Date` → `affected`, else `errors`. It reaches into no
projection internals, which is why I5's poisoned-ledger fixture works at all.

### The route wiring, and `cronBearerAnyMethod`

Six `POST` route modules, each a one-liner over `runBillingCronRoute`, which mirrors
`_lib/run-cron-route.ts`: the internal HMAC stage, `defineCronJob`, the `?limit=`
query, `cronResultSchema`.

The pins drive that ladder with a `POST` carrying **only**
`Authorization: Bearer ${getConfig().cron.secret}` and expect `200`. That is _not_
what the shipped auth policy allows: `authorizeInternalRequest` grants the
`CRON_SECRET` exception only to a `GET` under the cron prefix — a deliberate
narrowing pinned on the trunk by `internal-hmac.test.ts` **U4b** ("rejects the
CRON_SECRET bearer on a non-GET cron request"), and the shape `docs/API Contract.md`
§0.3 documents for the `internal` label (shared secret **+** HMAC). Three sources
therefore disagree with the ladder, while §10.2's own table spells every one of
these crons as `POST` and `docs/Subscription flow.md` §4.3 calls them _"invoked by
your scheduler (Vercel Cron / a hosted cron pinging with a secret header)"_.

**Decision:** the cron exception is scoped by _path_, not by method, so it is
expressed as an **opt-in** on the existing stage — `cronBearerAnyMethod?: boolean`
on `InternalAuthStageOptions` / `AuthorizeInternalRequestInput`, threaded through
`internalAuthStage` — and only the six billing routes pass `true`. The default is
unchanged (`undefined` ⇒ GET-only), so U4b and every shipped route keep their
behaviour byte-for-byte, and the divergence lives in one explicit flag with one
call site rather than in a duplicated auth implementation. This widens nothing
in practice: `CRON_SECRET` already triggers these bounded, idempotent jobs via
`GET`, and the exception's scope (`/api/v1/internal/cron/**`) is what bounds it.

**Flagged to the Test Author:** if the intended reading is instead "the ladder
should present a _signed_ `INTERNAL_API_SECRET` POST, or a `GET`", the one-line
change in `billing-crons.test.ts`'s `cronRequest` helper makes the flag dead and it
can then be removed. It is recorded here rather than guessed at silently.

### The C6 lint boundary

`eslint.config.mjs` gains one config object scoped to
`apps/web/src/server/billing/jobs/dunning.ts`, placed **after** the
`apps/web/src/server/**` object (flat config replaces a rule's options, so an
earlier object would be overwritten — ADR-0074 §"Implementation caveat"). Its
`no-restricted-imports` patterns are generated from one
`CONTENT_REPO_NAMESPACES` array of the six §10.2.1 content namespaces, each
expanded to the bare alias `@/server/repos/<ns>`, its trailing-segment form, and
the canonical `**/server/repos/<ns>` / `**/server/repos/<ns>/**` specifiers. The
logging and Novu patterns are repeated in that object, because a later matching
object replaces the whole rule. `@/server/repos` (the barrel) and
`@/server/repos/subscriptions` stay valid — a blanket `@/server/repos/**` ban
would block the one repository the rule exists to permit.

## Consequences

- **Three RED negative controls stay green** and are regression guards, not
  evidence: I4's sub-hour `incomplete`, I5's sub-60-second inbox row and I7's
  not-yet-due `scheduledChange`.
- **`dunning` writes `domain_events`, and that is the only extra collection.** A
  later change that has the job write a counter or a ledger row fails I1 by name —
  the intended pressure to keep observability out of the job (contract §10.2 rule
  3: the fan-out consumer delivers).
- **`statusHistory` gains its first writers.** The §14.3 transition log was read
  (`services/subscriptions/view.ts`) but never written before this lane; the three
  transition jobs (dunning, scheduled changes and — indirectly — the projection)
  now append to it. A future reader that assumes a single writer must not.
- **`skipped` is meaningful again.** Because the reads are batched, a conditional
  write that matches zero documents is a real observable (`skipped`), which is the
  ADR-0500 reading of a lost race — a drain-loop implementation would have been
  indistinguishable from "no work left".
- **One shipped module gained an optional flag** (`internal-hmac.ts`). It is
  additive and default-preserving; ADR-0500's module table does not name it, so it
  is recorded here rather than assumed.
- **The `admin.provider.failing` escalation is not emitted.** The §10.2 row names it
  for "repeated failures"; the card's `webhook-projection-sweep` section scopes this
  lane to re-projecting, and the `errors` counter is what a later card would latch
  on. Recorded, not silently dropped.

## Alternatives

- **A drain loop (`while` + one `findOneAndUpdate` per iteration) for `dunning`.**
  Rejected: it cannot distinguish "the batch is empty" from "a concurrent run took
  the row", so `skipped` would be structurally always `0` and I2's lost race would
  be invisible.
- **Reusing `runNotificationCronRoute` verbatim for the six billing routes.**
  Rejected: it would make the ladder's `POST` + cron-bearer case answer `401`, and
  the alternative of relaxing `authorizeInternalRequest`'s default instead would
  break the shipped **U4b** pin. An explicit opt-in satisfies both.
- **A duplicated cron-bearer check inside the billing route helper** (parsing the
  bearer and comparing it constant-time there). Rejected: two implementations of one
  auth policy drift; the flag keeps a single policy function.
- **Reading the reconcile window off `updatedAt` alone.** Rejected by I4's negative
  control, which stamps a fresh `createdAt` against a stale `updatedAt`.
- **Stubbing the projection inside the sweep.** Rejected: I5's fixture is a real
  signed webhook whose real projection fails, so the sweep must call the real seam.
- **A blanket `@/server/repos/**` C6 ban.** Rejected: it would block the
  subscription repository the dunning module is required to use.

## Evidence at the GREEN head

- the four pins, unedited, are green: U1 `14 passed`, U2 `13 passed`, U3
  `10 passed` (`37 passed (37)` across the three unit specs), and
  `billing-crons.test.ts` **`19 passed (19)`**;
- `tsc -p tsconfig.json`, `-p packages/contracts/tsconfig.json` and
  `-p apps/web/tsconfig.json` all exit `0`;
- `eslint .` → `0 errors` (the 106 warnings are pre-existing, none on a touched
  file), `prettier --check .` clean;
- `vitest run --project unit --project integration --coverage` exits `0` with the
  global thresholds met — 201 files, `2714 passed | 3 skipped`; statements
  `92.29 %`, branches `80.79 %`, functions `96.55 %`, lines `92.67 %` (measured at
  the reviewed head `a9aa770`, the pins head `9bb1aa8` merged with `origin/main`
  `d79a3f2`; the only conflict was the shared `docs/adr/README.md` ledger,
  union-resolved).
- PR Checks run
  [40217176682](https://github.com/yahodu/openpic-webapp/actions/runs/40217176682)
  on head `a9aa770` is **success** (`validate-branch-name`, `validate-pr-title`,
  `env-changes`, `secret-scan`, `lint`, `unit_test`, `test_coverage`, `audit` and
  the aggregate `ci` gate). `audit-dev` is red and **non-blocking by design**
  (`continue-on-error: true`, ADR-0301): 5 pre-existing `undici` advisories in the
  dev toolchain, with no dependency or lockfile change in this lane.
- The diff is production code plus this ADR and the README ledger cells — **no
  test, mock, fixture or factory is edited**; the pins are carried into the PR
  byte-unchanged.

## Number allocation

OP-111 is a dependent ticket and holds its own block (`0500`–`0519`, ADR-0300 §7).
`0500` is consumed by the RED, so this record takes **`0501`**, the lane cell's value
re-read on the pins head immediately before committing; the lane's `Next free`
advances to `0502`. No number outside `0500`–`0519` is touched.

## Review sign-off — 2026-10-25 (card t_71cc5e0c, round 1 · artifact lens)

Append-only: nothing above is retracted or edited. This section records the
round-1 review of [PR #352](https://github.com/yahodu/openpic-webapp/pull/352)
(the OP-111 billing-jobs GREEN, branch `OP-111-feature-billing-jobs-green`,
card `t_71cc5e0c`) by this lane's reviewer, and it consumes **no** ADR number
— the OP-111 lane `Next free` cell stays `0504` and `docs/adr/README.md` is
unchanged. The pins record [ADR-0500](ADR-0500-op111-billing-jobs-red.md)
shipped in the same squash and is covered here (see its "Carried unchanged —
PR #352" note) rather than in a section of its own.

**Verdict: APPROVED WITH FINDINGS, shipped as `5ecfc18`** — the squash-merge
of PR #352 (`feat(billing): OP-111 billing cron jobs — dunning, reminders,
renewals, scheduled changes, reconcile and the projection sweep (#352)`,
2026-10-25 17:54:13), carrying the pins commit `9bb1aa8` and the GREEN head
`d6f3983`. The reviewed head was the branch's `origin/main` merge `c8aeb30`
(parents `d6f3983` + `origin/main`).

**Criteria → evidence, measured by the reviewer on the merged tree in a
private probe worktree.**

- **Tree identity over the merge** — the merge-head diff
  `git diff d6f3983 c8aeb30 -- apps packages eslint.config.mjs` prints
  nothing: the `origin/main` merge into the GREEN branch touched only
  main's docs.
- **The four pins byte-identical** — `git rev-parse 9bb1aa8:<spec>` equals
  `git rev-parse HEAD:<spec>` at `c8aeb30` for
  `apps/web/src/test/unit/dunning-reminders.test.ts`,
  `apps/web/src/test/unit/renewal-reminders.test.ts`,
  `apps/web/src/test/unit/eslint/dunning-content-import-boundary.test.ts` and
  `apps/web/src/test/integration/billing-crons.test.ts`, and each blob is
  also identical at the squash `5ecfc18`.
- **Focused unit 66 passed (66)** — U1 `14`, U2 `13`, U3 `10`,
  `adr-numbering` `29`.
- **Integration `billing-crons.test.ts` 19 passed (19)** — re-run at `c8aeb30`
  **and** at the squash `5ecfc18`.
- **`checkAdrDirectory` 29/29** on the merged ledger — the only conflicted
  file was `docs/adr/README.md`, an index-only union rather than a renumber
  collision.
- **Prettier clean** — `prettier --check docs/adr/README.md` passes.
- **CI / PR Checks on `c8aeb30`** — success (run
  [40218811181](https://github.com/yahodu/openpic-webapp/actions/runs/40218811181),
  aggregate `ci` last), with `audit-dev` red-and-non-blocking by design
  (ADR-0301), and the CI Evidence Guard pass (run
  [40218221027](https://github.com/yahodu/openpic-webapp/actions/runs/40218221027)).

**Findings, each marked with its disposition.**

- **F1 (Medium, routed → card `t_f7717e2c` (TEST) → `t_2f274985` (GREEN))** —
  `admin.billing.manual_review` is not emitted for the reconcile mismatch
  class the §10.2 row names.
- **F2 (Medium, routed → the same two cards)** — the reconcile classes
  unpinned (72.7 % lines / 58.5 % branches).
- **F3 (Low, pinned inside `t_f7717e2c`)** — the reconcile two-stamp
  requirement (`updatedAt` missing ⇒ never reconciled) is only a window
  reading, not a pin; the missing-stamp case was unpinned.
- **F4 (Info, decision inside `t_f7717e2c`)** — `cronBearerAnyMethod`
  (flagged to the Test Author in §"The route wiring"): the ladder's
  `POST` + cron-bearer shape conflicts with the GET-only default the trunk
  pins (U4b); the flag records the divergence.
- **F5 (Info, no card)** — main's `board-wide / process` README paragraph
  left unwrapped by the union resolution.
- **F6 (Info/hotspot, no card)** — the concurrent worker that pushed the
  `origin/main` merge `c8aeb30` while the review started.

**Post-review status.** F1 and F2 are **addressed** by card `t_2f274985`
(GREEN; PR [#365](https://github.com/yahodu/openpic-webapp/pull/365), merged
as `f61d425`, 2026-10-26): `billing-reconcile.ts` now emits
`admin.billing.manual_review` for the crossing-only mismatch class (auto-apply
only drift toward `active`; mismatch writes nothing and is counted `skipped`),
and the admin-alert pins from `t_f7717e2c`
(`billing-cron-admin-alerts.test.ts`, 11 cases) landed in the same squash,
closing the reconcile coverage gap. F3 is **addressed** — `t_f7717e2c` pinned
the two-stamp candidate filter (a missing stamp is not fresh; both-present
rows keep the `AND`), shipped with PR #365. F4 is **resolved by decision**
inside `t_f7717e2c`: `cronBearerAnyMethod` is retained (the route-ladder
alternative was not adopted; U4b stays green). F5 is **resolved on `main`**
by the docs repair PRs #363 (`be9b072`, truncated board-wide tail deleted) and
#364 (`db0ca53`, OP-110 cell claim corrected) — no card was opened from F5
itself. F6 is **resolved as a process rule**: the run-level one-owner hazard
is codified in ADR-0308 §Recurrence (card `t_1deaf426`,
[PR #358](https://github.com/yahodu/openpic-webapp/pull/358)). No finding
remains open.

**Measurement note.** All figures above were re-measured for this append at
the post-follow-up trunk head `96bc00d`; the four pin files and the
`adr-numbering` spec are byte-identical across `9bb1aa8`, `c8aeb30`,
`5ecfc18` and `origin/main`, and the re-runs land at the same counts (unit
66/66, integration 19/19, `prettier --check docs/adr/README.md` clean). No
correction to the review's `c8aeb30`/`5ecfc18` pair is needed.
