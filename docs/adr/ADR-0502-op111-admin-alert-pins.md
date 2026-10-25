# ADR-0502 — OP-111 follow-up TEST: the §10.2 admin-alert escapes pinned (`admin.billing.manual_review`, `admin.provider.failing`) and the reconcile classes

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-111 follow-up TEST (`t_f7717e2c`) · **Branch:** `OP-111-task-admin-alert-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_f7717e2c` · **Base:** `origin/main` `5ecfc18`
- **Relates to:** [ADR-0500](ADR-0500-op111-billing-jobs-red.md) (the OP-111 RED contract, whose §"Open questions" named the `admin.billing.manual_review` class as unpinned), [ADR-0501](ADR-0501-op111-billing-jobs-green.md) (the GREEN, whose §Consequences recorded that `admin.provider.failing` is not emitted), [ADR-0029](ADR-0029-domain-event-outbox.md) (the outbox every alert is written through), [ADR-0008](ADR-0008-platform-settings-green-implementation.md) (the settings the reconcile windows read), [ADR-0306](ADR-0306-op93-red-by-design-ci.md) (the RED-by-design posture), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §10.2 (the cron table — the `billing-reconcile` and `webhook-projection-sweep` rows name the two emissions; rules 1–4), §10.1.2 line 3171 ("`admin.provider.failing` … always mobile"), §4.10 (the `platform_ops` catalogue) · **Schema:** §14.3 (`subscriptions`), §18.4 (`providerWebhookEvents`)

## Context

