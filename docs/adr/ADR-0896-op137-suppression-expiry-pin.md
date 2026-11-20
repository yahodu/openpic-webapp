# ADR-0896 — OP-137 TEST: the weaker-write `expiresAt` arm — a weaker receipt never clears a temporary suppression's expiry

- **Status:** Accepted (characterization pin + test hygiene) · **Date:** 2026-11-20
- **Card:** OP-137 TEST (Low) `t_59d05489`, the round-1 review's only follow-up to
  [ADR-0894](ADR-0894-op137-suppression-reverse-strength-pins.md) (card `t_1e7cb2a3`, PR
  [#762](https://github.com/yahodu/openpic-webapp/pull/762), squash `fc79fc20`). Branch
  `OP-137-task-suppression-expiry-pin`, worktree `/root/openpic/openpic-webapp/.worktrees/t_1e7cb2a3`,
  cut from `origin/main` at `fc79fc20` and rebased onto `origin/main` `208a3db0` (the tree of `3f5d0225`,
  the squash of PR [#761](https://github.com/yahodu/openpic-webapp/pull/761), which landed while this card
  ran, plus the `1.69.0` release commit) before the ADR number was drawn, so the delivered base is
  `208a3db0`.
- **Pins:** contract §10.1.3 (a hard bounce and a DND rejection suppress **all** scopes; an unsubscribe
  suppresses **marketing** only) and design §19.6 (one `{channel, contactHash}` suppression key).
- **Consumes:** [ADR-0894](ADR-0894-op137-suppression-reverse-strength-pins.md) §2 (the claim this record
  makes measurable: a weaker write does not re-arm `expiresAt`); [ADR-0891](ADR-0891-op137-suppression-strength-upgrade-only-green.md)
  (the ladder, and its `expiresAt: null` arm); [ADR-0889](ADR-0889-op137-suppression-strength-pins.md)
  (the upgrade direction, byte-identical here); [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md)
  §12–§13 (allocation, re-sweep, never lower a cell).
- **Consumers:** `apps/web/src/test/integration/webhook-novu-receipt-suppression-reverse-strength.test.ts`
  (its header cites this record). No production module cites it: the ladder it measures is
  `@/server/notifications/suppression-strength`, whose own record is
  [ADR-0891](ADR-0891-op137-suppression-strength-upgrade-only-green.md).
- **Number allocation:** the card names `0896` as the first candidate and directs a re-sweep immediately
  before pushing. The delivery sweep found `ADR-0895`
  ([ADR-0895](ADR-0895-op137-readme-ledger-link-guard-green.md), PR #761, merged as `3f5d0225`) as the
  highest record on `origin/main`, on `git rev-list --objects --all -- docs/adr`, in every
  `.worktrees/*/docs/adr` tree, and the highest on any open PR head (#763 `0894`, #755 `0889`, #752 `0888`,
  #743 `0881`, #272 `0306`); `ADR-0896` exists on no ref and no non-done card body names it except this
  card. Both `Next free` cells read `0896` on the base (`208a3db0`, the tree of `3f5d0225`), so this record
  takes `0896` and advances **both**
  the `OP-136 jobs lane` cell and the `unallocated (future lanes)` cursor to `0897`. No cell is lowered and
  no range is re-cut. A **pool draw** (the block `0849`–`0868` is exhausted, §11 items 18–21).

## Context

[ADR-0894](ADR-0894-op137-suppression-reverse-strength-pins.md) §2 records that a weaker incoming write
"neither narrows the stored scope nor rewrites its reason, its `source`, its `expiresAt` re-arm or its
`createdAt`", and its ledger row repeats the claim. The delivered case `P5` seeded its row with
`expiresAt: null`, so the **re-arm** half of that sentence was not measured: a row that never had an expiry
cannot show whether a weaker write preserves one.

The round-1 review measured the gap in a throwaway worktree detached at `fc79fc20`, mutating
`apps/web/src/server/notifications/suppression-strength.ts` so that the ladder's
`expiresAt: ladder("expiresAt", null)` becomes an unconditional `expiresAt: null`:

- `webhook-novu-receipt-suppression-reverse-strength.test.ts` answered `2 passed (2)` and the sibling pins
  `4 passed (4)` — `6 passed (6)`, nothing red;
- a probe case that seeded `expiresAt = T0 + 1h` and delivered the same weaker `unsubscribed` receipt was
  **red** under that mutation (`expected null to deeply equal 2026-11-20T01:00:00.000Z`) and **green** on
  the shipped code.

So the pin discriminates and needs no production change. The user story is the one ADR-0894 protects — _«we
never re-send to hard-bounced or DND contacts»_ — read the other way: a temporary suppression must stay
temporary. Under the mutation a weaker marketing receipt made an all-scope hard bounce **permanent**, and no
case saw it.

## Decision

### 1. `P7` — the expiry survives a weaker write, at an exact instant

The new case lives in the ADR-0894 spec,
`apps/web/src/test/integration/webhook-novu-receipt-suppression-reverse-strength.test.ts`, and uses the
file's existing helpers exactly as `P5` does: `seedRecipient` → the **real** `fanOutOtp` dispatch (so the
receipt's `transactionId` is the ledger's own `providerRef.messageId` and the key is the ledger's own
`contactHash`) → `seedSuppression({ reason: "hard_bounce", scope: "all", expiresAt: future, source: novu })`
with `future = T0 + 60 * 60 * 1000` → a **signed** `status: "unsubscribed"` receipt →
`deliverReceipt`, which drains the deferred projection.

Asserted:

- the webhook answers `200`;
- the suppression row is **exactly** the seeded row, expiry included — `reason: "hard_bounce"`,
  `scope: "all"`, `createdAt: new Date(T0)`, the same `source`, and `expiresAt` **equal to `future`** as an
  exact instant, not `null` and not a bound.

The exact-instant assertion is the point: `toEqual` on a `Date` compares the millisecond value, so a ladder
that stored "now + the old horizon", a re-armed horizon, `null` or a different seed all red with a diff
naming the two instants.

### 2. `P7` also asserts the row was **live**, not merely stored

The second half proves the case is not passing on an expired row: after the receipt, the next
`auth.otp.email.requested` fan-out must add no `sent` dispatch, leave the memory transport's outbox `[]`, and
record a `{ status: "skipped", skipReason: "suppressed" }` row. A seeded row that the fan-out's lookup
already ignored (`expiresAt` in the past, or a key the fan-out does not compute) could not satisfy both
halves.

### 3. `F2` — the dead logger scaffolding is removed

The file imported `getLogger`/`setLogger`, declared `let ambientLogger`, assigned it in `beforeAll` and
restored it in an `afterEach`. `grep -n "setLogger" <file>` returned exactly one call site — the `afterEach`
restore — so no case in the file ever swapped the logger: the scaffolding was copied from the pins file,
where a log-hygiene case needs it. It is deleted (import, declaration, assignment and the hook), together
with `afterEach` in the `vitest` import, which had no other use. `P7` does not swap the logger either; if a
later case needs one, it brings its own restore.

### 4. What `P7` deliberately does **not** hold

- The fan-out's own expiry semantics (`{ expiresAt: null }` or `{ expiresAt: { $gt: now } }`) are not
  re-specified here; `P7` only requires that the row it seeded is still in force.
- The inbox `processResult` of a weaker receipt stays as `P5` left it — asserted only as **not `error`**
  (ADR-0894 §4): `applied` and `ignored` are both legitimate.
- No pin holds `{ reason: "unsubscribe", scope: "all" }`, and the equal-strength
  `complaint`-after-`hard_bounce` reason refresh stays unpinned — ADR-0891's recorded limits, unchanged.
- The pins' own file (`webhook-novu-receipt-suppression-strength.test.ts`), the shipped
  `webhook-novu-receipts.test.ts` and `notification-unsubscribe.test.ts` are not opened.

## Consequences

- **The ADR-0894 §2 claim is now forced, not allowed.** Re-measured for this record in a throwaway worktree
  at this branch head with the same mutation (`expiresAt: ladder("expiresAt", null)` → `expiresAt: null`):
  the spec answers **`1 failed / 2 passed (3)`** — `P7` alone, at
  `- "expiresAt": 2026-11-20T01:00:00.000Z` / `+ "expiresAt": null` — while `P5` and `P6` stay green and
  the sibling pins answer `4 passed (4)`. The probe worktree was deleted; the mutation was never committed.
- **A future refactor that "simplifies" the ladder to an unconditional expiry clear reds `P7` alone**, with
  the two instants in the diff; the reverse-direction arms of ADR-0894 stay green, so the failure is
  attributable.
- **Test hygiene only, no production edit.** The diff is the spec (one added case and the scaffolding
  removal), this record and the ledger row/cells. No GREEN is needed: both arms are green on arrival and
  the shipped ladder already satisfies `P7`.
- **The file was not split.** The header's `P7` bullet states the arm, so a reader of the spec sees the
  contract the record describes.

## Evidence

Run on this branch (base `origin/main` `208a3db0`):

| Surface                                                                        | Result                                |
| ------------------------------------------------------------------------------ | ------------------------------------- |
| `webhook-novu-receipt-suppression-reverse-strength.test.ts` (touched)          | `3 passed (3)` — `P5`, `P6`, `P7`     |
| `webhook-novu-receipt-suppression-strength.test.ts` (ADR-0889, byte-identical) | `4 passed (4)`                        |
| `webhook-novu-receipts.test.ts` (shipped, untouched)                           | `20 passed (20)`                      |
| `notification-unsubscribe.test.ts` (untouched)                                 | `16 passed (16)`                      |
| `receipt-projection.test.ts` (pure reducer, untouched)                         | `9 passed (9)`                        |
| Seven `adr-*` guards                                                           | `248 passed (248)`                    |
| Unconditional-`expiresAt: null` probe (throwaway worktree, deleted)            | `1 failed / 2 passed (3)` — `P7` only |

`tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` 0 on the touched file; `prettier --check`
clean.

## Alternatives

- **Widen `P5` to seed a future `expiresAt`** — `P5` is delivered and green; rewriting it would change a
  published case's meaning and hide which arm a future failure belongs to. `P7` states the expiry arm as its
  own contract.
- **Assert `expiresAt` is not `null`** — too weak: a ladder that re-armed the horizon on every weaker write
  would pass, and it would still let the row lapse later than the writer that owns it intended. The exact
  instant is the contract.
- **Assert a bound (`expiresAt > now`)** — same hole, one step narrower: a re-arm by any amount passes.
- **Keep the second half out** — then `P7` could pass against an implementation whose lookup already ignored
  the row, so a green `P7` would not prove the seeded suppression was in force. Both halves are cheap and
  together they say "stored unchanged **and** still effective".
- **Keep the logger scaffolding "just in case"** — dead scaffolding that no case drives is a false signal
  that log hygiene is covered here; the pins file owns that case, and this file brings its own restore when
  it needs one.
