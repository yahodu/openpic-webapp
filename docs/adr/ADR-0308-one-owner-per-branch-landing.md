# ADR-0308 — One card owns a branch's landing (one-owner-per-branch/worktree)

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-110 follow-up (DOCS/ADR) — record the one-owner-per-branch landing
  rule (`t_58139e6e`), raised by the OP-110 PROCESS card `t_d5b1300a` after the
  PR [#339](https://github.com/yahodu/openpic-webapp/pull/339) landing was
  mandated to two cards at once
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the
  board-wide `0300`–`0319` range this record draws its number from; the shared
  `docs/adr/README.md` ledger is the file every lane branch conflicts on),
  [ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md) (a superseded draft is
  closed, never merged — the outcome the losing card had to reproduce by hand),
  [ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md) (a conflicting
  PR starts no `pull_request` run, so an unlanded head is UNVERIFIED),
  [ADR-0306](ADR-0306-op101-stale-branch-deletion.md) (a branch whose content is a
  subset of `main` is deleted), [ADR-0307](ADR-0307-unmerged-pr-blocks-card-completion.md)
  (a card must not complete on an unmerged deliverable — the merge lane it requires
  is exactly the card this rule must keep unique)
- **Schema:** n/a · **Contract:** n/a (process only; no application code)

## Context

The board's only serialisation mechanism is a **parent edge**: a card stays in
`todo` until every parent reaches `done`, and only then is it dispatched. Two
cards that are **siblings** — neither a parent of the other — can be claimed in
the same dispatcher tick, and a contention window that no lock covers opens.

On 2026-10-25 the OP-110 landing (PR #339, branch
`OP-110-task-self-serve-billing-green`, worktree
`/root/openpic/openpic-webapp/.worktrees/t_81899e24`) was mandated to two cards
at once:

- `t_81899e24` (round-1 review, resumed) — resolve the four-file union merge,
  `gh pr ready 339`, verify green CI, squash-merge — `workspace_kind = worktree`
  at `/root/openpic/openpic-webapp/.worktrees/t_81899e24`, `branch_name =
OP-110-task-self-serve-billing-green`.
- `t_0a36d165` (land) — **the same mandate** — `workspace_kind = dir` at **the
  same** worktree path, no `branch_name`.

They were **siblings** (both children of `t_2c3d158b`) with **no ordering edge**,
and the dispatcher claimed both at the same instant — `claimed` events at
`1792946783`, runs 1100/1101, worker pids 3329961/3329969. Each independently
built a four-file union merge of `origin/main` (`4dbcdc5`) into branch head
`94f1899`; `t_81899e24` pushed `1011550` and squash-merged PR #339 at
`16:54:20Z` (`7ab9780`) while `t_0a36d165` was still verifying CI. The loser only
learned this after the fact; its own merge commit was discarded and the whole
landing re-derived as a verification-only pass, proving its resolution
byte-identical to `1011550` except inert doc-comment wrapping.

Nothing was corrupted **by luck**, not by design: the two resolutions happened to
agree. The live hazards are structural — a non-fast-forward `git push`, a second
**divergent** resolution merged into the same branch, two racing `gh pr merge`
calls, duplicated CI runs and duplicated proof work.

The gap the existing rules left: the board's workspace allocator already forbids
two `ready` cards from sharing one `dir:`/`worktree` path, but `t_0a36d165`
declared `workspace_kind = dir` on the path and `t_81899e24` declared `worktree`
on it. The shape only shows up on the **landing mandate** — two cards that both
resolve a merge, mark the PR ready, verify CI and merge — and the
`workspace_path` gate alone does not catch it when the cards are typed
differently. A `branch_name` is the field that names the contended resource.

## Evidence

Reproducible from the board (`kanban_show`) and `git` against `origin/main`,
re-verified 2026-10-25.

- **Both cards claimed the same landing in the same tick.**
  `kanban_show(task_id="t_0a36d165")` and `kanban_show(task_id="t_81899e24")`
  each carry a `claimed` event at `1792946783`, runs **1100** / **1101**, worker
  pids **3329961** / **3329969**.
- **Same branch, same worktree, two card shapes.**
  `t_81899e24` (`worktree` @ `/root/openpic/openpic-webapp/.worktrees/t_81899e24`,
  `branch_name = OP-110-task-self-serve-billing-green`) and `t_0a36d165` (`dir` @
  the same path, no `branch_name`). The allocator's `workspace_path` gate saw one
  path, not the contention.
- **The mandate was identical, and the losing card performed it.** `t_0a36d165`
  was created as an **independent fallback land card** — a sibling, not a child —
  which routed around the parent edge that is the board's only serialisation.
- **The winner merged while the loser was still verifying.**
  `git log -1 --format='%h %an <%ae> %s' 1011550` (the pushed merge on the
  branch) and `git log -1 7ab9780` (the squash on `main`).
