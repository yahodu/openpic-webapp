# ADR-0979 — OP-101: the downgrade request's `billing.plan.downgrade_scheduled` outbox row and its delivery to the billing contact, pinned

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** OP-101 TEST (Low) `t_7df4b288` (openpic-webapp-testcase-writer) · **Branch:** `OP-101-task-downgrade-scheduled-event` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op101-downgrade-scheduled-event-red`
- **Lane:** OP-101 follow-up (request-side billing record) · **Consumes:** `0979` — a **pool draw** ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18: the board-wide block `0300`–`0319` is exhausted), allocator-assigned in the card body and re-verified by the four-surface sweep at this cut; the four pool-mirror cells read `0979` and advance to `0980`
- **Spec sources:** contract §3.3 (`POST …/billing/downgrade`), §7.7; schema §18.3 (`domainEvents`), §19.1 (`notificationTypes`), §19.4 (`notifications`), §19.5 (`notificationDispatches`), §20.2 (`auditLogs`), §22 (retention); notification design §2 (audiences), §4.3 (billing matrix), §5 (fan-out)
- **Consumers:** `apps/web/src/test/integration/billing-downgrade-scheduled-event.test.ts`
- **Relates to:** [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) (the decision of record this pack pins: §D1–§D5), [ADR-0975](ADR-0975-op101-billing-downgrade-audit-write.md) (the applied transition's audit row, untouched), [ADR-0974](ADR-0974-op101-audit-txn-failed-membership-pins.md) (the driver-refusal stub recipe reused here), [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) (§D4 log line stays), [ADR-0090](ADR-0090-op94-notification-fan-out-red.md) (the consumer whose recipient resolution §D3 amends), [ADR-0029](ADR-0029-domain-events-outbox.md) (`emitDomainEvent` is the only door to the outbox), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the pool-draw rule), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)

## Context

[ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) decided the gap [ADR-0975](ADR-0975-op101-billing-downgrade-audit-write.md) §D7 routed: `POST …/billing/downgrade` must emit `billing.plan.downgrade_scheduled` inside the same transaction as its `scheduledChange` write, and the fan-out must stop removing an actor whose id came from the `billing_contact` audience. This card is the **RED half** of that lane: it writes the pins, and no production file.

Measured on the delivery base `origin/main` `c291cd08` (the ADR-0978 squash):

- `apps/web/src/app/api/v1/tenants/[tenantId]/billing/downgrade/route.ts` imports neither `emitDomainEvent` nor `withTransaction`; its only write is one `subscriptions.updateOne` (`:156`), and its log line's field _named_ `event` (`:171`) is not an emission.
- `resolveRecipients` adds the `billing_contact` id (`fan-out.ts:400`) and then splices the actor out unconditionally (`:417-421`), while `processEvent` re-adds only a `subjectRef.kind === "user"` subject (`:1377`). `provisioning.ts:162` makes the owner the contact, so a user-actor emission to that audience reaches **nobody** (ADR-0978 §Context P1: `0` notifications, `0` dispatches, `0` outbound).
- The catalogue already carries the key with in-app and email enabled (`notification-types.values.ts:415`), the templates derive from it (`notification-templates.values.ts:148-153`), and §20.2 has no `subscription.downgrade_scheduled` member — so nothing in this lane needs a schema, catalogue or template edit.

## Decision

**One new integration spec carries the whole contract, and every pin is written against the §D1–§D5 wording, not against the shipped code.** `apps/web/src/test/integration/billing-downgrade-scheduled-event.test.ts` — 15 cases, no production file, no edit to the three hotspot siblings (`billing/scheduled-change/route.ts`, `billing-crons.test.ts`, the two billing jobs / audit seam owned by `t_e3bb5425` and `t_6634feb1`).

**D1 — the row's identity is pinned field by field, not by one `toMatchObject`.** Five cases (`A1`–`A5`) each seed their own workspace and assert one clause of §D2: the count and `eventKey` with the workspace **hex string** (`A1`); `actorRef` exactly `{kind:"user", id:<caller hex>}` and `subjectRef` exactly `{kind:"subscription", id:<live row hex>}` (`A2`); the payload **key set** exactly `{fromPlanKey, toPlanKey, effectiveAt}` with `effectiveAt` equal to the ISO string of the `scheduledChange.effectiveAt` the same request stored (`A3`); `expireAt − occurredAt` equal to `platformSettings.retention.domainEventDays` read from the settings (`A4`); and the `dedupeKey` template with `dispatch.notifications: "pending"` (`A5`). A single mega-assertion would tell the implementer only "something is off"; five named cases name the field.

**D2 — `A4` reads the setting instead of hard-coding `180`.** A literal would pin today's default and stay green through a settings change that the emitter correctly followed, which is the opposite of the invariant. The case loads the settings through the same `getPlatformSettings` seam the emitter uses, so the two cannot drift.

**D3 — dedupe is pinned in both directions and through delivery.** `B1` (a repeated identical request answers `200` and leaves one row), `B2` (that repeat leaves one event's worth of delivery: one feed row, one email dispatch), `B3` (a different target plan leaves a second row), `B4` (a later effective date, with the live row's `currentPeriodEnd` advanced between calls, leaves a second row). Together they pin the `dedupeKey`'s two variable segments — target and instant — as _new intent_ separators, which is §D2's sentence.

**D4 — the atomicity pin refuses the `domain_events` insert, not the subscription write.** `C1` installs the ADR-0974 stub recipe: every `insertOne` against `domain_events` rejects with driver `{ code: 91 }` and **no** `TransientTransactionError` label — so `classifyMongoError` answers `no-retry` and `withTransaction` rethrows instead of looping — while every other collection is forwarded to the driver. The route must answer `500 internal_error` and leave `scheduledChange` unset. `C2` is the anti-vacuity half: the same call with the stub absent must answer `200`, store the schedule and write exactly one row, so a route that never writes a row cannot satisfy `C1`'s "nothing stored" for the wrong reason.

**D5 — delivery is driven through the real consumer, not through a happy-path stub.** `D1`–`D3` call `runNotificationFanOut` over the real seeded catalogue and the real `mongoRecipientRepository`, with only the outbound `MessageTransport` in memory. `D1` (the requester _is_ the billing contact, `provisioning.ts:162`'s default) pins one feed row and one rendered, non-skipped email; `D2` (a different, active member is the contact) pins the contact's row **and** the requester's absence while both are deliverable, so the only thing separating them is the audience; `D3` is the `system`-actor control on the same type, which proves the type and its copy are live — the red in `D1` can therefore only be §D3's actor exclusion and not a missing template.

**D6 — §D4 is a characterization pin, green on arrival, and it is meant to stay green.** `E1` asserts the workspace's `audit_logs` holds no `subscription.downgrade_scheduled` row after a `200`. The obvious wrong repair for a red delivery case — write an audit row for the request — is exactly what §D4 refused, so the pin exists to make that repair red.

**D7 — boundary.** No production file in this pack. `billing/scheduled-change/route.ts` stays log-only (ADR-0978 §D5); `billing-crons.test.ts`, the two billing jobs and the audit seam belong to `t_e3bb5425` / `t_6634feb1` and are not touched; the applied-transition rows of [ADR-0975](ADR-0975-op101-billing-downgrade-audit-write.md) are not re-pinned.

## Consequences

- The GREEN that follows inherits this branch tip and makes, minimally: the `withTransaction` join with §D2's event, and the audience-scoped billing-contact exemption in `resolveRecipients`. Nothing else — the catalogue, the templates, the schema and the audit vocabulary are already right.
- **A dedupe-aware emit is required, and the pin says so.** The first near-fix probe (emit inside the transaction, relying on the unique index to answer `E11000` → `{ deduped: true }`) answered **`500` on the second identical request**, because a duplicate-key error inside a transaction aborts it and the commit then fails: `B1` reds on the naive shape. The probe's second pass — a `domainEvents.findOne({ dedupeKey }, { session })` guard inside the same transaction before the emit — answers `200` and leaves one row, and `Tests 15 passed (15)` (re-measured at this delivery head, below).
- **The atomicity pin is load-bearing and specific, measured twice.** Moving the emit outside the transaction (everything else identical) left exactly one red — `C1`, with `expected { toPlanKey: 'free', …(2) } to be null`: the schedule committed, the event did not, and the route claimed success. `Tests 1 failed | 14 passed (15)`. Both probe patches were reverted and both files verified byte-identical (`sha256` before == after).
- **Cost:** one new 15-case integration spec (~9.5 s focused) on the `integration` project; no production behaviour changes in this card.
- **Reversal condition:** if the fan-out's actor exclusion is ever re-scoped away from the audience (a product decision to silence the payer's own actions again), `D1` is the case that must be renegotiated first — not silently deleted.

## Numbering

The board-wide / process block `0300`–`0319` is exhausted ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18), so this record draws from the `unallocated (future lanes)` cursor. The card assigned `0979`; the four-surface sweep found it held by nothing else.

```
$ git rev-parse --short origin/main                                   9160a962
$ git ls-tree -r --name-only origin/main -- docs/adr | grep -oE 'ADR-09(7[6-9]|8[0-2])' | sort -u
                                                                      0976 0977 0978
