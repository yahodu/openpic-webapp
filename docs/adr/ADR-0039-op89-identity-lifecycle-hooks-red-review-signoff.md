# ADR-0039 — OP-89 RED review sign-off and the routing of two pipeline coherence findings

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-reviewer`
- **Card:** `t_7fe0b494` (OP-89 Better Auth lifecycle hooks, RED) · **Deliverable:** branch `OP-89-task-identity-lifecycle-hooks-red`, commit `2e19d27`, draft PR [#160](https://github.com/yahodu/openpic-webapp/pull/160)
- **Contract under review:** `docs/adr/ADR-0038-op89-identity-lifecycle-hooks-red.md`

## Verdict

**APPROVED WITH FINDINGS** (round 1, artifact lens). The RED delivery is test-only and
correct: it pins every behaviour its own card enumerates, fails for exactly the right
reason (the two modules and the `emit` seam do not exist yet), and regresses nothing.
No production code was written, no test was modified after handoff, no fixture-shaped
hardcoding and no test-environment conditional was found. The findings below are about
the **RED↔GREEN pipeline**, not about this card's compliance with its own spec, and are
routed to the orchestrator card `t_0a4c4224` which now gates GREEN (`t_eb421b87`).

## Evidence (reproduced by the reviewer, artifact lens)

- Unit: `vitest run --project unit` → **2 failed (the two new files) / 65 passed, 1296 tests pass.**
  Both fail with `Cannot find package '@/server/auth/locale'` / `'@/server/auth/device-fingerprint'` —
  i.e. only because the pinned modules are absent, not from an accidental error.
- Integration: `vitest run --project integration` (`TMPDIR=/root/tmp-mongo`) → **1 failed (the new file) / 33 passed, 204 tests pass.**
  Failure is the same missing `@/server/auth/device-fingerprint`.
- E2E: `playwright test -c apps/web/playwright.config.ts --list` discovers
  `E1: sign-up via OTP then GET /me shows profile defaults` (13 tests total).
- `eslint` and `prettier --check` clean on all four new files.
- `git diff --name-only main...HEAD` is exactly the four spec files plus the ADR + its index row —
  **no production file touched.**

## Findings routed (see `t_0a4c4224`)

1. **Medium — sections 4–6 + the claim service of OP-89 GREEN have no RED pins.** GREEN
   (`t_eb421b87`) asks for seven hook sections; RED pins only sections 1–3 and the
   emit-failure half of 7. `auth.contact.changed`, `auth.2fa.enabled/disabled`,
   `account.sessions.revoked` and the unclaimed-`op_att` claim service are asserted
   nowhere in the test tree. AGENTS.md §2.1 forbids implementing them untested, so the
   orchestrator must either add the RED pins first or narrow GREEN's scope.
2. **Medium — OP-89 e2e E1 pins `GET /me` defaults that OP-90 owns.** `/me` is OP-90's
   contract (`t_572f5d3b`/`t_43a20f13`) and OP-90 depends on OP-89. The ordering (OP-89
   expands `/me`, OP-90 completes it) must be confirmed and OP-90 written against the
   projection OP-89 lands, or the two cards will each redefine `/me`.
3. **Low (test-quality, reported not blocked).** (a) `I6` installs a process-wide memory
   logger via `setLogger` and never restores it; harmless today (Vitest isolates files per
   worker, and the following describing block asserts no log content) but worth restoring
   for hygiene. (b) `U3` does not pin the exact window boundary (`now - windowMs`, which
   the documented half-open interval `(now - windowMs, now]` treats as _new_). (c) `I5`
   asserts the admin `auth.admin.signin` event but not that an admin session also produces
   `auth.signin.new_device` as contract §1.1 requires.

## Consequences

- The RED specs stand as reviewed; the branch is held as draft PR #160 (RED CI is expected
  and it is **not** merged — per repo convention the pins ship inside their gated GREEN PR,
  as the sibling RED PRs closed in `t_6d2c0e47` demonstrate).
- GREEN `t_eb421b87` is gated on `t_0a4c4224` until the two Medium findings are settled, so
  no untested production code lands by drift.
- No test file and no production file was edited by the reviewer; this ADR is the only
  change made at review time.

## Alternatives

- **Request changes on the RED card.** Rejected: the card covers every behaviour it lists,
  and the gaps are cross-card pipeline issues the RED author could not fix within a
  test-only RED card whose test list was fixed by the card body.
- **Block the RED card.** Rejected: no external prerequisite or human decision is missing
  from the RED delivery itself; blocking would strand a sound deliverable.
- **Merge PR #160.** Rejected: it is a RED pin, its CI (typecheck/tests) is red by design,
  and merging it would break `main`'s gated pipeline.
