# ADR-0503 — OP-111 follow-up GREEN: the §10.2 admin-alert escapes emitted (`admin.billing.manual_review`, `admin.provider.failing`) and the reconcile classes closed

- **Status:** Accepted · **Date:** 2026-10-26
- **Card:** OP-111 follow-up GREEN (`t_2f274985`) · **Branch:** `OP-111-feature-admin-alert-green` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_f7717e2c` · **Base:** the pins head `3b0f5e2` (itself off `origin/main` `5ecfc18`)
- **Relates to:** [ADR-0502](ADR-0502-op111-admin-alert-pins.md) (the RED-by-design pins this card implements unedited), [ADR-0500](ADR-0500-op111-billing-jobs-red.md) (the OP-111 RED contract), [ADR-0501](ADR-0501-op111-billing-jobs-green.md) (the shipped GREEN whose open items routed this lane), [ADR-0029](ADR-0029-domain-event-outbox.md) (the outbox both alerts are written through), [ADR-0306](ADR-0306-op93-red-by-design-ci.md) (the RED-by-design posture), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §10.2 (the cron table — the `billing-reconcile` and `webhook-projection-sweep` rows name the two emissions; rules 1–4), §10.1.2 line 3171 ("`admin.provider.failing` … always mobile"), §4.10 (the `platform_ops` catalogue) · **Schema:** §14.3 (`subscriptions`), §18.4 (`providerWebhookEvents`), §18.3 (`domain_events`)

## Context

The pins card (`t_f7717e2c`, ADR-0502) fixed the three contract questions the OP-111
round-1 review left open and delivered a test-only RED: `billing-cron-admin-alerts.test.ts`
(11 cases), RED-by-design at its head — **6 failed | 5 passed (11)** — with the four frozen
OP-111 specs byte-identical and `billing-crons.test.ts` at **19 passed (19)**. This card is
the GREEN half of that pair: it implements the ADR-0502 contract exactly, ships the pins in
the PR byte-unchanged, and lands both emissions plus the reconcile-class closures.

ADR-0502 deliberately left two choices to this card (its §"Open items"): the sweep alert's
`tenantId`/`subjectRef` (the inbox row carries no tenant and §10.2 names no subject), and
whether a mandate-only drift also escalates (this record's §P1 treats it as resolvable, and
no pin depends on the alternative). Both are fixed here.

## Decision

### P1 — `admin.billing.manual_review` on a reconcile mismatch (`billing-reconcile.ts`)

The runner now implements the ADR-0502 mismatch predicate exactly:

- **Auto-apply only drift toward `fetched.status === "active"`.** The missed
  activation/reactivation webhook is idempotent and fabricates no side effects, so the
  existing correction path (patch `status`/`mandateStatus`, conditional `updateOne` whose
  filter carries the prior `status`, `affected += 1`, warn `billing.reconcile.drift`) is
  unchanged. A **mandate-only** drift (same `status`, different `mandateStatus`) also stays
  on this path and stays silent — it is not a status mismatch.
- **Any other `fetched.status !== row.status` is the `admin.billing.manual_review` class.**
  The row is left untouched (no write), counted once (`skipped += 1` — it is a row the job
  deliberately left alone, not a swallowed failure), and exactly one outbox row is emitted:

  ```jsonc
  {
    "eventKey": "admin.billing.manual_review",
    "tenantId": "<the subscription's tenantId, read off the row>",
    "actorRef": { "kind": "system", "id": "billing-reconcile" },
    "subjectRef": { "kind": "subscription", "id": "<hex ObjectId>" },
    "payload": { "fromStatus": "<ours>", "toStatus": "<the provider's>" },
  }
  ```

  `emitDomainEvent` is called with the `{ db, clock }` seams the outbox contract takes. A
  `warn` with `event: "billing.reconcile.manual_review"` accompanies the emit so the drift
  surface is visible in the job log without a second outbox row.

- `ReconcileCandidate` is widened with `tenantId` (read off the row) and `subjectId` (the
  `_id` hex when it is an `ObjectId`); the emit is guarded on both being present so a shape
  anomaly degrades to the warn rather than a `DomainEventError`.
- The **two-stamp candidate filter** is fixed per ADR-0502 §P3: each stamp is
  `{ $or: [{ <stamp>: { $lt: staleBefore } }, { <stamp>: { $exists: false } }] }` under
  `$and`. A missing stamp counts as _not fresh_, so a one-stamp row is still reconciled; a
  both-present row keeps the shipped **AND**, so `billing-crons.test.ts` I4's negative
  control (fresh `createdAt`, stale `updatedAt`, `provider.calls() === 0`) stays green.

### P2 — `admin.provider.failing` on repeated sweep failure (`webhook-projection-sweep.ts`)

The sweep persists a per-row consecutive-failure counter on the `providerWebhookEvents` row
(`sweepFailureCount`; an absent counter reads as `0`) and raises the escalation
**crossing-only** once the counter reaches **3** (§10.2; ADR-0502):

- The failure path (`projectProviderWebhookEvent` returned without a `processedAt` date)
  keeps `errors += 1` and then `$inc`s the counter via a single `findOneAndUpdate` with
  `returnDocument: "after"` — the same driver pattern `claimPendingEvents` uses.
- The emit fires only when the post-increment value **equals** the threshold (3): sweeps 1–2
  never emit, sweep 3 emits once, sweeps 4+ neither re-raise nor re-attempt. The outbox row
  carries `dedupeKey: "admin.provider.failing:<row hex>"` as the outbox-side backstop for a
  racing concurrent sweep — the unique partial index on `dedupeKey`
  (`domain_events_dedupe_unique`, live in the spec's `ensureIndexes`) collapses a duplicate
  to `{ deduped: true }` (ADR-0029 §7).
- `payload: { mobile: true }` — §10.1.2 line 3171: the alert is always mobile.
- The **open item** is fixed here: `tenantId` is the platform sentinel `"platform"` (the
  inbox row carries no tenant; a real tenant id would be a fabricated attribution), and
  `subjectRef` is the failing inbox row itself — `{ kind: "providerWebhookEvent", id: <row
hex> }`. `actorRef` is the job: `{ kind: "system", id: "webhook-projection-sweep" }`.
- The row still ends `processedAt: null` when it keeps failing; the counter lives beside it
  because the projection's own failure path only rewrites `processedAt`/`processResult`/
  `processError`.

### P3 — the reconcile classes and the shipment of the pins

`billing-crons.test.ts` already shipped three of the four behaviours the pins close, and
they are kept as-is — the pins now pin them:

- `past_due` is a reconcile class alongside `incomplete` (both in `RECONCILABLE_STATUSES`);
  the missed-reactivation case (`past_due` + provider `ACTIVE`) corrects like activation.
- A rejecting `fetchStatus` ⇒ `errors += 1`, no write, `warn` with
  `event: "billing.reconcile.provider_error"` (kept exactly as shipped).
- A row with no subscription `externalRefs` ⇒ `skipped`, no provider call.
- The two-stamp edge is _fixed_ (not merely pinned) by §P1's filter change.

### `cronBearerAnyMethod` — not deleted

ADR-0502 §"Route wiring" records that the pins card **did not adopt** the alternative of
rewriting `cronRequest` to sign its POST; the pins drive the jobs through `CronJob.run`, not
the route ladder. Per this card's instruction (delete the flag _only if_ the pins card
adopted the alternative), `cronBearerAnyMethod` in `internal-hmac.ts` and its call site in
`run-billing-cron-route.ts` are **left untouched** — the shipped opt-in stays
default-preserving and `internal-hmac.test.ts` U4b stays green.

## Consequences

- **The pins ship byte-unchanged.** `billing-cron-admin-alerts.test.ts` is RED-by-design at
  the pins head and green at this head; no test, mock, fixture or factory is edited — the
  diff is the two production runners, this ADR and the README ledger cells.
- **Both §10.2 emissions are now** `platform_ops` **domain events delivered through the
  outbox** (ADR-0029): `admin.billing.manual_review` (tenant-scoped, subscription subject)
  and `admin.provider.failing` (platform-scoped, inbox-row subject, always mobile). The
  fan-out consumer drains them like any catalogue key — the jobs themselves stay
  notification-free (ADR-0028 §1).
- **The reconcile candidate filter's semantics change** for one-stamp rows (previously
  never reconcilable, now reconcile after the hour window) — exactly the F3 defect the
  review routed; both-present rows are behaviourally unchanged.
- **The sweep gets durable per-row memory** (`sweepFailureCount`): one alert per failing row
  at the third failure, regardless of how the deployment restarts between sweeps.
- **`docs/adr/README.md` is the shared-ledger hotspot** — a later merge is a union
  resolution.
- **Number allocation.** The OP-111 lane cell read `0503` immediately before pushing (the
  pins card consumed `0502`); this record takes **`0503`** and advances the cell to `0504`.
  No number outside the lane range `0500`–`0519` is touched.

## Alternatives

- **Escalate on _every_ repeated failure (no threshold persistence).** Rejected: ADR-0502
  fixed the threshold at three and the pins assert no raise below it and no second raise
  after it.
- **Re-raise on sweeps 4+ under the dedupeKey alone.** Rejected as the primary mechanism:
  the crossing-only emit is the honest reading of "raised once" and does the fewer writes;
  the unique index remains as the concurrency backstop only.
- **Attributing the sweep alert to a real tenant.** Rejected: the inbox row carries no
  tenant, and guessing one would fabricate a tenant the event does not belong to; the
  `platform` sentinel is the honest subject while §10.2 names none (ADR-0502 §"Open
  items").
- **Counting the mismatch class in `errors`.** Rejected: `errors` is reserved for
  per-record failures the job swallowed; a mismatch is a row the job deliberately left
  alone, which is the `CronResult.skipped` definition (§10.2 rule 4).

## Evidence at this head

Focused integration **11 passed (11)** (`billing-cron-admin-alerts.test.ts`, the pins
unedited) and `billing-crons.test.ts` **19 passed (19)**; full unit **118 files / 2042
passed | 3 skipped** (no regression in pre-existing files); integration
`billing-crons.test.ts` green within the full integration project; `tsc` exit `0` on all
three projects; ESLint 0 errors; `prettier --check` clean; `vitest run --project unit
--project integration --coverage` exit `0` with no coverage threshold relaxed (the
ADR-0502 mutation probes proved this shape satisfiable without touching the frozen
controls).
