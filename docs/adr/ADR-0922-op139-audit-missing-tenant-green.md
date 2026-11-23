# ADR-0922 — OP-139 GREEN: the isolation audit reports a tenant-scoped row with no `tenantId`

- **Status:** Accepted
- **Date:** 2026-11-23
- **Card:** `t_b0c51c6e` (OP-139 GREEN, phase 6-M2M — Jobs & Compliance, epic Background Jobs,
  `tdd_stage: GREEN`; the pins of `t_f12d7d0f` /
  [ADR-0921](ADR-0921-op139-audit-missing-tenant.md), finding **F1** of the round-1 review of the
  GREEN `t_c414a059` / [ADR-0919](ADR-0919-op139-analytics-rollup-jobs-green.md))
- **Branch:** `OP-139-task-audit-missing-tenant-green`, cut from the RED head `d4333704` so one
  squash lands the pins, the record and the implementation together (the RED's draft PR [#808](https://github.com/yahodu/openpic-webapp/pull/808)
  is superseded by this card's PR). **Worktree:**
  `/root/openpic/openpic-webapp/.worktrees/t_b0c51c6e`
- **Number allocation:** draws **`0922`**, the OP-139 lane's `Next free` cell, and advances it to
  `0923`. The sweep (ADR-0300 §12 item 23) was read immediately before this commit and repeated
  immediately before the push:
  - `origin/main` `34b0e9c4` carries records up to `ADR-0941` (the OP-136 lane's `0938`–`0941`,
    outside this lane's `0918`–`0937` block);
  - every `.worktrees/*/docs/adr` tree and every open PR head (#810, #809, #808, #806, #755, #743,
    #272) carries up to `ADR-0942` (an OP-140 cut outside this block) and no `ADR-0922`;
  - `git rev-list --objects --all -- docs/adr` resolves no `ADR-0922` path;
  - no non-`done` card consumes `0922`; the lane row reads `0918`–`0937` / `Next free` `0922` on
    the delivery head. No cell is lowered and no range is re-cut.
- **Pins:** [ADR-0921](ADR-0921-op139-audit-missing-tenant.md) — five appended cases in one new
  `describe` of `apps/web/src/test/integration/tenant-isolation-audit.test.ts`. **No test file,
  factory, helper or fixture is edited by this delivery.**
- **Consumes:** ADR-0921 §3–§4 (the decisions the pins encode), ADR-0918 A10 (the alert's
  address), A11 (the reasons are exclusive) and A19 (`scanned` counts documents), ADR-0919 §5
  (the shipped sweep), ADR-0300 §12 item 23 (the number sweep), contract §10.2 (the audit's
  sentence) and §0.15 (no document payload leaves the boundary).
- **Consumers:** `apps/web/src/server/jobs/tenant-isolation-audit.ts`

## 1. Context

The shipped sweep read every tenant-scoped row's `tenantId` through `hexOf` and then `continue`d
when that answered `null`, so a row with the key **absent** — or present and explicitly `null` —
was counted in `scanned` and silently dropped: never `unresolved_tenant`, never `tenant_mismatch`.
ADR-0921 measured the blind spot (the reviewer's probe at `468ab713` reported
`{"scanned":2,"affected":0,"eventCount":0}` for two such rows) and pinned it with five cases.

On this card's base head the pins measured `4 failed | 5 passed (9)`, each red
`AssertionError: expected [] to have a length of 1 but got +0`, with the first case's
`scanned >= 3` control passing before its assertion: the rows were examined and dropped.

## 2. Decision

All three changes are inside `apps/web/src/server/jobs/tenant-isolation-audit.ts`; no other
production file, no route, no `vercel.json` entry and no limit is touched.

### 2.1 A third, exclusive reason

A row whose `tenantId` is absent, `null` or not an id shape is now grouped per collection into a
`missing` map and reported under the new reason `missing_tenant`:

```ts
if (tenantId === null) {
  const finding = missing.get(collection) ?? { tenantId: PLATFORM_TENANT_ID, count: 0 };
  finding.count += 1;
  missing.set(collection, finding);
  continue;
}
```

Classification stays single-shot. The `continue` keeps the row out of `unresolved_tenant`, and
the `tenant_mismatch` pass already skips a `tenantId` that `hexOf` cannot read, so the three
reasons are exclusive: `missing_tenant` XOR `unresolved_tenant` XOR `tenant_mismatch`. **This
turns ADR-0918 §A11's two exclusive reasons into three**; the invariant it records — a row is
reported once, under the reason that names what is wrong with it — is unchanged.

`scanned` is unchanged: these rows were already counted, and A19 keeps it the number of
tenant-scoped documents the sweep examined.

### 2.2 The event is addressed to `tenantId: "platform"`

The row has no tenant of its own, so the alert carries the codebase's existing platform-scope
address. The literal is declared in this module, as the card directs, with a comment naming its
precedent — `webhook-projection-sweep.ts:46` declares the same `PLATFORM_TENANT_ID = "platform"`
and passes it as a domain event's `tenantId`; there is no import from the billing module.

**This extends ADR-0918 §A10**, which recorded that "a platform-scope alerting address is not in
the contract". A10 remains true for the two reasons it was written about, whose events are
addressed to the offending row's own tenant; this record adds a third reason whose row has no
tenant to address, and the platform address is the only honest one for it.

### 2.3 Dedupe and payload unchanged

No new latch: the shipped `dedupeKey` shape `tenant.isolation:${reason}:${collection}:${dateKey}`
already carries the reason and the IST day, so `missing_tenant` participates in the same
one-event-per-`(reason, collection)`-per-IST-day dedupe — the same day's rerun is silent and the
next IST day speaks again. The payload key set stays exactly `{collection, count, reason}`
(§0.15), and the summary log line keeps its counts-only shape (`scanned`, `findings`,
`collections`), so the new reason adds no identifying field anywhere.

## 3. Evidence

Focused spec on this head: `9 passed (9)`.

- whole `unit` project: `193` files, `3233 passed | 3 skipped (3236)`.
- whole `integration` project: `157` files, `1668 passed (1668)`.
- the seven `adr-*` guards: `7` files, `248 passed (248)`.
- `tsc` 0; `eslint` 0 errors on the touched file; `prettier --check` clean.
- CI: PR checks on the head, recorded in the card handoff.

**Landing:** PR MERGE_RESULT. The squash SHA and the post-merge `git rev-list` check are recorded
in card `t_b0c51c6e`'s handoff — the record cannot carry a SHA that does not exist until the merge
button is pressed.

## 4. Consequences and known limits

- The audit now reports the strongest form of tenancy escape — a row that lost its tenant — as
  its own greppable reason, with the same one-event-per-day cadence as the two shipped reasons.
- Residual, not pinned by ADR-0921: the finding's `count` is checked for equality with `2` but no
  case pins its integrality beyond that; only `usageCounters` carries the no-tenant shape; and the
  consumer side of an `admin.abuse.flagged` event under `tenantId: "platform"` is not exercised.
- Pre-existing limitation, unchanged here and tracked by card `t_516fb5e6`: the sweep still reads
  whole collections with an unbounded `$in` over the parent events.

## 5. Alternatives

- **Fold these rows into `unresolved_tenant`** — rejected, and ADR-0921 §3.1 records why: that
  reason addresses its event to the offending row's own `tenantId`, which these rows do not have,
  and folding would break A11's exclusivity.
- **Address the event to a fresh hex id** — rejected: `emitDomainEvent` needs a string, and an id
  that resolves to no tenant would collide with what `unresolved_tenant` already means. The
  platform address is the codebase's existing answer for platform-scope alerts.
- **Hoist the constant to a shared module** — not done: it would move a billing file for a
  one-line non-behavioural change, and the card allows the local declaration.
