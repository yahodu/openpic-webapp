# ADR-0141 — OP-96 follow-up round 3 GREEN: a digest delivered by the retry sweep counts against the daily cap (F1c-r2)

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-96 follow-up round 3 (GREEN, `t_4c6c34fe`) · **Parent / RED:** `t_92c086f5` (ADR-0140) · **Grand-parent:** `t_6163c787` (round-2 GREEN, ADR-0134)
- **Implements:** ADR-0140 (the F1c-r2 RED pin) — turns the pin green under the **option (a)** contract: count the recovery · **Amends:** none (A4 as amended by ADR-0134 is unchanged; this makes the accounting match it) · **Related:** ADR-0127 / ADR-0130 F1 (the `failed` ledger row owns the redelivery), ADR-0137 (F1b-r2 terminal close)
- **Branch:** `OP-96-task-f1c-r2-cap-red` · **PR:** #219 (was a draft carrying the RED pin; this GREEN turns it ready) · **Workspace:** `/root/openpic/openpic-webapp/.worktrees/t_6a4943e8`

## Context

ADR-0140 pinned, RED, that a digest summary **delivered by the `notification-dispatch-retry` sweep**
must consume the recipient's `notifications.maxDigestEmailsPerDay` allowance exactly like a
first-attempt success. The defect: on a **retryable** digest-flush failure `flushDueDigests` closes
the bucket with `flushOutcome: "failed"` while the `failed` `notificationDispatches` row owns the
redelivery; `countFlushedToday` counted only `{ status: "flushed", flushOutcome: "sent" }`, so a
summary actually delivered by the redelivery path never counted and a recipient could receive more
digest emails in a local day than the configured cap.

The pin is deliberately mechanism-agnostic. This card implements option (a) with the cheapest
legitimate mechanism: **link the digest's `failed` ledger row back to its bucket**, and credit the
bucket when the row is finally redelivered. The allowance is thus consumed at **delivery** time,
which is what ADR-0120 A4 (amended by ADR-0134) describes.

## Decision

### The mechanism — a bucket link on the `failed` row, credited on redelivery

1. **`notificationDispatches.digestBucketId` (new field).** When `flushOneBucket` records a failed
   digest flush it now stores the source bucket's `_id` on the ledger row. This is the only durable
   handle the redelivery path has on the bucket; without it a redelivered digest row is
   indistinguishable from any other dispatch row.
2. **`notificationDigests.redeliveredAt` (new field).** When `redeliverDispatchRow` successfully
   (re)sends a row that carries `digestBucketId`, it stamps the bucket with `redeliveredAt: now` —
   the instant the summary actually reached the recipient. The update matches
   `{ _id, status: "flushed" }`, so it credits only the closed flush the row links from and is a
   no-op otherwise.
3. **`countFlushedToday` counts delivered digests from either path.** The count is now
   `{ status: "flushed", $or: [ { flushOutcome: "sent", flushedAt ≥ since }, { redeliveredAt ≥ since } ] }`.

A bucket that failed but has **not yet** been redelivered has no `redeliveredAt`, so it still burns
no allowance — the F1c behaviour is preserved. A bucket closed terminally by the F1b-r2 bound
(non-retryable, never delivered) likewise has no `redeliveredAt`.

### Why not the alternatives

- **Flip `flushOutcome` to `"sent"` on redelivery.** Rejected: `flushOutcome` records why the
  **flush attempt** ended, and the F1b-r2 pin asserts `"failed"` for a terminal non-retryable close;
  rewriting the flush outcome post-hoc would make the field mean two different things depending on
  when it is read. A separate `redeliveredAt` timestamp records the recovery without erasing the
  attempt history.
- **A join at count time (query `notificationDispatches` for `sent` rows with `digestBucketId`).**
  Rejected: it spreads one recipient's digest accounting across two collections and needs a new
  index for the hot cron path, for no benefit over one durable timestamp on the bucket.
- **Mark the bucket at attempt time.** Rejected: it breaks the F1c pin (a failed-but-undelivered
  flush must consume no allowance).

### Schema

The two new fields are recorded in the authoritative schema
(`docs/Notification and Database Design.md`): `digestBucketId` in §19.5 (`notificationDispatches`)
and `redeliveredAt` in §19.6 (`notificationDigests`). No new index is required — the bucket count
already filters on `{ userId, status }`.

### Files changed

- `apps/web/src/server/notifications/digest.ts` — stamp `digestBucketId` on a failed flush row;
  extend `countFlushedToday` (and its docs) to count a redelivered bucket.
- `apps/web/src/server/notifications/dispatch-redelivery.ts` — `RedeliveryRow.digestBucketId`;
  `creditDigestBucket` on a successful redelivery.
- `apps/web/src/server/notifications/dispatch-retry.ts` — carry `digestBucketId` through
  `asRetryRow`.
- `docs/Notification and Database Design.md` — §19.5 / §19.6.
- `docs/adr/ADR-0141-…` (this file) + `docs/adr/README.md`.

## GREEN evidence

- The pin `apps/web/src/test/integration/notification-digest-flush-daily-cap-redelivery.test.ts`
  is green; the second flush of the day logs `scanned: 1, affected: 0, skipped: 1`.
- `pnpm test:int` (`TMPDIR=/root/tmp-mongo`) → **55 files passed (55); 358 tests passed (358)**.
- `pnpm test:unit` → **85 files passed (85); 1477 tests passed (1477)**.
- `pnpm typecheck` clean · `pnpm lint` 0 errors (42 pre-existing warnings) ·
  `prettier --check` clean on the touched files.
