# ADR-0892 — OP-137 GREEN: every dispatch-ledger write carries the shared contact digest

- **Status:** Accepted (GREEN) · **Date:** 2026-11-20
- **Card:** OP-137 GREEN (Medium) `t_1039146a`, turning green the pins ADR-0888 accepted and closed on
  the pin case `t_8290f915`. Branch `OP-137-task-contact-digest-green`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_1039146a`, cut from the pin head `ce6e32a4`, delivered
  non-draft against `main` (draft PR #752 then closed as superseded).
- **Implements:** contract §10.1.3; design §19.5/§19.6; ADR-0875 §1 (one shared digest for every
  suppression lookup key).
- **Consumes:** [ADR-0888](ADR-0888-op137-contact-digest-pins.md) (the eleven unit and five integration
  pins this change turns green), [ADR-0875](ADR-0875-op137-delivery-receipts-red.md) §1 (the one shared
  digest), [ADR-0882](ADR-0882-op137-delivery-receipts-green.md) (which shipped the shared function and
  recorded the fan-out's private raw hash as a known limit), and
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 items 18–21 (the pool draw and the
  ledger cells).
- **Consumers:** `apps/web/src/server/notifications/fan-out.ts` (§1) and
  `apps/web/src/app/api/v1/notifications/unsubscribe/[token]/route.ts` (§2).
- **Number allocation:** `0892` is a **pool draw**. Both `Next free` cells read `0889` on this branch's
  base `ce6e32a4` (the pin record `ADR-0888` advanced them there; the branch's highest record is
  `0888`), while `origin/main` `63dbe750` reads `0891` in both cells with `ADR-0890` its highest record.
  The sweep immediately before minting found no `ADR-0892` file, object or open-PR path anywhere: every
  `.worktrees/*/docs/adr` tree stops at `0891`, `git rev-list --objects --all -- docs/adr` stops at
  `0891`, and the five open PR heads hold `0875` (#743), `0875`/`0888` (#752), `0889` (#755),
  `0889`/`0891` (#759) and `0283` (#272). The block `0849`–`0868` is exhausted, so §11 item 18 advances
  **both** the `OP-136 jobs lane` cell and the `unallocated (future lanes)` cursor to `0893`, one above
  this record. No cell is lowered (§11 item 20), no range is re-cut and no number outside `0892` is
  consumed. **F4 resolved, no renumber:** `ADR-0888` is not minted by anyone else — the only `0888`
  record on any surface is this lane's own pin record on `OP-137-task-contact-digest-pins` — so the pin
  record keeps its number. **Second union, before landing:** `origin/main` advanced to `fc79fc20` while
  this PR's checks ran and its ledger now holds `ADR-0894` with both cells at `0895`; the second
  index-only union keeps `0895` (a cell is never lowered, item 20), and `ADR-0892` is still held by no
  other ref, so no renumber is due and this lane mints `0892` only.

## Context

ADR-0875 §1 decided that every site needing a suppression lookup key derives it from one shared
function: `contactHashOf(contact)` = `sha256(contact.trim().toLowerCase())`, 64 lowercase hex
characters, with the stored key written `"sha256:" + <digest>`. ADR-0882 shipped that function and
recorded one limit it did not close: `fan-out.ts` kept its own private `contactHashOf`, which hashed the
destination **as stored** — no trim, no lower-case — and that value is what the dispatch ledger wrote to
`notificationDispatches.contactHash`.

A stored address with padding or mixed case (a shape the Better Auth `user` row can legitimately hold)
therefore wrote a ledger row keyed `efbc4102…` while every suppression key is built from `5fe71650…`.
No suppression keyed by the shared digest ever matched that row, so a hard-bounced or unsubscribed
contact kept receiving mail. ADR-0888 pinned it (`I9` the ledger form, `I10` the suppression key, `I11`
the next send `skipped`/`suppressed`) and measured that the pins discriminate **one** of the four
writers: they reach the `queued` dispatch's email path only.

The private hash had four callers, not one: `fan-out.ts` writes a ledger row in three places — the
quiet-hours/digest `deferred` dispatch, the main `queued` dispatch (email **or** phone) and the direct
single-dispatch builder — and a fourth copy of the digest lives in the unsubscribe route, which happens
to normalise by hand and so agrees today. A call-site fix at the pinned path would pass every pin and
leave three writers raw; that is the card's finding **F1**, and it is why the fix belongs in the
function body, not at an assertion's reach.

## Decision

One edit in `apps/web/src/server/notifications/fan-out.ts`, plus the optional consolidation the card
allows:

1. **The private `contactHashOf` delegates.** Its body becomes `return sharedContactHashOf(destination);`
   — the shared function the module already imports as `sharedContactHashOf`. All three ledger writers
   go through the one function unchanged, so completeness is structural rather than per-call-site: there
   is no code path left that can write a raw digest.
2. **The now-unused `createHash` import is removed.** With the delegate in place the import is dead, and
   an unused import is an eslint error (`'createHash' is declared but its value is never read`) — `lint`
   is a CI gate.
3. **The unsubscribe route's private copy delegates too.** `contactHashOf(contact)` becomes
   `` `sha256:${sharedContactHashOf(contact)}` `` — the `"sha256:"` prefix stays at the call site because
   the shared function returns bare hex. This is behaviour-preserving (that copy normalised identically
   already) and `I12`/`I13` neither demand nor forbid it; it removes the second independently written
   hash that would drift next.
4. **No test, fixture, helper, mock or pin is edited.** The two pin files are carried byte-identically
   from `ce6e32a4` — `git diff origin/OP-137-task-contact-digest-pins --` on both is empty.

## Evidence

Inherited RED (reviewer-reproduced at `ce6e32a4`, and reproduced here before the edit): unit
`11 passed (11)`; integration `3 failed | 2 passed (5)` with `I9`
`expected 'efbc4102…' to be '5fe71650…'`, `I10` the row keyed `"sha256:efbc41…"` and `I11` the marketing
dispatch `status: 'sent'`, `skipReason: null`; `I12`/`I13` green on arrival and still green after.

Measured with the delegate in place, at this head:

- `vitest run --project unit apps/web/src/server/notifications/receipt-projection.test.ts` →
  `11 passed (11)`.
- `TMPDIR=/root/tmp-mongo vitest run --project integration
apps/web/src/test/integration/notification-contact-digest.test.ts` → `5 passed (5)`.
- Neighbours that share the path: `notification-unsubscribe.test.ts`, the new digest spec and
  `webhook-novu-receipts.test.ts` → `3 files / 35 passed (35)`.
- **Completeness proof (F1):** `grep -n "createHash" apps/web/src/server/notifications/fan-out.ts`
  returns **nothing**, and `grep -n "contactHashOf"` shows every ledger write (`:913` `deferred`, `:1017`
  `queued`, `:1651` the direct builder) resolving to the single private function whose body is the
  shared import. The route's copy resolves the same way.
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` 0 errors on both touched files (only the
  eight pre-existing `security/detect-object-injection` warnings on `fan-out.ts`); `prettier --check`
  clean on both.
- Full suites at this head: `unit` `189 files / 3173 passed | 3 skipped (3176)`, exit `0`;
  `integration` `150 files / 1576 passed (1576)`, exit `0` — the inherited `3 failed | 2 passed (5)` is
  now `5 passed (5)`, and no file anywhere fails.
- The combined gate (`vitest run --project unit --project integration --coverage`, the shape CI runs):
  `339 files / 4749 passed | 3 skipped (4752)`, exit `0`, `92.26 % statements / 81.25 % branches /
96.53 % functions / 92.38 % lines` — every global threshold (80 %) held.
- Six `adr-*` guards green (the source-reference guard reds until this record exists, which is how the
  citation was caught before the commit).

## Consequences and known limits

- **Rows already written with a raw digest are not backfilled — accepted (F3).** A pre-fix ledger row
  carries `sha256(destination-as-stored)`, and a receipt for that dispatch keys its suppression from the
  ledger's own value, so a suppression written from a pre-fix row is itself non-canonical and the next
  fan-out lookup still misses it. No backfill is attempted, for two reasons. The ledger stores only the
  **digest** — the plaintext contact is not on the row, so re-hashing it into the canonical form is
  impossible from the ledger alone, and deriving it from the `user` row would be a guess: several
  stored spellings hash to any one raw digest, and the row does not record which. And the field is a
  **lookup key, not display data** — rekeying it changes no rendered value, and the exposure it leaves
  is bounded to dispatches sent before this deploy, whose suppression was already broken and cannot be
  repaired retrospectively without the provider's own echo. Everything written from this head forward is
  canonical, which is what the suppression lookup reads.
- **The remaining per-writer behavioural pins are not in this change.** `I9`–`I13` reach the `queued`
  email path; the `deferred` writer, the direct builder and the phone channel are covered here
  structurally (one function) but not behaviourally. Card `t_57c291d0` owns those pins.
- **`docs/adr/README.md` is the shared-ledger hotspot.** This row, the two cells (`0889` → `0893`) and
  the note merge as a union keeping the highest cells, beside the unmerged OP-137 pin and
  suppression-strength lanes.
- No config, environment variable, schema or collection changes, so no deploy step and no migration.

## Alternatives

- **Fix only the pinned call site (`:1013`).** Measured by the pin review to pass all five pins while
  leaving the `deferred` writer and the direct builder raw; rejected — it removes the measurement, not
  the defect (F1).
- **Keep the private hash and normalise at each call site.** That is three copies of one rule and the
  exact drift this change removes; rejected.
- **Delete the private wrapper and call the shared import at all three sites.** Equivalent behaviour;
  kept the wrapper so the three call sites keep their documented name and the production diff stays one
  body line.
- **Backfill `notificationDispatches.contactHash`.** Impossible without the plaintext the row does not
  store; accepted as a documented residual instead (above).
