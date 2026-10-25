# ADR-0500 — OP-111 RED: the billing cron jobs — dunning, reminders, renewals, scheduled changes, reconciliation and the projection sweep

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-111 RED (`t_41558165`) · **Branch:** `OP-111-task-billing-jobs` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_41558165`
- **Relates to:** [ADR-0028](ADR-0028-internal-hmac-and-cron-framework.md) (the `defineCronJob` framework, the §10.2 envelope and the `src/server/jobs/**` import boundary these jobs are declared on), [ADR-0440](ADR-0440-op108-webhook-inbox-red.md) / [ADR-0441](ADR-0441-op108-webhook-inbox-green.md) (the inbox row the projection sweep re-processes, and the projected-transaction shape it drives), [ADR-0480](ADR-0480-op110-self-serve-billing-red.md) / [ADR-0481](ADR-0481-op110-self-serve-billing-green.md) (the pending one-time charge the sweep's `payment_succeeded` heals), [ADR-0460](ADR-0460-op109-plan-change-red.md) / [ADR-0461](ADR-0461-op109-plan-change-green.md) (the `scheduledChange` shape `scheduled-plan-changes` applies), [ADR-0008](ADR-0008-platform-settings-green-implementation.md) / [ADR-0007](ADR-0007-platform-settings-singleton.md) (the `platformSettings.dunning` tunables every window here reads), [ADR-0074](ADR-0074-op92-message-transport-red-pins-followup.md) (the resolve-then-lint technique the C6 boundary pin reuses), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §10.2 (the cron table and rules 1–4), §10.2.1 (the C6 code rule), §10.1.2 (the webhook → projection mapping the sweep re-runs), §9.10 (the settings tunables) · **Schema:** §14.3 (`subscriptions`), §18.4 (`providerWebhookEvents`) · **Doc:** `docs/Subscription flow.md` §4.3 (the no-deletion-on-downgrade promise)

## Context

OP-111 is the platform-side half of the billing lane: the crons that make billing
**eventually correct** when nobody is watching. §10.2 names six of them for this
story:

```
POST /api/v1/internal/cron/dunning                    hourly     past_due + gracePeriodEndsAt < now → downgraded; writes nothing else
POST /api/v1/internal/cron/dunning-reminders          4×/day     grace-day schedule from settings.dunning.reminderDays, idempotent
POST /api/v1/internal/cron/renewal-reminders          daily      active + nextChargeAt within 3 days, once per cycle
POST /api/v1/internal/cron/scheduled-plan-changes     hourly     scheduledChange.effectiveAt <= now → apply and clear
POST /api/v1/internal/cron/billing-reconcile          4 h        incomplete > 1 h or stuck past_due → provider fetchStatus, correct drift
POST /api/v1/internal/cron/webhook-projection-sweep   5 min      processedAt: null and receivedAt < now − 60 s → re-project
```

Four sentences shape the design:

- **Never touch content.** C6 (§10.2.1): _"the dunning worker module may import
  **only** the `subscriptions` repository"_, and `docs/Subscription flow.md`
  §4.3 promises users that a downgrade deletes nothing. The card's I1 asks for a
  collection-level diff, not a code review.
- **Conditional single-document updates only.** §10.2 rule 1: every transition
  puts the expected prior state in the filter, so "a lost race matches zero
  documents and is a no-op, not corruption".
- **Bounded work per invocation.** §10.2 rule 2: `?limit=` + `hasMore`, so the
  scheduler re-invokes instead of the job looping.
- **Never emit notifications inline.** §10.2 rule 3: jobs write `domainEvents`;
  the fan-out consumer delivers. That is why I1's diff admits `domain_events`
  beside `subscriptions` and nothing else.

The card pins six integration behaviours and three units. It does not pin module
paths, the reminder idempotency token, the renewal cycle identity, the reconcile
window's field, or how the C6 lint boundary is spelled. This record fixes those,
because the gated GREEN card `t_71cc5e0c` must implement them in one pass.

## Decision

### Module contract

| Module (specifier)                               | Exports                                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@/server/billing/jobs/dunning-reminders`        | `resolveDueReminderDay(input: ReminderDueInput): ReminderDue \| null` (pure), `ReminderDueInput` / `ReminderDue`, and the job's business logic `runDunningReminders(...)`                                    |
| `@/server/billing/jobs/renewal-reminders`        | `decideRenewalReminder(input: RenewalWindowInput): RenewalDue \| null` (pure), `RenewalWindowInput` / `RenewalDue`, and `runRenewalReminders(...)`                                                           |
| `@/server/billing/jobs/dunning`                  | `runDunning(...)` — **the C6-guarded module**: the only repository it may import is the subscription one, and the only fields it may write are `status`, `activePlanKey`, `statusHistory`                    |
| `@/server/billing/jobs/scheduled-plan-changes`   | `runScheduledPlanChanges(...)`                                                                                                                                                                               |
| `@/server/billing/jobs/billing-reconcile`        | `runBillingReconcile(...)` — the only job that reaches `getPaymentProvider().fetchStatus`                                                                                                                    |
| `@/server/billing/jobs/webhook-projection-sweep` | `runWebhookProjectionSweep(...)` — selects inbox rows older than 60 s and calls the exported `projectProviderWebhookEvent` unchanged                                                                         |
| `@/server/billing/billing-cron-jobs`             | `dunningJob`, `dunningRemindersJob`, `renewalRemindersJob`, `scheduledPlanChangesJob`, `billingReconcileJob`, `webhookProjectionSweepJob` — the six `CronJob`s, wired like `services/notification-cron-jobs` |
| `@/app/api/v1/internal/cron/<job-name>/route`    | `POST` — the internal HMAC stage + the §10.2 `CronResult` (the `run-cron-route` wiring)                                                                                                                      |

A runner takes `{ db?, clock?, limit }` and returns a `CronRunOutcome`
(`{ scanned, affected, skipped, errors, hasMore, details? }`); `defineCronJob`
wraps it in the §10.2 envelope. `scanned` counts rows examined, `affected` rows
actually transitioned (a lost race counts as `skipped`), and
`hasMore = scanned === limit`.

### The reminder due-day computation (U1)

`resolveDueReminderDay({ gracePeriodEndsAt, settings, now })` returns
`{ day, key, isFinal } | null`:

- the grace window starts at `gracePeriodEndsAt − settings.dunning.gracePeriodDays × 24 h`
  — **never** a hard-coded 14 (§10.1.2) — and `day = floor((now − start) / 24 h) + 1`;
- `null` before the window opens and at/after `gracePeriodEndsAt` (the `dunning`
  job owns the past-grace transition);
- a reminder is due only on a day in `settings.dunning.reminderDays`;
- `key = "d" + day` — the token `dunning.remindersSent` stores (schema §14.3),
  which is what makes the job idempotent under retries;
- `isFinal` marks the last schedule day, the only day §10.2 allows the payload's
  `mobile` hint to be `true`.

The 24-hour bucket (rather than a calendar day) is deliberate: the window is
derived from an instant, the job runs 4×/day, and a calendar-day reading would
need a per-tenant timezone this module must not read.

### The renewal window (U2)

`decideRenewalReminder({ status, nextChargeAt, currentPeriodEnd, cancelAt, remindersSent, now })`
returns `{ key } | null`:

- only `status: "active"` renews;
- the window is `0 < nextChargeAt − now <= 3 days` (the charge instant itself is
  not "upcoming" — the payment webhook is the signal once it arrives);
- the cycle token is `renewal:<currentPeriodEnd ISO>`, so a reminder already sent
  for **this** cycle suppresses a second one while a previous cycle's token does
  not;
- `cancelAt !== null` suppresses the reminder (a period-end cancel will not be
  charged), and a missing `currentPeriodEnd` has no cycle to key on, so it is
  `null` rather than a reminder that could fire twice.

### The C6 boundary (U3)

`eslint.config.mjs` gains one config object scoped to
`apps/web/src/server/billing/jobs/dunning.ts`, placed **after** the
`apps/web/src/server/**` object (flat config _replaces_ a rule's options, so an
earlier object would be overwritten — ADR-0074 §"Implementation caveat"),
carrying a `no-restricted-imports` pattern group naming the six content
repository namespaces of §10.2.1 — `events`, `eventImages`, `mediaAssets`,
`imageFaces`, `faceMatches`, `selfies` — each as the bare alias
`@/server/repos/<namespace>` plus its trailing-segment form. The boundary is
**preventive**: `@/server/repos` is today the generic, tenant-stamping layer and
the six per-collection modules do not exist yet (nor do the `imageFaces` /
`selfies` collections), which is exactly why §10.2.1 asks for a lint rule rather
than a review habit. The pattern group must stay precise — a blanket
`@/server/repos/**` ban would also block the subscription repository the rule
exists to permit, so both the barrel and `@/server/repos/subscriptions` are
pinned as **valid**.

The pin drives the repository's real flat config (resolve with
`ESLint.calculateConfigForFile`, then run the core rule through `RuleTester`)
rather than snapshotting config text: `parserOptions.projectService` makes
`lintText` on a synthetic path fail before any rule runs (ADR-0074 §AC1).
`builtinRules` (the deprecated `eslint/use-at-your-own-risk` entrypoint) is the
only supported way to hand a core rule to a flat-config `RuleTester`; the single
`eslint-disable-next-line @typescript-eslint/no-deprecated` carries that
rationale.

### The I1 whole-database diff

I1 snapshots **every** collection (documents canonicalised by
`JSON.stringify`, so Dates are ISO strings and ObjectIds are hex) before and
after a dunning run over a tenant that owns events, images, assets, face matches
and attendee profiles, and asserts the changed set is exactly
`["domain_events", "subscriptions"]`. Any other write — a counter, a ledger row,
a content row — fails the assertion **by name**. The pin also asserts the run
really happened (`affected: 1`, `status: "downgraded"`, `activePlanKey: "free"`,
one `statusHistory` entry, one `billing.subscription.downgraded` event), so an
implementation that does nothing cannot pass by being inert.

### Reconcile and sweep seams

`billing-reconcile` reaches the provider through the shipped Cashfree adapter's
`GET {base}/pg/subscriptions/{id}` (§11.1) behind MSW, and the 1 h window is
driven with **both** `createdAt` and `updatedAt` set to the same stale instant so
the pin is about the window rather than which stamp the implementation reads.
The negative control (a 10-minute-old `incomplete`) asserts **zero** provider
calls — that is the reason the window exists.

`webhook-projection-sweep` is pinned through the OP-108 failure seam rather than
a stub: the ledger collection is created with a validator no document can satisfy
(`{_id: {$exists: false}}`), so a real signed `SUBSCRIPTION_PAYMENT_SUCCESS`
webhook is acknowledged `200` and its deferred projection fails, leaving the
inbox row `processedAt: null, processResult: "error"`. The case repairs the
ledger, ages the row past 60 s and runs the sweep: the subscription heals
(`active`, `pendingDueMinor: 0`, `gracePeriodEndsAt: null`), the row settles
(`processResult: "applied"`), and `billing.payment.succeeded` is on the outbox.

## Consequences

- **The GREEN owns one new lint object.** `no-restricted-imports` must be
  redeclared with the C6 patterns for the dunning module; the logging/Novu
  patterns are unaffected elsewhere. The spec runs the resolved options, so a
  boundary placed early (and therefore overwritten) fails `Should have 1 error
but had 0` — the same failure an absent boundary produces.
- **Three negative controls cannot fail on the trunk** and are deliberate
  regression guards, not RED: I4's sub-hour `incomplete` (no provider call),
  I5's sub-60-second inbox row (left unprocessed) and I7's not-yet-due scheduled
  change (no write). Every other assertion in the two new spec files fails
  before the implementation exists.
- **Two derived cases sit beside the card's six** (marked `(derived)` in the
  spec's titles): I7 (`scheduled-plan-changes` applies and clears a due
  `scheduledChange`, emits `billing.plan.downgrade_applied`) and I8
  (`renewal-reminders` fires once per cycle). Both are §10.2 rows and both are
  named by the card's own user story; without them those two jobs could ship as
  route-shaped no-ops.
- **`dunning` writes `domain_events`, and that is the only extra collection.**
  If a later change has the job write, say, `tenants.counters` for observability,
  I1 fails by name — which is the intended pressure to keep that write out of the
  job.
- The `renewal:<periodEnd>` token lives in `dunning.remindersSent` beside the
  grace `d{n}` keys. It is one array with two key grammars, which is a deliberate
  reuse of the schema's single idempotency field rather than a new column; a
  future ADR that splits them must repin U2's "a previous cycle's token does not
  cover this one" case.
- **Number allocation.** OP-111 is a dependent ticket and does not continue
  OP-110's `0480`–`0499` (ADR-0300 §7), so this lane drew the allocator's next
  block: **`0500`–`0519`**, `Next free = 0501`, pool advanced to `0520`+.

## Alternatives

- **A per-tenant timezone calendar day for the reminder schedule.** Rejected: the
  job would need a timezone the grace window never had, and the grace window is
  itself an instant. The 24-hour bucket is total and deterministic under an
  injected clock.
- **Pinning the reminder idempotency with a separate `renewalReminderSentAt`
  column.** Rejected in favour of `dunning.remindersSent`: schema §14.3 already
  defines that array as the idempotency field, and a new column would need its
  own index and migration note for no behavioural gain.
- **A blanket `@/server/repos/**` ban on the dunning module.** Rejected: the rule
  §10.2.1 states permits the subscription repository, and a blanket ban would
  block it — the boundary must name the six content namespaces.
- **Asserting the C6 rule by snapshotting `eslint.config.mjs` text.** Rejected
  (ADR-0074 §AC1): a text assertion passes on a boundary that is declared but
  overwritten by a later config object, which is the failure mode that matters
  under flat config.
- **Stubbing the projection to produce an unprocessed inbox row.** Rejected in
  favour of the collection-validator poison: the row is written by the real route
  and the real projection fails, so nothing in the spec reaches inside the
  projection's implementation.

## Evidence at the RED head

`tsc -p apps/web/tsconfig.json --noEmit` exits `0` against temporary contract
stubs (since deleted — `git status` shows the four spec files only), so every
pin is type-correct. With those stubs in place the suites fail at **assertion
level**, not by module resolution:

- unit — `dunning-reminders.test.ts` + `renewal-reminders.test.ts` +
  `eslint/dunning-content-import-boundary.test.ts`: **18 failed | 19 passed (37)**,
  including `expected null to deeply equal { day: 5, key: 'd5', isFinal: false }`
  and, for the boundary, `Should have 1 error but had 0: []`;
- integration — `billing-crons.test.ts`: **16 failed | 3 passed (19)** with
  `expected [] to deeply equal [ 'domain_events', 'subscriptions' ]` (I1),
  `expected [ +0, +0 ] to deeply equal [ +0, 1 ]` (I2),
  `expected +0 to be 1` (I3, I4, I8), `expected { job: 'dunning', …(8) } to match
object { scanned: 1, affected: 1, …(1) }` (I6) and `expected 500 to be 200`
  (the route ladder). The three passes are the negative controls listed above.

At handoff (stubs removed) both suites are red as **module-not-found** for
`@/server/billing/billing-cron-jobs`, `@/server/billing/jobs/dunning-reminders`,
`@/server/billing/jobs/renewal-reminders` and the six
`app/api/v1/internal/cron/<name>/route` modules — the OP-93/ADR-0306
RED-by-design posture. `eslint` reports 0 problems and `prettier --check` is
clean on all four files.

## Open questions for the GREEN

- Should `billing-reconcile` also emit `admin.billing.manual_review` when the
  provider's status contradicts ours in a way it cannot safely auto-apply? The
  card names the emit but not the mismatch class; only the resolvable drift (and
  its "no alert") is pinned.
- The `details` payload of each job's `CronResult` (§10.2's example carries
  `{ downgraded: 7 }`) is not pinned beyond shape — the framework validates
  `details` as a record and no assertion here depends on a specific counter.
