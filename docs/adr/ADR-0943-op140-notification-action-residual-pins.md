# ADR-0943 — OP-140: the residual pins (malformed id, the `actions` projection, the vendor-call count and the duplicate-key race)

- **Status:** Accepted · **Date:** 2026-11-23
- **Card:** `t_b4c8f1d9` (OP-140 TEST, Low, phase 6-M2M · epic Notifications) — follow-up of the round-1 review of the RED `t_5d080821` ([ADR-0942](ADR-0942-op140-notification-action-endpoint-red.md)) and of its GREEN `t_39c2bf80` (PR [#810](https://github.com/yahodu/openpic-webapp/pull/810), squash `5fc8c517`)
- **Branch:** `OP-140-task-notification-action-residual-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_5d080821` (cut from `origin/main` `521e305b`)
- **ADR number:** `0943` — the `OP-140 notifications lane` row's `Next free` cell at this branch head. The delivery sweep read `origin/main` `521e305b` (highest record `ADR-0942`), every `.worktrees/*/docs/adr` tree (445 record filenames, highest `0942`) and every open PR head (#812, #755, #743, #272; highest `0942`), none of which resolves `ADR-0943`.
- **Touches:** one **test-only** file — `apps/web/src/test/integration/notification-actions.test.ts` (+6 `it()` cases, one counter helper and one driver-seam capture; the ten shipped cases, every shipped helper and the harness are byte-identical) — plus this record, its index row, one ledger cell and one ledger paragraph. **No production code.**

## Context

The OP-140 RED was approved with findings, and the GREEN shipped. Three arms the
RED left unmeasured stayed green because the shipped assertions cannot see the
regressions they exist for:

1. The docblock and ADR-0942 §2 say an unknown, **malformed** or foreign id is
   `404 not_found`. `I5` pinned _unknown_ and _foreign_ only. A route that hands
   the segment to `new ObjectId(segment)` throws a BSON error and answers `500`.
2. ADR-0942 §2 says the response's `actions` are the re-read row projected to
   `{ key, label, state }`. The shipped helper `actionPairs()` reads only `key`
   and `state`, so a body that leaks the stored `style` or drops `label` stays
   green.
3. `I4` clicks `pay_now` twice **in sequence**, so the second click is answered
   from a ledger read and the duplicate-key exit of `startOutstandingCharge` is
   never taken. The reviewer's mutation (re-issuing `chargeOnce` on the replay
   branch) also stayed green, because `recordChargeRefs` `$set`s the intent's
   `externalRefs` and the memory provider mints the payment id from the
   idempotency key — a second call overwrites one ref with the same id, so the
   row count and the distinct-ref count are both still `1`.

## Decision

Six appended cases in the shipped file. Nothing is re-asserted and no shipped
case is edited.

### 1. The malformed id is a `404`, never a BSON `500`

`POST /api/v1/me/notifications/not-an-object-id/actions/accept` with a real
session answers `404` with `error.code === "not_found"`. `ObjectId.isValid` is
the shape gate; a segment that fails it is indistinguishable from a missing row
(the `invitationIdFromRequest` precedent).

### 2. The `actions` element is exactly the three projected facts

On a user invitee's first `200` (the shipped `I1` fixture: invite → fan-out →
feed row → accept), every element of `body.actions` has exactly the keys
`["key", "label", "state"]`, and the labels are the values the fan-out stored
(`["Accept", "Reject"]`). The stored row also carries `style`, so the key list
is what separates a projection from a leak, and the label assertion separates a
projection from a schema that silently drops the element.

`I1` itself is untouched: the pin re-builds the same fixture in its own `it()`,
because the card forbids editing the shipped cases.

### 3. The vendor is asked exactly once per intent — counted, not inferred

`pay_now` twice on one notification: two `200`s and **one** `chargeOnce` call.
The count is taken by wrapping the module the endpoint reaches the provider
through (`vi.spyOn` on `@/server/payments/get-payment-provider#getPaymentProvider`,
returning the real provider with a counting `chargeOnce`), restored in a
`finally`. The control arm — two **different** notifications, so two distinct
idempotency keys — counts `2`, which is what stops the first arm from being
satisfiable by an endpoint that never charges at all.