- **The loser's pass was verification-only and byte-identical.**
  PR [#339](https://github.com/yahodu/openpic-webapp/pull/339) comment
  `issuecomment-6400503331` records the verification-only pass and an **empty**
  `git diff 1011550 7ab9780`.
- **The guard landed with the decision.** The OP-110 PROCESS card is
  `t_d5b1300a`; its orchestrator-playbook guard is the skill `kanban-orchestrator`
  (new rule section + `references/board-rule-one-landing-owner-per-branch.md`)
  and a new hard `branch_name` gate in `scripts/board_worktree_collision_audit.py`,
  which now fails on two non-done cards sharing a non-null `branch_name` with no
  ordering edge — reproducing the OP-110 shape as a hard failure while the live
  board stays clean.

## Decision

**A branch has one landing owner at a time.** Four clauses:

1. **One owner.** The landing mandate — resolve the merge/conflicts, `gh pr
ready`, verify green CI, `gh pr merge` — is held by **one card that can be
   `ready`**. A branch's landing may not be mandated by two cards that can both
   be `ready`. The owner is the only card allowed to push to the branch, mark the
   PR ready, or merge it.
2. **A fallback card is a CHILD, never a sibling.** A fallback / recovery /
   verification-only card must be created with `parents=[primary]`, never as an
   independent sibling. If the primary lands first, the child performs its
   verification pass on the already-merged head — which is exactly the intended,
   serialised shape, and exactly what the losing card had to reconstruct by hand.
   The parent edge is the board's only serialisation mechanism; an independent
   fallback card routes around it.
3. **One workspace, one owner.** A `dir:`/`worktree` workspace must not be named
   by two cards that can be `ready` simultaneously (the existing
   one-worktree-per-card allocator rule). A landing card and its verification
   child may share the path **only** through a `parents=[...]` edge — the child's
   readiness is then gated on the parent's completion, so the sharing is
   serialised by construction.
4. **Enforcement is mechanical, at card-creation time.** The orchestrator
   playbook's `board_worktree_collision_audit.py` gained a hard gate: two non-done
   cards sharing a non-null `branch_name` with no ordering edge fail the audit.
   Any profile that mints cards runs the audit before creating them. The
   `branch_name` field is what makes the OP-110 shape detectable when the two
   cards are typed `dir` and `worktree` differently but contend for the same
   branch — the `workspace_path` gate alone misses it.

## Consequences

- **No racing push/merge.** One card owns the branch's landing, so a
  non-fast-forward push, a second divergent resolution and two racing
  `gh pr merge` calls cannot be produced by the board.
- **No duplicated proof.** The `16:54Z` landing and the verification-only pass it
  forced become one serialised unit: the primary lands, the child verifies the
  landed head — the verification work is done **once**, on the merged SHA, not
  twice in parallel on two independently derived merges.
- **Recovery/verification work is expressed as a child of the owning card.** A
  duplicated CI run and a duplicated four-file union merge are no longer the price
  of a fallback; the fallback runs after the owner, not beside it.
- **The OP-110 recurrence cannot be re-created without tripping the audit.**
  Two `ready` cards sharing a `branch_name` with no ordering edge is a hard audit
  failure, so the shape is caught before cards are minted rather than after the
  fact by a reviewer.
- **Composes with its siblings.** [ADR-0307](ADR-0307-unmerged-pr-blocks-card-completion.md)
  requires a MERGE lane for an unmerged deliverable; this rule is what keeps that
  lane a **single** owner (the merge lane and any fallback are a chain, not
  siblings). [ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md),
  [ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md) and
  [ADR-0306](ADR-0306-op101-stale-branch-deletion.md) cover the draft's other
  fates; this record covers **who is allowed to end it**.
- **Enforcement is partly by convention.** The board lives in
  `~/.hermes/kanban.db`, not a repository artifact, so the mechanical half is the
  orchestrator's `board_worktree_collision_audit.py` (run at card-creation time),
  and the review-time half is the reviewer reading the handoff for a second card
  claiming the same landing.
- No number outside `0300`–`0319` is touched.

## Alternatives

- **Hold a distributed lock on the branch for the duration of the landing.**
  Rejected: the board has no lock primitive beyond the parent edge, and a lock
  held across CI and review latency is exactly the "card pinned to a duration the
  worker does not control" shape [ADR-0307](ADR-0307-unmerged-pr-blocks-card-completion.md)
  rejects. The parent edge already gives serialisation without holding a slot.
- **Let the dispatcher deduplicate landing cards with the same mandate.** Rejected:
  the board records no "mandate" field, so the dedupe key would have to be
  inferred from prose; the distinguishable resource the board **does** record is
  `branch_name` (and `workspace_path`), and clause 4's audit keys on exactly that.
- **Rely on the workspace allocator's `workspace_path` gate alone.** Rejected: it
  is precisely the gate the OP-110 shape slipped past — `t_81899e24` was
  `worktree` and `t_0a36d165` was `dir` on the same path, so the path matched
  while the contention went unmodelled. The `branch_name` gate is the missing
  half.
- **Require every fallback to be a `parents=[primary]` child and nothing more
  (drop the audit).** Rejected: the OP-110 fallback was **created**, not
  mis-ordered by accident, which is why the rule needs a mechanical backstop at
  card-creation time (`board_worktree_collision_audit.py`), not only a convention a
  card-minting profile may forget.

## ADR number allocation

`0300`–`0307` are consumed on `main` — `0304` by
[ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md) (PR #259), `0305` by
[ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md) (PR #260), `0306` by
[ADR-0306](ADR-0306-op101-stale-branch-deletion.md) (branch
`OP-101-task-stale-branch-deletion`), and `0307` by
[ADR-0307](ADR-0307-unmerged-pr-blocks-card-completion.md) — so this record takes
`0308`, the board-wide cell's value re-read on a fresh `origin/main` (`2be55fb`)
immediately before committing, and advances the cell to `0309`. No number outside
`0300`–`0319` is touched.
