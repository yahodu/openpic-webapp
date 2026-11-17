# ADR-0858 — OP-136 TEST: the purge's anonymize pin is method-agnostic

- **Status:** Accepted · **Date:** 2026-11-17
- **Card:** OP-136 TEST `t_7d835e6f` (Low; finding **F1** of the review of the
  TEST card `t_b845ed28`, PR #639, squash `a9519252`; branch
  `OP-136-task-anonymize-injection-shape`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_8901d758`, cut from `origin/main`
  `a9519252`).
- **Implements:** contract §10.2 (the `account-deletion-purge` row), §1.4 (the
  deletion lifecycle), §12 (the retained contact), §2.3, §4.5.
- **Consumes:** [ADR-0857](ADR-0857-op136-purge-post-claim-step-pins.md) (the
  three post-claim pins this narrows the brittleness of),
  [ADR-0856](ADR-0856-op136-sweep-failure-windows-resume.md) (the
  `withTransaction` the pins constrain).
- **Consumers:** `apps/web/src/test/integration/job-sweep-failure-windows.test.ts`
  (the widened injection) and the module it constrains,
  `apps/web/src/server/jobs/account-deletion-purge.ts`.
- **Number allocation:** the `OP-136 jobs lane` row's `Next free` cell read
  `0858` at this head (`a9519252`). The sweep immediately before minting found
  no `ADR-0858*` file on the trunk, in any `.worktrees/*/docs/adr`, in
  `git rev-list --objects --all -- docs/adr`, or on any of the seventeen open PR
  heads (`0857` is the highest record anywhere). This record takes `0858` and
  advances **only** that cell to `0859`; both `unallocated (future lanes)` cells
  stay `0869`. No number outside `0849`–`0868` is consumed.

## Context

ADR-0857 §2.3 armed the anonymize pin with
`Collection.prototype.updateOne` gated on `this.collectionName === "user"`. The
behaviour that pin protects is "the Better Auth row keeps no contact of its own",
but the injection was armed on one driver **method**.

The review of `t_b845ed28` measured the consequence: a behaviour-preserving
refactor of the production erase

```ts
.updateOne({ _id: profile.userId }, { $unset: { email: "", name: "" } }, { session })
// ->
.updateMany({ _id: profile.userId }, { $unset: { email: "", name: "" } }, { session })
```

is identical for a filter that names one `_id`, and it reddened that pin alone:

```
× the account is anonymized by the next run after a failed anonymize write
AssertionError: the injection must fire exactly once: expected +0 to be 1
 Tests  1 failed | 6 passed (7)
```

A pin that reddens on a refactor which preserves the observable behaviour is
coupled to the implementation, not to the contract. The card that commissioned
the pin prescribed `updateOne`, so the implementer complied: the defect is in the
pin's gate, and it is fixed here.

## Decision

### 1. One widened injection, three driver methods

`failNextDocumentUpdate(collectionName)` replaces the anonymize case's
`failNextUpdateOne("user")` call. It spies on **all three** single-document write
shapes the erase can honestly take — `updateOne`, `updateMany`,
`findOneAndUpdate` — each still gated on `this.collectionName === collectionName`
and each delegating to the driver original captured by
`Object.getOwnPropertyDescriptor` at module load (reading the property at call
time would find the spy and recurse).

`failNextUpdateOne` itself is untouched: the other two pins that use it
(`accountDeletionTombstones`, `userProfiles`) inject into a step whose method is
not in question, and the card forbids editing an existing helper.

### 2. The gate stays the collection name

Gating on the `$unset` document shape would prescribe the erase mechanism —
ADR-0857 §Alternatives rejects exactly that, and a future `$set: { email: null }`
is the same observable anonymize. Gating on `updateOne` alone was the brittleness
the review found. The collection name is the narrowest honest gate: it is the
only fact the pin may assume about how the erase is written.

### 3. One call armed across the three methods

The three spies share one `remaining` counter, so the injection fires **once**
however the erase is written. `expect(injection.fired(), …).toBe(1)` therefore
keeps its meaning — it proves the injected failure was reached exactly once, and
it stays the first assertion of the case.

### 4. Nothing else moves

The other six cases, the fixtures, `seedUser`/`seedProfile`/`seedSession`/
`deletionState`/`purgeRun`, every existing assertion and ADR-0857's record are
unchanged. The spec diff is `98` insertions and `1` deletion (the call site plus
its comment); no production file is touched.

## Evidence

Measured in a throwaway probe worktree of this branch
(`cache/scratch/probe-op136-anon`, `git worktree add --detach HEAD`), whose
`apps/web/src/server/jobs/account-deletion-purge.ts` was replaced and then
restored with `git checkout --` to the same sha256
`2dd50c645b720547724a24700b2ff82add596e085b95e6aa44b068854311139c` each time;
`git status --short` was empty afterwards.

1. **Positive control** — the widened spec on the unmodified trunk production
   file: `Tests  7 passed (7)`.
2. **Negative control (the finding)** — `updateOne` → `updateMany`:
   - widened spec: `Tests  7 passed (7)` (the pin is now
     behaviour-preserving, as it must be);
   - **pre-change spec** (the `origin/main` blob) under the same mutation:
     `Tests  1 failed | 6 passed (7)` with
     `the injection must fire exactly once: expected +0 to be 1`. The widening is
     therefore what closes F1, not a change in the production code.
3. **The pin is still load-bearing** (the widening does not make it vacuous):
   - the erase **swallowed** inside the transaction → `Tests  1 failed | 6 passed (7)`,
     with
     `run 1 reports the account whose anonymize write failed: expected +0 to be 1`;
   - the erase **moved outside the transaction** (runs after the commit) →
     `Tests  1 failed | 6 passed (7)`, with
     `the account keeps no contact of its own: expected 'user-6afc4e196de7543d86b14f30@example…' to be null`;
   - both redden **only** the anonymize pin, as ADR-0857 measured for the
     `updateOne` arm.
4. **The third arm is live** — `updateOne` → `findOneAndUpdate` (the same
   behaviour for a single `_id`): `Tests  7 passed (7)`. So the injection really
   does fire for all three shapes rather than only for `updateMany`.

Gates: `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` on the spec
exit `0`; `prettier --check` clean; the six `adr-*` guards green.

## Consequences

- A GREEN may carry the erase with `updateOne`, `updateMany` or
  `findOneAndUpdate` (or move to an equivalent erase document) without editing a
  pin, provided the observable post-run state ADR-0857 §2.3 pins is preserved.
- ADR-0857 §2.3 still names `Collection.prototype.updateOne`; records are
  point-in-time and are not rewritten. This record supersedes that sentence for
  the anonymize injection only.
- Known limit, recorded and unpinned: a `bulkWrite` or an aggregation-pipeline
  `$merge` erase is **not** covered by the widened gate, because those carry no
  per-document method to arm. If a GREEN adopts one, this pin goes vacuous for
  that arm and a new pin is owed.

## Alternatives

- **Keep `updateOne` and accept the brittleness** — rejected: the review measured
  a behaviour-preserving refactor that reddens the pin, which is a false alarm on
  a legitimate change.
- **Gate on the `$unset` document** — rejected: mechanism-prescribing
  (ADR-0857 §Alternatives) and it would also fail the `$set: { email: null }`
  erase that is observably identical.
- **Widen `failNextUpdateOne` in place** — rejected: the card forbids editing an
  existing helper, and the two other call sites inject into steps whose driver
  method is not in question; widening them would hide a genuine change there.
- **A separate spec file for the anonymize pin** — rejected: it duplicates the
  file's injection harness and seven-collection reset for one case.

## Out of scope

- The purge's cancel-vs-purge exclusivity and the three unpinned sweeps
  (ADR-0856/ADR-0857's own out-of-scope lists).
- Generalising the three near-identical injection closures (`insertOne`,
  `deleteMany`, the widened one) into one factory — F3 of the same review, which
  the card explicitly leaves alone because it would edit an existing helper.
- `deletionState` reading a missing user row as anonymized (F4 of the same
  review): the anonymize pin's `fired() === 1` guard reddens first.
