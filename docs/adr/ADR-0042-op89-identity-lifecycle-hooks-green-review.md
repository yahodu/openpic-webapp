# ADR-0042 — OP-89 identity lifecycle hooks GREEN: review sign-off and follow-up routing

- **Status:** Accepted (review sign-off) · **Date:** 2026-10-06
- **Card:** OP-89 `t_eb421b87` (phase 1-Identity, epic Authentication, GREEN) · **Amends:** ADR-0041 (reviewer findings; does not supersede it)
- **PR / branch:** `OP-89-task-identity-lifecycle-hooks-green` (PR #161), base RED `OP-89-task-identity-lifecycle-hooks-red` @ b1b2ac2
- **Review lens:** artifact (round 1 — no prior `changes_requested`)

## Context

The GREEN implementation of the seven contract §1.1 Better Auth identity-lifecycle
hooks was handed off green. This ADR records the independent review at head
`883463c`, the verdict, and where each finding was routed. Per AGENTS.md §3.3 and
the review skill's role separation, the reviewer did **not** edit the
implementation; findings are routed as follow-up cards.

## Verification reproduced (not just read)

- `vitest run --project unit` — 1319 passed / 67 files.
- `TMPDIR=/root/tmp-mongo vitest run --project integration` — 225 passed / 34 files.
- `tsc` (root, packages/contracts, apps/web) clean; ESLint 0 errors; Prettier clean.
- PR #161 checks: branch-name, pr-title, ci, lint, unit_test, test_coverage,
  env-changes, secret-scan, CodeQL — all pass.
- Honesty audit: no fixture-shaped hardcoding, no `NODE_ENV`/test conditionals,
  no `@ts-ignore`/lint suppressions, no debug output in the delivered files.

## Decision

**APPROVED WITH FINDINGS.** The delivered behaviour matches the RED-pinned
contract; every finding below is outside what the tests pin, so none blocks this
card. The fixes are routed as follow-up cards and branch from `main`:

1. **High — `sessionDevices` has no index and no expiry.** Written on every
   production sign-in (`session.create.after`) and read with
   `find({userId}).toArray()`. → index + bound/expire + window-limited read.
   Card `t_5e541eaa` (openpic-webapp-backend-coder).
2. **High (privacy) — `contactChangeFanouts` TTL is not enforced.** Raw
   email/phone with an `expireAt` and no TTL index, so ADR-0040 §2's
   "short-lived (TTL-bound)" PII justification does not hold. → TTL index.
   Card `t_5e541eaa`.
3. **Medium — `userProfiles` uniqueness assumed but undeclared.** ADR-0041 §4
   calls the `autoProvisioned` precedence "inert" on a unique index that
   `INDEX_SPECS` does not declare, and `autoProvisioned` is not in schema §13.2.
   → declare the schema §13.2 indexes or correct the ADR. Card `t_5e541eaa`.
4. **Medium — sections 4–6 + contact-verified are handler-only, never surfaced.**
   Contract AC "Every hook's effects match the contract" is met at handler level
   only. → RED-pin the adapters/seams. Card `t_7ce3d03c`
   (openpic-webapp-testcase-writer), then GREEN card `t_42a91a52`
   (openpic-webapp-backend-coder, child of the pins).
5. **Medium — re-run idempotency gap for `handleContactChanged` /
   `handleSessionsRevoked`.** No `dedupeKey`, so a repeated invocation emits a
   second event. → pin + implement. Cards `t_7ce3d03c` → `t_42a91a52`.
6. **Low** — device-fingerprint salt reuses `getRateLimitConfig().salt`
   (rotating it silently re-flags every device as new); the `x-time-zone` client
   hint is persisted unvalidated; the 2FA enabled→disabled→enabled re-emit
   remains unpinned (carried from the prior RED review, ADR-0040 §3).

## Consequences

- OP-89 lands as the GREEN baseline; OP-90 (`t_572f5d3b`) is unblocked and builds
  its §1.2 projection against the delivered `/me` slice.
- The follow-up cards carry the worktree
  `/root/openpic/openpic-webapp/.worktrees/t_eb421b87` so their changes stay in
  the same lane before unrelated cards run.
- If the `userProfiles` unique index is not added, the `autoProvisioned`
  precedence in `guards.loadProfile` must be treated as load-bearing, not inert.

## Alternatives considered

- **Block the card on the High findings.** Rejected: the privacy issue is latent
  (the contact-changed adapter is unwired) and the perf issue is bounded at
  current scale; both are correctable in a tracked follow-up without stalling
  OP-90. No Critical (security/honesty) finding exists.
- **Reviewer edits the implementation.** Rejected: AGENTS.md §3.3 and the review
  skill preserve the implementer/reviewer boundary; a reviewer edit would hide
  ownership and weaken the re-review.
