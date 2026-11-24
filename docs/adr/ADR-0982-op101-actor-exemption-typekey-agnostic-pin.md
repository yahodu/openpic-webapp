# ADR-0982 — OP-101: the billing-contact actor exemption is pinned **type-key-agnostically**, on a synthetic `typeKey`

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** OP-101 TEST (Low, review finding F1 of #911) `t_8217bd99` (openpic-webapp-testcase-writer) · **Branch:** `OP-101-task-actor-scope-typekey-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_8217bd99`
- **Lane:** OP-101 follow-up (the billing actor exemption) · **Consumes:** `0982` — a **pool draw** ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18: the board-wide block `0300`–`0319` is exhausted and the OP-101 lane holds no reserved row), verified by the sweep below; the four pool-mirror cells read `0982` and advance to `0983`
- **Spec sources:** notification design §4.3 (the payer is the recipient, with no actor exclusion), §4.5 (event-lifecycle audiences carry "minus the actor"); schema §19.1 (`notificationTypes`)
- **Consumers:** `apps/web/src/server/notifications/fan-out.test.ts` (one appended case)
- **Relates to:** [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) (§D3, the decision under pin), [ADR-0980](ADR-0980-op101-downgrade-scheduled-event-green.md) (§D4 shipped it), [ADR-0981](ADR-0981-op101-actor-exemption-audience-scope-pins.md) (the record whose §Consequences claim this one corrects), [ADR-0979](ADR-0979-op101-downgrade-scheduled-event-pins.md) (the sibling pack), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the pool-draw rule), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)

## Context

