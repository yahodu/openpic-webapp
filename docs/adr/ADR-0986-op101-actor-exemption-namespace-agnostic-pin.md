# ADR-0986 — OP-101: the billing-contact actor exemption is pinned on a key **outside the `billing.plan.` namespace**, so a prefix-shaped `typeKey` gate reds

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** OP-101 TEST (Low, review finding F2 of #917) `t_ab833349` (openpic-webapp-testcase-writer) · **Branch:** `OP-101-task-actor-exemption-prefix-pin` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_ab833349`
- **Lane:** OP-101 follow-up (the billing actor exemption) · **Consumes:** `0986` — a **pool draw** ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18: the board-wide block `0300`–`0319` is exhausted and the OP-101 lane holds no reserved row), drawn **above** the three in-flight reservations `0983`/`0984`/`0985` for the reason §Numbering records; the four pool-mirror cells read `0983` and advance to `0987`
- **Spec sources:** notification design §4.3 (the payer is the recipient, with no actor exclusion), §4.5 (event-lifecycle audiences carry "minus the actor"); schema §19.1 (`notificationTypes`)
- **Consumers:** `apps/web/src/server/notifications/fan-out.test.ts` (one appended case in a new sibling describe)
- **Relates to:** [ADR-0982](ADR-0982-op101-actor-exemption-typekey-agnostic-pin.md) (the record whose §Consequences claim this one corrects), [ADR-0981](ADR-0981-op101-actor-exemption-audience-scope-pins.md) (the audience-scoped half, and the record ADR-0982 corrected), [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) (§D3, the decision under pin), [ADR-0980](ADR-0980-op101-downgrade-scheduled-event-green.md) (§D4 shipped it), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the pool-draw rule), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)

## Context

[ADR-0982](ADR-0982-op101-actor-exemption-typekey-agnostic-pin.md) §Consequences claims: "Any
`typeKey`-keyed exemption — one key or an enumerated list — reds the new case, which `F1D` alone cannot
do". The round-1 review of PR [#917](https://github.com/yahodu/openpic-webapp/pull/917) (merged, squash
`c28cc394`) measured the **third** shape of the same wrong "fix" — a **prefix** gate — in a detached
probe worktree, and it escapes every pin the lane had:

| variant of `fan-out.ts:425`                                                      | focused `fan-out.test.ts` at `c28cc394`  |
| -------------------------------------------------------------------------------- | ---------------------------------------- |
| shipped `!payers.has(actorUserId)`                                               | `30 passed (30)`                         |
| single-key `typeKey === "billing.plan.downgrade_scheduled" && payers.has(...)`   | `1 failed \| 29 passed (30)`             |
| two-key `new Set(["billing.plan.downgrade_scheduled", "billing.plan.upgraded"])` | `1 failed \| 29 passed (30)`             |
| **`!(typeRow.typeKey.startsWith("billing.plan.") && payers.has(actorUserId))`**  | **`30 passed (30)` — not discriminated** |

A prefix gate is still `typeKey`-scoped, and it is a natural way to write the same re-scoping: "spare the
actor only for the plan-change types". It is invisible to **both** pins that came before it, and for one
reason: ADR-0982's case runs on `billing.plan.probed`, which is _inside_ the prefix, and both integration
`EVENT_KEY`s are `billing.plan.*` as well, so the 17-case integration pair reads `17 passed (17)` under
the gate (measured by that review, not re-measured here). The gate therefore keeps all 47 cases of the
lane green while dropping the exemption for every type whose key sits outside the prefix.

The exemption itself is a pure function of the ids the `billing_contact` audience resolved — a `payers`
set filled in that arm — so the gap is one case, not one behaviour.

## Decision

**One appended case in the colocated unit spec, in a new sibling `describe`, and no production file
changes.**

**D1 — the case belongs to `apps/web/src/server/notifications/fan-out.test.ts`, not to an integration
spec.** The rule reads only the type row and the resolved ids, and the unit spec drives that port with
an injected repository, so the case runs in milliseconds with no Mongo, no clock and no consumer. Both
integration specs stay untouched, as the card requires.

**D2 — the discriminator is the key's _namespace_, not its identity.** The case builds the row with
`makeNotificationType({ typeKey: "account.payment_probed", audiences: ["billing_contact"] })` — a key
outside `billing.plan.`, so no prefix of that namespace can carry it. The repository's
`getBillingContactUserId` answers `u_payer` and the input's `actorUserId` is also `u_payer` (payer ==
actor), so `payers` holds the actor and the shipped rule must keep them. The assertion is
`expect(recipients).toEqual(["u_payer"])`.

