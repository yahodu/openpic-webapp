# ADR-0385 — OP-105 follow-up TEST: pin the memory provider's `fetchStatus` / `normalizeStatus` / `normalizeFailureCategory` (review F1/F2)

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-105 follow-up TEST (`t_1664350a`, round-1 review findings F1/F2 on `t_7dd42be8`) · **Branch:** `OP-105-task-memory-provider-normalizer-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_68faf9b3`
- **Relates to:** [ADR-0384](ADR-0384-op105-memory-payment-provider-green.md) §3 (the three methods this pin characterises) and its "Coverage note", [ADR-0383](ADR-0383-op105-memory-payment-provider-red.md) (the lane's RED pins) / [ADR-0382](ADR-0382-op105-live-sandbox-contract-test.md) (the live-sandbox record the stale comment used to name), [ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (the `ReadonlyMap` table style and the fail-safe defaults this adapter mirrors), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §7 (range allocation)
- **Contract:** §14.3 (`subscriptions.status` / `mandateStatus`), §14.4 (the four failure categories and the `technical` default) · **CONVENTIONS:** §7 (adapter boundary), §5.3 (nothing sensitive logged)
- **Releases:** nothing — this is a characterization pin of shipped behaviour (ADR-0384 §3); no production file changes

## Context

Round-1 (artifact lens) review of the OP-105 follow-up GREEN (`t_7dd42be8`, PR #296) approved with findings. Two of them are test-file work and therefore the Test Author's:

- **F1 (Medium)** — `fetchStatus`, `normalizeStatus` and `normalizeFailureCategory` are on the `PaymentProvider` port, implemented by the in-process adapter (ADR-0384 §3), and **no pin drives them**: the file measured 42/47 lines, 17/23 branches and 10/14 functions. OP-107 E1 (`t_98bf1d99`) and OP-108 drive that port, so their behaviour should be characterized now rather than when a downstream lane trips over it.
- **F2 (Low)** — `apps/web/src/test/unit/payments-memory-provider.test.ts:35` ended with `see ADR-0382`. After the ADR-0300 §7 renumber, `0382` names the **live-sandbox** record; this lane's RED is `0383`. The comment pointed a reader at the wrong document, and the GREEN lane may not edit a spec.

## Decision

### 1. The three port methods are pinned as **characterization pins**

The card's F1 is a regression lock, not a driver for new code: the behaviour already ships in ADR-0384 §3. Fourteen pins are added to the existing spec (12 → 26 in the file), in the file's established style (`loadProvider()` for a fresh module instance, `vi.useFakeTimers()` + `vi.setSystemTime(NOW)` in `beforeEach`):

- `fetchStatus(ref)` (2 pins) — `{ status: "active", mandateStatus: "active" }`, and the same answer for a ref of a different `kind` minted by a provider configured for a different `env` (the provider holds no state).
- `normalizeStatus` (7 pins) — one `it.each` over **all six** subscription statuses (`incomplete`→`incomplete`/`pending`, `active`→`active`/`active`, `past_due`→`past_due`/`paused`, `downgraded`→`downgraded`/`revoked`, `cancelled`→`cancelled`/`revoked`, `expired`→`expired`/`expired`), plus an unrecognised value (`ON_HOLD`) → `incomplete`/`pending` — the §14.3 fail-safe that must not silently grant entitlements.
- `normalizeFailureCategory` (5 pins) — one `it.each` over our four categories identity-mapped, plus an unrecognised code (`CARD_DECLINED`) → `technical` — the §14.4 fail-safe.

No assertion in the file is weakened or deleted; the pre-existing 12 pins are untouched.

### 2. The stale cross-reference is corrected

The one identifier `ADR-0382` in the file's header comment becomes `ADR-0383` (this lane's RED). No other line of the comment, and no other spec, changes.

### 3. This ADR records **no new contract**

Every behaviour pinned here was already decided by ADR-0384 §3 and the contract sections it cites; nothing is added to or widened in the port. The record exists because the lane records its decisions in `docs/adr/`, and because it carries the mutation evidence that the new pins are meaningful rather than a coverage-shaped tautology.

## Consequences

- The three port methods ADR-0384 §3 described are now executable specification; a future change to a status row, a fail-safe default or `fetchStatus`'s stateless answer breaks at least one pin and names itself in the failure message.
- The adapter's uncovered surface shrinks: the lines, branches and functions the review measured as uncovered are now exercised, so the global coverage gates are met with margin rather than eroded.
- OP-107 E1 and OP-108 inherit a characterized port: the normalizers can be relied on without re-deriving the §14.3 / §14.4 tables.
- `docs/adr/README.md` is the known shared-ledger hotspot. This card advances the OP-105 lane's `Next free` cell `0385` → `0386`; the next same-lane card must re-read the cell on a fresh `origin/main`.

## Alternatives

- **Leave the three methods unpinned** (the state ADR-0384 shipped). Rejected: they are on a port two downstream lanes drive, and the review routed the gap here rather than to the day a lane trips over it.
- **Write a RED and a GREEN sibling.** Rejected: this is characterization of shipped behaviour, so there is no code to write. The pins are green on first run and need no GREEN — had one failed, the card directs a GREEN card with the failure evidence rather than a weakened pin.
- **Pin one representative status and one representative category.** Rejected: the tables are the contract and are small; an exhaustive `it.each` is what makes a dropped or re-mapped row fail. A representative-value pin silently accepted exactly the tail mutations the probe below kills.

## Evidence (pin PR)

- Focused spec: `pnpm vitest run --project unit apps/web/src/test/unit/payments-memory-provider.test.ts` → **26 passed (26)** (12 pre-existing + 14 new), green on first run — no RED, no GREEN sibling.
- **Mutation probe** (adapter copied to the scratch dir, mutated, the spec re-run, the adapter restored — `git diff` on it empty afterwards); every mutation is killed by exactly the pin that names it:
  - `MEMORY_STATUS` → `past_due`/`paused`: `expected { status: 'past_due', … } to deeply equal { status: 'active', … }` (both `fetchStatus` pins).
  - `normalizeStatus`'s fail-safe default → `active`/`active`: `expected { status: 'active', … } to deeply equal { status: 'incomplete', … }`.
  - `normalizeFailureCategory`'s default → `insufficient_funds`: `expected 'insufficient_funds' to be 'technical'`.
  - the `past_due` status row → `revoked`/`revoked`: `expected { status: 'revoked', … } to deeply equal { status: 'past_due', … }`.
  - the `auth_required` category row → `technical`: `expected 'technical' to be 'auth_required'`.
- Production code in the diff: **none** (one spec file, this ADR and the README ledger cells).
