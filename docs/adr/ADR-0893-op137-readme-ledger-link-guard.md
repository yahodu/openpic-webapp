# ADR-0893 — OP-137 TEST: a ledger link resolves, or names a record the repository renamed

- **Status:** Proposed (RED pins — the guard module does not exist yet, so the
  spec fails at import; a GREEN is owed and this PR is a **draft** that must not
  be squash-merged, per OP-93 /
  [ADR-0306](ADR-0306-op101-stale-branch-deletion.md))
- **Date:** 2026-11-20
- **Card:** OP-137 TEST `t_0fb7e9b0` (Low; child of the review card
  `t_a587c8bd` of PR [#754](https://github.com/yahodu/openpic-webapp/pull/754),
  squash `63dbe750`). Branch `OP-137-task-readme-ledger-link-guard`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_op137-readme-link-guard`, cut from
  `origin/main` `1c2d519f`.
- **Implements:** nothing. No production file, no existing spec, no fixture and
  no helper is edited: the diff is one new spec, this record and the ledger row,
  the two `Next free` cells and the ledger's prose note.
- **Consumes:** [ADR-0302](ADR-0302-adr-number-guard-contract.md) (the six-row
  invariant table whose row (vi) this extends one file over, and the fixture
  marker / leaf rules the record sweep uses),
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §10 item 14 and
  §11 items 18–21 (a pool draw advances both cells).
- **Consumers:** `apps/web/src/test/unit/adr-ledger-links.test.ts` (the spec's
  docblock and this record cite each other).

## Context

**The defect, measured.** On the head that found it (`2a688e25`, the review of
PR #754) the ADR ledger pointed at a `-pins` variant of 0884's record name
(`docs/adr/README.md:1857`) while the record is the `-pins`-less file, and **all
six `adr-*` guards were green at `236 passed (236)`** on that head. Nothing in
the family could see it: `checkRepositoryAdrLinks` sweeps `docs/adr/ADR-*.md`
and its own spec pins that `docs/adr/README.md` is **not** swept. Invariant (vi)
exists because three landed records "404'd permanently, in frozen records, with
no mechanism able to notice" — this is the same failure, one file over.

**Why the exclusion exists, and why it is not enough.** The ledger's notes keep
pre-rename record names **on purpose**: they describe the collision they record,
and flagging history would force every future note to lie. That rationale is
sound for a name that existed and was renamed. It does not cover a name that
**never existed at all**, which is the class measured here. The split is
mechanical: a target missing **now** but **added at some point** stays allowed; a
target missing now and never added is an issue.

**The census at this branch cut (`origin/main` `1c2d519f`).** The ledger carries
**875** ADR-shaped link targets (28 external `https://` links are not targets),
and exactly **three** dangle, all three the pre-rename class:

| Ledger line | Target                                             | Ever added? |
| ----------- | -------------------------------------------------- | ----------- |
| 966         | `…0769-op129-anonymous-attendee-sessions-red.md`   | yes         |
| 968         | `…0770-op129-anonymous-attendee-sessions-green.md` | yes         |
| 1262        | `…0820-op132-confirm-transaction-failure-pin.md`   | yes         |

The delivery's own typo — the fourth dangling line at `2a688e25` — is repaired
and merged with PR #754, so the **never-existed class on the trunk is empty**.
That is exactly what the pins encode: the real-tree case asserts the never-existed
class is empty _and_ the pre-rename class is still tolerated, so it is green on
the trunk and only bites a future typo.

## Decision

1. **One new spec,**
   `apps/web/src/test/unit/adr-ledger-links.test.ts`, beside
   `adr-record-links.test.ts` and following its shape: a pure entry point driven
   by fixtures, a repository entry point driven by a real tree, the
   `AdrRecordLinkFileText` / `AdrRecordLinkIssue` / `AdrRecordLinkResult` types
   the record sweep already owns, and `makeTempRepoRoot` for the trees.
2. **The contract the GREEN must expose** — module
   `apps/web/src/test/helpers/adr-ledger-links.ts`:

   ```ts
   checkAdrLedgerLinks(
     ledger: AdrRecordLinkFileText,            // { path: "docs/adr/README.md", text }
     adrFileNames: readonly string[],          // names present in docs/adr NOW
     everAddedAdrFileNames: readonly string[], // names added at any commit reachable
                                               // from the repository's refs
   ): AdrRecordLinkResult

   checkRepositoryAdrLedgerLinks(root: string): AdrRecordLinkResult
   ```

   Per target, in order: the leaf resolves against `adrFileNames` -> no issue; it
   does not resolve but is in `everAddedAdrFileNames` -> renamed away, no issue;
   neither -> one `dangling-reference` issue carrying the ledger's own path, the
   1-based line and the target as written. `checkedLinks` counts the targets
   evaluated in all three classes and `scannedRecords` is `1` (the ledger is one
   document), so `ok: true` can never be a vacuous pass. The link shapes, the
   `#fragment` handling, the same-directory leaf predicate and the prose rules
   (fenced block, inline code span) are exactly the record sweep's. A root with
   no `docs/adr/README.md` **throws** `ENOENT`.

3. **The card's four directions, each pinned in both directions** — 12 cases in
   four blocks:

   | Card direction                                         | Pins                         |
   | ------------------------------------------------------ | ---------------------------- |
   | a never-added target is reported (the `-pins` shape)   | pure, and repo seam          |
   | a renamed-away target is not reported (history-driven) | pure, and a real commit pair |
   | an existing target is not reported (positive control)  | pure                         |
   | a dangling link inside a record is still an issue      | repo seam, both files        |
   | the real-tree census                                   | pure membership + repo seam  |

   The renamed fixture is a **synthetic** name (`ADR-0300-alpha.md`) added by one
   commit and `git mv`-ed by a second, so a check that answers from a hardcoded
   list of the three ledger names cannot pass it.

4. **The census is asserted as membership, never as a constant** — the three
   pre-rename target strings on one side, the empty report on the other, and the
   875 measured links on a floor of `850`.
5. **The record sweep is not touched.** Two cases re-pin at the new file's seam
   that `checkRepositoryAdrLinks` reports nothing and counts nothing from the
   ledger, and that it still reports a dangling link inside a record. A fix that
   widens the record sweep reddens two files, not one.

## Evidence

Measured in the delivery worktree at the branch cut, `origin/main` `1c2d519f`.

| Surface                                      | Result                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| the delivered spec, as delivered             | `Cannot find module '../helpers/adr-ledger-links.js'`, `no tests` — the honest RED |
| the spec under a faithful near-fix (deleted) | `12 passed (12)`                                                                   |
| near-fix minus the history tolerance         | `5 failed \| 7 passed (12)` — the five tolerance cases only                        |
| near-fix returning a vacuous report          | `9 failed \| 3 passed (12)`                                                        |
| `tsc -p apps/web/tsconfig.json --noEmit`     | exit `0` (with the near-fix in place)                                              |
| `eslint` on the spec                         | `0` errors, `0` warnings                                                           |
| `prettier --check` on the spec               | clean                                                                              |
| the six `adr-*` guards                       | green                                                                              |

The near-fix was a throwaway file written to prove the pins are **satisfiable and
type-correct**, then deleted: `git status --short` shows the new spec and this
record only. Its two mutations are the discrimination evidence — removing the
history term reddens exactly the tolerance class (`docs/adr/README.md` reporting
`ADR-0300-alpha.md`, the three pre-rename targets and the real tree), and
returning an empty report reddens the sweep cases as well.

## Consequences and known limits

- **The pins are RED by design.** The module does not exist, so the spec fails at
  import and no assertion runs. The near-fix above is the proof that the
  assertions themselves are reachable and green against a correct shape; the
  GREEN's PR is where they run for real.
- **Two measured corrections to the card's mechanism**, both recorded because a
  GREEN that follows the card's wording literally cannot satisfy the pins:
  - `git rev-list --objects --all -- docs/adr` lists each **object** once, under
    one path, so a pure `git mv` (identical bytes) hides the old name entirely —
    the rename case reds under that command. `git log --all --diff-filter=A
--name-only -- docs/adr` sees added paths, renamed-away ones included, and
    greens the same case.
  - The history set is **clone-dependent**. The three pre-rename names are not
    reachable from `origin/main` at all (they were added on lane branches and
    squash-merged away), so they survive only on `origin`'s still-existing branch
    refs. This checkout's `--all` sees 545 ADR names and all three; the `ci` job
    checks out at the default `fetch-depth: 1`, where `--all` sees one commit and
    the set is empty. A git-only oracle therefore reports the three pre-rename
    names **in CI** while reporting the ledger clean locally — a guard that reds
    the trunk it is supposed to accept. The real-tree case pins the observable
    the card asks for, not the command, so the implementation must consult a
    source that survives a shallow checkout (a committed record of the ledger's
    pre-rename names, unioned with the git set, satisfies every pin: the
    synthetic rename case still rejects a pure hardcoded list).
- **The tolerated class is pinned as membership, not as a count of three.** A
  future ledger note that adds a fourth pre-rename name stays green (history
  tolerates it) while a fourth **never-added** name reds on its own string.
- **Accepted residual:** the ledger's own four dangling lines are not repaired
  here. PR #754 repaired its own; the three historical ones are history and must
  stay. A `#fragment` inside a ledger target is not exercised because the ledger
  carries none at this head, and the git command's failure modes are the
  implementation's choice — only a missing `docs/adr/README.md` is pinned.

## Alternatives

- **A hardcoded allowlist of the three ledger names as the mechanism** —
  rejected: it forbids itself from ever learning a fourth rename, and the
  synthetic `git mv` case is written to red it. A committed list is acceptable
  only as a _durable_ complement to the git set, which is what the CI correction
  above asks for.
- **A line-shape heuristic** ("tolerate a dangling target whose line also links a
  resolvable record") — **measured and refuted**: at `2a688e25` the typo'd line
  `1857` also carried a resolvable link to 0887, so the heuristic would have
  tolerated exactly the defect this pack exists for; and line 1262 carries two
  resolvable links beside the missing 0820, so it would also tolerate a real
  pre-rename name for the wrong reason.
- **Widen `checkRepositoryAdrLinks` to sweep the ledger** — rejected: it reddens
  the frozen spec `adr-record-links.test.ts` (case "sweeps docs/adr/ADR-*.md
  records and never docs/adr/README.md"), and the ledger's counts would be mixed
  into a report whose census is already pinned as a pair of floors.
- **Report the pre-rename class in a non-failing channel** (the consumers
  guard's `unlisted` shape) — rejected: the never-existed class must fail, and
  two channels for one rule doubles the surface a GREEN has to satisfy without
  adding a fact.
- **Skip the real-tree repository case** — rejected: without it a check that
  reads history only in fixtures could ship, and a guard that reds the trunk in
  CI is the failure mode the CI correction describes.

## Number allocation

`0893`, a **pool draw**. The block `0849`–`0868` is exhausted (§11 items 18–21),
so a draw advances **both** the `OP-136 jobs lane` cell and the
`unallocated (future lanes)` cursor from `0892` to `0894` — one above this
record, so neither can re-mint it, and no cell is lowered.

The sweep immediately before minting, on `origin/main` `1c2d519f`: the trunk's
highest record is `ADR-0891`, both `Next free` cells read `0892`, and every
surface was read — `git rev-list --objects --all -- docs/adr`, every
`.worktrees/*/docs/adr` tree and the six open PR heads #760/#755/#752/#743/#272.
The only number above `0891` on any surface is `ADR-0892`, an **uncommitted**
file in the working tree of `.worktrees/t_1039146a` (the running OP-137
contact-digest GREEN), which is why this record draws above it rather than at the
cell. No `ADR-0893` file, object or PR-head path exists anywhere.

## Review — round 1

Sign-off card `t_0b952b7c` records the round-1 review of the pin card `t_0fb7e9b0` (PR [#761](https://github.com/yahodu/openpic-webapp/pull/761)). Verdict: **APPROVED**, artifact lens, posted as PR comment [`issuecomment-7039471719`](https://github.com/yahodu/openpic-webapp/pull/761#issuecomment-7039471719). No Critical, High or Medium finding; three Info notes, all recorded below. The pins were RED by design and the GREEN `t_67bca731` carried them, landing as the squash `3f5d0225`; the spec blob is `4c09b4e8` at the reviewed head `c38677c9`, at `3f5d0225` and on `origin/main` `208a3db0`, so the 12 cases this section describes are the bytes the trunk runs.

- **The delivered RED, measured on the delivered head `c38677c9`** (base `origin/main` `1c2d519f`): the spec fails at import with `Cannot find module '../helpers/adr-ledger-links.js'` and **no test is collected** — the RED the card asked for, and not a weakened one. `tsc -p apps/web/tsconfig.json --noEmit` reads **exactly three** errors, all downstream of the missing module (one TS2307 and two TS7031 at lines 360/364). The **six** `adr-*` guards stand at `236 passed (236)` with the new spec the only failing file. `eslint` reports 0 errors and 0 warnings, `prettier --check` is clean on the spec, this record and the ledger, and the diff carries no `@ts-ignore` and no `eslint-disable`.
- **Satisfiability and discrimination, measured in a throwaway worktree at that head.** A faithful near-fix — the git history term the card names, deleted afterwards — greens `12 passed (12)` and takes `tsc` to exit 0. Three mutations of it red exactly the cases they should: history term removed `5 failed | 7 passed (12)`, the tolerance cases only; a vacuous report at **both** entry points `9 failed | 3 passed (12)`; the tolerance replaced by a literal three-name list `1 failed | 11 passed (12)`, the synthetic `git mv` case alone. That last figure is what makes the anti-hardcode half load-bearing rather than decorative.
- **The census reproduced, not transcribed.** Re-measured with the approved record-link rule set at `1c2d519f`: **875** ADR-shaped targets, **28** external `https://` links that are not targets, and exactly **three** dangling, at lines **966**, **968** and **1262** (`0769`, `0770`, `0820` — the added-then-renamed class), with the never-existed class **empty**. At the delivery head `c38677c9` the ledger reads **877** and the three sit at lines **967**, **969** and **1263**: the delta is this delivery's own index row and its two links. On this section's base `208a3db0` the same three targets sit at lines 969, 971 and 1265 and the target count is 883 — rows other lanes landed above them — and the class split is unchanged.
- **The two mechanism corrections hold, verified independently of the pin pack.** `git rev-list --objects` lists a pure `git mv` only under the new name, so the card's stated command cannot carry the tolerance, while `git log --all --diff-filter=A --name-only` does. And a real `--depth 1` clone sees one commit and no pre-rename name, so a git-only oracle reds the trunk in CI: the committed complement is required, not an optimisation.
- **The refuted integrity rule.** "No complement entry may share a number with a live record" is the only disk-only rule that looked defensible, and it is **wrong**: `0770` is a legitimate complement entry and `ADR-0770-op128-account-status-gate-green.md` is a live record. The complement therefore stays a documented trust list, which is what the GREEN's own record states.
- **Info — the spec docblock overstates the oracle once.** Its lines 57–63 say `checkRepositoryAdrLedgerLinks` takes "the history set from `root`'s own git objects", while its lines 96–102 require a source that survives a shallow checkout. The later paragraph is the operative one and the GREEN implements it; the earlier sentence is imprecise rather than wrong for a full clone. Nothing was changed, because the pin spec is contract.
- **The pin spec was carried unchanged.** The review asked the GREEN to carry the 12 cases byte-identical and it did: spec blob `4c09b4e8` at `c38677c9`, at `3f5d0225` and at `208a3db0` — one OID three times, so the cases reviewed are the cases that run.
- **This section consumes no ADR number.** `docs/adr/README.md` stays byte-identical to `origin/main` `208a3db0` (`git diff --name-only origin/main...HEAD` lists this record only), so no row, note or cell moves and both `Next free` cells stay `0896` on that base; the trunk this section lands on (`f27eb8db`) reads `0897` in both cells because three other records landed in the merge window, and no cell was lowered. The follow-ups are cited by card id — the pins `t_0fb7e9b0`, the GREEN `t_67bca731` — and by PR #761, never by a number that could move.
- **No retraction.** Nothing in §Context, §Decision, §Evidence, §Consequences and known limits, §Alternatives or §Number allocation is retracted, reworded or re-badged. The three Info notes are properties of the delivery and the record, not defects: the docblock imprecision above, the `>= 850` floor that tolerates a 25-link drop by design, and the trust-list property of the committed complement.
