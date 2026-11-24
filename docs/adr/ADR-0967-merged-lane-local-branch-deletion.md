# ADR-0967 — A merged lane's tip is archived and its local branch released in the merge step

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** board process decision `t_84e8d0ed` (openpic-orchestrator) · **Branch:** `OP-101-task-local-head-hygiene-rule` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_84e8d0ed`
- **Lane:** board-wide / process (orchestrator), reserved range `0300`–`0319` (exhausted) · **Consumes:** `0967` (a pool draw, [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18)
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (§11 items 18–19 and 27 — the exhausted block, the pool cursor), [ADR-0306](ADR-0306-op101-stale-branch-deletion.md) (the stale-branch deletion gates this rule reuses), [ADR-0307](ADR-0307-unmerged-pr-blocks-card-completion.md) (an unmerged deliverable is declared and gets a merge lane), [ADR-0308](ADR-0308-one-owner-per-branch-landing.md) (one landing owner; a handoff ends the implementer's write ownership), [ADR-0318](ADR-0318-agent-enforced-merge-gate.md) (the merge gate), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (a record carries its own ledger row)
- **Schema:** n/a · **Contract:** n/a (process rule; no application code) · **Implementation:** `AGENTS.md` §2.3, `docs/CONVENTIONS.md` §9 and the reviewer profile's own merge checklist — routed as a follow-up card from `t_84e8d0ed`, since the rule binds the merger and not the tree

## Context

Measured on `origin/main` `cf67fa15`, 2026-11-24, in worktree
`.worktrees/t_84e8d0ed`; every command and its output is in §Evidence.

- The repository sets `delete_branch_on_merge: true`
  (`gh api repos/yahodu/openpic-webapp` →
  `{"delete_branch_on_merge":true,"allow_squash_merge":true,"squash_merge_commit_title":"PR_TITLE"}`).
  Every squash-merge therefore deletes the **remote** head while the merging
  worker's **local** head survives — unheld, because the worktree that held it is
  released or the head was checked out in the merger's own probe tree.
- Three hygiene phases removed 928 + 46 + 15 local-only branch refs and 71 + 14
  worktrees, and the population still regrew:
  - phase 3 (`t_c290a9c7`) finished at 11:44Z with **1** unheld local-only head;
    by 11:56Z there were **2** — `OP-102-task-if-none-match-list-and-unserved-tag`
    `5add954d` (PR #872) and `OP-132-task-confirm-outbox-failure-pins` `867665c9`
    (PR #873), the second created by the reviewer's own squash-merge;
  - at 12:05Z, after the phase-4 sweep had removed both, there was again **1** —
    `OP-102-task-adr0324-review-signoff` `92701608`, created by the squash-merge
    of PR #874 that produced `cf67fa15` minutes earlier, and released at 12:12Z by
    the archival card `t_bd0ce72e`.
    Three merges produced three unheld heads inside 25 minutes. No sweep can
    outrun the merge rate, and each such head is a live resurrection hazard: a
    `git push --all` or `git push origin <branch>` re-creates a branch whose PR is
    already merged, and `gh pr merge --delete-branch` cannot reach a **local** ref.
- The clone carries an archival namespace and it is now complete: `refs/prhead/<n>`
  covers #1 … #874 (874 loose refs; `refs/prhead/872` = `5add954d`, `/873` =
  `867665c9`, `/874` = `92701608`). A tip archived there is locally reachable, so
  `git gc --prune=now` cannot drop it; the recipe is one command per merged PR,
  needing no fetch and no working-tree change. `t_bd0ce72e` closed the phase-4
  record's gc-hazard list this way **without editing** that frozen attachment —
  the attachment still lists its tips as hazards, and the condition it recorded is
  closed by the archival, not by a rewrite.
- Two classes must not be conflated, and the censuses of the last hour did
  conflate them:
  - **unheld** — no worktree holds the ref. That is drift;
  - **unheld and absent from origin** (`git ls-remote --heads origin` empty) — that
    is the gc hazard, the class that needs an archive or a delete before anything
    downstream can drop the tip.

  Census at 12:12Z: 9 local heads, **1** unheld
  (`OP-101-task-tenant-members-residual-pins` `140c0b5f`) — but origin still serves
  that branch at the same SHA and its tip equals `refs/pull/866/head`, so **unheld
  local-only = 0** and **gc-hazard tips = 0**. A rule keyed on "unheld" alone would
  have deleted an origin-backed branch.

- The deletion mechanics were measured, not recalled (throwaway repository, same
  git): `git branch -d <b>` **refuses** while the branch is checked out in any
  worktree — `error: cannot delete branch 'lane' used by worktree at '<path>'`,
  exit 1 — because a worktree's `HEAD` is a symref to `refs/heads/<b>`.
  `git update-ref -d refs/heads/<b> <sha>` exits 0 in that same state but leaves
  the worktree on an **unborn** branch: `symbolic-ref HEAD` still reads
  `refs/heads/<b>`, `HEAD` no longer resolves, and `status` reports
  `## No commits yet on lane`.
