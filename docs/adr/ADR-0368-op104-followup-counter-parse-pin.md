# ADR-0368 — OP-104 follow-up TEST: the counter parse is pinned on the service, not only on the wire answer

- **Status:** Accepted (TEST; all three pins are **characterization** — green on arrival at `origin/main` `dbf93bf3`, no GREEN sibling opened)
- **Date:** 2026-11-19
- **Card:** OP-104 TEST follow-up (`t_3dd46e5f`) · **Branch:** `OP-104-task-counter-parse-pin` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_d614b82a`
- **Relates to:** [ADR-0367](ADR-0367-op104-followup-corrupt-counter-row-pins.md) (the record whose §Consequences this pin makes true), [ADR-0365](ADR-0365-op104-followup-bounded-counters-and-usage-sort-index.md) (the bounded counter read), [ADR-0364](ADR-0364-op104-followup-usage-cursor-edges-pins.md) (the sibling characterization-pin posture), [ADR-0361](ADR-0361-op104-entitlements-usage-endpoints-green.md) (the entitlements view), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.5 (entitlements) · **Schema:** §14.2 (`usageCounters`)
- **Consumers:** `apps/web/src/test/unit/entitlements-counter-parse.test.ts`

## Context

The review of PR #707 (`t_d614b82a`, squash `dbf93bf3`) measured review finding
F1: [ADR-0367](ADR-0367-op104-followup-corrupt-counter-row-pins.md) §Consequences
says _"a regression that loosens or drops `storedCounterSchema.parse` on the
fetched rows now fails on L8"_, and that is **false**. With the parse at
`apps/web/src/server/services/entitlements/view.ts:261` replaced by a
pass-through cast (`counterRows as unknown as …`), L8 stayed green
(`1 passed | 32 skipped (33)`) and the route still answered
`500 {"error":{"code":"internal_error",…}}`.

The reason is that L8 observes the **wire**, and the wire is fail-closed for two
different mechanisms: the corrupt `value` either trips
`storedCounterSchema.parse` in the service, or it survives into the response
body and trips response-model serialisation later. A `status === 500` +
`code === "internal_error"` pair cannot tell them apart, so L8 is an anchor on
"a corrupt served-period row never reaches a served `used`", not on "the row is
parsed".

The seam that does discriminate already exists and is exported:

```ts
readEntitlementsView(db: Db, tenantId: string, now: Date): Promise<EntitlementsBody>
// apps/web/src/server/services/entitlements/view.ts:227, re-exported by the barrel
```

## Decision

One new unit spec, `apps/web/src/test/unit/entitlements-counter-parse.test.ts`,
calls the service directly — no booted app, no replica set, no route handler — and
pins three behaviours:

1. **U10** — with a counter row whose stored `value` is `"corrupt"`, the read
   **rejects with a `ZodError`**. This is the mechanism ADR-0367 claims L8
   protects, pinned where it actually lives.
2. **U10** — the rejection **names the counter's `value` field**
   (`issues: [{ path: ["value"] }]`), so the case cannot be satisfied by a read
   that throws for an unrelated reason (a missing plan, a bad `_id`).
3. **U10** (negative control) — the **same seed with `value: 4` resolves** and
   serves `used: 4`, `remaining: 1` on `events.active` at `periodKey`
   `"2026-09"`. A service that threw for every input would satisfy 1 and 2, so
   this arm is what makes the pair a pin on the parse rather than on failure.

The seed is the integration file's L8 seed, expressed in unit fixtures: a `plans`
row for key `"free"` carrying one `tenant`-scoped monthly `events.active` spec
with `limit: 5`, and exactly one `usageCounters` row for `(events.active,
2026-09)`. No `subscriptions` row is seeded, so the view defaults to `free`
(schema §14.3) — the same state L8 exercises.

### The fake `Db` does not evaluate the `$or` pair filter

`makeFakeMongo` (`apps/web/src/test/helpers/fake-mongo.ts`) records every driver
call but returns `find`'s seeded rows **regardless of the filter**, so the
`$or` over the plan's `tenant`-scoped `(entitlementKey, periodKey)` pairs
(ADR-0365) is not modelled here. That is deliberate and recorded, as the card
permits: the filter's faithfulness is L7's and L8's subject in the integration
spec against a real replica set, and this file's subject is only "does the
fetched row reach the parse". A future change that widens the _fetch set_ is
L7's red, not this file's.

### Characterization, not RED

All three cases pass on `origin/main` `dbf93bf3`, where the
`counterRows.map((row) => storedCounterSchema.parse(row))` line is in place. The
spec's file-level docblock states that posture in the same words as this record.
**No GREEN sibling is opened**: nothing is routed to an implementer, because no
production behaviour is requested.

## Evidence

Measured in this worktree and in a throwaway probe worktree, real command
output.

- **Green on arrival (trunk).** `CI=true npx vitest run --project unit
apps/web/src/test/unit/entitlements-counter-parse.test.ts` →
  **3 passed (3)**, 858 ms.
- **The pin is load-bearing (mutation probe).** In the throwaway probe worktree
  `/root/.hermes/profiles/openpic-webapp-testcase-writer/cache/scratch/probe-t3dd`
  (created with `git worktree add --detach … 5c2122f`, never in the lane
  worktree), `view.ts:261` was replaced by
  `const counters = counterRows as unknown as z.infer<typeof storedCounterSchema>[];`
  — the same mutation the review measured — and the focused file ran:

  ```
  Tests  2 failed | 1 passed (3)
  ```

  ```
  × U10: a counter row whose `value` is not a number is refused by the read
  × U10: the refusal names the counter's `value` field, not the read as a whole
  ```

  ```
  AssertionError: promise resolved "{ activePlanKey: 'free', …(5) }" instead of rejecting

  + {
  +   "activePlanKey": "free",
  +   "entitlements": [
  +     {
  +       "key": "events.active",
  +       "periodKey": "2026-09",
  +       "remaining": NaN,
  +       "used": "corrupt",
  +       …
  ```

  The served body carries `used: "corrupt"` and `remaining: NaN` — the corrupt
  row survives the read exactly as the review predicted — while the negative
  control stays green (the `1 passed`). That split is the discrimination L8
  lacked: at the wire both mechanisms answer `500`, at this seam only the parse
  refuses.

- **Restore.** `git checkout HEAD -- apps/web/src/server/services/entitlements/view.ts`
  in the probe returned the file to `sha256
bbb9d32a08c965d8dc80ce63e65f6bf8dd392b7ef1b24a27a9f4e78b23359071` (the trunk
  value), `git status --porcelain` printed nothing, and the same command answered
  **3 passed (3)**.
- **Carried integration spec stays at its count.**
  `CI=true TMPDIR=/root/tmp-mongo npx vitest run --project integration
apps/web/src/test/integration/entitlements-endpoints.test.ts` → **33 passed
  (33)** at this head. L7, L8 and every carried case are untouched
  (`git diff --stat` over that file is empty).
- **`pnpm typecheck`** exit 0 on all three projects; **`eslint`** no issues and
  **`prettier --check`** clean on the new spec and the two docs.
- **ADR guards** (the six `adr-*` unit files) green with this record and its
  ledger row in place.

## Out of scope

- **No production file changed.** `view.ts`, the entitlements route, the
  schemas and the fixtures are untouched; the pin is written against the shipped
  code, as a characterization card requires.
- **No carried test edited.** L7 and L8 in
  `entitlements-endpoints.test.ts` are byte-identical; the new cases live in
  their own unit file rather than being appended to
  `entitlements-read-model.test.ts` (which pins pure functions only), so the
  service-level import does not widen that file's subject.
- **L8 is not strengthened.** This record does not claim L8 discriminates the
  parse; it records the opposite and puts the discriminating pin elsewhere.
  Correcting ADR-0367's §Consequences sentence in place is the DOCS sign-off
  card's job (`t_0f3d134a`, gated on this card), not this one's.
- **No assertion on the counter `$or` filter, the read count, or an index.** The
  filter is pinned in the integration spec; the read is a performance property
  owned by ADR-0365's evidence.
- **No route-level assertion of the `500`.** That is exactly the observation
  this card measured as non-discriminating.

## Consequences

- A regression that loosens or drops `storedCounterSchema.parse` on the fetched
  counter rows now fails at this seam with `promise resolved … instead of
rejecting`, printing `used: "corrupt"` — the reason ADR-0367 §Consequences
  intended, made true by a case that can see the difference.
- L8 keeps its own, narrower meaning: a malformed served-period counter row
  never reaches a served `used` on the wire. Both pins can redden
  independently, which is the point of splitting them.
- The file records a known limit of the unit fake (the `$or` is not evaluated);
  a future maintainer reading a green here must not conclude the fetch set is
  bounded.

## ADR number allocation

The OP-104 lane holds `0360`–`0379`. The lane's `Next free` cell was re-read on
`origin/main` `dbf93bf3` immediately before committing and read **`0368`**, so
this record takes `0368` and the cell advances to `0369`. `0364`, `0365` and
`0367` are consumed and are never renumbered. `0366` is **reserved in flight**
by the sibling card `t_6fdc277b`
(`OP-104-bug-bound-entitlement-grants-read`, PR #708), whose
`docs/adr/ADR-0366-op104-followup-bound-entitlement-grants-read.md` is present in
its worktree and on its open PR head but not on the trunk; the sweep the card
mandates — every `.worktrees/*/docs/adr/` tree, `git rev-list --objects --all --
docs/adr`, and every open PR head (`#709`, `#708`, `#690`, `#688`, `#685`,
`#272`) — found **no** in-flight mint at `0368`. If PR #708 lands first, its
`0366` row arrives on the trunk and this record's number is unaffected. No number
outside the lane range `0360`–`0379` is touched.
