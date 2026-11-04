# ADR-0624 — OP-118 review round 1 pin: a refused access-link rotation writes nothing

- **Status:** Accepted · **Date:** 2026-11-03
- **Card:** OP-118 review round 1 follow-up TEST (`t_b0d14648`), follow-up of the GREEN (`t_5a121a37`, PR [#385](https://github.com/yahodu/openpic-webapp/pull/385) squash-merged as `1aeca52`) · **Branch:** `OP-118-task-rotate-refusal-pin` (cut from the trunk `985ceff`, i.e. the `1aeca52` merge plus the `1.49.1` release) · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_b0d14648`
- **Relates to:** [ADR-0621](ADR-0621-op118-access-links-qr-green.md) (the shipped GREEN these pins review; §Coverage gaps item 3 is the behaviour pinned here), [ADR-0620](ADR-0620-op118-access-links-qr-red.md) (the lane's RED contract), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §4.2 (`POST /events/{e}/access-links:rotate`) · **Schema:** §15.1 (`events`), §18.3 (outbox)

## Context

Review round 1 of the OP-118 GREEN found **F1 (Medium)**: `POST
/api/v1/events/{eventId}/access-links:rotate` answered `409 conflict` on an
event whose stored `accessLinks` carry **no active element**, but the refusal
was raised _after_ the transaction committed. The route performed the
`withTransaction` write first (the revoke-plus-append pipeline and the
`event.link.rotated` outbox row) and only then threw `appError("conflict")` when
`activeLinkOf(before.accessLinks)` was `undefined`.

The reviewer reproduced it on head `7ddeee8` with a probe that seeds an event
whose only link was already revoked:

```
PROBE1 {"status":409, "storedCount":2, "storedActive":1,
        "slugs":["atc4hzcn","op000000"], "emitted":1}
```

ADR-0621 §Coverage gaps item 3 claimed the route "answers `409 conflict` today,
**nothing written**". The probe contradicts that claim: the caller is told the
request failed while the rotation and its announcement are durable.

## Decision

### P1 — F1: a refusal must not commit

`apps/web/src/test/integration/event-access-links.test.ts` gains one appended
case (the existing 14 cases are untouched, no assertion relaxed):

1. seed an owned event with the file's own `seedOwner` / `seedOwnedEvent`
   helpers, then rewrite its `accessLinks` through a direct
   `updateOne` on `COLLECTIONS.events` to a single element
   `{ slug, active: false, revokedAt: REVOKED_AT }` — the "no active link"
   state;
2. send one `POST …/access-links:rotate` with `{ confirmUnderstood: true }` as
   the organizer;
3. assert `409` and `(await errorBody(response)).code === "conflict"`;
4. assert the stored `accessLinks` array is unchanged: length `1`, the same
   single slug, still `active: false`, and no element with `active: true`;
5. assert `events.domainEvents` holds **no** `event.link.rotated` row for that
   tenant.

**The `409` status is retained.** The card left two admissible contracts open —
`409 conflict` for the refusal, or a `200` that describes the rotation. The pin
keeps `409` because the shipped handler already answers it and ADR-0621 §2
records that choice; changing the status would be a contract change no card
owes. What this pin fixes is the invariant the reviewer reported, independent of
the status: **a refusal leaves the row and the outbox untouched**. A future
decision to answer `200` would have to edit this pin deliberately, which is the
correct amount of friction.

## Evidence

RED on the reviewed trunk (`985ceff`, i.e. `1aeca52` merged), focused file run
with `TMPDIR=/root/tmp-mongo`:

```
Tests  1 failed | 14 passed (15)
AssertionError: expected [ { slug: 'u7ac7bkm', …(4) }, …(1) ] to have a length of 1 but got 2
 ❯ apps/web/src/test/integration/event-access-links.test.ts:726:19
```

The structured log in the same run shows the cause directly — the handler emits
the announcement and _then_ rejects:

```
"event":"domain_event.emitted","eventKey":"event.link.rotated",...
"event":"http.request.rejected","status":409
```

So the failure is assertion-level, for the reported reason: the refusal wrote a
second link (and one `event.link.rotated` row). The other 14 cases in the file
pass, which confirms the pin is additive and the happy path is unaffected.

## Consequences

- The GREEN card `t_673c5b48` owes the smallest fix: make the update
  **conditional on there being an active link to revoke** — the
  `findOneAndUpdate` filter becomes
  `{ _id: eventId, accessLinks: { $elemMatch: { active: true } } }` — so a
  `null` result is the `409` and nothing is written. Event existence is already
  proven by the preceding `loadEventRow`, so `404` is not decided there.
- The normal-path behaviour must not move: the transaction, the pipeline,
  `returnDocument: "before"`, the outbox write and the §4.2 body stay
  byte-identical, so the existing 14 cases (and the pinned `I1` shapes in
  `access-links-qr.test.ts`) stay green without edits.
- `docs/adr/README.md` is the shared-ledger hotspot: this row's `Next free 0625`
  merges as a union keeping the highest cell.
- No number outside the lane range `0620`–`0639` is touched; the OP-118 lane
  `Next free` advances from `0624` to `0625`.