- The two contract-pair pins stay green: F1c (`notification-digest-flush-daily-cap.test.ts`, a
  failed-but-undelivered flush consumes no allowance in the same run) and F1b-r2
  (`notification-digest-flush-non-retryable-bound.test.ts`).

## Consequences

- The per-recipient per-local-day digest cap now bounds the emails a recipient **receives**,
  including those recovered through `notification-dispatch-retry`; the over-delivery F1c-r2
  identified is closed.
- The ledger row→bucket link is durable: a redelivery that happens days later still credits the
  day it was delivered (`redeliveredAt`), not the day the flush was attempted.
- Every non-digest dispatch row is unaffected (`digestBucketId` is absent; `redeliveredAt` is never
  stamped).

## Alternatives considered

See §Decision. Also: reusing the F1c pin (rejected by the card — the scenarios differ: same-run
non-consumption vs cross-run consumption after redelivery).

## Out of scope

- The two sibling round-3 findings (F1 `failed_unrecorded` bucket unbounded; F2 overlapping flush
  runs double-deliver) are separate cards (`t_c9e903c5`, `t_e3369a9e`; ADR-0138/0139) and are not
  touched here.
- E2E: fully exercisable as an integration pin against the real jobs and a real Mongo replica set.

## ADR-number allocation

`0141` was taken as the lowest free number immediately before committing: `git fetch` of
`origin/main` ends at `0137`; the still-open OP-97 GREEN worktree (`t_58825ec3`) holds `0135`
(`0136` for its sign-off); the two sibling round-3 finding branches hold `0138`
(`OP-96-task-failed-unrecorded-bound-red`) and `0139` (`OP-96-task-flush-overlap-single-send-red`);
and this lane's RED holds `0140`. `0141` is therefore the next free, re-checked against every ref.

> **Post-review update (see the sign-off below):** a fourth, then-unknown claim to `0141` appeared
> four minutes after this commit — the sibling F1 GREEN lane (`t_cedd4e37`). This lane committed
> first and keeps `0141`; the F1 GREEN renumbers to `0145` under card `t_aa82386b` (`0142` is held by
> the still-open OP-101 lane, `ADR-0142-op101-ci-audit-job-split.md`) before which PR #220 must not be
> merged. _(The target number is corrected here from `0142` to `0145` by card `t_aa82386b`, which
> performed the renumber.)_

## Review sign-off (round 1, artifact lens) — card `t_4c6c34fe`

- **Reviewed head:** `7f5a830` on `OP-96-task-f1c-r2-cap-red` (base `origin/main` `3f46950`), PR #219
  (turned ready by the GREEN). **Verdict: APPROVED** — no changes requested.
- **Checks run independently** in `/root/openpic/openpic-webapp/.worktrees/t_6a4943e8`:
  - `TMPDIR=/root/tmp-mongo vitest run --project integration` → **55 files / 358 tests passed**; a
    focused re-run of the pin plus the two contract-pair pins (F1c
    `notification-digest-flush-daily-cap.test.ts`, F1b-r2
    `notification-digest-flush-non-retryable-bound.test.ts`) → 3/3 passed.
  - `vitest run --project unit` → **85 files / 1477 tests passed**; `pnpm typecheck` clean;
    `pnpm lint` **0 errors** (42 pre-existing warnings); PR #219 CI green at `7f5a830`.
  - **Scope/honesty audit:** the GREEN commit touches 6 files (3 production, the schema, this ADR,
    `docs/adr/README.md`); the pin file is byte-identical to the RED commit `012faad`; no
    `@ts-ignore` / `eslint-disable` / `.only` / `console.*` / env-conditional or fixture-shaped
    logic.
  - **Mechanism audit:** `digestBucketId` is stamped only on the failed-flush ledger row;
    `creditDigestBucket` only credits a bucket still `status: "flushed"`; the F1c pin (a
    failed-but-undelivered flush burns no allowance) and the F1b-r2 pin (a terminal non-retryable
    close is never credited) stay green, and the second flush in the pin logs
    `scanned: 1, affected: 0, skipped: 1`.
- **Findings (triaged; none blocking):**
  - **L1 (Low, maintainability) — routed to card `t_92776e91`.** The `markFlushed` JSDoc in
    `digest.ts` (~lines 501–507) still says _"counts `"sent"` flushes alone"_, which this change
    made false.
  - **L2 (Low, informational) — no card.** `redeliverDispatchRow` marks the ledger row `sent`
    _before_ awaiting `creditDigestBucket`. A crash in that window delivers the summary without
    crediting the bucket (cap undercount), mirroring the pre-existing crash window in the send →
    mark-sent order; not deterministically pinnable, and reordering would trade it for a duplicate
    send.
  - **L3 (Low, informational) — pre-existing, no card.** `countFlushedToday` filters
    `{userId, status: "flushed"}` and no supporting index exists on `notificationDigests`
    (`{userId, bucketKey}` is partial on `status: "open"`); the added `$or` does not change the
    access pattern. Introduced by ADR-0134/ADR-0132-class work, not by this change.
  - **L4 (Medium, delivery hygiene) — routed to card `t_aa82386b`.** ADR-number collision: the
    sibling F1 GREEN lane committed a _different_ `ADR-0141`
    (`ADR-0141-op96-f1-unrecorded-flush-bound-green.md`, `a0a7287`, 15:25:54Z) four minutes after
    this lane's `7f5a830` (15:21:12Z). This lane keeps `0141` (earliest claim, and the allocation
    the orchestrator reserved for it); the F1 GREEN renumbers to `0145`. Recorded here so the
    resolution is auditable, and flagged on PR #220.
