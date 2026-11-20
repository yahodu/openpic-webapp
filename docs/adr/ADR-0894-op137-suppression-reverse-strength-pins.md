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
