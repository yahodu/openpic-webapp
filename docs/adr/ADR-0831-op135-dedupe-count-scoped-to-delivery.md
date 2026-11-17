# ADR-0831 — OP-135 TEST: the dedupe count is scoped to the delivery it pins

- **Status:** Accepted (test-only repair; green on arrival at this head, no production change)
- **Lane:** the OP-135 lane block `0829`–`0848` (row `OP-135 worker interface lane`), which this
  record draws its next free number from: the OP-135 GREEN (`t_4a280d94`) left that cell at `0831`, no
  `.worktrees/*/docs/adr` carries an `ADR-0831*` file, `git ls-tree origin/main -- docs/adr` stops at
  `0828` (the lane's RED and GREEN records are on its own heads), `git rev-list --objects --all --
docs/adr` returns `0830` as the highest number on any object, and no other OP-13x head carries one.
  So this record takes **`0831`** and advances the lane cell to `0832`; both `unallocated (future
lanes)` cells stay at `0849`, and no range is re-cut.
- **Amends:** [ADR-0830](ADR-0830-op135-internal-worker-endpoints-green.md) §8.2 — the proposal made
  there (`countDocuments({ dedupeKey: activation }) === 1`, "or to the tenant") is adopted verbatim
  here, so §8.2's "still RED" is no longer true. No accepted record is edited: ADR-0830 keeps its text
  and this record carries the outcome.
- **Consumes:** [ADR-0029](ADR-0029-domain-events-outbox.md) (the outbox and its unique partial index
  on `dedupeKey`), [ADR-0808](ADR-0808-op132-late-match-publication-ownership.md) §3 (one activation
  result, one delivery identity), [ADR-0829](ADR-0829-op135-internal-worker-endpoints-red.md) §2 (the
  worker's batch endpoint and its three counters).

## Context

The OP-135 GREEN left exactly two pins RED by evidence rather than by choice, and ADR-0830 §8.2 named
them (called D1 and D2 in that record). D2 is this record's subject:

`apps/web/src/test/integration/internal-worker-endpoints.test.ts`, case `counts a repeat of the same
dedupeKey as deduped and keeps one row`, ended with

```ts
expect(await app.db.collection(COLLECTIONS.domainEvents).countDocuments({})).toBe(1);
```

Measured on the PR #616 head `6620ddee`: **`AssertionError: expected 3 to be 1`**, and the run's log
shows the reason in order — `beforeEach` empties `domain_events`, the case then calls
`world("op135-de-dedupe")`, and that fixture's `seedTenant` → `app.signIn` publishes
`account.welcome` and `auth.signin.new_device` **before** the batch POST:

```
{"event":"domain_event.emitted","eventKey":"account.welcome",…}
{"event":"domain_event.emitted","eventKey":"auth.signin.new_device",…}
```

The batch then inserts its own one row, so the collection holds **three**. No implementation can make
that read answer `1` without deleting another writer's outbox rows — data loss, and a violation of the
outbox being append-only for every producer. So the defect is in the assertion, not in the behaviour:
both dedupe assertions in the same case (first POST `{accepted: 1, deduped: 0, rejected: []}`, repeat
POST `{accepted: 0, deduped: 1, rejected: []}`) were already green.

## Decision

### 1. The count is scoped to the delivery, not to the collection

```ts
expect(
  await app.db.collection(COLLECTIONS.domainEvents).countDocuments({ dedupeKey: activation })
).toBe(1);
```

`activation` is the case's own `activationDeliveryKey(...)` string, already in scope and already the
key on both POSTs. A global count answers "how many events does this fixture's world hold", which is
not what the case is about; the scoped count answers the case's actual claim — **exactly one outbox row
carries this delivery's key, after two POSTs of the same batch**.

The tenant-scoped alternative ADR-0830 §8.2 also allows (`{ tenantId: seeded.tenantKey }`) was
measured and does answer `1` here: the fixture's sign-in rows carry the user's own tenant id, not
`seeded.tenantKey`. It is accepted as equivalent, but the delivery scope is preferred because it is the
narrower predicate and it cannot go quiet if the fixture ever seeds a second event for the same tenant.

### 2. This is not a weakened assertion — measured, twice

The scoped read is a **second, independent observable**, not a softer form of the answer body: the
answer counts what the handler believes, the row shows what the outbox holds. Two throwaway probes ran
against production files, each restored byte-identically afterwards (`sha256` before and after):
`apps/web/src/server/domain/domain-events.ts` `741e9a7a…`, `…/internal/domain-events/route.ts`
`e6a5e08c…`.

| probe                                                                                       | result     | red text (abridged)                                                                            | what it shows                                                                            |
| ------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| M1 — the route stops forwarding `dedupeKey` to `emitDomainEvent`                            | `1 failed` | `expected { accepted: 1, deduped: 0, …(1) } to deeply equal { accepted: 0, deduped: 1, …(1) }` | the case reddens on the answer at line 817, as it did before this repair                 |
| M2 — the emitter stores `${dedupeKey}:stored` (a minted key, ADR-0830 §7's forbidden shape) | `1 failed` | **`AssertionError: expected 0 to be 1`** at the scoped count, **both body assertions green**   | the count is the _only_ assertion that pins the stored key's identity, so it fails alone |

M2 is the load-bearing measurement: a handler that dedupes correctly on its own minted key answers both
POSTs exactly as the spec requires, and only the scoped count notices that the caller's key never
reached the row. An unscoped count would not notice it either (it would read 3).

### 3. What is not touched

Not one sibling case, helper, fixture or production file changes: the diff is the one assertion plus
its comment. D1 — `signedPost`'s bearer defaulting to the signing secret, which makes the four
`invalid_signature` cases collide with the `wrong bearer` / `CRON_SECRET` arms (ADR-0830 §8.1) — stays
open and out of this record's scope.

## Consequences

- PR #616's `ci` and `test_coverage` are no longer blocked by this pin: the lane spec is `30 passed
(30)` at this head, measured after the change with
  `pnpm exec vitest run --project integration apps/web/src/test/integration/internal-worker-endpoints.test.ts`.
- The delivery identity of an outbox row is now pinned by row content, not only by the handler's
  counters, so an endpoint that mints its own key (which ADR-0830 §7 forbids) reddens a case. That
  property survives any refactor of the handler as long as the caller's key reaches the row.
- The outbox stays append-only for every producer: no test asks one writer to remove another's rows.
- `docs/adr/README.md` is the shared-ledger hotspot: this row, this note and the `OP-135` cell merge as
  a union keeping the higher cell (`0832`); the pool cells stay `0849`.

## Alternatives

1. **Keep the global count and delete the two sign-in rows in the case's setup.** Rejected: it would
   make the spec's fixture responsible for another writer's outbox rows, and a `beforeEach` that
   deletes by `eventKey` would silently mask a real double-publish of those same events.
2. **Assert `countDocuments({}) === 3`.** Rejected: it re-pins the fixture's own side effects, so any
   future change to what sign-in publishes (a third welcome-class event, a settings-driven
   suppression) reddens a case about dedupe for a reason unrelated to dedupe.
3. **Drop the row assertion entirely and trust the answer body.** Rejected on M2: the body cannot
   distinguish "deduped on the caller's key" from "deduped on a key the handler minted", which is exactly
   the regression ADR-0830 §7 legislates against.
4. **Add a unique-index assertion instead** (`indexes` inspected for the partial unique key).
   Rejected: the index is a mechanism; the observable the contract promises is one delivery per key in
   the outbox. The index may be re-expressed without changing the promise.

## Not pinned here

- **The index's own shape.** `domain_events_dedupe_unique` (`{ dedupeKey: 1 }`, partial on
  `dedupeKey: { $type: "string" }`) is unchanged by this record; a change to its partial filter would
  have to re-open ADR-0029 and the OP-132 publication records.
- **D1 (`signedPost`'s bearer).** Still open, still a one-line test-side fix, owned by its own card.
- **How many rows the fixture's sign-in writes.** Three at this head (`account.welcome`,
  `auth.signin.new_device` and the batch's own), and this record deliberately does not pin that number.
