# ADR-0061 — OP-89 follow-up GREEN: recover the contact-change fan-out after a partial insert failure

- **Status:** Accepted (GREEN implementation) · **Date:** 2026-10-05
- **Card:** OP-89 `t_4f3ad9e7` (phase 1-Identity, epic Authentication, GREEN follow-up) · **Implements:** ADR-0059 (the partial-failure pin), ADR-0049 §1 (finding 1) · **Amends:** ADR-0040 §2 (fan-out recovery), ADR-0048 §1 (replaces its "return before the fan-out insert" idempotency)
- **Contract:** API contract §1.1 (hook table), §7.7 (domain events); schema §13.2, §13.6; ADR-0029 (outbox), ADR-0040 §2 (fan-out / privacy), ADR-0043 (indexes/TTLs)
- **PR / branch:** `OP-89-task-identity-lifecycle-hooks-followup-green-pins` (built on the reviewed RED pins `OP-89-task-identity-lifecycle-hooks-followup-pins`, `fa020aa`; non-draft GREEN PR ships the pins with the fix)

## Context

The OP-89 follow-up GREEN review (ADR-0049, finding 1) observed that
`handleContactChanged` performs two **non-atomic** writes:

1. it emits `auth.contact.changed` into the outbox, deduped on
   `auth.contact.changed:${userId}:${instant}`; then
2. it inserts the transient `contactChangeFanouts` row the security alert reads
   to reach the contact that was just replaced (ADR-0040 §2).

When the emit commits but the fan-out `insertOne` throws, the handler fails with
the emit already persisted. An at-least-once redelivery of the **same** event at
the **same** instant then finds the emit deduped (`emitted.id === null`), returns
**before** the fan-out insert, and the replaced contact's alert target is lost
permanently. The reviewed pin `I10` (ADR-0059) encodes the partial failure
explicitly: a `Db` whose first `contactChangeFanouts.insertOne` rejects, then a
same-instant redelivery against a healthy `db`, asserting one event row **and**
one fan-out row. `I8` pins that a healthy double invocation also leaves exactly
one of each.

## Decision

### 1. Recover the outbox id on the deduped path, then re-run the fan-out

The handler no longer short-circuits when `emitted.id === null`. On the deduped
path the persisted `_id` of the event is recovered by its unique `dedupeKey`:

```
const eventId = emitted.id ?? (await eventIdByDedupeKey(db, dedupeKey));
```

`eventIdByDedupeKey` reads `domain_events` (platform-scope, via `platformRepo`)
with a `{ dedupeKey }` filter and a `{ _id: 1 }` projection. The fan-out insert
then runs on **both** paths, keyed by that event id. A redelivery after a partial
failure therefore re-runs the insert the first attempt never committed.

### 2. Make the fan-out insert idempotent — one fan-out per event

A new unique index `contact_change_fanouts_event_id_unique` (`eventId`) makes the
re-insert safe: a healthy re-run re-attempts the same `eventId` and MongoDB
refuses it with E11000, which the handler treats as the idempotent no-op
(`isDuplicateKeyError` → swallow). Any other insert failure still surfaces, so a
genuine write failure is not hidden — as the pin records, the handler may still
throw on the first partial failure.

`eventId` is the outbox `_id` string, so the fan-out is keyed by the emitted
event itself: a genuinely new change at a later instant is a different event id
and still writes a second fan-out (S8).

## ADR numbering (collision resolution)

This lane provisionally held `ADR-0050` (pins) / `ADR-0051` (pins review
sign-off) against a `main` that ended at ADR-0049. By the time the GREEN PR
landed, `main` had the OP-90 `/me` lane's **0052–0056** and the OP-89
indexes/TTLs lane's **0050/0051/0057/0058** (PR #169, `04843a3`), so 0050/0051
collided. Per the orchestrator reconciliation card `t_93d4774b` (reviewer comment
on the `t_ffd7bc07` lane: lowest free number is now **0059**), the pins ADR was
renumbered **0050 → 0059**, its review sign-off **0051 → 0060**, and this GREEN
implementation ADR is **0061**, with the `docs/adr/README.md` rows updated to one
row per number (`0001`–`0061`). Rename only — no decision content changed.

## Consequences

- The partial-failure pin `I10` goes green for the right reason: after the
  injected insert failure the same-instant redelivery leaves one event row and
  one fan-out row carrying the replaced/current contacts.
- `I8` stays green: a healthy double invocation writes the event once and the
  fan-out once; the second fan-out insert is an E11000 no-op.
- The emit and the fan-out remain non-atomic; the design is
  **at-least-once-safe** via the idempotent re-insert rather than atomic via a
  transaction. The first partial failure still propagates (the pin tolerates
  it) — only the post-redelivery end state is pinned.
- A regression that restores the `emitted.id === null` early return, or drops the
  `eventId` unique index, breaks `I10`/`I8`.
- The `docs/adr/README.md` table is reconciled to 0001–0061 with no duplicates.

## Alternatives considered

- **Wrap the emit and the insert in a MongoDB transaction.** Rejected: the emit
  already owns the outbox row's lifetime and the integration harness would need a
  replica-set transaction, while the idempotent re-insert delivers the same
  at-least-once guarantee with no new coupling. Also rejected as the larger
  change for a defect whose observable contract is only the recovered end state.
- **`updateOne({ eventId }, { $setOnInsert }, { upsert: true })` for the
  fan-out.** Rejected: it makes the fan-out write a non-`insertOne` op, so the
  pin's injected `insertOne` failure no longer models the real write; keeping a
  real `insertOne` + unique index passes through the exact path the pin exercises.
- **Key the fan-out on the `dedupeKey` string instead of the event id.**
  Rejected: `eventId` is the existing field (the test's `ContactChangeFanout`
  interface), and the outbox `_id` is the natural per-event identity.
- **Write the fan-out only when the emit is fresh.** Rejected: that is the
  defect — it is exactly the path that loses the fan-out on a redelivery.