- The merged tip is served losslessly by the pull ref: `git ls-remote origin refs/pull/<n>/head`
  still returns it verbatim after the merge — the gate ADR-0306 already applies to a
  remote deletion. It is also, by definition, **not** an ancestor of `main`: a
  squash writes a new commit, so `git merge-base --is-ancestor <head-tip> origin/main`
  is false for every merged head.

## Decision

**R1 — the merge step archives the tip and releases the local head.** The card that
runs the squash-merge does both, in the same run, after the merge succeeds and
before it completes. This is the merge step's last act, not a later sweep's first
act.

**R2 — archive the tip first, into the pull-ref namespace.**

```
git update-ref "refs/prhead/<n>" "<reviewed-head-sha>"
```

Only when the ref is absent, and with `<reviewed-head-sha>` read from
`git ls-remote origin refs/pull/<n>/head` — never from the branch, which may have
moved. The archive makes the tip reachable from a local ref, so no
`git gc --prune=now` can drop it once the branch is gone, and the branch deletion
below is exactly what would otherwise un-anchor every object of that branch.
Archive **before** the delete: a failed archive must leave the branch in place.

**R3 — release the holder, then delete the ref.** If `refs/heads/<head>` is checked
out in a worktree, that worktree's `HEAD` moves off the branch first
(`git -C <wt> switch --detach`), or the worktree is removed under **R5.5**. The ref
is then deleted with the compare-and-delete form:

```
git update-ref -d "refs/heads/<head-branch>" "<reviewed-head-sha>"
```

The old-value argument is part of the rule: it fails rather than deleting a tip
that moved after the review. `git branch -D` is not used — it refuses while the
branch is checked out (measured) and it has no compare-and-delete form.

**R4 — assert the result.** `git for-each-ref "refs/heads/<head-branch>"` must print
nothing, `git for-each-ref "refs/prhead/<n>"` must print the archived SHA, and
`git worktree prune --dry-run` must stay empty. All three assertions are quoted in
the merge record.

**R5 — the gates.** The ref is released only when **all** hold, re-derived at the
moment of deletion:

1. the PR is `MERGED`, and the landed commit is on the trunk
   (`git merge-base --is-ancestor <squash-sha> origin/main`);
2. the tip `<reviewed-head-sha>` is served verbatim — `git ls-remote origin refs/pull/<n>/head`
   equals it — or it is already an ancestor of `origin/main`. A mismatch means the
   branch moved after review, so the head is **kept** and reported, and nothing is
   archived under that PR number (an archive of the wrong tip is a lie);
3. the branch is **local-only**: `git ls-remote --heads origin refs/heads/<head-branch>`
   is empty. A branch origin still serves is not drift and is not this rule's
   business;
4. no worktree holds it any more (R3), and no **other** non-`done` board row names
   it in `branch_name` or holds it through its `workspace_path`. A worktree **on**
   the branch blocks the deletion; a detached worktree parked at the squash commit
   does not. The merging card's own row is the lander and is exempt by
   construction — it is live while it merges;
5. a lane worktree is removed only when it is the merging card's own, or when it is
   clean (`git status --porcelain` empty) and named by no live row. A **dirty** tree
   is never removed and its branch is never deleted; it is recorded as a skipped
   head, the way phase 4 records its three dirty orphans.

**R6 — the RED-by-design pin, and every unmerged PR, is out of scope.** The rule is
authorised by a **merge**, never by a card completing. A PR that is deliberately
left open — a RED-by-design pin PR, a PR held for a sibling's dependency, a PR
closed as superseded — keeps its branch **and** its worktree; none of R1–R5 runs.
Its branch goes only when it later merges (the rule applies at that merge) or when
a hygiene sweep releases it under R5 plus ADR-0306's gates. A card that completes
with an open PR declares the merge lane (ADR-0307) and owns no deletion.

**R7 — one lane, one head.** The merger acts only on the branch the merged PR names
(`gh pr view <n> --json headRefName`). It never deletes another lane's head,
another card's dirty branch, or any ref it did not just merge.

**R8 — the sweep is the backstop, not the mechanism.** The hygiene sweep keeps its
place for heads the rule cannot reach — pre-existing, foreign, dirty, or a merge
run by a human — with the same gates. It is no longer the answer to "the population
regrows": the merge step bounds the future, the sweep bounds the past.

