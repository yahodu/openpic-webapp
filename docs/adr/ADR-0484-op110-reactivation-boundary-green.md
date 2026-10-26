# ADR-0484 — OP-110 follow-up GREEN: the reactivation predicate narrowed to the recovery pair

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-110 follow-up GREEN (`t_805e17b6`) · **Branch:** `OP-110-task-reactivation-boundary-green` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_805e17b6`
- **Relates to:** [ADR-0483](ADR-0483-op110-reactivation-boundary-pins.md) (the RED pins this turns green), [ADR-0480](ADR-0480-op110-self-serve-billing-red.md) §5 (the widening this bounds), [ADR-0481](ADR-0481-op110-self-serve-billing-green.md) (the GREEN that shipped it), [ADR-0440](ADR-0440-op108-webhook-inbox-red.md) / [ADR-0443](ADR-0443-op108-concurrent-projection-ordering-green.md) (the projection this extends), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation), [ADR-0306](ADR-0306-red-branch-pipeline.md) (the RED-by-design draft-PR pipeline)
- **Contract:** §3.3 (retry-charge success returns to `active`), §10.1.2 (`SUBSCRIPTION_PAYMENT_SUCCESS` projection row) · **Schema:** §14.3 (`subscriptions`) · **Appendix A.4**

## Context

The OP-110 follow-up TEST card (`t_ffec14e2`) pinned the boundary of the
reactivation predicate ADR-0480 §5 widened. ADR-0481 shipped
`apps/web/src/server/billing/webhook-projection.ts` with:

```ts
const reactivating = subscription.status !== "active";
```

so a stray `payment_succeeded` for a `cancelled` or `incomplete` row flipped
`status` to `active`, restored `activePlanKey = subscribedPlanKey`, and
re-emitted `billing.subscription.reactivated` + `usage.limit.restored` — a
widening, not a restatement. §3.3 and §10.1.2 ground reactivation on exactly two
recovery paths (`past_due` and `downgraded`) and name no third. The pins are RED
as shipped (`expected 'active' to be 'cancelled'`, `expected 'active' to be
'incomplete'`) with a green `past_due` control.

This card is that GREEN. It consumes `0484`, the OP-110 lane `Next free` cell's
value re-read on current `origin/main` immediately before this record was
written.

### Renumber (the lane cell was a snapshot)

While this lane was in flight, the sibling OP-110 follow-up pins card for the
invoice-number decode squash-merged onto trunk (`PR #346` → `c2ebc589`,
17:19:41), taking `0482`. Both pins branches had read `0482` on the same trunk
snapshot, so that number is now **trunk-owned** and this lane's two records are
renumbered past it: the reactivation-boundary pins `ADR-0482` → **`ADR-0483`**
and this GREEN `ADR-0483` → **`ADR-0484`**, with every file name, H1, in-text
cross-reference, README index row and ledger paragraph updated and the lane cell
advanced `0483` → **`0485`** (highest consumed `0484` + 1). Without this, the
trunk's unit `apps/web/src/test/unit/adr-numbering.test.ts`
(`checkAdrDirectory`) would see two `ADR-0482` files.

The numbers were chosen by enumerating the lane's **in-flight** reservations
(ADR-0300 §9, rule B) as well as trunk's consumed set: `0483` is free on trunk
_and_ on every open OP-110 remote head (`git ls-remote --heads origin "OP-110*"`
then `git ls-tree` each head's `docs/adr/` → the highest `048x` on any of them is
the trunk-owned `0482`), and no non-`done` OP-110 card reserves an `0480`–`0499`
number, so the pair takes the next free `0483`/`0484`. The invoice-number-decode
GREEN (`t_7f9ccfa0`) landed without minting a number, so the `0483` its pins
record had pencilled in for it stayed free.

## Decision

### 1. Gate the status flip, the `activePlanKey` restore and the emitted pair together

The narrowest honest change — exactly the shape ADR-0483 §4 prescribed:

```ts
const reactivating = ["downgraded", "past_due"].includes(subscription.status);
const reachesActive = reactivating || subscription.status === "active";
return {
  outcome: "applied",
  subscriptionPatch: {
    ...(reachesActive ? { status: "active" } : {}),
    ...(reactivating ? { activePlanKey: subscription.subscribedPlanKey } : {}),
    pendingDueMinor: 0,
    gracePeriodEndsAt: null,
    currentPeriodEnd: end,
    nextChargeAt: end,
    dunning: RESET_DUNNING,
  },
  transaction,
  emittedKeys: reactivating
    ? ["billing.payment.succeeded", "billing.subscription.reactivated", "usage.limit.restored"]
    : ["billing.payment.succeeded"],
};
```

