# ADR-0891 — OP-137 GREEN: the suppression row is **upgrade-only** — one strength ladder shared by the receipt projection and the unsubscribe route

- **Status:** Accepted (GREEN) · **Date:** 2026-11-20
- **Card:** OP-137 GREEN (Medium) `t_b7bcc125`, carrying the RED pins of `t_df4e6eb3`
  ([ADR-0889](ADR-0889-op137-suppression-strength-pins.md)). Branch
  `OP-137-task-suppression-strength-green`, worktree `/root/openpic/openpic-webapp/.worktrees/t_b7bcc125`, cut
  from the pin branch `OP-137-task-suppression-strength-pins` (head `c90ae3ba`, draft PR
  [#755](https://github.com/yahodu/openpic-webapp/pull/755)) because a RED pin pack cannot land, then merged
  with `origin/main` (`f370cf5b`).
- **Implements:** contract §10.1.3 (a hard bounce suppresses **all** scopes; an unsubscribe suppresses
  **marketing** only) and design §19.6 (the `notificationSuppressions` document and its
  `{channel, contactHash}` key).
- **Consumes:** [ADR-0889](ADR-0889-op137-suppression-strength-pins.md) (the four pins, `P1`–`P4`);
  [ADR-0882](ADR-0882-op137-delivery-receipts-green.md) §1 (the applier whose whole-document `$setOnInsert`
  is replaced); [ADR-0240](ADR-0240-op99-one-click-unsubscribe-red.md) (the one-click route); the user story _«we
  never re-send to hard-bounced or DND contacts»_; [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md)
  §12–§13 (allocation, re-sweep, never lower a cell).
- **Consumers:** `apps/web/src/server/notifications/suppression-strength.ts` (its module doc cites this
  record).
- **Number allocation:** the card body reserved `0886`, which the trunk consumed with `ADR-0886` (PR #753).
  The reviewer's 2026-11-20 11:08 brief directs this record above the highest in-flight number. The delivery
  sweep (`git fetch origin --prune`; `git rev-list --objects --all -- docs/adr`; every
  `.worktrees/*/docs/adr` tree; the six open PR heads #758/#755/#754/#752/#743/#272) found the highest record
  `0890` — `ADR-0890-op136-headerless-correlation-and-order-free-pointer-pins.md`, landed on the trunk by PR
  #757 while the pin branch was cut, and held by three worktrees. Both `Next free` cells read `0891` on
  `origin/main`, so `0891` is the free number: this record takes it and advances **both** cells to `0892`. No
  cell is lowered and no range is re-cut.

## Context

Two writers own the same `{channel, contactHash}` row (§19.6), and neither ordered them, so the write that
landed second decided which contacts keep receiving (ADR-0889 §Context, measured at the pin head):

- the receipt projection upserted with the **whole** document in `$setOnInsert`, so an existing row was never
  modified — a hard bounce arriving after a marketing unsubscribe was dropped, and the next
  `auth.otp.email.requested` fan-out wrote `status: "sent"` for the hard-bounced address;
- an all-scope row whose `expiresAt` had passed was never re-armed, so the fan-out's
  `$or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]` filter kept ignoring it;
- the unsubscribe route `$set` `reason`/`scope`, so a marketing unsubscribe after a hard bounce narrowed an
  all-scope row to `marketing`.

## Decision

### 1. One ladder, expressed as one conditional write

`apps/web/src/server/notifications/suppression-strength.ts` exports `upsertSuppression(handle, write, now)`,
a single `updateOne` on `{ channel, contactHash }` with `upsert: true` whose update is an
**aggregation-pipeline** (`[{ $set: … }]`), because the decision needs the stored row and a `$set` cannot see
it:

- `scope` strength is `all = 2`, `marketing = 1`. The incoming write applies when its rank is **at least** the
  stored row's (`$lte` on the rank pair); an absent row has no `$scope`, so it ranks lowest and every insert
  applies.
- `reason`, `scope`, `source` and `expiresAt` are each `$cond` on that one predicate: the stored value when the
  incoming write is weaker, the new one otherwise. `expiresAt` therefore becomes `null` on any equal-or-stronger
  write, which re-arms a lapsed row, and is left untouched by a weaker one.
- `createdAt` is `$ifNull: ["$createdAt", now]`, i.e. insert-only, as the shipped `$setOnInsert` had it.

`reason` follows the ladder through `scope`: `unsubscribe` is the only marketing reason and the three
all-scope reasons (`hard_bounce`, `complaint`, `dnd_registry`) are the strong ones, so a row that keeps its
`scope` keeps its `reason` and vice versa.

### 2. Both writers call it; the insert shape does not move

`projectDeliveryReceipt` passes its draft plus `source: { provider, providerEventId }`; the unsubscribe route
passes `{ reason: "unsubscribe", scope: "marketing" }` and no `source`, exactly the document it wrote before.
A first write therefore stores the same §19.6 key set as before (`P4`'s exact `toEqual` and key-set pin), and
the unique index still means one row per key with no duplicate-key error.

### 3. Coverage is not spent on the ladder

The branch lives in the database expression, not in JavaScript: the only new JS branch is the optional
`source` spread, and both arms are reached by the two writers. The repo's global branch threshold is
unchanged by this diff.

## Consequences

- **An equal-strength reason is refreshed.** A `complaint` after a `hard_bounce` (both all-scope) rewrites
  `reason` to the latest evidence and keeps `scope: "all"`. No pin holds this arm and no ordering among the
  three all-scope reasons exists, so latest-wins is recorded here rather than invented as a policy.
- **The receipt path's reverse direction is covered by construction.** An `unsubscribed` receipt after a
  `hard_bounce`/`all` row is a weaker write and leaves the row untouched — measured in a throwaway probe
  (§Evidence), not pinned; `t_1e7cb2a3` (TEST, gated on this card) is the pin.
- **A weak write no longer refreshes `createdAt`-adjacent fields.** A repeat marketing unsubscribe on an
  existing marketing row writes nothing (idempotent), which keeps the row's original `createdAt`.
- **Known limit, recorded not fixed:** the ladder ranks by `scope` only. A row written outside this codebase
  with `reason: "unsubscribe"` and `scope: "all"` would be treated as strong. No writer produces that shape.

## Evidence

- **Pins:** `webhook-novu-receipt-suppression-strength.test.ts` — `3 failed | 1 passed (4)` at the pin head
  `c90ae3ba` → **`4 passed (4)`**.
- **Neighbours unchanged:** the shipped `webhook-novu-receipts.test.ts` **`14 passed (14)`** and
  `notification-unsubscribe.test.ts` **`16 passed (16)`** (two files, `30 passed (30)`);
  `receipt-projection.test.ts` (pure reducer) `9 passed (9)`.
- **Reverse direction (throwaway probe, deleted, never committed):** a pre-seeded
  `{ reason: "hard_bounce", scope: "all", expiresAt: null }` row plus a signed `status: "unsubscribed"`
  receipt leaves the row byte-identical — `1 passed (1)`. The naive `$set` this ADR rejects answers the
  opposite (ADR-0889 §Consequences, measured by the review).
- `tsc -p tsconfig.json` chain exit `0`; `eslint` 0 on the three touched files; `prettier --check` clean; the
  six `adr-*` guards green.
- Delivered: two production files modified (`receipt-projection.ts`, the unsubscribe route) and one added
  (the ladder). No spec, fixture or helper in the diff; the pins are carried byte-identically from `c90ae3ba`.

## Alternatives

- **A plain `$set` of the mutable fields** — satisfies `P1`/`P2` and fails the downgrade direction: measured
  by the review, an `unsubscribed` receipt after a hard bounce becomes `{ reason: "unsubscribe", scope:
"marketing" }`, re-enabling transactional mail.
- **Read the row, then decide in JavaScript, then write** — two round trips with a race between them: two
  receipts for the same key can both read `marketing` and both write, and the later write still loses nothing
  but the ladder is no longer atomic.
- **A guarded filter (`scope: { $ne: "all" }`) with `upsert: true`** — when the stored row is strong the
  filter does not match and the upsert inserts, which the unique index rejects with a duplicate-key error.
- **A per-writer ladder** — two copies of the same policy, and the second copy is exactly where this defect
  came from.
