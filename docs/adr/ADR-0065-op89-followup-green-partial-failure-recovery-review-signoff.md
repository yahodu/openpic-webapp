# ADR-0065 — OP-89 follow-up GREEN review sign-off: the recovered contact-change fan-out is verified, with three Low references routed

- **Status:** Accepted (review sign-off) · **Date:** 2026-10-06
- **Card:** OP-89 `t_4f3ad9e7` (reviewed) · **PR:** #177 (merged, squash `33c45dd`) · **Reviewed head:** `ee0c02c`
- **Verifies:** ADR-0064 (the GREEN recovery), ADR-0062 (the partial-failure pin), ADR-0049 §1 (finding 1)
- **Reviewer:** `openpic-webapp-reviewer`, round 1, artifact lens + execution verification

## Context

`t_4f3ad9e7` implemented the recovery for ADR-0049 finding 1: `handleContactChanged`
no longer short-circuits when the outbox emit dedupes (`emitted.id === null`); it
recovers the persisted event `_id` by the unique `dedupeKey` and re-runs the
`contactChangeFanouts` insert, with a new unique `eventId` index turning the
re-insert into an idempotent E11000 no-op (ADR-0064). This ADR records the
independent review of that delivery and the integration reconciliation.

## Verification performed (round 1, artifact lens + execution)

Independently reproduced in the task worktree `.worktrees/t_4f3ad9e7` on
`ee0c02c`:

- **The fix is causal, not cosmetic.** Reversing only the production commit
  `ad1b6d7` restores the pre-fix handler; `I10` then fails on the fan-out count
  (`expected [] to have a length of 1 but got +0`) while the emit-dedupe
  assertion passes — the exact RED the pin encodes. With the fix applied, `I10`
  passes: one `domain_events` row and one `contactChangeFanouts` row carrying the
  replaced/current contacts.
- **`I8` stays green** — a healthy double invocation leaves one event row and
  one fan-out row; the second insert is the unique-index no-op.
- **Full suite green on `ee0c02c`:** unit 1342/1342 (69 files), integration
  250/250 (35 files), Playwright 14/14, `tsc` root+contracts+web clean, ESLint 0
  errors (21 pre-existing warnings), Prettier clean, `next build` OK. CI 11/11
  green.
- **Honesty scan clean** — no fixture-shaped hardcoding or test-env
  conditionals; the GREEN commit touches only `identity-hooks.ts` and
  `indexes.ts`. The test-file delta is the reviewed RED pin (98 insertions /
  1 deletion, the `ADR-0043`→`ADR-0045` header fix).
- **Integration reconciliation.** Merged a fresh `origin/main` and resolved the
  `indexes.ts` / `docs/adr/README.md` conflicts by keeping **both** sides (OP-90
  `tenantMembers` indexes alongside this lane's fan-out index; ADR rows 0060–0061
  then 0062–0064, ascending, no duplicate numbers). No renumbering was needed —
  0062/0063/0064 were free at integration.

## Findings (all Low, none blocking)

1. **ADR-reference drift** — the same finding is cited as `ADR-0049 §1` in the
   production comment and `ADR-0045 §1` in the pin-file header. Pre-existing and
   not introduced here; already routed to `t_c9c415e6`.
2. **Index-presence dependency** — the recovery's idempotence relies on
   `contact_change_fanouts_event_id_unique` existing. In an environment where the
   one-off `ensure-indexes` has not run, a redelivery would insert a duplicate
   fan-out row. The `index-bootstrap` integration spec covers `ensureIndexes`;
   deployment runs the one-off index build. Confirm pre-traffic in all envs.
3. **ADR-0064 historical note** — it records 0059–0061 as reserved; 0060/0061
   have since landed. The ADR text is left as the historical record; the live
   `docs/adr/README.md` index is corrected.

## Decision

Approve and ship. The delivery is behavior-minimal (one handler plus one index),
at-least-once-safe, and verified RED→GREEN for the right reason. Squash-merged as
`33c45dd`; the OP-89 follow-up pins ship with the fix per the OP-89 plan.
