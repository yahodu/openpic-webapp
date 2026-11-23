# ADR-0908 — OP-138 TEST: a consent row's `policyUrl` is a stored fact, not a read-time join

- **Status:** Accepted (characterization pin; green on arrival)
- **Date:** 2026-11-23
- **Card:** OP-138 TEST (Low) `t_48e4b3a2` — the gap the round-1 (artifact lens)
  review of the pin pack found in `I18` of
  [ADR-0901](ADR-0901-op138-dsr-contract-pins.md).
- **Branch:** `OP-138-task-consent-policy-url-pins`; **worktree:**
  `/root/openpic/openpic-webapp/.worktrees/t_48e4b3a2`; **base:** `origin/main`
  `8e08f190` (`docs(adr): OP-136 append the round-1 review to ADR-0938 (#799)`),
  read with `git fetch origin` immediately before the branch was cut.
- **Pins:** schema §15.4 (`docs/Notification and Database Design.md:1256`, the
  `consents` document and its "demonstrable consent" sentence at `:1266`) and
  contract §8.2 (`docs/API Contract.md:2925`; the "verifiable years later"
  sentence at `:2929`). The write half is
  `apps/web/src/app/api/v1/me/consents/acknowledge/route.ts`, the read half is
  `apps/web/src/app/api/v1/me/consents/route.ts`, and the single **current**
  policy list is `apps/web/src/server/compliance/policies.ts`.
- **Consumes:** [ADR-0901](ADR-0901-op138-dsr-contract-pins.md) §7 (`I18`, the
  case this pin completes), [ADR-0902](ADR-0902-op138-dsr-consent-contract-green.md)
  §4 (the write-time store this record measures) and
  [ADR-0903](ADR-0903-op138-verified-email-case-pin.md) /
  [ADR-0905](ADR-0905-op138-dsr-attendee-receipt.md) (the labels `I27`, `I28`
  and `I29` these records already hold on the trunk).
- **Consumers:** `apps/web/src/test/integration/data-subject-requests.test.ts`
  (`I30`'s and `I31`'s comments cite §2). **No GREEN child**: the behaviour the
  pin measures ships, so this card delivers tests, this record and ledger
  bookkeeping only.

## 1. Context

`I18` pins §8.2's row shape for **one** acknowledgement: the caller
acknowledges the live document and the history row must answer that document's
`policyUrl`, `eventId` and `method`. That case is satisfied by an implementation
that derives the URL at **read** time, because the row was written under the
version the platform still serves.