**D3 — the docblock names which pin covers each other half, and neither is duplicated.** The
**enumerated-list** half (one key, or a `Set` of keys) is ADR-0982's case, `spares the actor the
billing_contact audience resolved, whatever the type key is`, in the describe directly above; the
non-`billing_contact` actor half stays at `resolveRecipients — actor exclusion (U2)`. `U2` is also what
keeps this case from passing vacuously on an implementation that never excludes the actor: measured, a
splice that never fires leaves the new case **green** and reds `U2`'s two cases (`2 failed | 29 passed
(31)`).

**D4 — one stale sentence in the neighbouring docblock is corrected; no case byte moves.** The ADR-0982
describe's docblock read "so any re-scoping of the exemption onto `typeKey` — one key or an enumerated
list — reds here and nowhere else", which the escape above falsifies. It now says the enumerated-list
shape reds there and that the prefix shape carries its own pin in the sibling describe below. Two
comment lines changed; the existing case, its `it` title, the assertion, the helpers, the imports and
`U2` are byte-identical.

**D5 — the prefix gate is measured, and `fan-out.ts` is restored byte-identically.** The variant in
§Context is applied to the shipped file in this worktree, the focused unit spec is run under it, and the
file is restored with `git checkout -- apps/web/src/server/notifications/fan-out.ts`; `sha256sum` then
reads `c6a0cd457c05d25efb1bd70fc1624901333c7158827f6b0e9484d52cc9421481`, the pre-probe value.

## Consequences

- The exemption is now pinned on **three** shapes, and the set — not any single case — is what closes the
  class: `F1D` keeps the end-to-end half on a real `BILLING`-audience type, ADR-0982's case keeps the
  enumerated-list half, and this case keeps the namespace-agnostic half. A `typeKey` gate that admits any
  key outside `billing.plan.` reds here; a gate that enumerates keys reds ADR-0982's case.
- **Cost:** one case in an existing spec; no new file, no Mongo, no clock, no dependency.
- **The pin is a characterization of a shipped decision**, not of incidental behaviour: if a product
  decision ever scopes the exemption per type, these cases are renegotiated with it in one card, never
  deleted to make the refactor green.
- **ADR-0982's §Consequences claim is corrected here, not rewritten there.** The merged record is frozen;
  this record is the correction, and the claim now reads: the class is closed by the **three** pins, and
  ADR-0982's own case covers the enumerated-list subset only.
- **Recorded residual, out of scope here:** a gate written on _another_ namespace (for example
  `account.`) would red this case, but a gate on a _fourth_ namespace would still escape — no finite set
  of keys can exclude every prefix. What is pinned is that the exemption does not depend on the key's
  namespace at all; a future record that pins a second out-of-namespace key is a strengthening, not a
  defect in this one.
- **Interest, not re-measured here:** the same review measured that a `category === "billing"`
  re-scoping also reds ADR-0982's case alone at `c28cc394` (`1 failed | 29 passed (30)`), so the class is
  broader than the two `typeKey` shapes this record and ADR-0982 name.

## Numbering

The board-wide / process block `0300`–`0319` is exhausted and the OP-101 lane holds no reserved row
([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18), so this record draws from the
pool cursor. **The card's body expected `0983`:**

> The four pool-mirror cells read `0983` on `c28cc394` and advance to **`0984`**.

The cells do read `0983`, but `0983` is **not** free: three sibling cards hold reservations above it, and
under [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §7 an in-flight allocation counts as
taken. The reservation is what the allocator assigned each card, so it outranks the cells. The four-surface
sweep at this cut (`origin/main` `6ae204af`) plus the board read:

```
$ git rev-parse --short origin/main                                     6ae204af
$ git ls-tree -r --name-only origin/main docs/adr | grep -oE 'ADR-[0-9]{4}' | sort -u | tail -1
                                                                        ADR-0982
$ git rev-list --objects --all | path field | grep -oE 'ADR-09[0-9]{2}' | sort -u | tail -1
                                                                        ADR-0982
  # no ADR-0983 / ADR-0984 object or path on any ref
