# ADR-0143 — OP-96 follow-up round 3 GREEN: bound the repeated `failed_unrecorded` digest-flush re-attempt (F1)

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-96 follow-up round 3 GREEN (`t_cedd4e37`) · **Parent / RED pin:** `t_c9e903c5` (ADR-0138) · **Review of the RED:** ADR-0138 §"Review sign-off (round 1, artifact lens)"
- **Implements:** ADR-0138 §Decision (the terminal-state contract, option (a)), mirroring ADR-0137 §Decision (the merged transport bound) · **Amends:** ADR-0134 §"F1b — the design choice" (`failed_unrecorded` left `open`), ADR-0120 (the OP-96 contract, §10.2 `notification-digest-flush`)
- **Branch:** `OP-96-task-failed-unrecorded-bound-red`, base `origin/main` `509b559` (the merged round-3 GREEN) · **Workspace:** `/root/openpic/openpic-webapp/.worktrees/t-unrecorded-red`

## Context

The round-3 RED pin (`t_c9e903c5`, ADR-0138) is RED on this branch: a digest bucket whose flush is
**always** `failed_unrecorded` (`resolveDestination(...) === null`, or `buildRedeliveryMessage(...)
=== null`) is left `open` and re-selected on **every** flush tick. Each tick re-resolves the
destination, re-renders the summary and counts `errors: 1`, until the bucket's `expireAt` TTL retires
it — an unbounded re-attempt loop of a permanent failure, and permanent `errors: 1` alert noise.

The merged round-3 GREEN (`509b559`, ADR-0137) bounded the **transport** variant of a permanent flush
failure (`failed_terminal`, counted in `nonRetryableFailures`, capped at
`platformSettings.pipeline.maxAttempts`). ADR-0138 §Decision selected the **terminal-state** shape
(option (a)) for the unrecorded variant so the two permanent-failure paths share one rule. The RED pin
asserts only observable outcomes (stored bucket state, `CronRunOutcome` counters, transport calls,
ledger rows) and deliberately does **not** assert the counter's field name.

## Decision

### The bound

`flushDueDigests` already reads `platformSettings.pipeline.maxAttempts` through
`getPlatformSettings({ db, clock })` for the transport bound (ADR-0137). The `failed_unrecorded`
branch now uses the **same** ceiling and the **same** counter:

1. **Same counter, same ceiling — `nonRetryableFailures`.** On a `failed_unrecorded` result the flush
   records one **unrecoverable** flush failure via the existing atomic `$inc` helper (renamed
   `recordNonRetryableFailure` → `recordUnrecoverableFailure`) and, when the resulting count reaches
   `maxAttempts`, closes the bucket terminally with `status: "flushed"` and `flushOutcome: "failed"`
   — the same marker ADR-0137's transport bound uses. No new `platformSettings` field, no second
   marker, no second counter.
2. **Below the ceiling the bucket stays `open`.** The RED pin asserts the bucket is still `open` with
   no `flushOutcome` after the first failure — the bound is `N`, not `1`.
3. **The per-attempt cost stays zero.** `failed_unrecorded` is returned **before** any transport call
   and writes **no** ledger row, before and after the bound, so the bound removes the permanent
   `errors: 1` noise without adding any transport or ledger cost.

### Why one counter rather than a distinct `unrecordedFailures` field

Reusing `nonRetryableFailures` (explicitly permitted by ADR-0138 §Consequences and flagged as
acceptable in ADR-0138 §"Review sign-off" §F1-r1-L2) is the more robust choice, not merely the smaller
one. A bucket can alternate failure classes across ticks (a transient transport failure one tick, a
destination that has gone away the next). With one shared counter, whichever combination accumulates
to `maxAttempts` closes the bucket. With two independent counters, a bucket that alternates would let
each counter stall below the ceiling and the re-attempt loop would remain unbounded — the very defect
this ADR closes. The field therefore means "unrecoverable flush failures" (both permanent classes);
its doc comment, the module header and the §19.6 schema comment in
`docs/Notification and Database Design.md` are updated to say so.

## Consequences

- A permanently unrecorded digest flush failure is now bounded and observably terminal
  (`status: "flushed"`, `flushOutcome: "failed"`) instead of re-selecting on every tick until TTL —
  the asymmetry F1 identified is closed, and the flush cron's `errors` is bounded by the ceiling.