The shipped `subscriptionPatch` set `status: "active"` **unconditionally**;
gating only the predicate would have left a `cancelled` row landing on `active`,
so the status flip is gated too (ADR-0483 §5's mutation probes demonstrate
exactly this).

### 1a. One deviation from ADR-0483 §4's literal snippet, forced by the OP-108 U1 pin

ADR-0483 §4's snippet gates the status flip on `reactivating` alone:

```ts
...(reactivating ? { status: "active" } : {}),
```

That literal form breaks the existing unit pin `webhook-projection.test.ts` ›
**U1** (`payment_succeeded → the period extends…`), which seeds an
`activeSubscription()` and asserts the patch **contains** `status: "active"` via
`toMatchObject`. With the flip key absent for an already-`active` row the
received patch no longer matches. The card's own acceptance ("OP-108's own
`payment_succeeded` pins … must stay green") therefore requires the status key to
survive for an already-`active` row, so the gate is
`reactivating || subscription.status === "active"` — the row reaches (or
restates) `active` on a recovery or when it is already there, and every other
status (`cancelled`, `incomplete`, or a status a later contract adds) is left
untouched. This is a general rule, not a fixture special-case: no test input is
sniffed and the omitted key was always the redundant `"active"` already stored.
The `activePlanKey` restore and the emitted pair remain gated on `reactivating`
alone, exactly as the pins require.

### 2. What is deliberately unchanged

- A `payment_succeeded` still records the ledger row and emits
  `billing.payment.succeeded` for every status.
- For an `active` row the patch is byte-for-byte the same effect as before: the
  omitted `status` was `"active"` already, and the period/dunning reset still
  applies. OP-108's own `payment_succeeded` pins (seeded `active`) are untouched.
- The non-recovery period/grace handling is left as-is. ADR-0483's Consequences
  record it as **deliberately unpinned**: the contract is silent, and a GREEN
  that instead patches nothing for a non-recovery status is equally legitimate.
  This change takes the one-line narrowing the card asked for rather than
  over-constraining a decision the contract does not make.

## Evidence

The pins ship **unchanged** in this branch (`git diff` on
`apps/web/src/test/integration/provider-webhook-inbox.test.ts` is empty; the
pins commit `89dbfd7` is the base).

Focused acceptance:

```
npx vitest run --project integration \
  apps/web/src/test/integration/provider-webhook-inbox.test.ts \
  -t "the reactivation boundary"
  → 3 passed | 21 skipped (24)
```

The `past_due` control, the OP-110 I3 pin (`billing-self-serve.test.ts` › I3)
and OP-108's own `payment_succeeded` pins are green. Static gates: `tsc -p
apps/web/tsconfig.json --noEmit` exit 0, ESLint 0 errors (the single pre-existing
`security/detect-object-injection` warning on `webhook-projection.ts:572` is
unchanged), `prettier --check` clean.

## Consequences

- The reactivation boundary is now executable and honest: a `cancelled` row is
  terminal by the tenant's own action and an `incomplete` row is pre-activation
  (its documented transition to `active` is the activation event, not a charge
  confirmation), so neither is resurrected by a stray confirmation.
- A future re-widening of the predicate that lets `cancelled`/`incomplete`
  through, or that drops `past_due`, breaks at least one pin with a message that
  names the observable.
- One-line production change plus this ADR and the shared-ledger update; no test,
  mock, fixture or factory is edited.
- `docs/adr/README.md` is the shared-ledger hotspot: the OP-110 lane `Next free`
  cell advances `0484` → `0485`, and a later lane's merge is a union resolution
  keeping this row at `0484`.

## Alternatives

- **Delete the pins instead of narrowing the predicate.** Rejected as absurd and
  forbidden: the pins encode the contract's own §3.3/§10.1.2 reading, and editing
  a test to reach green is sabotage of the pipeline.
- **Keep the wide `status !== "active"` predicate.** Rejected in ADR-0483 §
  Alternatives; this GREEN removes it.
- **Patch nothing for a non-recovery status (`subscriptionPatch: null`, the
  refund shape).** Equally legitimate per ADR-0483, but it changes the ledger's
  period/bookkeeping side-effects for a payment that is still real; the card's
  narrowest change keeps money-side effects and gates only the access-side flip.

## Review sign-off — 2026-10-25 (card t_c83556f9, round 1 · artifact lens)

Append-only: nothing above is retracted or edited. This section records the
round-1 review of [PR #354](https://github.com/yahodu/openpic-webapp/pull/354)
(the reactivation-boundary GREEN, branch `OP-110-task-reactivation-boundary-green`)
by the card `t_c83556f9`, and it consumes **no** ADR number — the OP-110 lane
`Next free` cell stays `0485` and `docs/adr/README.md` is unchanged.

**Verdict: approved, landed as `2ac32c14`** — the squash-merge of PR #354
(`fix(billing): OP-110 narrow the reactivation predicate to the recovery pair
(#354)`, 2026-10-25 18:10:34). The reviewed head was `4e62d5d` (parents
`29ffd59` + `origin/main` `5ecfc18`), and local `main` == `origin/main` ==
`2ac32c14` at land time.