`currentPolicies(settings)` is deliberately the single **current** list: terms
and biometric are read from `platformSettings.legal` and re-read after
`invalidatePlatformSettings()`. A read-time join therefore answers the wrong
document for every row acknowledged before a `legal.terms.updated` rotation — and
it answers silently, because a URL that exists but names the wrong document
still parses as a URL. §15.4 states the property the record exists for
("GDPR/DPDPA require _demonstrable_ consent: who, what for, which policy version,
when, and how"), and §8.2 states the same for the read: the row is "verifiable
years later".

The GREEN `t_0eab7a02` ([ADR-0902](ADR-0902-op138-dsr-consent-contract-green.md))
stores `policyUrl` and `method` at write time. Its card instructed that; nothing
measured it.

## 2. Decision — `policyUrl` and `method` are row facts, and a rotation is pinned

Two characterization cases are appended to
`apps/web/src/test/integration/data-subject-requests.test.ts` (`+173/−0`; the
shipped 35 `it` cases and the `I8` `it.each` rows, every helper and the harness
are byte-identical):

- **`I30`** — a fixture guard asserts the seeded `platformSettings.legal` terms
  triple differs from the distinctive `ROTATED_TERMS` (`tos-2099-11`,
  `https://openpic.in/legal/terms/2099-11`, `2099-11-01T00:00:00.000Z`), so the
  case cannot pass on a hard-coded answer. The caller acknowledges the live
  version, the singleton is rotated with the idiom `I7c` already uses
  (`deleteMany({})` + `insertOne(makePlatformSettingsDocument({...}))` +
  `invalidatePlatformSettings()`), a control asserts the public document now
  serves the rotated triple and that its version changed, and then
  `GET /me/consents?purpose=terms_of_service` must still answer the
  **pre-rotation** `policyVersion` and the URL of **that** version, with
  `method: "in_app_action"` and `eventId: null`.
- **`I31`** — the second arm: acknowledge before the rotation, rotate,
  acknowledge again against the rotated version, and require two rows, each
  carrying its own `policyVersion` + `policyUrl` pair and a distinct `id`. The
  rows are selected **by version**, never by array index, because the list's
  `grantedAt` ordering is not what the case decides.

The decision the pin encodes: the `policyUrl` in a consent record is a **stored
fact of the row**, written with the document it acknowledges, exactly like
`policyDocumentHash`. `method` is stored for the same reason — it describes how
_that_ acknowledgement was given, and §15.4's evidence block is immutable. A
read-time join to `currentPolicies` is therefore a defect, not an optimization,
and `I18` alone cannot catch it.

## 3. Evidence — measured, both directions

Green on arrival on `origin/main` `8e08f190` with this branch's spec:
`Tests 47 passed (47)` (45 before the append: 35 `it` cases, the ten `I8`
`it.each` rows; `+I30` `+I31`). A characterization pin is load-bearing only if a
plausible regression reds it, so two single-site mutations were measured in
place, each restored byte-identically afterwards (`git status --short` showing
only the spec):

1. **Read-time join** (the defect this card exists for): in
   `apps/web/src/app/api/v1/me/consents/route.ts`, resolve `policyUrl` from
   `currentPolicies(await getPlatformSettings({ db: getDb() }))` instead of the
   stored field. Result: `Tests 2 failed | 45 passed (47)` — **`I30` and `I31`
   alone**, at
   `§8.2: a consent row answers the policyUrl of the document it acknowledged, not the rotated document's URL: expected 'https://openpic.in/legal/terms/2099-11' to be 'https://openpic.in/legal/terms/2026-03'`
   (`I30`) and
   `§8.2: the pre-rotation row answers its own document's URL, not the rotated document's`
   (`I31`). `I18` stays **green** under this mutation — the measured proof that
   the shipped pin cannot see the defect and these two cases are its only
   witnesses.
2. **No write-time store**: delete the `policyUrl: document.url` line from
   `apps/web/src/app/api/v1/me/consents/acknowledge/route.ts`. Result:
   `Tests 3 failed | 44 passed (47)` — `I18`, `I30`, `I31`, all at
   `expected null to be 'https://openpic.in/legal/terms/2026-03'`. The pin
   therefore also catches the "drop the column" shape, and the different red
   sets separate the two defect classes.

Recorded restore hashes: the read route
`9e48491fa5cbd762cb20b4f5124ea640742ade65dfb6044bdee0ebbdbd592055` and the
acknowledge route
`82566ae66e2f9ffffd8d178cef6406c18728090627aa22d31b942b02b0959ace`, identical
before and after each mutation; no production file is in the delivery diff.

## 4. Assumptions and residuals

- **The rotation is exercised through the singleton, not through a settings
  route.** The case re-seeds `platformSettings` and drops the process read
  cache, which is the same transition a `legal.terms.updated` rotation performs.
  A rotation that also rewrites every `consents` row would be a different defect
  and is not pinned here.
- **Only `terms_of_service` is rotated.** The biometric document shares
  `effectiveFrom` and has its own version pair, but the write and read paths are
  the same code, so a biometric arm would duplicate the pin rather than widen it.
- **A row written before the field existed is out of scope.** The read route
  answers `null` for a missing `policyUrl` (`textOrNull`) so older rows stay
  readable; no case here pins that representation, because a `null` arm is inert
  on a collection this young.
- **`I30`/`I31` are appended, never merged into `I18`.** `I18` keeps its single
  row-shape verdict; the rotation needs its own rotation, and folding them would
  make one failure explain two decisions.
- **Labels.** The card suggested `I27`/`I28`; the trunk already carries `I27`
  (`ADR-0903`), `I28` and `I29` (`ADR-0905`), so the cases take `I30`/`I31` and a
  duplicate label is avoided.
- **Number.** The card expected `0903`; the lane cell had advanced to `0908` by
  the time this branch was cut (see §5). `0904` is an unused gap on the trunk:
  a crashed attempt of this card once minted `ADR-0904` locally, never committed
  or pushed, so no trunk record and no live ref holds it. The record takes the
  cell's `0908` rather than the gap.

## 5. Number allocation — `0908`

The OP-138 lane holds `0898`–`0917` and its `Next free` cell
(`docs/adr/README.md:77`) read **`0908`**. The immediate pre-push re-sweep read:

- `git fetch origin`; `origin/main` `8e08f190`; trunk `docs/adr` records
  `0900`–`0903`, `0905`–`0907`, `0938`–`0940` (highest OP-138 record `0907`);
- every `.worktrees/*/docs/adr` tree, **tracked and untracked** (`find … -name
'ADR-09*'`): no `ADR-0908` file anywhere; six sibling worktrees already quote
  `0908` as their _cell_ (`op138-dsr-index`, `op138-dsr-receipt`,
  `t_1e732648`, `t_4b37e5de`, `t_62d6ef86`, `t_op138-dsr-list-read-reuse`) but
  none has minted the file;
- every open PR head read with `git ls-tree` (#800 `OP-138-task-dsr-lapsed-session-fixture-clock`
  carries the OP-138 block plus `0938`–`0941`, no `0908`; #780, #755, #743, #272
  carry no `0908`);
- `git rev-list --objects --all -- docs/adr` matched no `ADR-0904` and no
  `ADR-0908`.

No surface holds `0908`, so this record consumes it and advances the cell to
**`0909`**. No cell is lowered and no range is re-cut.

## 6. Consequences

- A future refactor that replaces the stored `policyUrl` with a lookup reds
  exactly two cases, each naming §8.2 in its failure message.
- A future refactor that stops writing the column reds three, `I18` included.
- No other case in the repository moves: the file's other 35 cases plus the ten
  `I8` rows are byte-identical, and the whole `unit` and `integration` projects
  were re-run to prove no collateral change (§7).

## 7. Verification on the delivery head

`tsc -p apps/web/tsconfig.json --noEmit` exit 0; `eslint` 0 errors on the touched
spec (only pre-existing warnings elsewhere); `prettier --check` clean; the seven
`adr-*` guards (`adr-consumers`, `adr-inline-code-spans`, `adr-lane-ranges`,
`adr-ledger-links`, `adr-numbering`, `adr-record-links`,
`adr-source-references`) green inside the whole `unit` project; the whole `unit`
and `integration` projects green, with the exact counts in the card's handoff.

## Alternatives

- **Amend `I18` in place.** Rejected: the file is a lane hotspot and the card is
  append-only; a rotation would change what the shipped case means.
- **Pin the digest instead of the URL.** Rejected: `policyDocumentHash` is
  already stable per version, so it would not discriminate a read-time URL join.
- **Trust the GREEN's write-time store.** Rejected: that is what this card
  measures. The two mutations show the store is the property, not an
  implementation detail.
