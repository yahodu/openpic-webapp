# ADR-0897 — OP-137 TEST: the ledger writers the `I9` pin cannot see — the quiet-hours `deferred` row and the phone channel

- **Status:** Accepted (characterization pins; green on arrival) · **Date:** 2026-11-20
- **Card:** OP-137 TEST (Low) `t_57c291d0`, gated on the OP-137 GREEN `t_1039146a`
  ([ADR-0892](ADR-0892-op137-contact-digest-green.md), PR
  [#763](https://github.com/yahodu/openpic-webapp/pull/763), squash `b15e0268`). Branch
  `OP-137-task-contact-digest-writer-pins`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_1039146a` (the GREEN's worktree, reused so the lane stays
  one-worker-at-a-time), cut from `origin/main` at `c0bc6f1e` and merged with `origin/main` `2578e95e`
  (the ADR-0894 sign-off) before delivery, so the delivered head is `13aef7d4`. The fix is present on that
  base: `grep -n "createHash" apps/web/src/server/notifications/fan-out.ts` returns nothing.
- **Pins:** contract §10.1.3 (a suppression is keyed on `{channel, contactHash}`) and design §19.5/§19.6
  (one `{channel, contactHash}` key, one digest for every writer).
- **Consumes:** [ADR-0888](ADR-0888-op137-contact-digest-pins.md) (the pin pack this record extends, and
  its non-canonical-address shape); [ADR-0892](ADR-0892-op137-contact-digest-green.md) (the GREEN whose
  completeness this record makes measurable); [ADR-0875](ADR-0875-op137-delivery-receipts-red.md) §1 (one
  shared digest for every suppression lookup key); [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md)
  §12–§13 (allocation, re-sweep, never lower a cell).
- **Consumers:** `apps/web/src/test/integration/notification-fan-out.test.ts` (its `I14`/`I15` block cites
  this record). No production module cites it: the function it measures is
  `@/server/notifications/fan-out`, whose own records are
  [ADR-0882](ADR-0882-op137-delivery-receipts-green.md) and
  [ADR-0892](ADR-0892-op137-contact-digest-green.md).
- **Number allocation:** the card names no number and directs a sweep at delivery. The delivery sweep
  (`git fetch origin --prune`; `origin/main` `c0bc6f1e`; every `.worktrees/*/docs/adr` tree; every open PR
  head — #766, #755, #743, #272, each fetched for the purpose) reads `0896` as the highest record
  anywhere: `origin/main` and the head of PR #766 stop at `0896`
  ([ADR-0896](ADR-0896-op137-suppression-expiry-pin.md)), PR #755 at `0889`, PR #743 at `0881` and PR #272
  at `0306`. Both `Next free` cells read `0897` on that base (`OP-136 jobs lane` and
  `unallocated (future lanes)` — the cell is a consumed count, so `0896`'s own record already advanced
  them), so this record takes `0897` and advances **both** cells to `0898`. No
  cell is lowered and no range is re-cut. A **pool draw** (the block `0849`–`0868` is exhausted, §11
  items 18–21).

## Context

`notificationDispatches.contactHash` is derived inside `@/server/notifications/fan-out` at **three**
sites, and all three now resolve to the one shared digest
(`contactHashOf(destination)` at `:251` returns `sharedContactHashOf(destination)` =
`sha256(trim + lowercase)`, ADR-0875 §1):

| writer                                                                  | line at the pin base | pinned before this card                                         |
| ----------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------- |
| the quiet-hours / digest `deferred` row (email **or** phone)            | `:911`               | **no**                                                          |
| the `queued` row an outbound `send` inserts (email **or** sms/whatsapp) | `:1015`              | email half only — `I9` of `notification-contact-digest.test.ts` |
| the synchronous single-dispatch builder, `sendTransactionalNow`         | `:1649`              | **no**                                                          |

[ADR-0888](ADR-0888-op137-contact-digest-pins.md) delivered five pins that all discriminate a raw
`sha256(destination)` from the shared digest — but only at `:1015`, and only through the **email**
destination. The card's finding F1 measured the consequence on the GREEN: a fix that patched `:1015`
alone, instead of making the private function delegate, still passes the whole pin pack
(`5 passed (5)`) while `:911` and `:1649` keep writing the raw hash. The completeness proof was
therefore a grep over `fan-out.ts`, not the suite. A raw row never matches the lookup key
`"sha256:" + sharedContactHashOf(contact)` that `loadSuppressions` builds, so a deferred or
transactionally-sent contact that later bounces or unsubscribes cannot be suppressed — the same defect
ADR-0875 §1 forbids, at two writers no pin could see.

A canonical destination cannot show the difference: `sha256("a@b")` and the shared digest of `"a@b"`
are the same value. The only observable shape is a destination whose **stored bytes are not their own
canonical form**, which is exactly the shape ADR-0888 adopted (`"  Probe.Recipient@Example.COM "`) and
the shape Better Auth's `user` row can carry, because neither the fan-out nor the receipt path
normalises `user.email` on write (ADR-0888 §Consequences).

## Decision

Deliver **tests only**, additive, in the file where the quiet-hours case already lives
(`apps/web/src/test/integration/notification-fan-out.test.ts`). The delivered twelve cases, the shared
helpers and the `PRE-1` quiet-hours case are byte-identical; the new block appends at EOF (+142/−0) and
the only other edit is one import line (`contactHashOf` from
`@/server/notifications/contact-hash`).

- **`I14` — the `deferred` writer.** Seed the recipient's stored address as
  `"  Probe.Recipient@Example.COM "`, enable quiet hours (`22:00`→`07:00`, `Asia/Kolkata`) so the
  injected clock at `T0` (05:30 IST) is inside the window, run the real `runNotificationFanOut` for
  `account.welcome`, and assert the row is `status: "deferred"` on channel `email`, that nothing left
  through the transport, and that `contactHash === contactHashOf(<the stored address>)`. The case opens
  with a fixture guard (`STORED !== CANONICAL` **and**
  `contactHashOf(STORED) === contactHashOf(CANONICAL)`) so it can never silently stop discriminating.
- **`I15` — the `queued` writer on the non-email channel.** The same non-canonical idea for a phone
  destination — `"  +919876543210  "`, the only non-canonical shape a stored number can carry (padding;
  there is no case to fold) — through `collab.invite.sent`, whose mobile group resolves `whatsapp`→`sms`
  with `whatsappCapable: null`. It asserts exactly one `sms` row, `channelGroup: "mobile"`,
  `status: "sent"` (so the row is the send path's own insert, not a skip), the transport actually
  carried an `sms`, and `contactHash === contactHashOf(<the stored phone>)`.
- **No expectation re-implements `sha256`.** Both cases compare against the shared `contactHashOf`, so a
  change to the canonical form moves the writer and the expectation together — the rule ADR-0888 set.
- **No production file, fixture, helper or existing case is edited.** The private function's declaration
  is untouched, so this record makes a regression _visible_; it does not restate the fix.

## Evidence

Measured on branch `OP-137-task-contact-digest-writer-pins` at `eb7bbf00` (the spec commit) unless
stated otherwise.

- **The focused file is green on arrival** — the whole point of a characterization pack:
  `Test Files 1 passed (1)`, `Tests 14 passed (14)` (the twelve delivered cases plus `I14`/`I15`), with
  both new titles named in `--reporter=verbose`.
- **Mutation M1 — the `deferred` writer back to the raw hash.** In a **throwaway** worktree
  (`git worktree add --detach <scratch>/probe-eb7bbf00 eb7bbf00`, the three per-package `node_modules`
  symlinked — root, `apps/web`, `packages/contracts`) `:911` was rewritten to
  `destination === null ? null : createHash("sha256").update(destination).digest("hex")` (plus the
  `node:crypto` import the tree no longer needs). Result: `Test Files 1 failed (1)`,
  `Tests 1 failed | 13 passed (14)` — **`I14` alone**, with
  `AssertionError: expected 'efbc41026c263b1f113faf3040f2528de596e…' to be '5fe7165032ac04af8a67ae6328798fd765de6…'`.
  Those are the two digests ADR-0888 recorded for the same address, which independently confirms the
  mutated writer reproduces the pre-GREEN defect. Every shipped case stayed green.
- **Mutation M2 — the `queued` writer back to the raw hash.** The same worktree, `:1015` rewritten the
  same way: `Tests 1 failed | 13 passed (14)` — **`I15` alone**, with
  `AssertionError: expected '9d481083e32094bc58fa195aeb5b7f0cfda75…' to be 'f3a47ce5ce3d4ca8ad15225a245b2759022f7…'`
  (the raw hash of the padded number versus the shared digest of the same number trimmed). The email row
  the same writer produced in that case is unaffected — the case pins the phone destination — and every
  shipped case stayed green.
- **Byte-identical restore.** After each mutation the production file was restored from the in-memory
  copy and hashed: `sha256` `8a6cf389092aa6f3…` before and after both runs, and the probe worktree was
  removed with `git worktree remove --force`. The delivered tree's diff against `origin/main` names one
  file and no deletions: `git diff --stat origin/main HEAD` → `1 file changed, 142 insertions(+)`.
- **Neighbours untouched.** `notification-contact-digest.test.ts` (`I9`–`I13`) and the `PRE-1` case are
  byte-identical; the canonical-address cases are not opened.
- **Gates:** `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` on the spec 0 errors / 0
  warnings ("No issues found"); `prettier --check` clean; the seven `adr-*` guard files green.
- **Full suites, at the delivered head `13aef7d4`** (the merge of `origin/main` `2578e95e` into the two
  commits), both exit `0`: `unit` `190 files / 3185 passed | 3 skipped (3188)` and `integration`
  `152 files / 1593 passed`. Delivered as PR
  [#768](https://github.com/yahodu/openpic-webapp/pull/768).

## Consequences and known limits

- **A regression at `:911` or on the phone half of `:1015` now reds the suite**, with a failure that
  names the digest it wanted. Before this record, both were invisible: the pin pack exercised `:1015`
  with an email destination only.
- **The third writer is deliberately left unpinned, and the reason is scope, not impossibility.**
  `:1649` lives in `sendTransactionalNow`, whose `destination` is a **caller-supplied** argument (the
  address a user typed at sign-in), not a stored `user` row. It is therefore reachable from a spec in one
  call — `sendTransactionalNow({ db, clock, transport, typeKey, channel: "email", destination:
"  Probe.Recipient@Example.COM ", payload })` with `typeKey: "auth.otp.email.requested"` — asserting the
  inserted row's `contactHash` at `:1649`. It is not pinned here because the card scopes the pack
  to the `deferred` row and the phone channel; the shape above is recorded so the follow-up is a decision,
  not a discovery. Until it lands, the completeness proof for that writer remains the grep, not the suite.
- **The pins are behaviour pins, not shape pins.** They never assert that `fan-out.ts` has no
  `createHash`, that the private function delegates, or that the shared module is imported — a legitimate
  refactor that keeps one canonical digest passes every case.
- **`in_app` rows stay out of scope**, as in ADR-0888: their `contactHash` is legitimately `null`.
- **A padded `user.email` is still not normalised on write.** These cases pin the digest, not the stored
  bytes; normalising the row is a data-migration decision ADR-0888 already recorded as out of scope.

## Alternatives

- **Pin the private function instead of the writers.** Rejected: it asserts an implementation shape, so a
  refactor that inlines or renames it breaks the test while the behaviour is unchanged.
- **Re-seed `I9` with a phone destination instead of adding a case.** Rejected: it would delete the
  email-destination coverage the file relies on, and the card requires additions.
- **Assert `sha256(destination)` locally to show the two differ.** Rejected: it re-implements the digest
  in the spec, so a change to the canonical form would red both the writer and the spec for the same
  reason and the failure would stop explaining itself.
- **Sweep `fan-out.ts` for `createHash` from the suite.** Rejected for the same reason as the first: a
  source-text assertion freezes one implementation and passes a raw hash written any other way (for
  example via `createHmac` or an inline constant).
