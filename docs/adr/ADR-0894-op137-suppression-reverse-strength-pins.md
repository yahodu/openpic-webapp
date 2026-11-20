# ADR-0894 — OP-137 TEST: the receipt path's **reverse** direction — a weaker receipt can never downgrade the shared suppression row

- **Status:** Accepted (characterization + regression pins) · **Date:** 2026-11-20
- **Card:** OP-137 TEST (Medium) `t_1e7cb2a3`, gated on the GREEN `t_b7bcc125`
  ([ADR-0891](ADR-0891-op137-suppression-strength-upgrade-only-green.md)) and following the pins
  `t_df4e6eb3` ([ADR-0889](ADR-0889-op137-suppression-strength-pins.md)). Branch
  `OP-137-task-suppression-reverse-pins`, worktree `/root/openpic/openpic-webapp/.worktrees/t_1e7cb2a3`,
  cut from `origin/main` at `061c5ae0` (the squash `a69f0340` of PR
  [#759](https://github.com/yahodu/openpic-webapp/pull/759) already carries the strength pins —
  `git grep -n "P1:" origin/main -- apps/web/src/test/integration/` is non-empty — so no deleted branch is
  a base).
- **Pins:** contract §10.1.3 (a hard bounce and a DND rejection suppress **all** scopes; an unsubscribe
  suppresses **marketing** only) and design §19.6 (one `{channel, contactHash}` suppression key).
- **Consumes:** [ADR-0891](ADR-0891-op137-suppression-strength-upgrade-only-green.md) (the ladder the pins
  must force); [ADR-0889](ADR-0889-op137-suppression-strength-pins.md) (the upgrade direction and its
  recorded "known limit": this reverse direction); [ADR-0882](ADR-0882-op137-delivery-receipts-green.md)
  (the projection); [ADR-0875](ADR-0875-op137-delivery-receipts-red.md) (the receipt envelope and the
  suppression key); [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §12–§13 (allocation,
  re-sweep, never lower a cell).
- **Consumers:** `apps/web/src/test/integration/webhook-novu-receipt-suppression-reverse-strength.test.ts`
  (its header cites this record). No production module cites it: the ladder it pins is
  `@/server/notifications/suppression-strength`, whose own record is
  [ADR-0891](ADR-0891-op137-suppression-strength-upgrade-only-green.md).
- **Number allocation:** the card body names no number and directs a fresh one above the highest in-flight
  record. The delivery sweep (`git fetch origin --prune`; `origin/main`; `git rev-list --objects --all --
docs/adr`; every `.worktrees/*/docs/adr` tree; every open PR head — #761/#755/#752/#743/#272) found
  `ADR-0893` (`OP-137-task-readme-link-guard`, PR [#761](https://github.com/yahodu/openpic-webapp/pull/761))
  as the highest live record, with `ADR-0892` (`.worktrees/t_1039146a`, the contact-digest GREEN) beside it.
  Both `Next free` cells read `0892` on this base, so `0894` is the free number: this record takes it and
  advances **both** cells to `0895`. No cell is lowered and no range is re-cut. A **pool draw** (the block
  `0849`–`0868` is exhausted, §11 items 18–21), so both the `OP-136 jobs lane` cell and the
  `unallocated (future lanes)` cursor move.

## Context

ADR-0889 pinned the receipt path in the **upgrade** direction (`P1`, `P2`), the unsubscribe route's
non-downgrade (`P3`) and the stored document's shape (`P4`), and recorded one arm as a known limit: a
**weaker receipt** arriving on the projection path. On the head ADR-0889 was written against, that arm was
harmless — the projection's `$setOnInsert` never modified an existing row, so nothing could be downgraded.
That is exactly why no pin saw it, and exactly why it had to be pinned before the repair landed.

ADR-0891 then replaced the write with a strength ladder. When the receipt path stops being "leave the row
alone" and becomes a write, an unconditional `$set` of `reason`/`scope` re-opens the defect from the other
side: the projection's `case "unsubscribe"` drafts `{ reason: "unsubscribe", scope: "marketing" }`, so a
signed `status: "unsubscribed"` receipt over a `hard_bounce`/`all` row would narrow it — and transactional
mail would resume for a hard-bounced contact. ADR-0891 §Consequences records the reverse direction as
"covered by construction, measured in a throwaway probe, not pinned". A construction that nothing measures
is a construction that a later refactor may remove silently.

## Decision

### 1. One new sibling spec, no delivered case touched

`apps/web/src/test/integration/webhook-novu-receipt-suppression-reverse-strength.test.ts` (**+2 cases**). The
pins' own file (`webhook-novu-receipt-suppression-strength.test.ts`, ADR-0889) is **byte-identical** — its
documented "known limit" stays the historical record — and the shipped `webhook-novu-receipts.test.ts` and
`notification-unsubscribe.test.ts` are not opened. Reusing the pins file would have renumbered or rewritten
delivered cases for a new behaviour; a sibling states the reverse direction as its own contract.

### 2. `P5` — an `unsubscribed` receipt never downgrades an all-scope row

Driven through the real routes exactly as `P1`/`P3` are: a real fan-out writes the dispatch (so the key is
the ledger's own `contactHash` and the receipt's `transactionId` is the ledger's own
`providerRef.messageId`), an all-scope `hard_bounce` row is seeded for that key, a **signed**
`status: "unsubscribed"` receipt is `POST`ed, and the deferred projection is drained. Asserted:

- the webhook answers `200` and its §18.4 inbox row is not `processResult: "error"`;
- the suppression row is **exactly** the seeded row — `reason: "hard_bounce"`, `scope: "all"`,
  `expiresAt: null`, `source` unchanged, `createdAt` unchanged (a weaker write neither narrows the scope,
  rewrites the reason, re-dates the row nor drops its provenance);
- **the observable consequence**: the next `auth.otp.email.requested` fan-out adds no `sent` dispatch
  (the pre-receipt dispatch is `sent` and stays the only one), the memory transport's outbox is `[]`, and
  the fan-out records exactly one `{ status: "skipped", skipReason: "suppressed" }` row — so the pin is the
  user story (_«we never re-send to hard-bounced contacts»_), not a document shape, and the skip cannot pass
  vacuously through a dedupe.

### 3. `P6` — a `dnd_rejected` receipt is a **reason-aware** upgrade

A `marketing` row (as the one-click route writes it) plus a signed `status: "dnd_rejected"` receipt must
store `{ reason: "dnd_registry", scope: "all" }` with the receipt's `source`, keeping `createdAt`. Both
`complaint` and `dnd_rejection` are all-scope kinds, so the ladder is not merely a comparison of the _two
writers'_ scope constants: the third all-scope reason must travel the same path, and the observable
consequence flips too — the next OTP, which a `marketing` row must never block (§10.1.3, U11), is now
`skipped`/`suppressed` with an empty outbox.

### 4. What the pins deliberately do **not** hold

- The inbox `processResult` of a weak receipt is asserted only as **not `error`**: an implementation that
  records a weaker receipt as `applied` (the shipped one) and one that records it as `ignored` are both
  legitimate; pinning either would forbid a valid strategy.
- No pin holds `{ reason: "unsubscribe", scope: "all" }` — the shape ADR-0891 §Consequences records as a
  known limit that no writer produces.
- The `complaint`-after-`hard_bounce` reason refresh (ADR-0891: latest wins, no ordering among the three
  all-scope reasons) is still unpinned.

## Consequences

- **The ladder is now forced, not allowed.** Measured in a throwaway worktree detached at `origin/main` with
  the naive repair the card describes (`$set` the mutable fields + `$setOnInsert: { createdAt }`), the new
  file answers **`1 failed | 1 passed (2)`**: `P5` fails at the row — `reason: "unsubscribe"`,
  `scope: "marketing"` where `hard_bounce`/`all` is required — which is the downgrade, in the assertion's own
  words. `P6` passes under that same naive repair because `marketing → all` is an upgrade in **both**
  implementations; its teeth are a scope-blind or bounce-only DND arm (a `dnd_rejected` receipt mapped to
  marketing, or one skipped as "not a bounce"), not the naive-`$set` class. Recorded so no future reader
  mistakes `P6` for a second guard on `P5`'s defect. The probe worktree was deleted; the repair was never
  committed.
- **Green on arrival, by design.** The GREEN already landed, so on this base the file is `2 passed (2)` and
  the PR is **non-draft**. A RED pack here would have meant the ladder was not what ADR-0891 claims, and the
  card's instruction was then to report the measurement and leave the PR a draft.
- **The next refactor that "simplifies" the projection to a `$set` reds `P5` alone**, with a diff naming
  `reason`/`scope`; a refactor that drops the DND arm reds `P6` alone.
- **No production edit.** The diff is the new spec, this record and the ledger row/cells only.

## Evidence

Run on the delivery branch (base `origin/main` `061c5ae0`):

| Surface                                                                        | Result                                 |
| ------------------------------------------------------------------------------ | -------------------------------------- |
| `webhook-novu-receipt-suppression-reverse-strength.test.ts` (new)              | `2 passed (2)` — `P5`, `P6`            |
| `webhook-novu-receipt-suppression-strength.test.ts` (ADR-0889, byte-identical) | `4 passed (4)`                         |
| `webhook-novu-receipts.test.ts` (shipped, untouched)                           | `20 passed (20)`                       |
| `notification-unsubscribe.test.ts` (untouched)                                 | `16 passed (16)`                       |
| `receipt-projection.test.ts` (pure reducer, untouched)                         | `9 passed (9)`                         |
| Naive-`$set` probe (throwaway worktree at `origin/main`, deleted)              | `1 failed \| 1 passed (2)` — `P5` only |

`tsc` typecheck chain exit `0`; `eslint` 0 on the touched files; `prettier --check` clean; the six `adr-*`
guards green.

## Alternatives

- **Append `P5`/`P6` to the pins' file** — the card requires that file byte-identical (it is the record of
  what was delivered against `c90ae3ba`), and an append would silently renumber its `describe` blocks.
- **Pin only the stored document** — the document shape is `P4`'s job; without the fan-out consequence the
  pin could pass while transactional mail still resumed (e.g. a row left `marketing` because the _lookup_
  used a different key form).
- **Fabricate the dispatch instead of fanning out** — the suppression key is the ledger's own
  `contactHash`; a fixture's guess would pin the projection against a key no fan-out ever looks up.
- **Assert the inbox `processResult` strictly** — see §4: both `applied` and `ignored` are plausible for a
  weaker receipt, so only "not an error" is contract.
- **Pin the DND arm as `complaint`** — a complaint is a different provider signal with different semantics
  on the dispatch ledger; `dnd_rejected` is the arm the card asks for and the one that exercises the third
  all-scope reason.

## Review — round 1

Sign-off card `t_f02b587c` records the round-1 review of the pin card `t_1e7cb2a3` (PR
[#762](https://github.com/yahodu/openpic-webapp/pull/762)). The delivery merged by its own card's
mandate before the review ran, so this is a **post-merge verification** of the bytes the trunk
carries. Every figure below is this sign-off's own measurement at the squash `fc79fc20`; none is
transcribed from the delivery handoff.

- **Verdict:** accepted, `APPROVED WITH FINDINGS` — posted as the PR comment
  [`issuecomment-7039970506`](https://github.com/yahodu/openpic-webapp/pull/762#issuecomment-7039970506).
  The two findings are **Low** and additive: **F1** is a coverage gap and **F2** is dead test
  scaffolding. No production change was requested, and no re-review is needed.
- **Merge proof.** Head `2112dd7e`, squash `fc79fc20`, merged `2026-11-20T12:35:25Z`.
  `git diff 2112dd7e fc79fc20` is empty, so the squash kept the branch tree, and
  `git merge-base --is-ancestor fc79fc20 origin/main` passes. This record's blob is `cccebd78` at the
  head, at the squash and at `origin/main`: the reviewed bytes are the trunk bytes. I did not merge
  again, and I did not edit a delivered file.
- **Re-run at the merged squash `fc79fc20`** (detached scratch worktree, `node_modules` linked from
  the lane, worktree removed afterwards): the four integration files → **4 files, `42 passed (42)`** —
  the new spec `2 passed (2)` (`P5`, `P6`), the pins `4 passed (4)`, the shipped
  `webhook-novu-receipts.test.ts` `20 passed (20)` and `notification-unsubscribe.test.ts`
  `16 passed (16)`; the reducer `9 passed (9)`; the six `adr-*` guards → **6 files,
  `236 passed (236)`**; `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` exit `0` on the
  new spec; `prettier --check "docs/adr/**/*.md"` clean.
- **Probe 1 — the projection path only.** The naive write the card describes (`$set` the mutable
  fields + `$setOnInsert: { createdAt }`) replaced the `upsertSuppression` call in
  `apps/web/src/server/notifications/receipt-projection.ts` → **`1 failed | 5 passed (6)`**: `P5`
  alone, with `P6` and the four pins green:

  ```
  -   "reason": "hard_bounce",
  -   "scope": "all",
  +   "reason": "unsubscribe",
  +   "scope": "marketing",
  ```

  The pin is **forced**, which is this record's whole claim. `P6` passing here repeats what
  §Consequences states: a `marketing → all` write is an upgrade under both implementations.

- **Probe 2 — the shared helper.** The same naive write inside
  `apps/web/src/server/notifications/suppression-strength.ts` → **`2 failed | 4 passed (6)`**:
  `P5` and the pins' `P3`. Both writers share the ladder, so one wrong helper reds both directions.
- **Probe 3 — the DND arm.** `dnd_rejection` mapped to `marketing` in `receipt-projection.ts` →
  **`1 failed | 21 passed (22)`**: `P6` alone, with the shipped `20 passed (20)` green. `P6` has
  teeth and is not a second guard on `P5`'s defect.
- **Probe 4 — the expiry arm.** `expiresAt: ladder("expiresAt", null)` → `expiresAt: null` in the
  shared helper → **`6 passed (6)`**: every case green. This is **F1**. Each probe was reverted with
  `git checkout -- <path>`; `git status --porcelain` was empty after every revert and the worktree
  stayed at `fc79fc20`.
- **F1 — the `expiresAt` arm is invisible to every case (Low, coverage gap).** §2 claims a weaker
  write does not re-date the row, but `P5` seeds `expiresAt: null`, so an unconditional
  `expiresAt: null` passes every case (probe 4). A case that seeds `expiresAt = T0 + 1h` over a
  weaker receipt and expects the instant intact reds under the mutation
  (`expected null to deeply equal 2026-11-20T01:00:00.000Z`) and passes on the shipped code. The
  failure direction is fail-safe — over-suppression, never resumed mail — so the severity is **Low**.
  Routed to `t_59d05489`.
- **F2 — dead logger scaffolding (Low, test hygiene).** `getLogger`/`setLogger`, `ambientLogger` and
  the restoring `afterEach` are present, and no case swaps the logger. Routed to `t_59d05489`.
- **F3–F6 (Info, no card).** At `fc79fc20` the new spec has **448** non-blank lines and **329** of
  them repeat a line of the sibling pins spec (a `Counter` multiset over non-blank lines; a plain
  membership count reads `346`). The card instructed a new sibling and the pins file is frozen, so the
  duplication is the instructed shape. `P5` asserts the inbox `processResult` only as not `"error"`,
  which §4 records as deliberate. The commissioning card's "shipped `14 passed`" figure is stale: the
  shipped file reads `20 passed (20)` here. `{ reason: "unsubscribe", scope: "all" }` and the
  equal-strength `complaint`-after-`hard_bounce` refresh stay unpinned, as §4 records.
- **No production change, no re-review.** The findings add one coverage case and remove dead code.
  Neither changes a delivered case, and the PR is already on the trunk.
- **After the review — both findings closed.** Card `t_59d05489` landed them as PR
  [#765](https://github.com/yahodu/openpic-webapp/pull/765) (squash `f27eb8db`, an ancestor of
  `origin/main`), which mints [ADR-0896](ADR-0896-op137-suppression-expiry-pin.md): `P7` pins F1's
  arm with an exact seeded instant, and F2's scaffolding is gone. Measured on this section's base
  `c0bc6f1e`, the reverse-strength spec reads `3 passed (3)` and the guard family seven files,
  `248 passed (248)`. The figures in the bullets above stay the review's own, at `fc79fc20`.
- **Ledger.** Both `Next free` cells read `0897` on this section's base `c0bc6f1e`. This section mints
  no number, adds no index row and moves no cell: `docs/adr/README.md` is byte-identical to the base
  (`sha256 9fac9d248bec11b37dcddddbafb66a465e5fbd0fe062c979504279c5aaad3052` before and after the
  append), so no reader finds a renumbered record beside this section.
- **No retraction.** Nothing in the header block, §Context, §Decision (all four subsections),
  §Consequences, §Evidence, §Alternatives or §Number allocation is retracted, reworded or re-badged.
  The measurements those sections state stand, and probes 1–4 reproduce them at the squash.
