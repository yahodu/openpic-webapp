# ADR-0048 — OP-89 follow-up GREEN review sign-off: re-run dedupe and the sections 4–6 / contact-verified surfaces verified working, with two coverage follow-ups

- **Status:** Accepted (GREEN review sign-off) · **Date:** 2026-10-06
- **Card:** OP-89 `t_42a91a52` (GREEN follow-up review) · **Verifies:** ADR-0047, ADR-0045
- **Branch / PR:** `OP-89-task-identity-lifecycle-hooks-followup-green` → `main` (PR #165)
- **Reviewed head:** `bb28fc3` (pre-sign-off; this ADR is the only commit added after it)
- **Reviewer:** `openpic-webapp-reviewer`, round 1, artifact lens

## Context

The GREEN follow-up card `t_42a91a52` (ADR-0047) implemented the three pins
ADR-0045 fixed for the OP-89 GREEN-review findings 4–6 and handed them to
review. This ADR records the independent verification and the two non-blocking
coverage follow-ups routed onward. It does not reship ADR-0045's contract, only
the verdict on the implementation against it.

## Verification performed (round 1, artifact lens)

Independently reproduced on head `bb28fc3`, in a rebuilt worktree
`.worktrees/t_42a91a52` (the reviewed GREEN head is not behind `origin/main`;
merge-base = `origin/main` = `6b9cd6e`):

- `vitest run --project unit` → **1319 passed (67 files)**.
- `TMPDIR=/root/tmp-mongo vitest run --project integration` → **234 passed (34
  files)**; the focused `identity-hooks.test.ts` → **30 passed (30)**, i.e. the
  nine ADR-0045 pins now pass for the intended reason (previously 9 failed | 21
  passed RED).
- `next build` from the current source, then
  `playwright test -c apps/web/playwright.config.ts` → **13 passed**, including
  `identity-hooks.spec.ts` E1 against the fresh standalone build.
- `tsc` (root + contracts + web) → exit 0; ESLint → **0 errors**;
  Prettier `--check` → clean.
- PR #165: OPEN, non-draft, `MERGEABLE`; all 11 checks pass (`ci`, `codeql`,
  `unit_test`, `test_coverage`, `lint`, `secret-scan`, `env-changes`,
  `validate-branch-name`, `validate-pr-title`, two `Analyze` jobs).
- Artifact-lens honesty scan: no fixture-shaped hardcoding, no
  test-environment conditional, no `@ts-ignore`/`.only`/`.skip`/`console.*`/
  `TODO` in the diff.
- The reviewed test file is **byte-identical** to the RED pin head `6966364`
  (`git diff 6966364 HEAD -- apps/web/src/test/integration/identity-hooks.test.ts`
  is empty) — the implementer did not touch a pin.
- Better Auth 1.7.7 genuinely declares `databaseHooks.user.update.after`
  (`@better-auth/core/dist/types/init-options.d.mts:1282-1295`), so the
  contact-verified adapter is a real hook, not a phantom surface.

## Decision

**Approve and merge.** Each card acceptance criterion is met:

- **Re-run idempotency.** `handleContactChanged` and `handleSessionsRevoked`
  now pass `dedupeKey = eventKey:userId:at.toISOString()` (`at =
resolveDeps(deps).clock.now()`), collapsed by the pre-existing
  `domain_events_dedupe_unique` partial index; `handleContactChanged` already
  returns before its `contactChangeFanouts` insert when `emitted.id === null`,
  so a same-instant replay leaves exactly one event **and** one fan-out row.
  Pinned by I8 (×2) and I9.
- **Surfaces.** `createIdentityLifecycleSeams(wiring)` is exported with
  `contactChanged` / `twoFactorToggled` / `sessionsRevoked`, each delegating to
  its policy handler inside `safeRun`; `createIdentityDatabaseHooks` gained
  `user.update.after → handleContactVerified`. The wiring→deps projection was
  de-duplicated into a private `toHookDeps` helper shared by both factories.
  Pinned by S8 (×3), S9, S10, S11.
- The pinned contract is unaltered: event keys, flags-only payload, transient
  fan-out shape, `safeEmit` / `identity_hook.emit_failed` /
  `identity_hook.claim_failed` are all preserved; the diff is additive.
- ADR numbering is correct: `0043` indexes (`t_5e541eaa`), `0044` its sign-off,
  `0045` RED pins, `0046` its sign-off, `0047` this GREEN; the `docs/adr/README.md`
  rows are in order and Prettier-clean.
- ADR-0041's "Coverage gaps" is refreshed truthfully (sections 4–6 adapters and
  the 2FA transition re-emit marked _closed_; route bodies and the §6.7 claim
  endpoint left open).

## Findings routed onward (non-blocking; do not hold the merge)

1. **Low — coverage gap: contact-change fan-out on a partial failure.** In
   `handleContactChanged`, the event emit and the `contactChangeFanouts`
   insert are not atomic. If the emit succeeds but the insert throws, a retry
   at the same instant de-dupes the event (`emitted.id === null`) and returns
   before the insert, so the fan-out target for the security alert is
   permanently lost. No spec covers this interaction. Routed to the Test
   Author (a pin), then the Implementer if the pin exposes a defect. This is
   the natural edge of the ADR-0045 §1 instant-derived design; it does not
   affect the pinned happy path.
2. **Low — stale ADR reference in the pin file header.** The comment header of
   `apps/web/src/test/integration/identity-hooks.test.ts` still cites
   `ADR-0043`, but the RED pins ADR was renumbered to `ADR-0045` (ADR-0047 §
   "ADR numbering"). Test files are immutable to the Implementer, so this is a
   Test Author follow-up (comment-only, no behavioural impact).

Both are recorded on card `t_42a91a52` and routed as a Test Author follow-up
card so they are solved rather than merely flagged.

## Consequences

- PR #165 ships the RED pins (from `6966364`) together with their GREEN
  implementation — the established OP-89 pipeline convention; PR #163 stays a
  superseded draft.
- The instant-derived dedupe collapses same-instant replays only; a
  cross-instant redelivery still re-emits. This is the accepted, documented
  limitation (ADR-0040 §2 privacy, ADR-0045 §1) and is guarded by S8's
  "different change" case.
- The sections 4–6 seams have no production caller until the owning endpoint
  cards (OP-91 revoke-all, the 2FA-toggle and the contact-change endpoints)
  call them; the surfaces are exported and pinned ready for those cards.

## Alternatives considered

- **Request changes for the partial-failure fan-out gap.** Rejected: the gap is
  beyond the pinned contract, has no spec, and does not affect any acceptance
  criterion; the correct next step is a RED pin, owned by the Test Author.
- **Hold the merge pending the two follow-ups.** Rejected: both are Low and
  coverage-only; the shipped behaviour matches the reviewed ADR-0045 contract
  exactly.
- **Editorialise the pin file's stale ADR reference in place.** Rejected: test
  files are immutable to the reviewer and the implementer alike (AGENTS.md
  §2.1); it is routed to the Test Author.