- A permanent unrecorded failure and a permanent non-retryable transport failure now share one field
  and one ceiling. That is intentional (both are "unrecoverable flush failures" that nothing will
  ever retry) and recorded here so a future round does not read the shared field as a bug. The two
  remain distinguishable on the ledger: a non-retryable transport failure writes a `failed` row, an
  unrecorded failure writes nothing.
- No schema field was added, so §19.6 of `docs/Notification and Database Design.md` keeps its shape;
  only the field's describing comment is broadened to the two failure classes.
- The behaviour is pinned only through the `resolveDestination(...) === null` trigger (ADR-0138
  §Assumptions F1-r1-L1). The sibling `buildRedeliveryMessage(...) === null` trigger returns from the
  same `FlushOne` member, so the same branch — and therefore the same bound — covers it.

## Alternatives considered

- **A distinct `unrecordedFailures` counter.** Rejected: it needs a new schema field and, more
  importantly, a bucket alternating between the two permanent classes would keep each counter below
  the ceiling and stay unbounded (see §Decision).
- **Bound `N = 1`.** Rejected for symmetry with ADR-0137 and because a single transient
  address-resolution blip would silently strand a deliverable summary (ADR-0138 §Alternatives).
- **Leave `failed_unrecorded` unbounded (option (b)).** Rejected by ADR-0138 §Decision; not revisited
  here.

## Evidence (GREEN)

- `TMPDIR=/root/tmp-mongo pnpm vitest run --project integration
apps/web/src/test/integration/notification-digest-flush-unrecorded-bound.test.ts` → **1 passed (1)**.
  The four flush ticks log `{scanned: 1, errors: 1}`, `{scanned: 1, errors: 1}`, `{scanned: 0,
errors: 0}`, `{scanned: 0, errors: 0}` — the bucket is terminal after the seeded `N = 2` and the
  two trailing ticks select nothing.
- Full suite and static gates recorded in the GREEN card handoff (`t_cedd4e37`).

## Out of scope

- No test, mock, fixture or factory is modified. The RED pin (ADR-0138) is untouched.
- The F2 round-3 finding (overlapping flush invocations double-deliver a summary) is a separate card
  (`t_e3369a9e`, ADR-0139); the F1c-r2 coverage gap is a separate card (`t_92c086f5`, ADR-0140).

## ADR-number allocation

This file was committed as **`0141`** by the GREEN card `t_cedd4e37` (`a0a7287`,
2026-10-20T15:25:54Z), taken as the lowest number free against `origin/main` at that moment
(`origin/main` ended at `0137`; the F1 RED held `0138`, the sibling F2 RED `0139` and the F1c-r2 RED
`0140`). Four minutes earlier the sibling F1c-r2 GREEN (`t_4c6c34fe`, PR #219, `7f5a830`,
2026-10-20T15:21:12Z) had committed a **different** `ADR-0141`
(`ADR-0141-op96-f1c-r2-redelivered-digest-cap-green.md`), which then merged to `main` as `4424e74` —
so two distinct ADRs briefly shared `0141`.

