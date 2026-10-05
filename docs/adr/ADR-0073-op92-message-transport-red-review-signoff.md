# ADR-0073 — OP-92 RED review sign-off and the routing of three RED↔GREEN coherence findings

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-reviewer`
- **Card:** `t_fd03ff87` (OP-92 MessageTransport port, Novu adapter and workflow drift guard, RED) · **Deliverable:** branch `OP-92-task-message-transport-novu-drift`, commit `f4cecb1`, draft PR (held)
- **Contract under review:** `docs/adr/ADR-0072-op92-message-transport-and-novu-drift-guard-red.md`
- **Renumbered from:** ADR-0071 (central allocation `t_eb61c823`, resolving Finding 2)

## Verdict

**APPROVED WITH FINDINGS** (round 1, artifact lens). The RED delivery is test-only and
correct: it pins every behaviour its own card enumerates (U1–U3, I1–I5), fails for exactly
the right reason (the pinned modules do not exist yet), and regresses nothing. No
production code was written, no pre-existing test was modified, no fixture-shaped
hardcoding and no test-environment conditional was found. The findings below are about the
**RED↔GREEN pipeline**, not about this card's compliance with its own spec, and are routed
to a new orchestrator card that now gates GREEN (`t_8930fc35`).

## Evidence (reproduced by the reviewer, artifact lens)

- Unit: `vitest run --project unit` → **3 failed (the three new files) / 71 passed, 1357
  tests pass.** Every failure is `Cannot find package '@/server/adapters/novu/…'` /
  `'@/server/adapters/transport-error'` — the pinned modules, i.e. only the intended RED
  reason, never an accidental error.
- Integration: `vitest run --project integration` (`TMPDIR=/root/tmp-mongo`) → **2 failed
  (the two new files) / 36 passed, 262 tests pass.** Same two missing-module failures.
- `git show --stat f4cecb1` is exactly the six new spec/factory files, the ADR and its
  index row (**770 insertions, 0 deletions**) — **no production file touched and no
  existing test file edited.**
- `eslint` and `prettier --check` clean on all eight changed files.
- I4's premise (a client `AbortController` abort propagates to MSW's intercepted
  `request.signal`) was verified empirically with a throwaway `msw@2.15` probe:
  `{"aborted":true,"outcome":"threw:AbortError"}` — so the timeout spec is passable by the
  GREEN adapter, not a false pin.

## Findings routed (see the OP-92 RED↔GREEN coherence card)

1. **Medium — GREEN scope exceeds the RED pins.** `t_8930fc35` (GREEN) `_notes` sections 2
   (`memoryTransport` outbox), 5 (`scripts/novu/upsert-workflows.ts`) and 6
   (`List-Unsubscribe` / `List-Unsubscribe-Post`) plus `security_and_logging_requirements`
   (log `transport.sent` with channel/provider/messageId; **never** log html/text/contacts)
   and acceptance criterion 1 ("no file outside the adapter imports the Novu SDK (lint)")
   are asserted nowhere in the test tree. Under AGENTS.md §2.1 GREEN cannot implement them
   untested. The orchestrator must either add the RED pins (same worktree/branch) or narrow
   GREEN's scope.
2. **Medium — ADR number collision.** This branch added `ADR-0070-op92-…`; the open draft PR
   #181 (`OP-91-task-followup-deletion-requested-red`) adds a _different_ `ADR-0070-op91-…`.
   Both were in flight against the same `main`. **Resolved** by the central allocation
   (`t_eb61c823`): #181 keeps `0070`/`0071`; this lane renumbered `0070 → 0072` and
   `0071 → 0073`, and ADR-0074 was added for the RED-pins follow-up.
3. **Low — outbox adapter name collides with the logging port.** GREEN §2 names the outbox
   adapter `memoryTransport`, but `@/server/logging` already exports `memoryTransport` (the
   memory log sink these very specs import). Recommend a distinct name
   (`memoryMessageTransport`) in the GREEN card body to keep the vocabulary unambiguous.

### Reported, not blocked (test-quality, Low)

- I1 asserts `novuTriggerRequestSchema.safeParse(body).success === true` without surfacing
  the parse error, so a future break reports `expected false to be true` with no field. A
  `expect(parsed.error?.issues ?? []).toEqual([])` (or asserting the parsed payload) would
  diagnose better.
- I2 pins the thrown `UpstreamContractError` but not its `retryable: false` result; U1's
  classifier case covers the mapping, so this is a slight redundancy gap only.

## Consequences

- The RED specs stand as reviewed; the branch is pushed and held as a **draft PR** (RED CI is
  red by design and it is **not** merged — per repo convention the pins ship inside their
  gated GREEN PR, exactly as ADR-0039 records for OP-89).
- GREEN `t_8930fc35` is gated on the new orchestrator card until Finding 1 (and Finding 2's
  numbering) are settled, so no untested production code lands by drift.
- No test file and no production file was edited by the reviewer; this ADR and its README row
  are the only changes made at review time.
- The reviewer's own sign-off ADR number was provisional; it is renumbered
  `0071 → 0073` by the central allocation (`t_eb61c823`).

## Alternatives

- **Request changes on the RED card.** Rejected: the card covers every behaviour its own
  `tests:` list enumerates; the gaps are cross-card pipeline issues the RED author could not
  fix within a test-only RED card whose test list was fixed by the card body.
- **Block the RED card.** Rejected: no external prerequisite or human decision is missing
  from the RED delivery itself; blocking would strand a sound deliverable.
- **Merge the RED PR.** Rejected: it is a RED pin, its CI (typecheck/unit/integration) is red
  by design, and merging would break `main`'s gated pipeline.