[ADR-0981](ADR-0981-op101-actor-exemption-audience-scope-pins.md) §Consequences claims that "the
near-miss class is closed: any future re-scoping of the exemption away from the audience — the exact
`typeKey`-shaped refactor the review card demonstrated — now reds `F1D`". The round-1 review of
PR [#911](https://github.com/yahodu/openpic-webapp/pull/911) (merged, squash `f0422e2e`) measured that
the claim holds for the **single-key** shape only. On that tree, the two integration specs
(`billing-plan-upgraded-delivery.test.ts` and `billing-downgrade-scheduled-event.test.ts`, 17 cases
together) answered:

| variant of `fan-out.ts:425`                                                           | result                                                         |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| shipped (audience-scoped)                                                             | `17 passed (17)`                                               |
| single-key `typeKey` scope (`typeRow.typeKey === "billing.plan.downgrade_scheduled"`) | `1 failed \| 16 passed (17)`, `F1D` alone                      |
| **`typeKey` list scope** (a `Set` of the two billing keys)                            | `17 passed (17)` — **not distinguished from the shipped rule** |

A two-key (or longer) enumerated list is still `typeKey`-scoped, and a list is exactly how a future
"fix" would be written. It silently drops the exemption for the next type that carries the
`billing_contact` audience. `F1D` cannot see it: it runs on one of the two keys such a list carries.

The shipped rule is a pure function of the ids the `billing_contact` audience resolved
(`apps/web/src/server/notifications/fan-out.ts`: a `payers` set filled in that arm, tested by the
actor splice), so the gap is one test, not one behaviour.

## Decision

**One appended case in the colocated unit spec, and no production file changes.**

**D1 — the case belongs to `apps/web/src/server/notifications/fan-out.test.ts`, not to an integration
spec.** The rule reads only the type row and the resolved ids, and the unit spec already drives that
port with an injected repository, so the case runs in milliseconds with no Mongo, no clock and no
consumer. Both integration specs are out of scope by the card and by
[ADR-0981](ADR-0981-op101-actor-exemption-audience-scope-pins.md) §D6; neither file is in the diff.

**D2 — a synthetic `typeKey` carries the discriminator.** The case builds the row with
`makeNotificationType({ typeKey: "billing.plan.probed", audiences: ["billing_contact"] })` — a key that
exists in no catalogue and in no plausible spared list, so a `typeKey`-keyed rule cannot happen to
carry it. The file's `typeWith()` helper does not accept a key override and is left untouched; the
factory is called directly. The repository's `getBillingContactUserId` answers `u_payer` and the input's
`actorUserId` is also `u_payer` (payer == actor), so `payers` holds the actor and the shipped rule must
keep them; the assertion is `expect(recipients).toEqual(["u_payer"])`.

**D3 — the case's docblock names which pin covers the other half.** The non-`billing_contact` actor is
still excluded, and that half is already pinned by the same file's `resolveRecipients — actor exclusion
(U2)` describe (its organizer/co-organizer/attendee case). It is **not** duplicated here, and it is what
keeps this case from passing vacuously on an implementation that simply never excludes the actor.

**D4 — the two rejected rules are measured, and `fan-out.ts` is restored byte-identically.** Both the
single-key and the list variants of `fan-out.ts:425` are applied to the shipped file in this worktree,
the focused unit spec is run under each, and the file is restored with
`git checkout -- apps/web/src/server/notifications/fan-out.ts`; `sha256sum` then reads
`c6a0cd457c05d25efb1bd70fc1624901333c7158827f6b0e9484d52cc9421481`, the pre-probe value.

## Consequences

- The exemption is now pinned on **both** shapes, and the pair is what closes the class: `F1D` keeps the
  end-to-end half on a real `BILLING`-audience type, and this case is the type-key-agnostic half. Any
  `typeKey`-keyed exemption — one key or an enumerated list — reds the new case, which `F1D` alone
  cannot do.
- **Cost:** one case in an existing spec; no new file, no Mongo, no clock, no dependency.
- **The pin is a characterization of a shipped decision**, not of incidental behaviour: if a product
  decision ever scopes the exemption per type, this case is renegotiated with it in one card, never
  deleted to make the refactor green.
- **ADR-0981's §Consequences claim is corrected here, not rewritten there.** The merged record is frozen;
  this record is the correction, and the claim now reads: the class is closed by the **pair** of pins.

## Numbering

The board-wide / process block `0300`–`0319` is exhausted and the OP-101 lane holds no reserved row
([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18), so this record draws from the
pool cursor. The card did not carry a number; the four-surface sweep at this cut
(`origin/main` `42efacf2`) finds `0982` held by nothing:

```
$ git rev-parse --short origin/main                                   42efacf2
$ git ls-tree -r --name-only origin/main docs/adr | grep -oE 'ADR-[0-9]{4}' | sort -u | tail -1
                                                                      ADR-0981
$ git rev-list --objects --all -- docs/adr | grep -oE 'ADR-09[0-9]{2}' | sort -u | tail -1
                                                                      ADR-0981
$ ls .worktrees/*/docs/adr | grep -oE 'ADR-09[0-9]{2}' | sort -u | tail -1
                                                                      ADR-0981
  # 0982 resolves in no worktree tree — no sibling lane holds it
$ gh pr list --state open --json number,title
                                                                      #916 (README ledger row 0980 only)
                                                                      #914 (ADR-0302) ; #896 (no ADR)
$ python3 <read-only probe over the 9 non-done cards>
                                                                      t_28478ccb mentions 0982 only as the
                                                                      figure it corrects in row 0980;
                                                                      no card holds 0982 in `Consumes`
```

The four cells that read `0982` — `board-wide / process`, `OP-129 attendee identity lane`, `OP-136
jobs lane`, `unallocated (future lanes)` — advance to **`0983`** (forward only; no cell is lowered and
no range is re-cut).

## Evidence

**Green on the shipped tree** (`origin/main` `42efacf2`), focused:

```
$ ./node_modules/.bin/vitest run --project unit apps/web/src/server/notifications/fan-out.test.ts
Test Files  1 passed (1)
     Tests  30 passed (30)
```

The same file at the parent commit read `29 passed (29)`, so the new case is the one added.

**Red under the reviewed single-key rule** — the `typeKey`-scoped variant of `fan-out.ts:425` quoted in
§Context, applied to the shipped file:

```
× resolveRecipients — billing-contact actor exemption (OP-101, ADR-0978 §D3) > spares the actor the
  billing_contact audience resolved, whatever the type key is
    AssertionError: expected [] to deeply equal [ 'u_payer' ]
Test Files  1 failed (1)
     Tests  1 failed | 29 passed (30)
```

**Red under the `typeKey` list rule** — the two-key `Set` variant that the integration specs cannot see:

```
× resolveRecipients — billing-contact actor exemption (OP-101, ADR-0978 §D3) > spares the actor the
  billing_contact audience resolved, whatever the type key is
    AssertionError: expected [] to deeply equal [ 'u_payer' ]
Test Files  1 failed (1)
     Tests  1 failed | 29 passed (30)
```

In both mutations the red is the new case alone — no sibling case moves — and the two integration specs
keep their measured behaviour: `17 passed (17)` under the list rule (not distinguished) and
`1 failed | 16 passed (17)`, `F1D` alone, under the single-key rule.

The probe was reverted with `git checkout -- apps/web/src/server/notifications/fan-out.ts` and the file
is byte-identical to its pre-probe state:

```
$ sha256sum apps/web/src/server/notifications/fan-out.ts     (before == after)
c6a0cd457c05d25efb1bd70fc1624901333c7158827f6b0e9484d52cc9421481  …/server/notifications/fan-out.ts
$ git status --porcelain
 M apps/web/src/server/notifications/fan-out.test.ts
```

**Static gates on the delivery head.** Measured at the merge head `36fb3912` (this record's own
docs-only commit sits above it and cannot move a test count; `apps/web/src/server/notifications/fan-out.ts`
is byte-identical to the trunk's). `tsc -p` answered `0` on all three projects (`tsconfig.json`,
`packages/contracts`, `apps/web`); `prettier --check` on the spec, this record and the ledger is clean;
the ten `adr-*` guard files answered `10 files / 337 passed (337)`; and the whole `unit` project
answered `201 files / 3419 passed | 3 skipped (3422)`, exit `0` — the `origin/main` `2468dbae` cut's
`3418 passed | 3 skipped (3421)` plus this one case.