## Consequences

- The cost lands on the merger at the only moment the facts are known: the PR
  number, its head branch, the reviewed SHA and the merge's success. One extra
  local ref per merged PR (`refs/prhead/<n>`) plus one `update-ref -d`.
- Every gate except the `git ls-remote` pair is local and cheap; the network calls
  are one or two per merge.
- Reading R5.4 as "no **other** live row names it" is load-bearing. Phase 4's
  wording ("no row with a live status names that branch") would block every
  application, because the merging card is live while it merges.
- R5.3's "local-only" condition is the other load-bearing reading: the 12:12Z
  census held an unheld head that origin still served, and deleting it would have
  been a deletion the hazard never asked for.
- A head whose tip moved after review is kept (R5.2): the borrowed safety is the
  pull ref, and a moved tip is no longer served by it.
- The archive makes the release **cheap to reverse**: the branch is gone from
  `refs/heads`, but `refs/prhead/<n>` still names its tip, so a mistaken release is
  undone with one `git branch <name> refs/prhead/<n>`.
- The rule is per-lane, so the merger does not become a clone-wide cleaner; foreign
  heads remain the sweep's business.
- The next application is visible by construction: this record's own PR archives
  `refs/prhead/876` and releases `OP-101-task-local-head-hygiene-rule` at its merge.