$ for d in /root/openpic/openpic-webapp/.worktrees/*/; do ls "$d/docs/adr" | grep -oE 'ADR-09(7[6-9]|8[0-2])'; done | sort -u
                                                                      ADR-0976 ADR-0977 ADR-0978 ADR-0979
  # 0979 resolves only inside this card's own worktree — no sibling holds it
$ git rev-list --objects --all | grep -oE 'ADR-09(7[6-9]|8[0-2])' | sort -u
                                                                      ADR-0976 ADR-0977 ADR-0978 ADR-0979
  # 0979 resolves only on this branch's own commit
$ gh pr list --state open --json number,headRefName
                                                                      906 OP-101-task-downgrade-scheduled-event (this card)
                                                                      896 OP-132-task-adr-item-section-pins   (records 0971–0973)
$ python3 <read-only board probe over 7 non-done cards>
t_7df4b288  running  Consumes: 0979   (this card)
t_ddd87497  todo     the gated GREEN  (0980)
# no other non-done card holds a 0979–0982 number
```

The four cells that read `0979` — `board-wide / process`, `OP-129 attendee identity lane`, `OP-136 jobs lane`, `unallocated (future lanes)` — advance to **`0980`** (forward only; no cell is lowered and no range is re-cut).

## Evidence

The RED run at the delivery head (`origin/main` `9160a962` merged in as `d944df8a`), with the card's five groups named:

```
$ npx vitest run --project integration \
    apps/web/src/test/integration/billing-downgrade-scheduled-event.test.ts
× A1 × A2 × A3 × A4 × A5        (the outbox record — 0 rows today)
× B1 × B2 × B3 × B4             (dedupe — 0 rows today)
× C1 × C2                       (atomicity — the route answers 200 on a refused insert, and writes no row)
× D1 × D2                       (delivery — 0 feed rows, 0 dispatches)
✓ D3                            (system-actor control, green on arrival)
✓ E1                            (no audit row — the §D4 characterization, green on arrival)
Test Files  1 failed (1)
     Tests  13 failed | 2 passed (15)
```

Every red is the same missing write, and each names a different field of it: `expected [] to have a length of 1`, `expected undefined to deeply equal { kind: 'user', … }`, `expected [] to deeply equal [ 'effectiveAt', 'fromPlanKey', 'toPlanKey' ]`, `expected 200 to be 500`, `expected [] to have a length of 1 but got +0` (D1/D2).

**Satisfiability (near-fix probe, reverted).** A throwaway near-fix — the `withTransaction` join with the dedupe guard, plus the audience-scoped billing-contact exemption in `resolveRecipients` — answered `Tests 15 passed (15)`: the pin set is satisfiable exactly as written, and the two changes are the whole of the GREEN.

**Load-bearing (mutation probe, reverted).** With the emit moved **outside** the transaction and everything else identical, the file answered `Tests 1 failed | 14 passed (15)`: `C1` alone, `AssertionError: expected { toPlanKey: 'free', …(2) } to be null` — the schedule committed and the event did not. The probe was reverted with `git checkout --` and both files are byte-identical to their pre-probe state:

```
$ sha256sum <downgrade/route.ts> <notifications/fan-out.ts>   (before == after)
81778782822a9ce966f39349e547d18b498395239c0f9f384950e44e4217dc16  …/billing/downgrade/route.ts
9273ce7d154686516bd3950ac655e5d940937511fef0f73a2beaa8c98e6df020  server/notifications/fan-out.ts
$ git status --porcelain     (empty)
```

Neither production file is in the diff.

**Static gates on the delivery head.** `pnpm typecheck` answered `TYPECHECK_EXIT=0` (all three projects — `tsconfig.json`, `packages/contracts`, `apps/web`), so the pins import only symbols the trunk exports (`runNotificationFanOut`, `emitDomainEvent`, `mongoRecipientRepository`, `seedNotificationTypes` / `seedNotificationTemplates`, `getPlatformSettings`, `Collection.prototype.insertOne`). `npx eslint` on the spec: **No issues found**. `npx prettier --check` on the spec, this record and the ledger: **All files formatted correctly**. The nine `adr-*` guard files answered `Tests 299 passed (299)` (`9 passed (9)` files) with this ledger in the tree, and the whole `unit` project answered `199 passed (199)` files / `Tests 3378 passed | 3 skipped (3381)`, `UNIT_EXIT=0`.

**§D6 note.** `E1` asserts both that no `subscription.downgrade_scheduled` action appears and that the workspace's `audit_logs` is empty after the request. The second half is stricter than the card's literal wording and is deliberate: §D4's sentence is "the request gets **no** audit row", and the fixture seeds none, so any row present after the `200` was written by the request.
