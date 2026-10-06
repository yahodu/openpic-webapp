# ADR-0101 — OP-96 RED review sign-off: digest/retry/quiet-hours contract approved, four coverage gaps routed

- **Status:** Accepted · **Date:** 2026-10-06
- **Card:** OP-96 RED (`t_bf539e5b`, reviewer `openpic-webapp-reviewer`)
- **Reviewed artifact:** branch `OP-96-task-digest-retry-quiet-hours-crons-red`, head `639fd06`, base `origin/main` `d261297` (draft PR opened to hold the review)
- **Contract:** ADR-0100 (the RED pins) · ADR-0092/0093 (OP-94 fan-out + Medium finding) · ADR-0028 (bounded cron framework)
- **Verdict:** APPROVED WITH FINDINGS (no Critical/High); the RED contract is fit to implement against
- **Follow-up:** `t_7a67b87d` (RED pins), a parent of the GREEN card `t_609968cf`

## Context

OP-96 phase-1 RED pins U1–U3 and I1–I5 for digest bucketing, the dispatch-retry
cron and the durable quiet-hours deferral + release cron (ADR-0100). The
Implementer handed off a green-except-new suite. This ADR records the independent
review: what was verified, why the RED is trustworthy, and which coverage gaps
were routed to a follow-up RED card rather than waved through to GREEN.

## Decision

Accept the RED contract. It is RED for the right reason (missing
modules/routes only), it is satisfiable against the real seed catalogue, fan-out
and `MongoMemoryReplSet`, and it pins the orchestrator's settled quiet-hours
semantics (durable `status: "deferred"` row with `until`, not a terminal
`skipped`). The findings below are additive coverage gaps, not contract
violations; they are routed to `t_7a67b87d`, which gates the GREEN card so the
strengthened pins land **before** implementation (TDD order), avoiding drift.

Per `AGENTS.md` §3.3 the reviewer made **no implementation or test edits** — the
only change to this branch is this sign-off ADR and its README row.

## What was independently verified (head `639fd06`)

- **RED is genuine and precise.** Unit: `vitest run --project unit` → `2 failed |
79 passed`, 1444 tests passed; the two failures are `Cannot find package
'@/server/notifications/digest'` and `.../dispatch-retry`. Integration:
  `4 failed | 40 passed`, 297 tests passed; the four failures are the four new
  specs, each a module/route-not-found. `tsc -p apps/web/tsconfig.json --noEmit`
  → exactly 8 `TS2307` errors (the new modules/routes) and no other error.
  `prettier --check` and `eslint` are clean on all six new files.
- **The specs are satisfiable against the code they build on.** I1/I2's
  `bucketKey` (`attendee.matches.new:<eventId>`), `firstItemAt`/`lastItemAt`/
  `flushAt` values, and the `itemCount` counts match `resolveThrottle`
  (`resolve-channel.ts:262`), the digest type in the seed (`digest(6)`), and the
  fan-out's in-app passthrough (`fan-out.ts:976-991` — only the email-group digest
  decision reaches the bucket path, so one increment per arrival is achievable).
  I4's `lastError { retryable, status: 503 }` / `attempts: 1` matches the fan-out's
  transport-failure path (`fan-out.ts:936-947`). I5's `until =
2026-03-02T07:00:00.000Z` matches `resolveQuietHours`'s midnight-crossing math
  (`resolve-channel.ts:336-345`). `event.details.updated` is `informational`,
  respects quiet hours, and `coalesce` does not short-circuit before quiet hours,
  so the defer path is reachable as pinned.
- **No honesty issues.** No fixture-shaped hardcoding, no environment/test
  conditionals, no `@ts-ignore`/lint suppressions in the new specs; assertions are
  on observable transport calls, row transitions and computed instants.
- **Numbering.** `0100` was free at `origin/main` `d261297`; `docs/adr/README.md`
  is the known cross-lane hotspot and the lane prose was updated coherently.

## Findings (all non-blocking) and routing → `t_7a67b87d`

1. **Medium — no pin bounds the three job functions or asserts `hasMore`.** The
   GREEN card's acceptance criteria say "Retries are bounded and idempotent" and
   §5 "All bounded by limit with hasMore", but every spec call passes `limit: 100`
   and never checks `hasMore`. Pin `limit` clamping and `hasMore` for
   `flushDueDigests`, `retryDueDispatches` and `releaseDeferredDispatches`.
2. **Low — idempotency of a re-run is unpinned.** Pin that a second retry/release
   run after success is a no-op (`affected: 0`, transport not re-called).
3. **Low — the digest daily-cap day boundary is unpinned.** ADR-0100 assumption 4
   deliberately leaves cross-day rollover to the implementation and I3 is
   same-UTC-day only, so a GREEN could silently use server-local time. Pin the
   intended timezone source (or `it.todo` + orchestrator decision).
4. **Low — index shape and per-type cap.** The I5 index assertion accepts any
   `{status, until}` index, not a **partial** one as ADR-0100 requires; and the
   GREEN body's "per user per type" cap is indistinguishable from ADR-0100's
   "per recipient per day" because I3 uses one type. Tighten both.

## Consequences

- The OP-96 RED contract is fixed and the OP-94 Medium quiet-hours finding is
  resolved by the pinned durable-deferral semantics.
- `t_7a67b87d` must complete before `t_609968cf` (GREEN) is dispatched; the GREEN
  PR continues to carry the RED pins + implementation and is the artifact that
  merges. The RED branch itself is red-CI by design and is never merged.
