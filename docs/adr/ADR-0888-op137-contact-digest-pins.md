# ADR-0888 — OP-137 TEST: one canonical contact digest, pinned where a second hash is observable

- **Status:** Accepted (TEST; three RED pins, two characterization pins) ·
  **Date:** 2026-11-20
- **Card:** OP-137 TEST (Medium) `t_8290f915`, branch
  `OP-137-task-contact-digest-pins`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_8290f915`, cut from `origin/main`
  `efa034ff`, delivered as draft PR
  [#752](https://github.com/yahodu/openpic-webapp/pull/752).
- **Implements:** contract §10.1.3; design §19.5/§19.6; ADR-0875 §1 (one shared
  digest for every suppression lookup key).
- **Consumes:** [ADR-0875](ADR-0875-op137-delivery-receipts-red.md) (the pins
  this suite discriminates), [ADR-0882](ADR-0882-op137-delivery-receipts-green.md)
  (which recorded the ledger's private raw hash as a known limit), and the
  OP-99 unsubscribe route's suppression write (ADR-0240).
- **Consumers:** `apps/web/src/test/integration/notification-contact-digest.test.ts`
  (the new spec), and `apps/web/src/server/notifications/receipt-projection.test.ts`
  (two appended U2 cases).
- **Number allocation:** at the pin base `efa034ff` both `Next free` cells read
  `0886`, the trunk's highest record is `0885`, and the sweep found two numbers
  above it held by open refs: `ADR-0886-op136-row-failed-warn-reason-pin.md`
  (untracked in `.worktrees/t_16239628`) and
  `ADR-0887-op136-multi-row-containment-pins.md` (branch
  `OP-136-task-multi-row-containment-pins`, together with `0884`).
  `git log --all -- docs/adr` stops at `0887` and no `ADR-0888` or above exists
  on any ref. The card's reserved `0883` is stale — `ADR-0883` is the OP-136
  discovery-abort record — so the number is drawn at this sweep. The block
  `0849`–`0868` is exhausted, so this is a **pool draw** under ADR-0300 §11
  item 18: it draws `0888` and advances **both** the `OP-136 jobs lane` cell and
  the `unallocated (future lanes)` cursor to `0889`, one above this record so
  neither can re-mint it. No range is re-cut and no other number is consumed.

## Context

ADR-0875 §1 decided that every site needing a suppression lookup key derives it
from one shared function, `contactHashOf` = `sha256(trim + lowercase)` — 64
lowercase hex characters, with the stored key written `"sha256:" + <digest>`.
ADR-0882 shipped that function and recorded one limit it did not close: the
fan-out kept its own private hash. Nothing measured either gap, and two
measurements on the merged trunk show why that matters:

1. **The delivered U2 case is non-discriminating.** The case "the suppression key
   reuses the ledger's contact hash" passes even when the reducer _ignores_
   `dispatch.contactHash`: the fixture's ledger hash and its receipt address
   normalise to the same value, so a reducer that re-hashes `receipt.contact`
   agrees with one that prefers the ledger. Measured: with
   ``contactHash: `sha256:${contactHashOf(receipt.contact)}` `` the delivered
   suite reads `9 passed (9)`.
2. **The fan-out's ledger form is raw.** `contactHashOf` at `fan-out.ts` hashes
   the destination **as stored** — no trim, no lowercase — while
   `loadSuppressions` builds the lookup key from the shared canonical digest. A
   stored address `"  Probe.Recipient@Example.COM "` therefore writes
   `notificationDispatches.contactHash = efbc4102…` while the shared digest is
   `5fe71650…`: no suppression keyed by the shared digest can ever match that
   row, so a bounced or unsubscribed contact keeps receiving mail. A third copy
   lives in the unsubscribe route; it happens to agree today because it
   normalises by hand, which is exactly the kind of copy that drifts.

## Decision

Deliver **tests only**, in two places, both additive:

1. **Unit** (`receipt-projection.test.ts`, inside the existing U2 block; the
   delivered cases are byte-identical). One **discriminating** case gives the
   ledger a hash of a _different_ address (`previous@example.com`) from the one
   the receipt echoes (`"  RECIPIENT@EXAMPLE.COM "`), asserts the two digest
   derivations differ (a fixture guard, so the case cannot silently stop
   discriminating), and requires the suppression key to be `"sha256:"` + the
   **ledger** value. One supporting case pins the only fallback that is
   defensible for a legacy row: `contactHash === null` derives the key from the
   receipt, so an implementation can never write `"sha256:null"`.
2. **Integration** (new spec `notification-contact-digest.test.ts`). The
   canonical-address cases in `notification-fan-out.test.ts` and
   `webhook-novu-receipts.test.ts` are left untouched; the new suite seeds a
   **non-canonical** stored address throughout (`"  Probe.Recipient@Example.COM "`),
   which is the only shape in which a second digest is observable, and pins the
   whole path: `I9` the fan-out's `notificationDispatches.contactHash` is the
   shared digest; `I10` a signed hard bounce keys the suppression `"sha256:"` +
   that digest; `I11` the next marketing fan-out to the same stored address is
   `skipped`/`suppressed`; `I12` the unsubscribe route's row is keyed by the
   shared digest; `I13` an unsubscribe-then-fan-out round trip skips the
   marketing email. `I12`/`I13` are **characterization pins** (green on arrival)
   that put the third copy under test, so a future divergence reds instead of
   silently agreeing.
3. No production file, fixture, helper, config or existing case is edited. The
   only files in the diff are the two specs and this record with its ledger row.

The expected GREEN is one edit: `fan-out.ts`'s private `contactHashOf` — its
only remaining caller path is the dispatch write — delegates to the shared
`contactHashOf` it already imports. The unsubscribe route's copy may be
consolidated in the same pass; behaviour is identical, so `I12`/`I13` neither
demand nor forbid it.

## Evidence

Measured at `efa034ff` (branch `OP-137-task-contact-digest-pins`):

- Unit, at the pin head: `11 passed (11)` (the 9 delivered cases unchanged plus
  the 2 appended). **Mutation M1** — the reducer's suppression key changed to
  `` `sha256:${contactHashOf(receipt.contact)}` `` — gives
  `1 failed | 10 passed (11)`: the new discriminating case alone reds with
  `AssertionError: expected 'sha256:5efba3df…' to be 'sha256:be55f262…'`, while
  the delivered U2 case stays green. That is the card's non-discrimination
  claim reproduced, and the pin proved load-bearing. The production file was
  then restored byte-identically (`git status --porcelain` names only the spec).
- Integration, at the pin head: `3 failed | 2 passed (5)`.
  `I9` — `AssertionError: expected 'efbc41026c263b1f113faf3040f2528de596e…' to be