$ ls .worktrees/*/docs/adr | grep -oE 'ADR-09[0-9]{2}' | sort -u | tail -1
                                                                        ADR-0982
$ gh pr list --state open                                              #920 (head 0742a94f → ADR-0982),
                                                                        #896 (3aa0b048 → ADR-0973)
$ python3 <read-only probe over the 10 non-terminal cards>
                                                                        t_9eafff78 reserves 0983
                                                                        t_e05af75c reserves 0984
                                                                        t_b4d8d70e reserves 0985
                                                                        no card holds 0986
```

So this record draws **`0986`**, the first number free on every surface _and_ above the three
reservations, and advances the four pool-mirror cells — `board-wide / process`, `OP-129 attendee identity
lane`, `OP-136 jobs lane`, `unallocated (future lanes)`, all reading `0983` — to **`0987`** (forward only;
no cell is lowered and no range is re-cut). The three reserved numbers are left to their own cards; when
they land, the ledger's union merge keeps the highest value in every cell. Its row is written here, after
row `0982`, because rows `0983`–`0985` do not exist yet.

**Postscript, after the sweep.** `0983` landed while this PR was in flight — PR
[#922](https://github.com/yahodu/openpic-webapp/pull/922), squash `a92b468a`, whose
[ADR-0983](ADR-0983-op101-downgrade-concurrent-repeat-pin.md) row sits above this one in the ledger and
advances the same four cells to `0984`. The branch merged that `origin/main` in, the ledger union keeps
the **higher** `0987` in every cell, and both rows stand, ascending (`0983`, then `0986`). `0984` and
`0985` are still reserved in flight and still untouched here.

## Alternatives

- **Extend ADR-0982's case instead of appending one.** Rejected: the existing case's key
  (`billing.plan.probed`) is the value that makes the enumerated-list half red. Repointing it at
  `account.payment_probed` would drop that half, and the card requires the existing case's bytes
  unchanged.
- **Change the production splice to a helper the test can call.** Rejected: the exemption is a
  documented product decision, not an internal seam; the observable behaviour is the recipient list.
- **Pin a second out-of-namespace key** (`account.payment_probed` _and_, say, `attendee.selfie.probed`).
  Rejected as duplication: one key outside the namespace already discriminates the shape, and a second
  would red under exactly the same mutations.

## Evidence

All counts are measured at `f8965c99` — the spec commit `130fa894` with `origin/main` `6ae204af` merged
in — in this worktree, with a clean tree.

**Green on the shipped tree**, focused:

```
$ ./node_modules/.bin/vitest run --project unit apps/web/src/server/notifications/fan-out.test.ts
Test Files  1 passed (1)
     Tests  31 passed (31)
```

The same file read `30 passed (30)` on the trunk before this case, so the case is the one added.

**Red under the prefix gate** — the variant in §Context, applied to the shipped file:

```
× resolveRecipients — billing-contact actor exemption outside the billing namespace (OP-101) > spares
  the actor on a type key that no billing prefix carries
    AssertionError: expected [] to deeply equal [ 'u_payer' ]
Test Files  1 failed (1)
     Tests  1 failed | 30 passed (31)
```

The red is the new case **alone** — every other case in the file, ADR-0982's included, stays green, which
is the escape this record closes recorded in one measurement.

**Anti-vacuity** — a splice that never fires (`actorUserId === null && …`) leaves the new case green and
reds `U2`:

```
     Tests  2 failed | 29 passed (31)
```

The probe was reverted with `git checkout -- apps/web/src/server/notifications/fan-out.ts` and the file
is byte-identical to its pre-probe state:

```
$ sha256sum apps/web/src/server/notifications/fan-out.ts     (before == after)
c6a0cd457c05d25efb1bd70fc1624901333c7158827f6b0e9484d52cc9421481  …/server/notifications/fan-out.ts
```

**Static gates on the delivery head.** Whole `unit` at `f8965c99` plus this record and its ledger row in
the tree (docs cannot move a test count): `201 files / 3423 passed | 3 skipped (3426)`, exit `0` — the
trunk cut's `3422 passed | 3 skipped (3425)` plus this one case. `tsc -p` answered `0` on all three
projects (`tsconfig.json`, `packages/contracts`, `apps/web`); `prettier --check` is clean on the spec, on
this record and on the ledger; the ten `adr-*` guard files answered `10 files / 340 passed (340)` with
this record and its row in the tree.
