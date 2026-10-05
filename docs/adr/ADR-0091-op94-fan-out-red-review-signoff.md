# ADR-0091 — OP-94 RED review sign-off: fan-out pins verified after fixture correction; no production change

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-94 notification fan-out consumer RED (`t_ccfe8295`), review round 2 (execution lens) · **Relates to:** [ADR-0090](ADR-0090-op94-notification-fan-out-red.md) (the pinned fan-out contract this card reviews), [ADR-0086](ADR-0086-op93-red-review-signoff.md) (the sibling OP-93 RED sign-off)

## Context

OP-94 RED pins the fan-out consumer (`@/server/notifications/fan-out`, a module
that deliberately does not exist yet) with 3 unit pins (U1–U3) plus 9 integration
pins (I1–I8 and the round-2 addition I2b), run against a real
`MongoMemoryReplSet` and the real seed catalogue. Round 1 (artifact lens,
PR #188) requested changes on one blocking inconsistency: I2 and I5 set
`actorRef.id` to a member of the resolved recipient set while U2, design §4.5 and
the GREEN card all require the actor to be removed — those pins could only pass
by an implementation that stopped deriving the actor. The root cause was an
under-specified `actorRef`/`subjectRef` → `actorUserId`/`subjectUserId`
derivation.

This round re-verifies the corrected fixtures and the RED reason empirically
(execution lens), and signs the RED card off so it can release the gated GREEN
child (`t_d8f1e9e5`).

## Decision

**Approved — no findings requiring a change.** All round-1 corrections landed and
the specs remain RED for the right reason.

Independent evidence (this review, worktree
`/root/openpic/openpic-webapp/.worktrees/t_ccfe8295`, branch
`OP-94-task-notification-fan-out-red`, head `9d17fe5`):

- Diff `a01a83e..9d17fe5` touches only
  `apps/web/src/test/integration/notification-fan-out.test.ts` and
  `docs/adr/ADR-0090-…-red.md` — no production file, no unit spec change.
- **I2 / I5 actor collision fixed.** I2 `actorRef.id` → non-recipient peer
  `editor` (L348/L358) with audience `[organizer]`; I5 `actorRef.id` → `editor`
  (L527/L551) with recipients `[failing, healthy]`, so both pins now exercise the
  opt-out skip and the per-recipient failure isolation independently of U2.
- **New pin I2b** (`runNotificationFanOut — actor exclusion at the outbox
boundary`): audience `[actor, peer]`, actor dropped (no dispatch, no feed row),
  peer emailed. Satisfiable against the seed: `event.details.updated` has
  `audiences: ORGANIZERS` (`["organizer","co_organizer"]`) and
  `channels: [true, true, false]`, so `listEventRoleMembers` is consulted and the
  email channel group is enabled for the non-opted-out peer.
- **I7 strengthened.** Now asserts `listEventRoleMembers` was **not** called for
  the `billing_contact`-only `billing.payment.failed`, making the "co-organizer
  never billed" claim behavioural rather than structural; the `vi.fn` reference
  survives `fixedRecipients`' spread, so the assertion targets the repository the
  fan-out was handed.
- **ADR-0090** now states the derivation (`actorUserId = actorRef.kind === "user"
? actorRef.id : null`, likewise `subjectUserId`) and corrects the §19.5
  citation (design text says unique `{dedupeKey}`; the implemented index is
  `dispatches_tenant_dedupe_unique` `{tenantId, dedupeKey}`).
- **RED reason reproduced:** both
  `./node_modules/.bin/vitest run --project unit fan-out` and
  `TMPDIR=/root/tmp-mongo ./node_modules/.bin/vitest run --project integration
notification-fan-out` fail with `Cannot find package
'@/server/notifications/fan-out'` (module under test absent — the intended RED),
  and the Mongo harness boots cleanly.
- `./node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit` reports **only**
  the two expected `TS2307` module-not-found errors; `eslint` on the changed spec
  is clean. No `.skip`, no test-env conditional, no fixture-shaped hardcoding.
- Branch base check: `origin/main` (`e570787`) is an ancestor of `9d17fe5`, so
  the fixture corrections do not need a renumber/merge hop.

## Consequences

- The RED contract is unambiguous for the GREEN implementer: the actor derivation
  is pinned, I2/I5 measure their own behaviour, and I2b proves actor exclusion at
  the wiring boundary.
- No production code and no observable behaviour changed — this is a test-fixture
  correction plus an ADR note, so the gated GREEN child (`t_d8f1e9e5`) is
  unaffected and is released by this sign-off.
- The RED branch stays an unmerged **draft** PR #188 by design (merging it would
  land the whole stacked OP-93 tree plus red specs on `main`); these pins ship
  inside the OP-94 GREEN PR. This mirrors the OP-93 RED lane (ADR-0086).

## Alternatives considered

- **Write a per-round sign-off ADR for round 1 as well.** Rejected: round 1 was a
  `changes_requested` verdict, not a terminal approval; its decision is recorded
  durably in the card thread and PR #188. A sign-off ADR is authored only at
  approval, avoiding an extra `docs/adr/README.md` row on a known hotspot.
- **Merge PR #188.** Rejected: the branch is stacked on OP-93 (unmerged) and
  contains only red specs; squash-merging would put a red suite on `main`.
- **Edit the fixtures from the review lane.** Rejected: reviewer role separation
  — test changes belong to the Test Author, who produced `9d17fe5`.