'5fe7165032ac04af8a67ae6328798fd765de6…'` (the card's own two digests).
  `I10` — the row keyed `"sha256:efbc41…"`, not `"sha256:5fe716…"`.
  `I11` — the marketing dispatch `status: 'sent'`, `skipReason: null`.
  `I12`/`I13` passed on arrival, as intended.
- **Near-fix probe M2** — the fan-out's private `contactHashOf` returning
  `sharedContactHashOf(destination)` — turns the whole new spec `5 passed (5)`,
  then the file is restored byte-identically. The RED is the raw hash, not the
  fixture.
- Neighbours untouched: `webhook-novu-receipts.test.ts`,
  `notification-fan-out.test.ts` and `notification-unsubscribe.test.ts` read
  `Test Files 3 passed (3)`, `Tests 42 passed (42)`.
- `tsc` exit `0` (root, contracts and `apps/web`), `eslint` 0 on both specs,
  `prettier --check` clean on every touched file, and the six `adr-*` guards
  read `6 passed`, `236 passed (236)`.
- Full suites at the pin head: `unit` `189 files / 3173 passed | 3 skipped
(3176)`, exit `0` (the base's 3174 plus this card's two unit cases);
  `integration` `150 files / 3 failed | 1572 passed (1575)` — the three are this
  card's `I9`, `I10` and `I11`, and every other file is green.

## Consequences and known limits

- **Until the GREEN lands, a non-canonical stored address cannot be
  suppressed.** The suppression row is written with the shared digest and the
  ledger row with the raw hash, so the lookup misses and mail keeps flowing to a
  hard-bounced or unsubscribed contact. `I11` and `I13` are the red and the
  guard for exactly that.
- **A future divergence in the unsubscribe route now reds.** `I12`/`I13` compute
  the expected key with the shared function only, so a hand-written normaliser
  that drifts from `trim().toLowerCase()` fails rather than agrees.
- **Out of scope, deliberately unpinned:** normalising `user.email` on write
  (a data-migration decision, not a digest one); the resolver's channel match
  and marketing/transactional scope split (pinned by `I4` of
  `webhook-novu-receipts.test.ts`); whether the unsubscribe route imports the
  shared module (behaviour only — importing is not observable); and the
  `in_app` arm, whose `contactHash` is legitimately `null`.

## Alternatives

- **Characterise the raw hash instead (green on arrival).** It would freeze the
  defect ADR-0875 §1 forbids; rejected.
- **Normalise the address in the fixture.** It makes the two derivations agree
  again and re-creates the non-discriminating case the card exists to remove;
  rejected.
- **Rewrite the delivered U2 case to use a different ledger address.** It would
  delete the canonical-address coverage the same suite relies on, and the card
  requires additions; rejected in favour of a new case beside it.
- **Seed the address with different casing only.** `contactHashOf` already
  lowercases, so casing alone cannot show the raw-hash gap; the fixture carries
  padding too, which is the shape a stored Better Auth row can actually have.
