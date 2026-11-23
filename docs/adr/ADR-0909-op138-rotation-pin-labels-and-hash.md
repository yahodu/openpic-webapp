# ADR-0909 — OP-138 TEST: the rotation pin is `I34`/`I35`, and a row's own `policyDocumentHash` is pinned

- **Status:** Accepted (characterization pin; green on arrival)
- **Date:** 2026-11-23
- **Card:** OP-138 TEST (Low) `t_baa6f0a5` — findings **F1** and **F2** of the
  post-merge review of PR [#802](https://github.com/yahodu/openpic-webapp/pull/802)
  (squash `fa621c4c` / [ADR-0908](ADR-0908-op138-consent-policy-url-rotation-pin.md)).
- **Branch:** `OP-138-task-rotation-pin-labels-hash`; **worktree:**
  `/root/openpic/openpic-webapp/.worktrees/t_48e4b3a2`; **base:** `origin/main`
  `fa621c4c`, read with `git fetch origin` immediately before the branch was cut.
  `origin/main` advanced to `1a1800e3` while this card ran and was merged into
  the branch before the delivery head was measured (see §7).
- **Pins:** schema §15.4 (`docs/Notification and Database Design.md:1256`; the
  pair `policyVersion` + `policyDocumentHash` at `:1262`; the "demonstrable
  years later" sentence at `:1268`) and contract §8.2 (`docs/API Contract.md:2925`;
  the `policyDocumentHash` sentence at `:2929`). The read half is
  `apps/web/src/app/api/v1/me/consents/route.ts`; the write half is
  `acknowledge/route.ts`; the single **current** policy list is
  `apps/web/src/server/compliance/policies.ts`.
- **Consumes:** [ADR-0908](ADR-0908-op138-consent-policy-url-rotation-pin.md) §2
  (the two cases this card extends) and its §4 "Labels" bullet (superseded here);
  [ADR-0905](ADR-0905-op138-dsr-attendee-receipt.md) (the records that already
  hold `I30`/`I31`).
- **Consumers:** `apps/web/src/test/integration/data-subject-requests.test.ts`
  (`I34`'s and `I35`'s comments cite §2). **No GREEN child**: the behaviour ships,
  so this card delivers tests, this record and ledger bookkeeping only.

## 1. Context

ADR-0908 appended two rotation cases and left two Low defects behind, both
measured by the review at `fa621c4c`:

1. **F1 — duplicate labels.** The two new cases were titled `I30` and `I31`,
   but ADR-0905 already ships `I30` (`:1664`/`:1665`) and `I31`
   (`:1703`/`:1704`) in the same file, so the file carried two of each. A
   duplicate label makes a failure message ambiguous — `I30` named two
   different behaviours — and ADR-0908 §4's claim that the labels avoided a
   duplicate was false.
2. **F2 — the digest half is invisible.** §15.4 keeps `policyVersion` **and**
   `policyDocumentHash` as the pair that makes consent demonstrable years later
   (`:1268`), and the acknowledge route stores both. The delivered pin asserted
   the version, the URL, the method and the event id. Replacing
   `policyDocumentHash: String(row.policyDocumentHash)` in the read route with
   the **live** document's digest left the file `47 passed (47)` — the same
   read-time-join defect class ADR-0908 closed for `policyUrl`, still open for
   the digest, because `documentHash` is derived from version+url and a rotation
   therefore changes it.

## 2. Decision — relabel to `I34`/`I35`, and pin the row's own digest

Both changes live in the two ADR-0908 cases; **no new case is added**.

- **F1.** Only the two ADR-0908 `describe`/`it` titles are renamed, to `I34`
  and `I35` (the next free labels; `I33` is the file's previous highest). The
  ADR-0905 cases, every helper, fixture, seed and existing assertion are
  untouched. The `seedOwnerEvent("i30")` / `("i31")` prefixes stay as they are:
  they are identity prefixes, not case labels, and renaming them would change a
  fixture for a cosmetic reason.
- **F2.** Two assertions are added to the existing cases:
  - **`I34`** — after the rotation, `row.policyDocumentHash` must equal
    `acknowledged.documentHash`, where `acknowledged` is the `PolicyEntry` from
    `currentTermsPolicy()` the case already reads; and
  - **`I35`** — each row's digest must be its own document's: `preRotated` →
    `before.documentHash`, `postRotated` → `after.documentHash`.

  Each carries a §15.4 message naming the version+digest pair as **what makes
  the acknowledgement demonstrable years later**, so the failure text states the
  property rather than the field name.

The decision the pin encodes: a consent record is evidence of **one** document.
Both members of the §15.4 pair, and the URL, are row facts written with the
document the caller acknowledged; any of the three resolved at read time from
`currentPolicies` answers the wrong document for every row that predates a
`legal.terms.updated` rotation.

## 3. Evidence — measured, not argued

Green on arrival at the delivery head (`fa621c4c` with this branch's spec):
`Tests 47 passed (47)` — the same 47 as before, because the arm is added to
existing cases (45 before ADR-0908, 47 after). A characterization pin is
load-bearing only if a plausible regression reds it, so the F2 defect was
re-applied in a throwaway worktree detached at the base `fa621c4c` carrying this
branch's spec, and restored afterwards:

- **Read-time hash join** — in `apps/web/src/app/api/v1/me/consents/route.ts`,
  resolve the digest from
  `currentPolicies(await getPlatformSettings({ db: getDb() }))` (matched by
  `purpose`) instead of the stored field. Result:
  `Tests 2 failed | 45 passed (47)` — **`I34` and `I35` alone**, `I18` **green**,
  both at
  `§15.4: the policyVersion and policyDocumentHash pair is what makes the acknowledgement demonstrable years later, …: expected 'sha256:ad4deb43…' to be 'sha256:54caaa37…'`.
  That red set is the measured proof that the shipped pin cannot see the defect.
- **Restore:** the route was restored byte-identically, sha256
  `9e48491fa5cbd762cb20b4f5124ea640742ade65dfb6044bdee0ebbdbd592055` before
  **and** after; the probe worktree was removed and no production file is in the
  delivery diff.

## 4. Assumptions and residuals

- **ADR-0908 §4's "Labels" bullet is superseded.** `I30`/`I31` were already held
  by ADR-0905 in this file; the rotation cases are `I34`/`I35`. This record is
  the correction of that bullet, not a new label policy.
- **ADR-0908's "Alternatives" rejected "pin the digest instead of the URL"** on
  the ground that the digest "would not discriminate a read-time URL join". That
  is true and stays true — a digest assertion is not a substitute for the URL
  assertion. It is not redundant either: the measured mutation above shows the
  digest assertion discriminates the **hash** join, which no URL assertion can.
  The two arms cover one defect class at two fields.
- **The hash arm closes the §15.4 gap ADR-0908 §3 did not measure.** Its
  mutation set contained only the URL join and the URL store deletion; the digest
  was asserted nowhere, which is why the F2 mutation was invisible.
- **Only `terms_of_service` is rotated** — same reasoning as ADR-0908 §4: the
  read and write paths are one code path, so a biometric arm duplicates the pin.
- **`I18` still does not pin the digest's value.** It asserts the key set and
  the URL; this card deliberately extends the rotation cases rather than
  widening `I18`, which stays a single row-shape verdict.

## 5. Number allocation — `0909`

The OP-138 lane holds `0898`–`0917` and its `Next free` cell
(`docs/adr/README.md:77`) read **`0909`**. The immediate pre-push re-sweep read:

- `git fetch origin`; `origin/main` `1a1800e3`; trunk `docs/adr` records
  `0900`–`0903`, `0905`–`0908`, `0938`–`0940` (highest OP-138 record `0908`);
- every `.worktrees/*/docs/adr` tree, **tracked and untracked**: no
  `ADR-0909` file anywhere (`ADR-0941` and `ADR-0918` exist in sibling lanes,
  both outside this block);
- every open PR head read with `git ls-tree` (#780 `1253a841`, #755 `c90ae3ba`,
  #743 `40df0afd`, #272 `d5be9af4`): none carries `ADR-0909`;
- `git rev-list --objects --all -- docs/adr` matched no `ADR-0909` blob.

No surface holds `0909`, so this record consumes it and advances the cell to
**`0910`**. No cell is lowered and no range is re-cut.

## 6. Consequences

- A future refactor that joins the digest at read time reds exactly two cases,
  each naming §15.4 and the version+digest pair in its message.
- A future refactor that stops storing the digest reds the same two, at
  `expected 'undefined' to be 'sha256:…'`, plus nothing else.
- The file's case count does not move: `I34`/`I35` are the ADR-0908 cases under
  new labels, so every handoff figure elsewhere in the lane stays comparable.
- Failure messages are unambiguous again: `I30`/`I31` name one behaviour each.

## 7. Verification on the delivery head

`tsc -p apps/web/tsconfig.json --noEmit` exit 0; `eslint` 0 issues on the touched
spec; `prettier --check` clean on the spec, this record and `docs/adr/README.md`;
the seven `adr-*` guards green; the whole `unit` and `integration` projects green,
with the exact counts in the card's handoff.

## Alternatives

- **Add new `I34`/`I35` cases instead of renaming.** Rejected: the card is
  explicit that the hash arm extends the same two cases, and four rotation cases
  would make one failure explain one decision twice.
- **Assert only the digest, dropping the URL assertions.** Rejected: the two
  fields fail independently (ADR-0908 §3 measured the URL set), and a digest is
  not a URL.
- **Compare the digest with `policyDocumentHash(version, url)` recomputed in the
  spec.** Rejected: that re-implements the production derivation in the test and
  would stay green if the derivation changed on both sides; the public
  `documentHash` the route already serves is the contract-level value.
