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
  (the new spec), `apps/web/src/server/notifications/receipt-projection.test.ts`
  (two appended U2 cases), and `apps/web/src/test/integration/notification-fan-out.test.ts`
  (`I14`/`I15`, the writers this pack could not see — appended by
  [ADR-0897](ADR-0897-op137-contact-digest-writer-pins.md)).
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

## Review — round 1 (artifact, then execution)

Reviewed at the pin head `ce6e32a4` (branch `OP-137-task-contact-digest-pins`, draft PR
[#752](https://github.com/yahodu/openpic-webapp/pull/752)) in a detached worktree of that commit, with
the root, `apps/web` and `packages/contracts` `node_modules` symlinked from a healthy lane. Every figure
below is this review's own run at that commit, not a transcription of the handoff.

**Verdict: accepted as a RED pack.** The pins discriminate the defect they name, each carries a fixture
guard that stops it going vacuous, and no production file, fixture, helper or delivered case is in the
diff. The pack is RED by design, so the PR stayed a draft and was closed as superseded by the GREEN
(card `t_1039146a`, PR [#763](https://github.com/yahodu/openpic-webapp/pull/763), squash `b15e0268`).
Reproduced at `ce6e32a4`:

- Unit, the appended block inside the delivered `U2` suite: `11 passed (11)`.
- Integration, the new spec: `3 failed | 2 passed (5)`. `I9` — `AssertionError: expected 'efbc41026c263b1f113faf3040f2528de596e…' to be '5fe7165032ac04af8a67ae6328798fd765de6…'`. `I10` — the suppression row keyed `sha256:efbc41…`, not
  `sha256:5fe716…`. `I11` — the marketing dispatch `status: 'sent'`, `skipReason: null`. `I12` and
  `I13` passed on arrival, as intended.
- Full suites at the same commit: `unit` `189 files / 3173 passed | 3 skipped (3176)`, exit `0`;
  `integration` `150 files / 3 failed | 1573 passed (1576)`, the three being this pack's `I9`, `I10`
  and `I11`.
- Guards at the same commit: the six `adr-*` specs `6 files / 236 passed (236)`.

One figure in §Evidence does not reproduce, and this section is the correction of record (the frozen
text above is not edited): that section gives the full `integration` run as
`150 files / 3 failed | 1572 passed (1575)`, while this run at the same commit read
`1573 passed (1576)`. The failing three, the file count and every defect signature are identical; only
the passed total differs, by one.

### The pins were proved load-bearing, not merely red

- **M1** — the projection's suppression key derived from the receipt's own address instead of the
  ledger's `dispatch.contactHash`: `1 failed | 10 passed (11)`, the new discriminating case alone, with
  `expected 'sha256:5efba3df…' to be 'sha256:be55f262…'`, and the delivered `U2` case still green. The
  file was restored byte-identically (`sha256 fe6cebe8…`, `git status --porcelain` empty).
- **M2** — the fan-out's private digest returning the shared one: the new integration spec
  `5 passed (5)`.
- **Third-copy probe** — the unsubscribe route's digest made raw (no `trim`, no lower-case), with M2 in
  place: `2 failed | 3 passed (5)`, `I12` and `I13` alone. That route is the third copy of the digest,
  and these two characterization pins are the only thing that puts it under test.

### Findings

- **F1 (Low/Medium, coverage) — the pack pins one of three ledger writers.** `fan-out.ts` wrote the
  dispatch ledger's digest at three sites: `:909` (the quiet-hours `deferred` row), `:1013` (the
  `queued` row an outbound `send` inserts — the only one `I9` reaches) and `:1647` (the synchronous
  `sendTransactionalNow` builder). Measured: fixing the call site at `:1013` alone reads
  `5 passed (5)` while `:909` and `:1647` still call the raw private hash, and `eslint` stays clean
  (`0 errors`, 8 pre-existing warnings) because the private function is still used there. Neither the
  suite nor the lint gate can see the two uncovered writers, so the GREEN's completeness proof is a
  `createHash` grep rather than a test. Routed to TEST card `t_57c291d0`.
- **F2 (Low) — the delegate leaves an unused import.** With M2 in place, `fan-out.ts:31`'s
  `createHash` import is unused and `eslint` reports exactly one error there
  (`'createHash' is defined but never used`, `@typescript-eslint/no-unused-vars`). Lint is a gate, so
  the GREEN owes that deletion.
- **F3 (Low) — rows written before the fix stay raw.** A pre-fix ledger row carries
  `sha256(destination-as-stored)` and can never match a canonical suppression key, so the GREEN has to
  decide between backfilling and accepting. It decided **accepted, not backfilled** (the ledger stores
  only the digest, and the field is a lookup key rather than display data).
- **F4 (Low, process) — the trunk's `Next free` cells lagged a consumed number.** At `c96c2d18` (the
  trunk the pin branch merged) both cells read `0888` while the unmerged branch had already drawn
  `0888` and advanced its own cells to `0889` (`63afdf06`), so a trunk-only sweep of that day could
  have re-minted the number. Reservations were posted on the two cards about to draw — `t_df4e6eb3`
  and `t_b7bcc125`, both at 2026-11-20 10:44 — and both drew above it.

### Two corrections to the commissioning card

Both were measured, and both are recorded here rather than silently omitted.

- **(a) The worktree path.** The card named `.worktrees/t_838a93a7`, which does not exist in this
  checkout; `git worktree list` has never carried it. The board row's `.worktrees/t_8290f915` is the
  worktree the pins were authored in, and it is authoritative.
- **(b) The ADR number.** The card reserved `0883`, and that number was already consumed by an OP-136
  record (`ADR-0883-op136-discovery-abort-pin.md`, PR #746). The number was therefore drawn at the
  author's own sweep — `origin/main`, every `.worktrees/*/docs/adr` tree and every open PR head — which
  found no collision on any of them and no `0888` anywhere above the trunk's highest record.

### What this review changed, and what it did not

- The only reviewer-authored commit on the pin branch is `ce6e32a4`
  (`author=openpic reviewer <reviewer@openpic.local>`, 2026-11-20 10:36 UTC): a merge of `origin/main`
  `c96c2d18` into the pin tip `63afdf06`. Against the pin tip it introduces exactly three paths —
  main's `job-pipeline-indexed-check.test.ts` and `ADR-0887` record, byte-identical to the trunk
  (blobs `60a214ee…` and `16be20a5…`), and `docs/adr/README.md` (`+3`): main's `0887` index row, a
  blank line and its `t_3d67936e` ledger paragraph, inserted in ascending position so the ledger reads
  `0886`, `0887`, `0888`. Both `Next free` cells stay `0889`; main's `0888` cell is not carried.
- No test, fixture, helper or delivered case was edited by the review.
- The one-line `Consumers:` addition to [ADR-0875](ADR-0875-op137-delivery-receipts-red.md) — the new
  spec named as a consumer — came with the pin author's commits, not with the merge, and it is
  **guard-required**: removing it reddens the repository case of `adr-consumers` with
  `{ code: 'consumer-mismatch' }` (`1 failed | 97 passed (98)`), and the restored line reads
  `98 passed (98)`. That is not the same thing as this record's own `Consumers:` line, which later
  gained the `I14`/`I15` spec as **disclosure** rather than a guard requirement (measured by card
  `t_57c291d0`).

### Status after this review

No section above is retracted. Each finding has an owner and a landing:

- **F1** → TEST card `t_57c291d0`, landed as PR
  [#768](https://github.com/yahodu/openpic-webapp/pull/768) (squash `d1f99b8a`): `I14` pins the
  `deferred` writer and `I15` the `queued` phone arm, each proved load-bearing by mutating its own line
  back to the raw hash.
- **F2, F3** → GREEN card `t_1039146a`, landed as PR
  [#763](https://github.com/yahodu/openpic-webapp/pull/763) (squash `b15e0268`): the private digest
  delegates to the shared one at every writer, the unused `createHash` import is gone (the trunk's
  `fan-out.ts` imports no `createHash`), and the pre-fix rows are **accepted, not backfilled**, as
  recorded in that GREEN's consequences.
- **F4** → the reservations on `t_df4e6eb3` and `t_b7bcc125`; both drew above `0888` and landed, the
  pins of the first carried in by the GREEN's PR
  [#759](https://github.com/yahodu/openpic-webapp/pull/759) (squash `a69f0340`) and the second being
  that GREEN's own record.

The three writers are now measured rather than grepped: `I9` (the `queued` email arm), `I14` (the
`deferred` email arm) and `I15` (the `queued` phone arm) are pinned, and the `sendTransactionalNow`
builder is recorded as a deliberate residual in the follow-up's own record, not as a discovery.
