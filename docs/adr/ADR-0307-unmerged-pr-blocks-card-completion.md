# ADR-0307 — A card must not complete on an unmerged deliverable: an open PR is declared in the handoff and gets a follow-up merge lane

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-106 follow-up (DOCS) — retire the stale "PR #299 open" wording in
  [ADR-0401](ADR-0401-op106-subscription-read-green.md) and record the merge-lane
  gap rule (`t_892df2ea`, raised by the OP-106 merge lane `t_66441715`)
- **Relates to:** [ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md) (the
  content test the merge lane reused; the rule for a _superseded_ draft),
  [ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md) (a conflicting PR
  starts no `pull_request` run, so an open/conflicting draft carries no CI
  evidence — why an unmerged head is UNVERIFIED, not green),
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the board-wide
  `0300`–`0319` range this record draws its number from; the shared
  `docs/adr/README.md` ledger is the file every lane branch conflicts on),
  [ADR-0401](ADR-0401-op106-subscription-read-green.md) /
  [ADR-0402](ADR-0402-op106-subscription-read-followup-pins.md) (the two records
  the observed incident left stale)
- **Schema:** n/a · **Contract:** n/a (process only; no application code)

## Context

The board's completion transition means _"this card's work is finished"_. Reviewers,
downstream cards and the ADR ledger read the same transition as _"the deliverable is
on `main`"_. Nothing in the protocol reconciled the two, and nothing required a
merge owner to exist.

On 2026-10-25 the OP-106 follow-up TEST card `t_09e53bea` (the characterisation pins
over the shipped subscription read) completed **available-to-complete and correctly
completed** — its pre-created DOCS child was gated on it, and no rule forbade the
transition — while its own PR
[#299](https://github.com/yahodu/openpic-webapp/pull/299) was still an **open
draft**. The pins therefore sat **off-trunk**, and two records already spoke of them
as landed:

- [ADR-0401](ADR-0401-op106-subscription-read-green.md) §"Post-review status" read
  _"**F1, F2 and F3 have since been pinned** by the OP-106 follow-up TEST card
  `t_09e53bea` …"_ and cited PR #299 as still unmerged at the time — an honest
  caveat, but the sentence's subject was already the pinned fact;
- [ADR-0402](ADR-0402-op106-subscription-read-followup-pins.md) — the pins' own
  record, committed on that very branch — was unreachable from `main` entirely.

The gap was **structural, not clerical**. Nothing on the board was gated on the
merge, so the dependency graph could not see it: no card's title or body referenced
PR #299 or a merge lane for it, and the lane that eventually owned the merge
(`t_66441715`) was created by a _later_ card (`t_5fa28f29`, the ADR-0401 sign-off)
after a reviewer noticed the orphan, rather than by an edge in the graph.

By then the branch had aged. PR #296 (the OP-105 in-process memory payment provider,
ADR-0383/0384) landed **after** the pins' branch cut `cab62e8`, so PR #299 was
**CONFLICTING** on the shared `docs/adr/README.md` ledger and — per
[ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md) — carried **no
`CI`/`PR Checks` run at all**. The merge lane had to resolve the ledger conflict as
a union, re-derive the head's CI evidence on the new head `536c4f0`, re-run both
suites there (unit **108 files / 1859 passed | 3 skipped**, integration **75 files /
541 passed**, against the branch's own recorded **106 files / 1843 passed | 3
skipped** and 75 / 541) and squash-merge as `0f53970`. The wasted work was a direct
cost of the missing rule, not of the pins.

## Evidence

Reproducible with `git` + `gh` against `origin/main` `0f53970`, re-verified
2026-10-25.

- **PR #299 was open, and not even non-draft, when the card completed.** `gh api
repos/yahodu/openpic-webapp/issues/299/timeline` yields `created_at`
  `2026-10-25T03:47:50Z` and a single `ready_for_review` event at
  `2026-10-25T04:01:06Z` — i.e. the PR left the draft state **after** `t_09e53bea`
  completed, on the merge lane, not on the card.
- **PR #299 `MERGED` at `2026-10-25T04:07:11Z`**, merge commit
  `0f53970926ca0f895c147237a392a6c30a5aa6a2`; `git merge-base --is-ancestor 0f53970
