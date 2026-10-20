# ADR-0107 — OP-94 §1 follow-up GREEN review sign-off: the notification-fanout cron route, the recipient/transport wiring and the `after()` trigger

- **Status:** Accepted · **Date:** 2026-10-06
- **Card:** OP-94 §1 follow-up DOCS sign-off (`t_e5b239ab`, assignee `openpic-webapp-reviewer`)
- **Reviewed artifact:** PR [#201](https://github.com/yahodu/openpic-webapp/pull/201) head `d188202` (base `main` `0a66d6a`), squash-merged as `49126f4`; superseded RED draft PR [#192](https://github.com/yahodu/openpic-webapp/pull/192) (`81402e1`) closed at merge
- **Follow-up coverage card:** OP-94 §1 follow-up TEST (`t_bd94250c`, assignee `openpic-webapp-testcase-writer`)
- **Relates to:** [ADR-0106](ADR-0106-op94-followup-fanout-cron-route-green.md) (the reviewed GREEN decision), [ADR-0105](ADR-0105-op94-followup-fanout-cron-route-red.md) (the pinned contract), [ADR-0090](ADR-0090-op94-notification-fan-out-red.md) / [ADR-0092](ADR-0092-op94-notification-fan-out-green.md) (the fan-out consumer), [ADR-0028](ADR-0028-internal-hmac-and-cron-framework.md) (cron framework)

## Context

The round-1 review of the OP-94 §1 follow-up GREEN (`t_205e5ae7`, ADR-0106, PR
#201) checked the delivery with an artifact-plus-execution lens. The verdict was
**APPROVED WITH FINDINGS** with **no Critical/High** items; the code was
squash-merged to `main` as `49126f4` and the superseded RED draft PR #192 was
closed with a pointer. Nothing in this card changes production or test code — it
records the sign-off and routes the open coverage questions, matching the lane
precedent (ADR-0101, ADR-0104).

## Decision

### Item 1 — verdict recorded

APPROVED WITH FINDINGS. The merge happened because no finding was Critical or
High; the open items are coverage gaps and one cosmetic drift, all routed below.

### Item 2 — independent evidence

The reviewer re-ran the full gates on the reviewed head (`d188202`), not only the
focused specs:

- Full Vitest suite: **123 files / 1770 tests passed**.
- Focused RED pins: unit `fan-out-cron domain-events-after-trigger` **10/10**;
  integration `notification-fanout-cron-route` **13/13**.
- Playwright e2e: **16/16**.
- `eslint`, `prettier --check` and `tsc` (root + contracts + web): **clean**.
- Honesty scan (fixture-specific hardcoding, test-environment conditionals,
  suspiciously narrow logic): **clean**; the reviewer changed no file
  (`changed_by_reviewer: []`).

### Item 3 — findings routed to `t_bd94250c`

No finding required a code change before merge. All three are routed to the OP-94
§1 follow-up TEST card (`t_bd94250c`):

- **M1** — the shared transport factory's non-memory branch changed from a loud
  `throw` to `novuTransport(...)` built from `getNovuRuntimeConfig()`
  (`adapters/message-transport-provider.ts`). With `NOVU_API_KEY` unset in a
  non-memory environment, the empty-key posture is unpinned; the branch is shared
  with the synchronous OTP path. → a direct pin for the non-memory branch.
- **M2** — `repos/notification-recipients.ts` audiences (organizer,
  co-organizer, attendee-identified, billing-contact, platform-admin) and the
  `notifications/fan-out-trigger.ts` failure path have no direct pin; the
  integration route spec exercises the `memory` branch and seeds no catalogue
  type, so no recipients are claimed. → direct pins for the audiences and the
  trigger-failure path.
- **L1** — PR #201's body lists a non-existent
  `notifications/notification-transport.ts` and still cites `ADR-0094`; cosmetic
  file-path / ADR-reference drift (PR body only, not repository content).

### Item 4 — design decisions confirmed unchanged

The review confirmed, and this sign-off records, that the following stay exactly
as ADR-0106 documents them; **no behaviour change is requested**:

- The **shared transport factory** design: `getNotificationTransport()` delegates
  to the one `getMessageTransport()` factory, which carries the single documented
  Novu-import exemption, rather than a second provider selection in
  `services/**`.
- The **deferred `auth.contact.changed` old+new contact delivery**: the frozen
  `RecipientRepository` port returns user ids, not contacts, so destination-only
  delivery stays with the contact-change / OP-95 lane (ADR-0090 already lists it
  out of scope).

## Consequences

- The OP-94 §1 follow-up GREEN has a durable review record; a reader arriving
  from ADR-0106 finds the verdict, the reproduced evidence and the routed gaps.
- The three open items live on `t_bd94250c` rather than in this docs-only card,
  so the ADR remains a record and not a re-review.
- No production or test file changed here; the suite is unaffected by this ADR.

## Alternatives considered

- **Fold the coverage pins M1/M2 into this card.** Rejected: this card is
  docs-only by constraint; coverage pins are the Test Author's jurisdiction and
  are already routed to `t_bd94250c`.
- **Fix the PR #201 body drift (L1) as part of sign-off.** Rejected: it is
  cosmetic drift in a merged PR's body, recorded here and routed with the other
  findings; editing historical PR prose is not a code or contract change.
- **Request a behaviour change for the empty-`NOVU_API_KEY` posture (M1).**
  Rejected: no test pins the posture and the current behaviour matches ADR-0106's
  documented single-factory design; a change would need new/changed tests first.

## Out of scope

- Any production behaviour change (the merged GREEN is authoritative).
- Test edits (routed to `t_bd94250c`).
- The RED pins themselves (`t_1a77ec00`, ADR-0105).