**Tree-identity proof.** `git rev-parse 4e62d5d^{tree} 2ac32c14^{tree}`
resolves both to `309346514258ab3d0b3dc274f06bfe67b3551582` — the reviewed
head's tree is the shipped tree — and `git diff --stat 4e62d5d 2ac32c14` is
empty. Everything below was re-derived in throwaway probe worktrees at that tree
(per-package `node_modules` symlinked, probes removed afterwards).

**The six checks.**

- **ADR-numbering guard on the merged tree** — `vitest run --project unit
apps/web/src/test/unit/adr-numbering.test.ts` → **29 passed (29)**.
- **No duplicate numbers** — `ls docs/adr/ | grep -oE 'ADR-[0-9]{4}' | sort |
uniq -d` → empty; trunk `docs/adr/` carries `0480`–`0484` with no duplicate.
- **Full suites** — unit **2042 passed | 3 skipped (118 files)** and
  integration **704 passed (84 files)**.
- **Focused acceptance + mutation probe** — `-t "the reactivation boundary"` →
  **3 passed (21 skipped)**; with the predicate widened back to
  `subscription.status !== "active"` in the probe tree the two new pins go RED
  (`expected 'active' to be 'cancelled'`, `expected 'active' to be
'incomplete'`), the `past_due` control stays green, and the OP-108 U1
  colocated spec stays green (16 passed) — i.e. the `reachesActive` deviation is
  forced by U1, not a fixture special-case.
- **Docs and PR gates** — `prettier --check "docs/adr/**/*.md"` clean; PR
  Checks on `4e62d5d` pass (`ci`, `unit_test`, `test_coverage`, `lint`,
  `audit`, `env-changes`, `secret-scan`, `validate-*`, CodeQL, Analyze), with
  `audit-dev` red **by design** (ADR-0301).
- **Ledger union resolution** — **+7/−1** vs `origin/main` (OP-110 cell
  `0483`→`0485`, the two index rows, the two OP-110 prose paragraphs — main's
  rows/prose verbatim).

**Findings routed (not fixed here).**

- **F1 (Medium, routed → card `t_517c30ca`)** — trunk `docs/adr/README.md` is
  truncated at EOF (`5ecfc18`, PR #352, dropped the body of the board-wide
  `0309`→`0310` paragraph: `2f5a080` 572 lines properly terminated vs `5ecfc18`
  552 dangling). Repaired by that card, not by this one.
- **F2 (Low, routed → the same card `t_517c30ca`, second edit)** — the OP-110
  pins ledger paragraph claims "the cell's value re-read on the base immediately
  before committing" while its named base `2be55fb` read `0482` (`git show
2be55fb:docs/adr/README.md | grep 'OP-110 self-serve billing lane'`); the
  allocation is right, the clause is not.
- **F3 (Low, reviewer action)** — draft PR
  [#344](https://github.com/yahodu/openpic-webapp/pull/344)
  (`OP-110-task-reactivation-boundary-pin`, `89dbfd7`) was superseded by #354
  and closed as such; its three files ride in the squash (the pins ADR identical
  apart from the H1 renumber `ADR-0482` → `ADR-0483` and one in-text
  source-line reference `:564` → `:572`).

The follow-up card `t_517c30ca` is cited by id only — no ADR number it may still
mint and no PR number that does not exist yet. The findings above are **not**
retracted; the follow-up's own record documents what followed.