The OP-111 GREEN landed (PR [#352](https://github.com/yahodu/openpic-webapp/pull/352), squash `5ecfc18`).
Its round-1 review routed three findings that are _beyond_ the RED's pinned criteria here
rather than bouncing the GREEN:

- **F1** — §10.2 line 3224 names `admin.billing.manual_review` for the `billing-reconcile`
  row "on mismatch"; `billing-reconcile.ts` emits **nothing** (ADR-0500 §"Open questions").
- **F2** — `billing-reconcile.ts` measures 72.7 % lines / 58.5 % branches: the
  `past_due` reconcile class, the provider-error path and the no-`externalRefs` skip are
  unpinned.
- **F3** — the candidate filter requires `createdAt < now−1h` **and** `updatedAt < now−1h`;
  `{updatedAt: {$lt: …}}` does not match a document where `updatedAt` is missing, so a row
  carrying only one stamp can never be reconciled.
- **F4** (§10.2 line 3225, §10.1.2 line 3171) — `webhook-projection-sweep` names
  `admin.provider.failing` "on repeated failure"; the job only counts `errors`.

Three of those needed a _contract decision_ the card left to the Test Author, because no
document fixes them: what counts as a reconcile "mismatch", how many failures are
"repeated", and whether a missing stamp blocks reconciliation. This record fixes all three
so the gated GREEN (`t_2f274985`) implements one shape rather than guessing.

## Decision

### P1 — the reconcile mismatch predicate

**`billing-reconcile` auto-applies only drift toward `status: "active"`.** The missed
activation / reactivation webhook is idempotent, fabricates no side effects, and is exactly
what the job's own docstring names ("never activated" / "never reactivated").

**Every other status divergence is the `admin.billing.manual_review` class.** A provider
reporting `cancelled`, `expired` or `past_due` while we hold `incomplete`/`past_due` is a
transition whose side effects belong to the webhook that never arrived — the grace clock,
the dunning reset, a refund, an access cut. A reconciler that invents them would start
dunning or revoke access on a state no event explains, so the row is **left untouched** and
one outbox row is emitted:

```jsonc
{
  "eventKey": "admin.billing.manual_review",
  "tenantId": "<the subscription's tenant>",
  "actorRef": { "kind": "system", "id": "billing-reconcile" },
  "subjectRef": { "kind": "subscription", "id": "<hex>" },
  "payload": { "fromStatus": "<ours>", "toStatus": "<the provider's>" },
}
```

`subjectRef` is pinned because the card names it; `actorRef` is not pinned (no document
names it). A mandate-only drift (same `status`, different `mandateStatus`) stays resolvable
and is corrected silently — it is not a status mismatch.

### P2 — the repeated-failure threshold

**The sweep persists a consecutive-failure counter per inbox row and raises
`admin.provider.failing` on the third consecutive failed sweep, once per row.** Two
failures are the transient tolerance (a crash, a lock, a momentary write error — the very
reasons the sweep exists); three is a pattern worth paging on. The counter lives on the
`providerWebhookEvents` row (any field name; an absent counter reads as `0`) because the
sweep has no memory between invocations and the projection's own failure path only rewrites
`processedAt`/`processResult`/`processError`.

The escalation carries `payload.mobile: true` — §10.1.2 line 3171: a silent
payment-webhook failure means wrongful downgrades, so the alert is always mobile (the same
mechanism `billing.grace.reminder` uses for its day-13 hint). It is raised **once** per
failing row: a crossing-only emit, or a `dedupeKey` over the row id (the outbox's unique
partial index is live in the spec).

The alert's `tenantId` and `subjectRef` are **deliberately not pinned**: the inbox row
carries no tenant and §10.2 names no subject for this event, so the GREEN owns that choice
(see §"Open items").

### P3 — the reconcile classes and the two-stamp edge

- **`past_due` is a reconcile class** alongside `incomplete`: the missed _reactivation_
  webhook (provider `active`, we hold `past_due`) is corrected like the activation case.
- **A provider fetch that rejects** counts `errors += 1`, writes nothing and logs a `warn`
  with `event: "billing.reconcile.provider_error"` (the shipped surface; pinned now so a
  refactor cannot drop it).
- **A row with no subscription `externalRefs`** is counted `skipped`, never fetched.
- **A missing stamp is treated as _not fresh_.** A row carrying only one of
  `createdAt`/`updatedAt` is still a candidate, so the filter must be
  `($lt OR $exists:false)` per stamp. This is the load-bearing constraint: a row that is
  _stale by one stamp and fresh by the other_ must **stay unselected**, or
  `billing-crons.test.ts`'s I4 negative control (fresh `createdAt`, stale `updatedAt`,
  `provider.calls() === 0`) breaks. A both-present row therefore keeps the shipped **AND**.

### Route wiring (`cronBearerAnyMethod`)

**Not adopted.** The card offered the option of rewriting this lane's `cronRequest` helper
to sign its POST instead of relying on the shipped `cronBearerAnyMethod` opt-in
(ADR-0501 §"The route wiring"). This file does not drive the route ladder at all — it calls
the jobs through `CronJob.run`, exactly as `billing-crons.test.ts` does — so the opt-in is
untouched and the flag stays the GREEN's call (its card deletes it only "if the pins card
says it adopted the alternative"). Recorded, not silently dropped.

## Consequences

- **The two new emissions are RED-by-design on the trunk.** Six of the eleven new cases
  fail at this head (ADR-0306): the mismatch case because the job auto-corrects
  (`affected: 1` where `0` is expected), the two-stamp cases because the row is never
  selected (`provider.calls() === 0`), and three of the four sweep cases because no
  escalation exists. The five that pass are regression guards, not evidence: the
  resolvable-drift control, the `past_due` class, the provider-error path, the
  no-`externalRefs` skip and the below-threshold control.
- **`admin.billing.manual_review` is the first `platform_ops` alert emitted from a job.**
  The catalogue already carries both keys (`notification-types.values.ts`), so
  `emitDomainEvent`'s `eventKey` gate admits them; the reconcile alert needs the
  subscription's `tenantId`, which the candidate shape does not carry today — the GREEN
  must widen `ReconcileCandidate`.
- **The sweep alert has no tenant in the row.** Any non-empty `tenantId` satisfies the
  outbox contract; the choice is the GREEN's (below).
- **`docs/adr/README.md` is the shared-ledger hotspot** — a later merge is a union
  resolution.
- **Number allocation.** OP-111 holds `0500`–`0519`; `0500` (RED) and `0501` (GREEN) are
  consumed, so this record takes **`0502`**, the lane cell's value re-read immediately
  before committing. The cell advances to `0503`.

## Alternatives

- **Escalate on _any_ status difference (including `active`).** Rejected: it would page an
  operator for the one drift the job exists to heal, and it contradicts §10.2's
  "correct drift".
- **Escalate only on a _terminal_ provider status (`cancelled`/`expired`).** Rejected as
  too narrow: a provider `past_due` we cannot set the grace clock for is equally
  unresolvable, and the narrower rule needs a second list to maintain.
- **A run-level "spike" threshold (N failing rows in one sweep).** Rejected: the contract
  says "on repeated failure" of a row, and a run-level count pages on an unrelated burst
  while missing one row failing forever.
- **A threshold of two failures.** Rejected: the projection's first failure is already
  recorded by the route's own deferred attempt, so a two-strike rule would page on the
  first sweep that merely retried — no tolerance at all.
- **Treating a missing stamp as "never stale".** Rejected: it is the shipped behaviour and
  it is exactly the F3 defect — a row can never be reconciled.
- **Pinning the sweep alert's tenant.** Rejected: no document fixes it, and inventing a
  platform-tenant sentinel in a _test_ would force a production constant the contract does
  not have.

## Open items for the GREEN

- The sweep alert's `tenantId`/`subjectRef`: any non-empty `tenantId` satisfies the outbox
  (a platform sentinel is fine), and the subject is the GREEN's choice — the failing inbox
  row is the natural subject.
- Whether `billing-reconcile` should also emit `admin.billing.manual_review` for a
  mandate-only drift: this record treats it as resolvable (auto-corrected); no pin depends
  on it either way.
- A row with **neither** stamp is not pinned; "missing ⇒ not fresh" makes it always a
  candidate, which is the conservative reading of F3.

## Evidence at the pins head

`tsc -p apps/web/tsconfig.json --noEmit` exits `0`; `eslint` reports 0 problems and
`prettier --check` is clean on the new spec. The focused integration run is
**6 failed | 5 passed (11)**, with the six failing cases failing at _assertion_ level and
for the named reason:

```
P1: a provider divergence the job cannot auto-apply emits one admin.billing.manual_review
  → expected { job: 'billing-reconcile', … } to match object { scanned: 1, affected: 0 }
    - "affected": 0  + "affected": 1        (the job auto-corrects instead of escalating)
P3: a stuck row whose updatedAt is missing is still reconciled   → expected +0 to be 1   (provider.calls)
P3: a stuck row whose createdAt is missing is still reconciled   → expected +0 to be 1   (provider.calls)
P2: at the repeat threshold the escalation is raised once        → expected [] to have a length of 1 but got +0
P2: further failing sweeps do not raise a second escalation      → expected [] to have a length of 1 but got +0
P2: the provider-failure escalation is always mobile             → expected [] to have a length of 1 but got +0
```

Two throwaway mutation probes prove the pins are satisfiable and coherent (each mutation
reverted, the touched production files `sha256`-identical and `git diff` empty afterwards):

1. **The two-stamp fix alone** (`find({…, $and: [{$or:[{createdAt:{$lt}},{createdAt:{$exists:false}}]}, {$or:[{updatedAt:{$lt}},{updatedAt:{$exists:false}}]}]})`)
   turns both F3 pins green **and leaves `billing-crons.test.ts`'s I4 pair green** (2 passed
   | 17 skipped) — i.e. the fix does not break the frozen negative control.
2. **A faithful P1+P2 implementation** (the non-`active` divergence emits
   `admin.billing.manual_review` and skips the write; the sweep `$inc`s a counter and emits
   `admin.provider.failing` with `payload.mobile: true` at the third failure) turns 9 of the
   11 cases green — the only two reds are the F3 pair the probe above covers — **and leaves
   `billing-crons.test.ts` at 19 passed (19)**.

The frozen four OP-111 specs are **byte-identical** (this record adds one new spec file and
touches no other test, mock, fixture or factory); the I1 whole-database diff is unchanged.
