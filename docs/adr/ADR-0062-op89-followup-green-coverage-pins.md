# ADR-0062 — OP-89 follow-up GREEN coverage pins: the contact-change fan-out on a partial failure, and the stale ADR reference in the pin file

- **Status:** Accepted (RED pin) · **Date:** 2026-10-05
- **Card:** OP-89 `t_ffd7bc07` (phase 1-Identity, epic Authentication, Test Author coverage follow-up) · **Extends:** ADR-0045 (pins), ADR-0048 (GREEN); **Amends:** nothing
- **Contract:** API contract §1.1 (hook table), §7.7 domain events; schema §13.2, §18.3, §19.3; ADR-0029 (outbox), ADR-0040 §2 (fan-out/privacy rationale)
- **Branch / PR:** `OP-89-task-identity-lifecycle-hooks-followup-pins` (draft; RED CI is the intended state) — append-only extension of `apps/web/src/test/integration/identity-hooks.test.ts`.

## Context

The OP-89 follow-up GREEN review (ADR-0049) approved the delivery and routed
two Low findings to this Test-Author card:

- **Finding 1 (Low, coverage gap)** — `handleContactChanged` performs two
  **non-atomic** writes: it emits `auth.contact.changed` and then inserts the
  transient `contactChangeFanouts` row the security alert reads. The emit is
  deduped on `auth.contact.changed:${userId}:${instant}` and the handler
  returns _before_ the fan-out insert whenever that emit dedupes
  (`emitted.id === null`). When the emit commits but the fan-out insert fails,
  an at-least-once redelivery at the same instant finds the emit already
  deduped, short-circuits, and never re-runs the insert — the security alert's
  target for the replaced contact is permanently lost. No spec covered this
  interaction.
- **Finding 2 (Low, comment-only)** — the pin file's comment header still cited
  `ADR-0043` for the follow-up RED pins, but that ADR was renumbered to
  `ADR-0045`.

## Decision

### 1. Pin the honest outcome — a redelivery must not lose the fan-out

The pin (`I10`) injects a `Db` whose **first** `contactChangeFanouts.insertOne`
rejects (a small `Proxy` around `test.db` that passes every other collection
through to the real driver, with the real `emitDomainEvent` and a fixed clock at
`T0`). It calls `handleContactChanged` once against that db (the emit commits,
the fan-out insert does not), then redelivers the **same** event at the **same**
instant against the healthy db, and asserts:

- exactly **one** `auth.contact.changed` row (the emit dedupe held), and
- exactly **one** `contactChangeFanouts` row referencing both the replaced and
  the replacement contact (the security alert keeps its target).

The current handler leaves **zero** fan-out rows, so the pin is **RED for the
right reason** (`expected [] to have a length of 1 but got +0`). The fix (owned
by the Implementer) is to make the two writes survivable at-least-once — for
example, re-insert/upsert the fan-out record idempotently keyed by the deduped
event id, or make the emit + insert atomic — without regressing the existing
`I8` specs (a _healthy_ re-run still leaves exactly one fan-out row).

The partial failure itself is not pinned as "must not throw": the handler may
throw on the failed insert, and the spec tolerates that (`await ... .catch(() =>
undefined)`). What is pinned is that the _redelivery_ does not silently leave
the fan-out lost — no spec silently ignores the partial failure.

### 2. Correct the stale ADR reference in the pin-file header

The comment header of the follow-up RED-pin block now cites `ADR-0045` (was
`ADR-0043`). Comment-only, no behavioural change. The two `describe(...)` titles
that also carry `(ADR-0043 §3)` were left untouched: the finding scoped the
header reference, and the card requires the existing specs to stay
byte-identical apart from that change (flagged for the reviewer).

## Tests added (append-only; one spec, RED for the right reason)

- `I10` — a retry after a failed fan-out insert still records one
  `contactChangeFanouts` row (and the emit stays deduped to one row).

Reproduced RED (`TMPDIR=/root/tmp-mongo vitest run --project integration
apps/web/src/test/integration/identity-hooks.test.ts`): 1 failed / 30 passed;
the failure is `expected [] to have a length of 1 but got +0` at the fan-out
count assertion.

## Assumptions resolved unilaterally (flagged for the implementer)

- **The lost fan-out is a defect, not intentional.** ADR-0040 §2 makes the
  fan-out record the _only_ way the security alert reaches the replaced
  contact; a same-instant redelivery that drops it defeats that rationale.
  Hence the pin asserts recovery (1 row), not acceptance (0 rows).
- **The db wrapper is test-only.** It lives in the spec file; it does not alter
  `test.db`, any repository, or any production module.
- **The `describe` titles were not renumbered.** See §2.

## Consequences

- A regression that loses the contact-change fan-out on a partial failure — or
  that re-introduces the "dedupe short-circuits before the insert" path — breaks
  `I10` loudly.
- The existing 30 `identity-hooks.test.ts` specs are byte-identical apart from
  the header comment (verified: unit 1319, integration 234 + this one RED pin,
  Playwright 13, `tsc`/ESLint/Prettier clean).

## Alternatives considered

- **Pin the current loss as intentional (assert 0 rows with a comment).**
  Rejected: it would enshrine losing a security alert on an at-least-once retry.
- **Fix it in production code here.** Rejected: this is a Test-Author card; the
  Implementer owns the fix, guided by the RED pin.
- **Drive the partial failure through a mocked `emit`.** Rejected: the defect is
  the interaction between a _committed_ emit and a failed insert, so the emit
  must be the real outbox writer.
