# ADR-0348 — OP-103 follow-up TEST: the lost-race `U9` pin asserts the throw + single-emit enforcement surface

- **Status:** Accepted
- **Date:** 2026-10-24
- **Lane:** OP-103 (Entitlements), reserved range `0340`–`0359`
- **Card:** `t_f0d58138` (follow-up TEST, strengthen only), worktree
  `/root/openpic/openpic-webapp/.worktrees/t_f0d58138`, branch
  `OP-103-task-nontenant-lostrace-pins`, off `origin/main` `60df2ae` (the
  F1 squash `b721200` + the `1.29.2` release chore)
- **Consumes:** `0348`
- **Fixes:** the round-1 review finding **L1 — Low (test quality)** raised on
  card `t_4b89884d` (the REVIEW+MERGE of the F1 GREEN PR #281)
- **Supersedes nothing.** No decision in [ADR-0342](ADR-0342-op103-nontenant-scope-red.md)
  or [ADR-0343](ADR-0343-op103-nontenant-scope-green.md) is changed; this
  record only upgrades an assertion to match what those records already chose.

## Context

The F1 GREEN PR #281 is merged (`b721200`, ancestor of `origin/main`); `main` ==
`origin/main` == `60df2ae`, and `consumeEntitlement` already implements
ADR-0343 §2 — on a lost counter race it re-resolves against the live counter,
emits `usage.action.blocked` outside the transaction and throws the Appendix A
`plan_limit_exceeded` / `payment_required` error, exactly as a decision-time
denial does (`service.ts:578–586`).

The pin for that path did not say so. Spec **`U9: a failed advance is never
reported as success off the stale counter`** in
`apps/web/src/test/unit/entitlements-nontenant-scope.test.ts` read:

```ts
const verdict = await consumeEntitlement(...).catch(() => null);
expect(verdict?.allowed ?? false).toBe(false);
```

That assertion passes whether the call **throws** the Appendix A denial _or_
**returns** an `allowed: false` verdict, so it pinned neither the enforcement
surface ADR-0343 §2 deliberately chose nor the truthfulness of the denial's
payload. A future refactor that returned a denied verdict (or denied off the
pre-race `resolved`, reporting `used: 0` while the stored counter is `5`) would
have kept the suite green — the exact "report off a stale read" defect the F1
fix removed.

## Decision

The `U9` spec asserts the observable enforcement surface, split into four
behaviour-atomic specs (all in the same `describe`), with `makeLostRaceDb()`
extended by an optional `subscriptionStatus` so the `402`/`403` split is
observable:

1. The lost race **denies by throwing** — `await expect(consumeLostRace(db)).rejects.toMatchObject({ code: "plan_limit_exceeded" })`.
   It never resolves an `allowed: false` verdict. (This subsumes the previous
   weak assertion: a rejected promise is not a success verdict.)
2. The thrown denial's `details` carry the **re-read** state, not the pre-race
   counter — `{ entitlementKey, reason: "plan_limit", used: 5, limit: 3 }`
   (`makeLostRaceDb`'s pre-race read yields `0`, its post-race re-read yields
   `5`, so a payload reporting `used: 0` is the stale-state regression).
3. The lost race emits **exactly one** `usage.action.blocked` (an injected
   `vi.fn` emitter — `toHaveBeenCalledTimes(1)`), whose `payload` carries
   `used: 5`, `limit: 3`, `reason: "plan_limit"`, `scope: "tenant"`,
   `entitlementKey` and `periodKey: "2026-09"`, mirroring the decision-time
   denial.
4. When the re-read subscription status is `downgraded` the lost race denies
   with **`402 payment_required`** — the `payment_downgrade` half of the
   `402`/`403` split that `limitDenialReason(resolved)` shares between `decide`
   and the lost-race path.

No production file is touched. The four pre-existing `U8` specs and the four
`consumeEntitlement — non-tenant scope uses ctx.counts (option a)` specs are
unchanged; `makeLostRaceDb`'s new parameter defaults to `"active"`, so the
existing call site keeps its baseline.

## Consequences

- A regression that (a) returns a denied verdict instead of throwing, (b) denies
  from the stale `resolved`, or (c) drops/duplicates the blocked emit now breaks
  the suite loudly. Verified by mutation on a throwaway copy of `service.ts`
  (reverted before handoff, `git diff` on it empty):
  - pre-fix `return allowedVerdict(resolved, resolved.used)` on `advanced === null`
    → **4 failed / 4 passed** in the file;
  - `return deniedVerdict(resolved, limitDenialReason(resolved))` (the
    `allowed: false` surface the old assertion accepted) → **4 failed /
    4 passed**, with `AssertionError: promise resolved "{ allowed: false, … }"
instead of rejecting` — the failure message names the defect.
- The pin remains a _behaviour_ pin: it asserts the thrown error's `code`/
  `details` and the emitted event's `payload` (both contract surfaces), not
  private helpers, call counts of internal collaborators, or the `deny(...)`
  extraction.
- The strengthened `U9` is green on the trunk — it locks existing behaviour, it
  does not drive new code. No GREEN sibling is needed.
- Evidence at the pin head: unit **101 files / 1743 tests** green (+3 specs on
  the trunk's 1740), integration **72 files / 515 tests** green
  (`TMPDIR=/root/tmp-mongo`), `tsc` exit `0` on the root, `packages/contracts`
  and `apps/web` projects, `eslint` 0 errors, `prettier --check` clean on the
  changed file, the `adr-numbering` guard 29/29.

## Alternatives considered

- **Leave the pin as-is and record only a comment.** Rejected: the reviewer's
  finding is that the assertion is surface-blind; a comment does not fail on a
  regression.
- **Assert the denied verdict's shape instead of the rejection.** Rejected: it
  re-introduces exactly the ambiguity — the enforcement surface is the throw.
- **Fold the assertion into one large `U9` spec.** Rejected: one behaviour per
  spec keeps the failure message diagnostic (surface vs payload vs emit vs
  `402`).
- **Pin the emit via the real `emitDomainEvent` / outbox.** Rejected for the
  unit layer: the injected `emit` seam is the ADR-0340 contract's observation
  point; the durable emit is already covered by the integration suite (`I3`).
- **Change production to make the pin pass.** Not needed: the trunk already
  implements ADR-0343 §2. An implementation change would have required the GREEN
  card `openpic-webapp-backend-coder` and a stop-and-report on this card.

## Review sign-off — 2026-10-25 (card `t_f0d58138`, round 1 · artifact lens)

The round-1 (**artifact-lens**) review of the OP-103 follow-up TEST
(`t_f0d58138`) returned **APPROVED**, zero changes requested, zero reviewer
edits to the deliverable. Reviewed head `3edced1`, merged with `origin/main`
`93f44e3` as `8317585` — the shared-ledger `docs/adr/README.md` resolved as a
**union** (cell `0349`, rows `0340`–`0348` all present, zero conflict markers) —
squash-merged as `9f0fc44`.

- **Merged, and reviewed what landed.** PR
  [#287](https://github.com/yahodu/openpic-webapp/pull/287) `MERGED` as
  `9f0fc44` (squash); `git merge-base --is-ancestor 9f0fc44 origin/main` holds.
  Local `main` == `origin/main` == `9f0fc44` at review time.
- **The branch-only change is test + record only.**
  `git diff --name-only origin/main...HEAD` is exactly
  `apps/web/src/test/unit/entitlements-nontenant-scope.test.ts`,
  `docs/adr/ADR-0348-op103-nontenant-lostrace-pin.md` and `docs/adr/README.md` —
  **no production file touched**.
- **The pin changed exactly as §Decision records.** The four `U8` specs are
  byte-unchanged (titles and bodies); `U9` went from 1 spec to 4 (net +3).
- **The gates reproduced independently** on the merged head: unit **102 files /
  1748 tests**, integration **72 files / 515 tests** (`TMPDIR=/root/tmp-mongo`),
  `tsc --noEmit` exit 0 on root, `packages/contracts` and `apps/web`, `eslint`
  0 errors, `prettier --check` clean, and the ADR-numbering guard **29/29**.
- **The pin is proven load-bearing.** A throwaway detached probe worktree at
  `3edced1` (removed afterwards; the reviewed tree was never mutated):
  `return deniedVerdict(reread, limitDenialReason(reread))` → **4 failed | 4
  passed (8)** (`AssertionError: promise resolved "{ allowed: false, … }"
instead of rejecting`), and `return allowedVerdict(resolved, resolved.used)` →
  **4 failed | 4 passed (8)** (`… "{ allowed: true, … }"`). Both redden exactly
  the four `U9` specs and leave the four `U8` specs green, so the pin is neither
  vacuous nor over-broad.
- **Info (no action, no card).** The implementer's handoff metadata listed
  "4 × `U8` specs **and** 4 × `consumeEntitlement — non-tenant scope uses
ctx.counts (option a)` specs" as separate unchanged groups; they are the same
  four specs (the `U8` specs live in that `describe`). The substance is correct —
  4 unchanged, 4 new — the wording just double-counts.

Nothing in §Context–§Alternatives above is retracted: the strengthened `U9` is
the pin, not new production behaviour — the trunk already implements ADR-0343
§2, and this record only makes the existing enforcement surface fail loudly on a
regression.