**This lane yields and renumbers `0141 → 0143` under card `t_aa82386b`** (child of `t_cedd4e37`):
`0141` stays with the F1c-r2 GREEN on `main` and `0142` is held by the still-open OP-101 lane
(`ADR-0142-op101-ci-audit-job-split.md`, PR #213), so `0142` would reproduce the same collision.
`0143` was re-checked free against `origin/main`, every `origin` ref and the other local worktrees
immediately before the rename. The number renumber raised as finding **F1-r1-A** by the round-1
(artifact lens) sign-off below is the only documentation change; no behaviour, test, mock, fixture or
the RED pin (ADR-0138) is touched.

## Review sign-off (round 1 GREEN, artifact lens)

- **Verdict:** APPROVED WITH FINDINGS. The implementation is correct, contract-preserving and green;
  the only required change is this lane's ADR **number** (finding F1-r1-A), routed to card
  `t_aa82386b`, which renumbers and then merges PR #220.
- **Reviewed head:** `a0a7287` (implementation) plus this docs-only sign-off commit.
- **Independently reproduced** in `/root/openpic/openpic-webapp/.worktrees/t-unrecorded-red` on
  `a0a7287`: RED pin `1 passed`; integration `55 files / 358 tests` green **twice**
  (`TMPDIR=/root/tmp-mongo`); unit `85 files / 1477 tests` green; `typecheck` clean on all three
  projects; `eslint .` 0 errors (42 pre-existing warnings); `prettier --check` clean on the touched
  files; `pnpm build` exit 0; CI on `a0a7287` green, including the `ci` job's E2E and dependency-audit
  steps.
- **Contract audit:** `failed_unrecorded` still returns before any transport call and writes no ledger
  row — the pin asserts `transport.calls === 0`, an empty outbox, zero ledger rows and zero
  `status: "sent"` rows. The four flush ticks log `{scanned 1, errors 1}`, `{1, 1}`, `{0, 0}`,
  `{0, 0}`; the bucket is `open` after the first failure and terminal (`status: "flushed"`,
  `flushOutcome: "failed"`) after the seeded `N = 2`. The ceiling is
  `platformSettings.pipeline.maxAttempts` (validated `min(1)`, default `5`) read through the existing
  `getPlatformSettings({ db, clock })` seam; no new setting and no new schema field.
- **Honesty audit:** the diff adds no `@ts-ignore`/`@ts-expect-error`, no `eslint-disable`, no
  `.only`/`.skip`, no `console.*`, no test-environment conditional and no fixture-shaped logic.
  `a0a7287` touches no test, mock, fixture or factory; ADR-0138 and the RED pin are byte-unchanged.
- **Refactor log:** none — this is a review lane and a behaviour-preserving refactor would have added
  re-verification risk for no gain.

### Findings

- **F1-r1-A (Medium — delivery hygiene / cross-lane numbering).** Two distinct ADRs claim `0141`:
  this file (`a0a7287`, 2026-10-20T15:25:54Z) and the sibling F1c-r2 GREEN's
  `ADR-0141-op96-f1c-r2-redelivered-digest-cap-green.md` (`7f5a830`, 2026-10-20T15:21:12Z — the
  earlier claim, already pushed to the open PR #219). **This lane yields** and renumbers to **`0143`**
  — **not** `0142`, which is held by the OP-101 audit-job-split ADR (`ADR-0142-op101-ci-audit-job-split.md`)
  on the still-open PR #213, so `0142` would reproduce the same collision. Routed to card
  `t_aa82386b` (child of `t_cedd4e37`): rename, retitle, README row, every F1-lane `ADR-0141`
  citation, then merge PR #220. **PR #220 must not merge while it still contains an `ADR-0141` file.**
- **F1-r1-B (Low — maintainability, informational).** The `failed_terminal` and `failed_unrecorded`
  branches of `flushDueDigests` are now byte-identical, and the trailing `else` is an implicit
  catch-all that is only safe because `FlushOne` is a closed union. Collapsing both into one
  "unrecoverable" branch (behaviour-preserving) is recommended at the next change that touches
  `flushDueDigests`; not blocking, and not worth a dedicated card.
- **F1-r1-C (Low — product trade-off, informational).** The bound turns a possibly transient
  unrecorded failure into a permanent drop of the summary: the `notification-digest-flush` cron runs
  **every 5 minutes** (`docs/API Contract.md` §10.2, `apps/web/vercel.json`) and the ceiling is
  `pipeline.maxAttempts` (default `5`), so the digest is discarded roughly 25 minutes after the first
  unrecorded failure instead of staying `open` until its `expireAt` TTL. Deliberate under ADR-0138
  option (a); recorded so the product owner can weigh a time-based ceiling if a recipient regaining an
  address inside the digest's window matters.
- **F1-r1-D (Low — coverage, informational).** Only the `resolveDestination(...) === null` trigger is
  pinned; `buildRedeliveryMessage(...) === null` shares the same `FlushOne` member and therefore the
  same branch and bound (already recorded as ADR-0138 §Assumptions F1-r1-L1).
- **F1-r1-E (Low — flake note, informational).** One non-reproducible integration failure in
  `notification-bounded-sweeps.test.ts` was reported mid-development; two full integration runs plus a
  targeted re-run of that spec are green here, and the retryable-transport path it exercises is not
  touched by this diff.

### Merge posture

PR #220 is **ready** and CI-green on `a0a7287`, but its merge is **held** until `t_aa82386b` renumbers
this ADR to `0143` and re-runs CI. The F1c-r2 lane keeps `0141`.
