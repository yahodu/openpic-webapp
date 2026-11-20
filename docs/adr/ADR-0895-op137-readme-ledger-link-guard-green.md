# ADR-0895 — OP-137 GREEN: the ledger's links resolve against the tree and against the history

- **Status:** Accepted
- **Date:** 2026-11-20
- **Card:** OP-137 GREEN `t_67bca731` (Low; the GREEN the round-1 review of the pin
  pack routed). Pins: `t_0fb7e9b0` /
  [ADR-0893](ADR-0893-op137-readme-ledger-link-guard.md), child of the review
  `t_a587c8bd` of PR [#754](https://github.com/yahodu/openpic-webapp/pull/754)
  (squash `63dbe750`). Branch `OP-137-task-readme-link-guard`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_op137-readme-link-guard`, PR
  [#761](https://github.com/yahodu/openpic-webapp/pull/761).
- **Implements:** invariant (vi)'s **ledger half** — one new test helper,
  `apps/web/src/test/helpers/adr-ledger-links.ts`, exporting
  `checkAdrLedgerLinks` and `checkRepositoryAdrLedgerLinks`. No production file,
  no spec, no fixture and no existing guard is edited: the diff is the helper,
  this record, the ledger row, the two `Next free` cells and the ledger's prose
  note.
- **Consumes:** [ADR-0302](ADR-0302-adr-number-guard-contract.md) (row (vi) of
  the invariant table, and the link shapes, leaf predicate, prose rules and
  fixture marker the record sweep owns),
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §10 item 14 and
  §11 items 18–21 (a pool draw advances both cells).
- **Consumers:** apps/web/src/test/helpers/adr-ledger-links.ts

## Context

**The pin pack is unchanged and now runs.** ADR-0893 delivered 12 cases against a
module that did not exist, so its RED was `Cannot find module
'../helpers/adr-ledger-links.js'` with no assertion reached. The round-1 review
reproduced every census figure and both mechanism corrections, measured a
faithful near-fix at `12 passed (12)`, and approved the pins as satisfiable and
discriminating. This record is the module that makes them run for real.

**The rule.** Per markdown link target inside `docs/adr/README.md`, in this
order: the leaf resolves against the names in `docs/adr` **now** → no issue; it
does not resolve but was added under `docs/adr` at some commit reachable from
the repository's refs → renamed away, no issue; neither → one
`dangling-reference` issue carrying the ledger's own path, the 1-based line and
the target as written. `checkedLinks` counts the targets evaluated in all three
classes and `scannedRecords` is `1`, so `ok: true` can never be a vacuous pass.

**Why the record sweep is not widened.** `checkRepositoryAdrLinks` sweeps
`docs/adr/ADR-*.md` and never the ledger, because the ledger's notes keep
pre-rename record names on purpose. Widening it would red the frozen
`adr-record-links.test.ts` and would mix the ledger's 875 links into a report
whose census is pinned as floors. The ledger half lives in its own module, and
the pin pack re-pins both directions of the old behaviour at the new seam.

**The oracle is a union, and that is the load-bearing decision.** The three
pre-rename names the ledger keeps (`0769`, `0770` and `0820`) are not reachable
from `origin/main` at all — they were added on lane branches and squash-merged
away — and the `ci` job checks out at `fetch-depth: 1`, where `git log --all` sees
one commit and no pre-rename name. A git-only oracle therefore reports those
three targets **in CI** while reporting the ledger clean locally: a guard that
reds the trunk it is meant to accept. So the history set is
union(committed record of the pre-rename names, git set).

The git half is `git log --all --diff-filter=A --name-only -- docs/adr`, not
`git rev-list --objects`: the latter lists each **object** once under one path,
so a pure `git mv` (identical bytes) hides the old name and the pin pack's
synthetic rename case reds under it. The committed half cannot replace the git
half either — a literal three-name list fails that same synthetic case
(`1 failed | 11 passed (12)` when the review probed it), because the fixture's
name is not in any list.

## Decision

1. **One new helper, two entry points**, exactly the contract the pin pack
   states: `checkAdrLedgerLinks(ledger, adrFileNames, everAddedAdrFileNames)` at
   the pure seam and `checkRepositoryAdrLedgerLinks(root)` at the repository
   seam. The report is `AdrRecordLinkResult` — the shape the record sweep already
   owns — so a reader compares the two reports without a translation.
2. **The link reader is mirrored, not imported.** `adr-record-links.ts` keeps its
   three parsers private and the card freezes that file, so the ledger helper
   carries the same link shapes, `#fragment` handling, same-directory leaf
   predicate and fenced-block / inline-code prose rules. Two copies are a
   divergence risk; the pin pack settles it, because both sweeps' specs pin the
   same shapes and a change to one without the other reds a case in the other
   file.
3. **The history set is the union** described above, with the committed complement
   held as `LEDGER_PRE_RENAME_FILE_NAMES` in the helper — a `.ts` constant, so
   each line can carry the `adr-fixture` marker the reference sweep requires for
   a number that is not live on every surface.
4. **Ordering** is the record sweep's: `file`, then `line`, then `target`, so the
   same ledger in any order produces one report.
5. **A missing `docs/adr/README.md` throws.** The directory is read first and the
   ledger second, so a wrong root fails loudly at the `ENOENT` instead of
   reporting a vacuous pass — and `checkRepositoryAdrLedgerLinks` never reads a
   directory that is not there and calls it clean.

## Evidence

Measured in the delivery worktree, branch head after the `origin/main` merge
(`061c5ae0`):

| Surface                                                    | Result                |
| ---------------------------------------------------------- | --------------------- |
| `vitest run --project unit … /adr-ledger-links.test.ts`    | `12 passed (12)`      |
| `vitest run --project unit … /adr-*.test.ts` (seven files) | `248 passed (248)`    |
| `tsc -p apps/web/tsconfig.json --noEmit`                   | exit `0`              |
| `eslint` on the helper                                     | `0` errors, `0` warns |
| `prettier --check` on the helper                           | clean                 |
| full `unit` project                                        | green                 |

The pin pack's own discrimination evidence stands unchanged from ADR-0893; the
three mutations are not re-run here, because the spec is byte-identical to the
reviewed head.

## Consequences and known limits

- **The committed complement is a trust list.** CI cannot check it against
  history: at `fetch-depth: 1` there is no history to check it against, which is
  exactly why the list exists. A name added to it is believed, and a reviewer is
  the only gate on that.
- **No disk-only integrity rule exists, and none is added.** The obvious one — "no
  complement entry may share a number with a live record" — would reject `0770`,
  because `ADR-0770-op128-account-status-gate-green.md` is a live record and the
  ledger's `0770` is the OP-129 GREEN draft that was renamed. The rule would have
  to encode the very history it cannot see.
- **A git failure degrades to the complement, never to a throw.** History is the
  tolerance source; the ledger read is the loud gate. In a shallow clone the git
  set is small, and the complement is what keeps the three historical targets
  quiet.
- **A `#fragment` inside a ledger target is unimplemented only in the sense that
  the ledger carries none at this head** — the code strips it and keeps it in the
  report, and the pin pack covers the shape through the record sweep's specs.
- **Reference-style links and bare autolinks stay unread**, exactly as in the
  record sweep. That is a shared limit, not a new one.
- **The helper is test infrastructure.** It is never imported by shipped code, so
  it adds nothing to the production bundle and no untested branch to the app.

## Alternatives

- **Widen `checkRepositoryAdrLinks` to sweep the ledger** — rejected: it reds the
  frozen `adr-record-links.test.ts` and mixes two censuses in one report.
- **Git-only oracle** — rejected as measured above: it reds the trunk in CI,
  because the pre-rename names live only on branch refs a depth-1 clone never
  fetches.
- **Literal three-name allowlist as the mechanism** — rejected: it cannot learn a
  future rename, and the pin pack's synthetic `git mv` case is written to red it.
  It is acceptable only as the shallow-clone _complement_, which is what ships.
- **`git rev-list --objects --all -- docs/adr`** — rejected as measured: one
  object per path, so a pure `git mv` hides the old name.
- **Export the record sweep's parsers and import them here** — rejected for this
  cut: it edits a file the card freezes, and the pin pack already pins the shared
  shapes in both specs. If a third sweep ever needs them, the parsers move to a
  shared module and both files change in one commit.

## Number allocation

`0895`, a **pool draw**. The block `0849`–`0868` is exhausted (§11 items 18–21),
so a draw advances **both** the `OP-136 jobs lane` cell and the
`unallocated (future lanes)` cursor from `0894` to `0896` — one above this
record, so neither can re-mint it, and no cell is lowered.

The sweep immediately before minting, on the delivery head after merging
`origin/main` `061c5ae0`: the trunk's highest record is `ADR-0891` (the merge
touched the OP-136 header-less correlation record `0890` and one ledger note
only), both `Next free` cells read `0894`, and every surface was read —
`git rev-list --objects --all -- docs/adr`, every `.worktrees/*/docs/adr` tree,
and the seven open PR heads #763/#762/#761/#755/#752/#743/#272, the two newest
fetched explicitly. The highest in-flight number on any surface is `ADR-0894`
(`.worktrees/t_*` of the OP-137 suppression reverse-direction pin lane, PR #762),
so this record draws one above it. No `ADR-0895` file, object or PR-head path
exists anywhere on any surface.