origin/main` holds. Its pushed head was `536c4f0`, the merge of `origin/main`
  into the pins branch, created by the merge lane (normal push, no force-push).
- **The conflict had an unrelated cause.** PR #296 `MERGED` `2026-10-25T03:56:57Z`
  (merge commit `4c5a7eb`), after the pins' cut `cab62e8` — the branch was
  CONFLICTING on the shared ledger, which per [ADR-0305](…) suppressed its
  `pull_request` runs.
- **The claim outran the fact by one board hop.** ADR-0401's §"Post-review status"
  asserted the pinned fact while PR #299 was open; the sibling deliverable of this
  card rewrote that sentence to the landed fact (`0f53970`, an ancestor of
  `origin/main`).
- **The graph did not carry the gap.** `t_66441715` has the sign-off card
  `t_5fa28f29` as its parent and `t_892df2ea` as its child; `t_09e53bea` had no
  merge-lane child. The gap was closed by review, not by a dependency edge.

## Decision

**A card must not complete while its own deliverable's PR is unmerged.** Five
clauses, one of which is ordering:

1. **Scope.** The rule binds a card whose deliverable is a `main`-bound artifact
   (production code, tests, docs/ADR changes shipped by PR). A card that produces no
   `main`-bound artifact — research, board-only operations, a review sign-off
   recorded against a still-open PR — is exempt **and must say so** in its handoff.
2. **Declaration.** If the card's PR is left open — **draft**, **ready but
   unmerged**, or **CONFLICTING** — the completion handoff must state, explicitly:
   the PR number, its state, its head SHA, and that the deliverable is
   **off-trunk** (not an ancestor of `origin/main`). A completion without that
   statement is read as "the deliverable is on `main`" — the false claim this rule
   exists to prevent.
3. **Owner.** The board must carry a follow-up **MERGE** lane with `parents=[the
card that left the PR open]`, assigned to a profile with merge authority, before
   any downstream record claims the deliverable "landed" or "pinned". The lane is a
   real card in the graph, not a note: that edge is what makes the gap visible to
   the next reader and to the dispatcher.
4. **Claim discipline.** While a PR is open, no record may assert the landed fact.
   A record may state that the work exists **on a branch**, cite the PR number and
   its state, and the past tense ("has since been pinned", "landed", "merged") is
   reserved for a SHA that satisfies
   `git merge-base --is-ancestor <sha> origin/main`.
5. **Ordering.** The merge lane is dispatched **before unrelated later cards**, so
   the shared ledger is reconciled while the branch is still fresh and the drift
   this rule prevents does not accumulate. A stale merge waits on CI, review and
   every PR that lands in the meantime — each of which is a new conflict and a new
   round of evidence.

The merge lane's own obligations are [ADR-0304](…)/[ADR-0305](…)'s: re-read
`origin/main`; apply the content test to any conflict; resolve `docs/adr/README.md`
as a **union** (every lane cell at its highest value on `origin/main`, the pool at
its highest value, every index row ascending); re-derive CI evidence on the head
being merged (a conflicting PR starts no `pull_request` run, so a CodeQL-only
rollup is UNVERIFIED); re-run the suite at that head; and correct any record that
asserted the landed fact early.

## Consequences

- Every "landed"/"pinned" claim in `docs/adr/` is backed by a merge commit that is
  an ancestor of `origin/main`. A reader no longer has to reconstruct a branch's
  state from GitHub's timeline to know whether a claim is true.
- A card that leaves its PR open pays one extra card, one extra review and one
  merge-lane round. That is the intended price. The alternative observed here — an
  unmerged deliverable invisible to the dependency graph, a branch that had to be
  re-evidenced after two other PRs landed, and two records that had to be corrected
  — cost more, and its cost was paid by a card that was not even about this lane.
- **Enforcement is by convention and review, not by CI.** The board's state lives in
  `~/.hermes/kanban.db`, which is not a repository artifact, so no workflow can
  assert "this card's PR is an ancestor of `main`". The mechanical half —
  `git merge-base --is-ancestor <claimed-sha> origin/main` — is the reviewer's
  acceptance check, and clause 4 is what makes the claim checkable at all.
- The rule composes with its siblings: [ADR-0304](…) settles a **superseded** draft
  (close it, never merge it), [ADR-0305](…) fixes what evidence an open or
  conflicting head can carry (none — it is UNVERIFIED), and this record requires
  that an open PR is **declared and owned**. The three now cover the full life of a
  draft that outlives its card: declare it, evidence it, land it or close it.
- No number outside `0300`–`0319` is touched.

## Alternatives

- **Keep "done" meaning "my card's work is finished" and let review catch the gap.**
  Rejected: that is exactly what happened. Review _did_ catch it — one card later,
  after another PR had landed on top, after the branch had gone CONFLICTING with no
  CI run, and after a record ([ADR-0401](…)) had already been written as if the pins
  were on `main`. Review caught the consequence; this rule removes the cause.
- **Hold the card `running`/blocked until its PR merges.** Rejected: it pins a
  dispatcher slot to a duration the worker does not control (CI and review latency),
  and a card blocked on "waiting for a merge" is indistinguishable, to the
  unblock-loop accounting, from a stalled one. An explicit handoff plus a MERGE
  child records the same fact without holding a worker.
- **Infer the state from "was the PR open when the card completed".** Rejected: the
  board records no PR state, so the inference is not reconstructible after the fact
  — it had to be recovered from GitHub's timeline while writing this record. Making
  the state a first-class field of the handoff (clause 2) is what makes it durable.
- **Add a CI workflow that fails when a `docs/adr/` claim cites an unlanded SHA.**
  Considered for clause 4 only, and not adopted: a claim's SHA is prose, and there
  is no reliable contract for extracting it from arbitrary ADR text — the same scope
  boundary the `adr-numbering` guard draws for file names
  ([ADR-0302](ADR-0302-adr-number-guard-contract.md)). The reviewer check is the
  enforcement arm; a guard here would be a scanner built on a guess.

## ADR number allocation

`0300`–`0306` are consumed on `main` — `0304` by
[ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md) (PR #259), `0305` by
[ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md) (PR #260), `0306` by
[ADR-0306](ADR-0306-op101-stale-branch-deletion.md) (branch
`OP-101-task-stale-branch-deletion`) — so this record takes `0307`, the board-wide
cell's value re-read on a fresh `origin/main` (`0f53970`) immediately before
committing, and advances the cell to `0308`. No number outside `0300`–`0319` is
touched.
