# ADR-0903 — OP-138 TEST: `verifiedEmail` is compared verbatim, case included

- **Status:** Accepted (characterization pin; green on arrival) · **Date:** 2026-11-20
- **Card:** OP-138 TEST (Low) `t_4b37e5de` — finding **F3** of the round-1
  (artifact lens) review of the OP-138 GREEN `t_0eab7a02`
  ([ADR-0902](ADR-0902-op138-dsr-consent-contract-green.md), PR
  [#781](https://github.com/yahodu/openpic-webapp/pull/781), squash `50a5e56f`).
- **Branch:** `OP-138-task-dsr-verified-email-case-pin`; **worktree:**
  `/root/openpic/openpic-webapp/.worktrees/t_4b37e5de`; **base:** `origin/main`
  `67c3a1bd` (the `1.71.0` release chore above the GREEN squash).
- **Pins:** contract §8.1 (`docs/API Contract.md:2840`; the `verifiedEmail`
  request example at `:2851`), schema §20.3 (`docs/Notification and Database
Design.md:2039`, the `subject` shape at `:2043`) and
  [ADR-0902](ADR-0902-op138-dsr-consent-contract-green.md) **§5** (the rule) and
  **§9** (the assumption this record makes measurable).
- **Consumes:** [ADR-0901](ADR-0901-op138-dsr-contract-pins.md) §7 (the
  `I19`–`I22` `verifiedEmail` group this case joins),
  [ADR-0899](ADR-0899-op138-data-subject-requests-green.md) §3 (the route's
  principal and subject shape) and
  [ADR-0902](ADR-0902-op138-dsr-consent-contract-green.md) §5/§9.
- **Consumers:** `apps/web/src/test/integration/data-subject-requests.test.ts`
  (`I27`'s comment cites §2). No production module cites this record: the module
  it measures is `apps/web/src/app/api/v1/me/data-requests/route.ts`, whose record
  is ADR-0902. **No GREEN child is created** — this card delivers no behaviour
  change (see §2).
- **Number allocation:** the OP-138 lane holds `0898`–`0917` and its `Next free`
  cell (`docs/adr/README.md:77`) read `0903`. The re-sweep — `git fetch origin`;
  `origin/main` `67c3a1bd` (highest `ADR-0902`); every `.worktrees/*/docs/adr`
  tree (`0900`–`0902` in the lane's own worktrees, plus `ADR-0918` in
  `t_7da4009d`, the OP-139 lane's first cut and **outside** this block); every
  open PR head read with `git ls-tree` (`OP-138-task-adr0901-evidence-count`
  stops at `0902`, `OP-139-task-analytics-rollup-red` carries `0900` and
  `0918`, the other three heads carry no `09xx`); and
  `git rev-list --objects --all -- docs/adr` (`0900`, `0901`, `0902`, `0918`) —
  resolves **no `ADR-0903`** anywhere. This record consumes `0903` and advances
  the cell to **`0904`**. No cell is lowered and no range is re-cut.

## 1. Context

`POST /api/v1/me/data-requests` accepts an optional `verifiedEmail`
(`route.ts:71`, schema `z.string().min(1).max(320)`) and, when it is present,
reads the caller's own verified Better Auth address through `verifiedEmailOf`
(`route.ts:102` — the `user` document's `email`, only when `emailVerified ===
true`) and refuses a mismatch with `422 invalid_verified_email` and
`details { field: "verifiedEmail" }` (`route.ts:221`–`227`), writing no
`dataSubjectRequests` row and no `privacy.dsr.received` event.

The comparison is `claimedEmail !== callerEmail` — **verbatim, case included**.
[ADR-0902](ADR-0902-op138-dsr-consent-contract-green.md) §9 records that as an
assumption ("the address is an identity a client repeats from its own profile,
not a contact to canonicalize"), but nothing measured it: a GREEN that compared
normalised forms, or that lowercased one side, changed behaviour with every
shipped case green. `I19` proves the exact address is accepted, `I20` proves a
_different_ address is refused and `I22` proves an attendee's claim is refused;
none of the three varies the case. That gap is finding **F3**.

The contract does not decide it either: §8.1 documents `verifiedEmail` only in
its request example (`:2851`) and never states a comparison rule, so this is a
lane decision to record, not a contract sentence to honour.

## 2. Decision — the verbatim rule stands; `I27` characterises it

**Characterization, not a decision to normalise.** `I27` asserts the shipped
answer for a case-variant claim — `422 invalid_verified_email`,
`details { field: "verifiedEmail" }`, no row, no event — and therefore creates
**no GREEN child**. Three reasons, in order of weight:

1. **The field is an echo of the profile, not a typed identity.** A client that
   sends `verifiedEmail` copies it from the account it is signed in as; a caller
   that omits it files with `202` (`I21`). A case variant is therefore not a
   refused statutory request — the right is exercised by the very next filing
   without the field — it is a refused _confirmation affordance_. Nothing in
   §8.1 makes the affordance load-bearing.
2. **Normalising would split the comparison from the record.** The route stores
   the claim **as sent** into `subject.verifiedEmail` (the `subject` spread,
   `route.ts:242`–`247`). If the comparison accepted `ALICE@EXAMPLE.COM`, the
   stored subject of an accepted filing would carry a form the account does not
   hold, and the row would need a second rule ("store the account's form, not
   the caller's") that no contract sentence asks for. Verbatim keeps one rule
   for both the check and the record: an accepted claim _is_ the account's
   address, character for character.
3. **`verifiedEmail` is not a contact to match, unlike the two places this repo
   does canonicalise.** `callerEmail`
   (`@/server/collaboration/invitation-access`) and
   `@/server/collaboration/invitations` lowercase because they match an
   invitation's addressee against an account; a DSR confirmation matches the
   caller against _themselves_, with the session already authenticating them.

The residual is accepted, not hidden: the pin makes a refusal of
`Alice@Example.com` a _specified_ answer, so a future card that wants
case-insensitive matching must red `I27` deliberately and record its own
decision (the board's F2 card `t_4fdff479` already owns the adjacent question of
an anonymous attendee's verification path).

**The rejected alternative, measured.** Changing `route.ts:224` to
`callerEmail === null || claimedEmail.toLowerCase() !== callerEmail.toLowerCase()`
reds **`I27` alone** — `1 failed | 38 passed (39)`, `AssertionError: expected
202 to be 422` at `:1441` — with `I19`, `I20`, `I21` and `I22` green, so this
case is the only thing that judges the rule. The production file was restored
byte-identically (`sha256 f385594d…27cd` before and after, `git status --short`
showing only the spec).

**Why not an exact-string pin on the stored column instead.** Under verbatim
comparison a row can only exist for a claim that already equals the account's
address, so no case-preserving "stored as sent" observation is possible without
first accepting a variant (§4).

## 3. What the pin measures

One additive case in `apps/web/src/test/integration/data-subject-requests.test.ts`
(`+58/−0`; `I1`–`I26`, `I7b`, `I7c`, every helper and the harness are
byte-identical, and `I19`–`I22` are untouched):

- **The premise is measured, not assumed.** `I27` reads the `user` document and
  asserts `email` equals `user.identity.email` (the fixture's lowercase address)
  and `emailVerified: true`, then asserts the claim it will send differs from
  that address **and** that the two are equal once lowercased — so the case
  cannot drift into "a different address" as the fixture or Better Auth changes.
- **The claim** is `caseVariantOf(storedEmail)`: a leading capital in the local
  part and in the domain (`alice@example.com` → `Alice@Example.com`), the shape
  an autocapitalizing field leaves behind. The helper is new and additive; no
  shipped helper is reused or edited.
- **The answer** is the refusal quartet `I20` and `I22` already use — `422`,
  `invalid_verified_email`, `details { field: "verifiedEmail" }`, no
  `dataSubjectRequests` row, no `privacy.dsr.received` event — asserted against
  the same harness (`seedOwnerEvent`, `postDataRequest`, `errorBody`,
  `storedRequests`, `dsrEvents`).

## 4. Recorded: the value is stored **as sent**, and that is unobservable here

`subject.verifiedEmail` is the caller's claim verbatim (`route.ts:246`), not the
account's form read back from the `user` document — the route never re-writes
it. `I19` asserts the stored value equals the address its fixture sent, and its
fixture sends exactly the account's address, so it cannot distinguish "as sent"
from "as the account holds it".

Under a verbatim comparison the two readings are **behaviourally identical**:
an accepted claim equals the account's address character for character, so both
rules store the same string. The distinction becomes observable only if this
lane ever adopts normalisation, at which point an accepted `ALICE@EXAMPLE.COM`
would store either the caller's case (today's spread) or the account's — and a
card taking that decision must pin which. That is now stated here rather than
left to be discovered.

## 5. Evidence — measured on this head

- **The focused spec:** `data-subject-requests.test.ts` `39 passed (39)` at
  `67c3a1bd` + this case (the base, before the append, is `38 passed (38)`).
- **The probe:** the normalise mutation on `route.ts:224` answers
  `1 failed | 38 passed (39)` — `I27` alone, `expected 202 to be 422`; restore
  verified by `sha256sum` (`f385594de512b37afeb3c9cb44a8008ae14a84926900a7361973e1b1342927cd`)
  and `git status --short` (only the spec modified).
- **The full suites:** `unit` and `integration` runs quoted in the handoff, plus
  the seven `adr-*` guards (`adr-numbering.test.ts` included).
- **Gates:** `tsc -p apps/web` and `tsc -p packages/contracts` exit `0`; `eslint`
  0 errors on the changed files; `prettier --check` clean.
- **Honesty:** no skip, no `only`, no environment conditional, no lint
  suppression, no production file in the diff (`+58/−0`, one file plus this
  record and its ledger bookkeeping).

## 6. Consequences

A case-variant confirmation is now a specified refusal instead of an unspecified
one, so a regression that starts accepting it — or that starts accepting only one
side normalised — reds a named case with the answer in its message. The rule the
review recorded as an assumption is a measured property, and the storage
question (`as sent` vs `as the account holds it`) is recorded as unobservable
under it.

## Alternatives

- **Normalise the comparison now** (case-insensitive match, `I27` red by design
  plus a GREEN child). Rejected in §2: it either stores a non-canonical claim or
  needs a second, uncontracted rule, and it changes a compliance surface on the
  strength of a Low finding. The probe shows exactly what it would cost —
  `I27` alone reds — so a future card can take the decision with the measurement
  in hand.
- **Lowercase only the domain.** Rejected: the domain is the case-insensitive
  part per RFC 5321, the local part the provider-dependent one, so this accepts
  neither half of the concept and would still refuse the card's example.
- **Refuse with `invalid_request` or `422` without `details.field`.** Rejected:
  `invalid_verified_email` is the shipped, catalogued code
  (`packages/contracts/src/errors.ts`) and `details { field: "verifiedEmail" }`
  is the repo's singular one-field refusal shape (ADR-0902 §5).
- **Pin `subject.verifiedEmail` "as sent" with a mixed-case account address.**
  Rejected: with a verbatim comparison the request is refused, so there is no
  row to read; the reading is unobservable (§4), and asserting it would require
  the behaviour change this card declines.
