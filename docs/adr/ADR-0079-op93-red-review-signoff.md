# ADR-0079 — OP-93 RED review sign-off: pins verified; lane wiring and body drift routed

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-93 RED (`t_fe5e3429`), review round 1 (artifact lens) · **Relates to:** [ADR-0078](ADR-0078-op93-channel-resolution-and-template-renderer-red.md) (the pinned contract), [ADR-0076](ADR-0076-op92-message-transport-and-novu-drift-guard-green.md) (`MessageTransport` the resolved decision feeds)

## Context

The OP-93 RED card delivered two failing specs — `resolve-channel.test.ts`
(U1–U17, U22) and `render-template.test.ts` (U18–U21, U23) — plus ADR-0078
defining the module contract. This review verifies the pins independently and
records the findings that feed the next cycle.

## Decision

**Approved with findings.** The specs pin observable behaviour (decision unions,
preference precedence, escaping, strict variable validation), not an
implementation; they use the shared `test/factories/notification` factories and
an injected `now`, and the corpus reconciles against design §5/§6/§19.2–§19.6.

Independent evidence (this review, worktree `t_fe5e3429`, head `ffa5e17`):

- `./node_modules/.bin/vitest run --project unit` → `2 failed | 75 passed (77)`,
  `1394 passed`. Both new files fail collection with
  `Cannot find package '@/server/notifications/resolve-channel'` and
  `...render-template'` — new-module RED, the intended state.
- Quiet-hours `until` math checked against the doc: `2026-10-05T18:00:00Z`
  = 23:30 `Asia/Kolkata`, window `22:00–07:00` crosses midnight, so the next
  `07:00 IST` is `2026-10-06T01:30:00.000Z` — matches U15.
- ADR renumbering is lowest-free: `0078` is the first free number after `0077`.
- No honesty issues: no fixture-specific hardcoding, no test-environment
  conditionals, no `@ts-ignore`, no console noise, no test file edited by
  non-test changes.

### Findings routed

1. **Medium — RED→GREEN lane wiring.** The GREEN card `t_beda070f` had
   `branch_name: null` and a shared-repo workspace, so it would branch from
   `main` and never see the pins. Routed to the orchestrator (`t_95f00b11`) to
   point GREEN at a branch created from the final tip of
   `OP-93-task-channel-resolution-and-template-renderer-red` (PR #185, draft).
2. **Low — GREEN card body drift.** The body omitted `eventId`, used singular
   `renderTemplate`, and kept `group disabled → no-op`. ADR-0078 and the tests
   are authoritative; the orchestrator card refreshes the body.
3. **Low — follow-up RED pins.** `respectQuietHours: false` inside the window
   (design §19.1 line 1819), `mobile` per-candidate suppression fallback
   (design §5 lines 269–270, ADR-0078 assumption 2), and subject escaping were
   unpinned. Routed to the test author (`t_2fc90876`).

The RED branch (PR #185) stays an unmerged draft: its CI is red by design and
the pins ship inside the GREEN PR (the OP-92 pattern, PR #182).

## Consequences

- GREEN starts from a base that actually contains the failing pins.
- The three unpinned behaviours are pinned before they are implemented, per TDD
  RED-before-GREEN.
- No refactor was performed: there is no production code in this delivery.

## Alternatives considered

- **Merge the RED branch to `main` so GREEN branches cleanly.** Rejected: the
  pins fail collection, so merging turns `main`'s unit CI red.
- **Let GREEN branch from `main` and re-add the pins.** Rejected: it forfeits
  the review of the pins and duplicates them.
- **Approve without the follow-up pins.** Rejected: it would let GREEN ship
  `respectQuietHours`, mobile suppression fallback, and subject escaping
  untested.