### 4. The duplicate-key exit is forced, because `Promise.all` does not reach it deterministically

The card's literal pin — `Promise.all` of two `pay_now` posts on one
notification — is authored as written: two `200`s, exactly one `applied` and one
`already_resolved`, exactly one `billing_transactions` row for the workspace and
exactly one payment ref. It is green, but it does **not** deterministically
reach the `E11000` mapping: measured with `DUPLICATE_KEY = 11000 → 11001`, one
run of the pair stayed **green** (the loser's read followed the winner's insert)
and a later run reddened. The in-process pair is therefore a characterisation of
the observable contract, not a guaranteed exercise of the exit.

So a fifth case forces the **cross-process** shape: a `Collection.prototype.findOne`
spy (the `billing-checkout.test.ts` `driverInsertOne` precedent; the original is
captured from the property descriptor at module scope so the spy cannot recurse)
returns `null` for the first two `{ idempotencyKey }` probes on
`billing_transactions` — exactly what a second process's read sees when its row
lands after ours — and delegates every later read to the driver. Both requests
then insert, the unique `billing_transactions_idempotency_key_unique` index
decides, and the loser's recovery read finds the winner's row: two `200`s, one
row, one payment ref. `expect(probeReads).toBe(2)` keeps the forcing honest.

## Evidence

Focused suite on the branch head, `npx vitest run --project integration apps/web/src/test/integration/notification-actions.test.ts`:
**16 passed (16)** — the ten shipped cases and the six new ones. `tsc -p
apps/web/tsconfig.json --noEmit` exit 0; `eslint` 0 errors; `prettier --check`
clean.

Four mutation probes, each restored byte-identical afterwards (`sha256` printed
before and after):

| Probe | Mutation                                                                           | Result                                                                                          |
| ----- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A     | `notification-id.ts`: drop the `ObjectId.isValid` gate                             | `AssertionError: expected 500 to be 404` on the malformed-id pin                                |
| B     | the route's `storedActionSchema` widened with `style` and the raw action projected | `expected [ …(2) ] to deeply equal [ [ 'key', 'label', 'state' ], …(1) ]` on the projection pin |
| C     | `charge-outstanding.ts`: `DUPLICATE_KEY = 11001`                                   | forced-race pin: `expected [ 200, 500 ] to deeply equal [ 200, 200 ]`                           |
| D     | `charge-outstanding.ts`: the ledger-replay branch re-issues `chargeOnce`           | `expected 2 to be 1` on the vendor-count pin                                                    |

Probe C against the plain `Promise.all` arm stayed green on its first run and
reddened on a later one — the measurement behind decision 4.

## Consequences

- The three findings the RED left open are now measured, and the vendor-call
  count and the duplicate-key exit have a pin that fails when either regresses.
- The replay-branch mutation that the reviewer measured as invisible is now
  caught (`expected 2 to be 1`), so the "applied exactly once" claim no longer
  rests on a ledger shape the memory provider cannot distinguish.
- A copy change to the invitation affordance labels (`Accept`/`Reject`) reddens
  the projection pin. That is intended: the pin asserts the stored label is
  passed through unchanged, and an affordance whose label silently changed is a
  behaviour change worth seeing.
- The forced-race arm depends on the service's read being a
  `billing_transactions.findOne({ idempotencyKey })` probe. If that read moves
  into a transaction or a different collection, the spy stops firing and
  `expect(probeReads).toBe(2)` fails loudly rather than passing vacuously.

## Alternatives

- **`vi.mock` of the provider module.** Rejected: a module-level mock replaces
  the provider for the whole file, including the shipped `I4`, and the counters
  then need per-test reset logic instead of a scoped spy.
- **Re-issuing the charge and comparing payment refs.** Rejected: measured to be
  indistinguishable (the memory provider derives the id from the idempotency
  key), which is exactly the reviewer's finding.
- **Asserting the duplicate-key exit from the ledger only.** Rejected: one row
  after two clicks is also what the ledger-read path produces, so the pin would
  pass on the regression it exists for. The read spy is the smallest seam that
  separates the two paths, and it changes no production byte.
