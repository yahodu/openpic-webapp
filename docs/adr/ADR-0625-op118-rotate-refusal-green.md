# ADR-0625 — OP-118 GREEN (review round 1): the rotation refuses before it writes

- **Status:** Accepted · **Date:** 2026-11-04
- **Card:** OP-118 review round 1 follow-up GREEN (`t_673c5b48`), turning the pin
  [ADR-0624](ADR-0624-op118-rotate-refusal-pin.md) (`t_b0d14648`) green ·
  **Branch:** `OP-118-feature-rotate-refusal` (based on the pin's head
  `1c0f864`, itself `origin/main` `b584f26` merged) · **Worktree:**
  `/root/openpic/openpic-webapp/.worktrees/t_673c5b48`
- **Relates to:** [ADR-0621](ADR-0621-op118-access-links-qr-green.md) (the shipped
  GREEN whose §Coverage gaps item 3 is corrected here),
  [ADR-0620](ADR-0620-op118-access-links-qr-red.md) (the lane's RED contract),
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §4.2 (`POST /events/{e}/access-links:rotate`) · **Schema:** §15.1
  (`events`), §18.3 (outbox)

## Context

Review round 1 of the OP-118 GREEN raised **F1 (Medium)**: `POST
/api/v1/events/{eventId}/access-links:rotate` answered `409 conflict` on an event
whose stored `accessLinks` carry no active element, but it committed the rotation
and the `event.link.rotated` outbox row **before** raising the refusal. The pin
[ADR-0624](ADR-0624-op118-rotate-refusal-pin.md) records that invariant — a
refusal must not commit — and is RED on the trunk for exactly that reason.

ADR-0621 §Coverage gaps item 3 claimed the no-active-link path answers `409` with
"nothing written". At head `7ddeee8` that claim was **false**: the probe
`{"status":409,"storedCount":2,"storedActive":1,"emitted":1}` shows a second link
stored and one `event.link.rotated` announced. The merged ADR-0621 is frozen, so
this record carries the correction (its own §Review — round 1 section already
retracts the claim; this is the durable fix that makes it true again).

## Decision

### The update filter carries the precondition

The rotation write becomes conditional on there still being an active link to
revoke. In
`apps/web/src/app/api/v1/events/[eventId]/access-links:rotate/route.ts` the
`findOneAndUpdate` filter changes from `{ _id: eventId }` to:

```ts
{ _id: eventId, accessLinks: { $elemMatch: { active: true } } }
```

Everything else about the normal path is **byte-identical**: the
`withTransaction` wrapper, the `rotatePipeline` aggregation update,
`returnDocument: "before"`, the `event.link.rotated` outbox write inside the same
session, and the §4.2 `{ accessLinks, warning }` body. A concurrent rotation
still cannot leave zero or two active links — the engine serialises the writes on
the document and the filter now also makes the second writer a no-op.

### A `null` result is the `409`, raised before any write

When the filter matches nothing `findOneAndUpdate` returns `null` and the
transaction throws `appError("conflict")`. Because the event's existence is
already proven by the preceding `loadEventRow`, a `null` here can only mean
"nothing to rotate", so **`404` is no longer decided in this branch**. The
refusal now precedes the document update and the outbox insert, so the pinned
invariant holds: `409 conflict`, no write, no `event.link.rotated`.

The old post-write `if (revoked === undefined) throw appError("conflict")` branch
is gone. The handler still narrows `activeLinkOf(before.accessLinks)`, but for an
**unreachable** internal invariant only — the filter guarantees the committed
`before` image carries an active link — and it throws a plain `Error` (a `500`),
never a user-facing `409`. This keeps the response build type-safe without a
non-null assertion (banned by the strict ESLint profile) while leaving the
refusal decision where it belongs: before the write.

### ADR-0621 §Coverage gaps item 3 — corrected

Item 3 read "a rotation on an event whose stored `accessLinks` carry no active
element (answers `409 conflict` today, nothing written)". The status is
unchanged; the "nothing written" half is now true by construction (the refusal
precedes every write) and is pinned by ADR-0624. The claim is corrected here
rather than edited into the frozen ADR-0621.

## Evidence

- **RED at the branch base (`1c0f864`)**, focused integration file:
  `Tests 1 failed | 16 passed (17)` and
  `AssertionError: expected [ … ] to have a length of 1 but got 2` at
  `event-access-links.test.ts:731`, with the structured log showing
  `domain_event.emitted event.link.rotated` then
  `http.request.rejected status:409`.
- **GREEN after the filter change**, same focused file: `Tests 17 passed (17)`.
- Full `--project unit` and `--project integration` projects, `tsc`, ESLint,
  `prettier --check` and the ADR-numbering guard are green (recorded in the
  card's handoff).

## Consequences

- No test, mock, fixture or factory is edited: the diff is the one route file,
  this ADR and the `docs/adr/README.md` ledger cells.
- `docs/adr/README.md` is the shared-ledger hotspot: this row's `Next free 0626`
  merges as a union keeping the highest cell.
- No number outside the lane range `0620`–`0639` is touched; the OP-118 lane
  `Next free` advances from `0625` to `0626`.

## Review — round 1 (artifact lens)

| Field         | Value                                                                                  |
| ------------- | -------------------------------------------------------------------------------------- |
| Reviewer card | `t_673c5b48` (the round-1 artifact-lens review)                                        |
| Reviewed head | `c948e42` on `OP-118-feature-rotate-refusal`                                           |
| Merge commit  | `6227241` — the squash of PR [#400](https://github.com/yahodu/openpic-webapp/pull/400) |
| Verdict       | **APPROVED** — no blocking findings; the delivery ships                                |

### What was verified

The numbers below are the reviewer's own, measured on the reviewed head and on
the squash. They are not transcribed from the implementer's handoff.

| Check                                              | Result                                  |
| -------------------------------------------------- | --------------------------------------- |
| Branch-tip → squash whole-tree diff                | empty                                   |
| `event-access-links.test.ts` (focused integration) | **17 passed (17)**                      |
| Full `--project unit`                              | **2286 passed / 3 skipped (142 files)** |
| Full `--project integration`                       | **811 passed (93 files)**               |
| ADR guard (`adr-numbering.test.ts`)                | **29/29**, no duplicate `ADR-NNNN`      |
| `tsc --noEmit`                                     | exit `0`                                |
| ESLint on the rotate route                         | 0 warnings                              |
| `prettier --check "docs/adr/**/*.md"`              | clean                                   |
| PR #400 CI checks                                  | all pass                                |

The review is artifact-lens: the branch tip and its squash are the same tree, no
test, mock, fixture or factory is edited, and no fixture-specific hardcoding was
found. The frozen `docs/adr/README.md` is untouched and no `ADR-NNNN` is
duplicated.

### Findings and routing

| Finding | Severity | What it is                                                                                                                                                                                                                                                                                                         | Routed to | State at `6227241` |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------------ |
| **I1**  | Info     | After the change a `findOneAndUpdate` `null` conflates "no active link" with "the event row vanished between `loadEventRow` and the update", so that race now reads `409 conflict` instead of the former `404 not_found`. This is the card's explicit mandate and the race is not reachable from the pinned paths. | —         | Accepted           |

The one finding is Info and is recorded here with no separate card. It is a
deliberate consequence of the decision: deciding the refusal before the write
leaves the missing-active-link case as the only reachable `null`, and the card
mandated `409` for it.

### Post-review status

- The frozen [ADR-0621](ADR-0621-op118-access-links-qr-green.md) remains
  **unedited**; this sign-off appends nothing new to the ADR ledger and consumes
  no ADR number.
- No pinned criterion regressed: the refusal precedes every write, so a
  no-active-link rotation leaves the stored `accessLinks` and the outbox
  unchanged, exactly as [ADR-0624](ADR-0624-op118-rotate-refusal-pin.md) fixes
  it.