- The rule binds a **profile** as well as a document: the reviewer's own merge
  checklist lives outside the repository, so the follow-up card must change both
  `AGENTS.md` §2.3 and that checklist. That checklist already carries the
  `update-ref -d` command as a **pitfall** ("a squash-merged local branch cannot be
  deleted with `git branch -d`"), which is exactly why the heads kept regrowing: a
  pitfall is read when it bites, not at merge time.

## Alternatives considered

- **Never create a local branch for a lane (rejected).** `git worktree add --detach`
  plus `git push origin HEAD:refs/heads/<branch>` would remove the object instead of
  the debris. But the local branch name is the board's serialisation key:
  `branch_name` carries the one-owner-per-branch gate (ADR-0308), the dispatcher's
  worktree/branch collision audit keys on it, one ticket's RED and GREEN share one
  branch, and `validate-branch-name` runs on the pushed name. A detached lane also
  turns every worker's push into a `HEAD:<name>` push and costs the cheap
  `git rev-parse <branch>` handoff. The rule would trade one `update-ref` per merge
  for a change to every card's dispatch contract, for the same outcome.
- **Periodic census with a threshold N (rejected as the mechanism).** Measured:
  three phases removed 928 + 46 + 15 refs and the population regrew three times in
  25 minutes. A threshold N still permits N live hazards between runs, each sweep
  re-derives the full gate set, and the census costs a dispatch per cycle. It
  remains R8's backstop.
- **Delete the branch and rely on the pull ref staying reachable on `origin`
  (rejected as the sole safety).** The pull ref is a network object; the local
  clone's reachability is what a `gc` reads, and the archive costs one ref. That is
  why R2 is a step, not an optimisation.
- **Delete with `git branch -D` (rejected).** Measured to refuse while the branch is
  checked out — the common case, since the lane worktree holds its own branch — and
  it cannot express "only if the tip is still the reviewed SHA".
- **Delete the ref without releasing the worktree (rejected).** Measured to leave an
  unborn branch, so the next `git switch` or `git commit` in that tree fails or lands
  on a branch nobody owns: a worse state than the leak.
- **Delete at card completion instead of at merge (rejected).** A card can complete
  without merging (ADR-0307's declared-but-unmerged shape), so completion is not
  evidence that a merge happened; and on the merged path the card is often not the
  lander, so the deletion would still be unowned.
- **Key the rule on "unheld" alone (rejected).** It would have deleted
  `OP-101-task-tenant-members-residual-pins` at 12:12Z — an unheld head that origin
  still served at the same SHA. The hazard is "unheld **and** absent from origin",
  which is also the only class that needs an archive or a delete.

## Numbering

The board-wide / process block `0300`–`0319` is **exhausted**: its `Next free` cell
reads `0320`, one past the range end (ADR-0300 §11 item 19), and ADR-0319's ledger
note records that any later board-wide record draws from the
`unallocated (future lanes)` cursor. This record therefore draws **`0967`**, the
cursor value at `cf67fa15`, whose newest record is `0966`.

The draw advances the cursor to `0968`. Per ADR-0300 §11 item 27's mechanism — a
cell holding a just-consumed pool number may not be minted from — the two lane cells
that read `0967` at this head (`OP-129 attendee identity lane` and `OP-136 jobs lane`)
advance to `0968` in the same edit, as does the board-wide cell (`0320` → `0968`,
forward only; item 20 forbids a lowering, not an advance). No range is re-cut and no
cell is lowered.

The pre-mint sweep ran over all four surfaces at `cf67fa15` — the trunk, every
`.worktrees/*/docs/adr` tree, every open PR head, and
`git rev-list --objects --all -- docs/adr` — and found no `ADR-0967` on any of them;
no non-`done` card body reserves it. §Evidence quotes the commands.

## Evidence

Every number below is quoted from a command run on this head, never remembered.

The mechanism, measured on a throwaway repository (a branch `lane` checked out in a
second worktree):

```
$ git branch -d lane
error: cannot delete branch 'lane' used by worktree at '<probe>/wt'
exit=1
$ git update-ref -d refs/heads/lane <sha>
exit=0
$ git for-each-ref --format='%(refname)' refs/heads
refs/heads/main
$ git -C <probe>/wt symbolic-ref HEAD ; git -C <probe>/wt status --short --branch
refs/heads/lane
## No commits yet on lane
$ git -C <probe>/wt rev-parse HEAD
fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.
```

The repository setting, the head census and the three regrowth tips:

```
$ gh api repos/yahodu/openpic-webapp --jq '{delete_branch_on_merge,allow_squash_merge,squash_merge_commit_title}'
{"allow_squash_merge":true,"delete_branch_on_merge":true,"squash_merge_commit_title":"PR_TITLE"}
$ git for-each-ref --format='%(refname:short) %(objectname:short) [%(worktreepath)]' refs/heads
OP-101-task-local-head-hygiene-rule 720ef625 [<this worktree>]
OP-101-task-tenant-members-residual-pins 140c0b5f []   # unheld, but origin serves it at the same SHA
OP-101-task-tenant-members-tiebreak-green b6779c38 [<t_bb55940d>]
OP-113-task-signer-seam-pins c055cac1 [<t_c469c799>]
OP-140-task-marker-span-exempt-pins 78a356bf [<op140-marker-span-precision>]
OP-96-task-adr-number-guard a6a199d6 [<t_868c4a63>]
OP-96-task-adr-number-guard-edge-pins eda4e1b6 [<t_4b0b4828>]
main cf67fa15 [<main checkout>]
wt/t_32a7131c 5be02588 [<t_32a7131c>]
$ git ls-remote --heads origin 'refs/heads/OP-101-task-tenant-members-residual-pins'
140c0b5f1878cd9cbf2779283aac4a57b50749b0    refs/heads/OP-101-task-tenant-members-residual-pins
$ git ls-remote origin 'refs/pull/866/head' 'refs/pull/872/head' 'refs/pull/873/head' 'refs/pull/874/head'
140c0b5f1878cd9cbf2779283aac4a57b50749b0  refs/pull/866/head
5add954d88afb5f0bdd04932140608af3eda5fc5  refs/pull/872/head
867665c9e37269279f74188d4393d0aece4982df  refs/pull/873/head
92701608f73ad934df988cb01a5d8f011ce44c39  refs/pull/874/head
$ git merge-base --is-ancestor 92701608 origin/main ; echo $?
1                                                       # a squash never contains its head tip
```

The archival namespace, complete to the last merged PR:

```
$ git for-each-ref refs/prhead | wc -l
874
$ git for-each-ref --format='%(refname) %(objectname)' refs/prhead/872 refs/prhead/873 refs/prhead/874
refs/prhead/872 5add954d88afb5f0bdd04932140608af3eda5fc5
refs/prhead/873 867665c9e37269279f74188d4393d0aece4982df
refs/prhead/874 92701608f73ad934df988cb01a5d8f011ce44c39
```

The `0967` sweep, four surfaces (all zero) and the cells that read it:

```
$ git ls-tree -r --name-only origin/main -- docs/adr | grep -c 'ADR-0967'
0
$ ls .worktrees/*/docs/adr/ADR-0967* 2>/dev/null | wc -l
0
$ gh pr list --state open --json number,headRefName
[{"headRefName":"OP-140-task-marker-span-exempt-pins","number":875}]   # no ADR-0967 on its head
$ git rev-list --objects --all -- docs/adr | grep -c 'ADR-0967'
0
$ grep -nE '^\| (board-wide|OP-129|OP-136|unallocated)' docs/adr/README.md
43:| board-wide / process (orchestrator) | `0300`–`0319`                   | `0320`    |
74:| OP-129 attendee identity lane       | `0780`–`0798`                   | `0967`    |
76:| OP-136 jobs lane                    | `0849`–`0868`                   | `0967`    |
80:| unallocated (future lanes)          | `0799`+ (20 per lane, in order) | `0967`    |
```
