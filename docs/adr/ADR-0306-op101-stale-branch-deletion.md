# ADR-0306 — A stale branch whose content is a subset of `main` is deleted; `main` is the only surviving ref

- **Status:** Accepted · **Date:** 2026-10-23
- **Card:** board cleanup — delete the stale branches, keep only `main` (`t_c362aaf8`, dashboard-created)
- **Relates to:** [ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md) (the content-subset test this record reuses, and the sibling cleanup that closed the eight stale draft RED PRs), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the board-wide `0300`–`0319` range this record draws its number from; the shared `docs/adr/README.md` ledger is the file every lane branch conflicts on), [ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md) (why the stale heads carried no `CI`/`PR Checks` run)
- **Schema:** n/a · **Contract:** n/a (process only; no application code)

## Context

GitHub held **30 branches** in `yahodu/openpic-webapp`: `main` plus 29
leftover `OP-*` lane branches. The repository sets
`delete_branch_on_merge: true`, so every branch that was merged was deleted
automatically; the 29 survivors are therefore, by GitHub's own bookkeeping,
**unmerged** — 24 whose PR was closed without merge and 5 with **no PR at
all** (see §Evidence). All 29 last moved between `2026-10-05` and
`2026-10-22`; none had an open PR (`gh pr list --state open` → 0), and no
board task referenced any of them.

The recorded facts point the wrong way, exactly as
[ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md) found for the eight stale
draft RED PRs. Every surviving branch is _ahead_ of `main` by 1–14 commits
(`git rev-list --count origin/main..origin/<branch>`), because PRs here are
**squash-merged** and a squash never preserves ancestry. A reviewer who trusted
"these are ahead of `main`" or "none has a merged PR" would conclude the work is
stranded. It is not: the lane's GREEN landed on `main` through a _different_,
later PR, and [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) later
renumbered each lane's ADRs, so the branch's `docs/adr/ADR-00nn-*.md` files are
absent from `main` under those _names_ while the decisions themselves sit on
`main` under their new numbers.

The request — "remove all the stale branches, I only want the `main` branch" —
is a destructive, irreversible ref deletion on a shared repository. It is
therefore gated on the same **content** test
[ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md) fixed, not on ancestry.

## Evidence

Resolved against `origin/main` @ `55d7bdb` on 2026-10-23. Every figure is
reproducible with `git` + `gh` as shown.

**The population.** 29 non-`main` branches, all with no merged PR:

- **24** carry a CLOSED (never-merged, `mergedAt: null`) PR — e.g.
  `OP-84-feature-notification-type-schema` (#122) …
  `OP-101-task-workflow-shell-safety-refname-red` (#241).
- **5** carry **no PR at all**: `OP-85-task-production-trusted-client-ip-required`,
  `OP-86-task-auth-guards-gap-pins`, `OP-87-task-internal-hmac-cron-green`,
  `OP-88-followup-outbox-hardening`, `OP-94-task-fanout-mobile-skip-channel-pin`.

**The content test (ADR-0304 §Decision step 3).** For every branch, every path
in the branch-unique three-dot diff (`git diff --name-only origin/main...<b>`)
was classified `SAME` (byte-identical to `main`), `DIFFER` (present, diverged) or
`ABSENT` (not on `main` by that path):

- **No branch carries a code file `main` lacks.** Every `ABSENT` path is a
  `docs/adr/ADR-*.md` record, renumbered on `main` under
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md), or the
  space-in-filename artifact ADR-0304 warns about (`docs/API Contract.md` splits
  into three shell words — a false `ABSENT`).
- **No branch carries a live test assertion `main` lacks.** Scanning every
  branch-unique `*.test.ts` / `*.spec.ts` for branch-only `it(`/`describe(`/
  `test(` lines yielded exactly **one** hit —
  `OP-97-task-in-app-feed-read-state-red`, `notification-unread-count.test.ts`
  `+1`. Inspection shows it is the _same_ `it("I4: the count query is served by
the partial index idx_user_unread", …)` that `main` carries multi-line; the
  branch simply has it on one line, and `main` is the _newer_ copy (it adds the
  `insertFeedRows` bulk seed and the explicit F1 timeout). The branch is a
  subset, exactly as ADR-0304 recorded for PR #215.
- Every other `DIFFER` file diverges only in the direction of `main` having
  evolved past the branch (renumbered ADR citations, the fixture-clock anchor,
  a newer catalogue row) — the "stale copy" case, not the "missing work" case.

**Recoverability.** Every deleted branch's tip SHA was recorded before deletion
(see §Consequences), so any branch is restorable from its SHA while GitHub
retains the objects.

## Decision

**A branch whose content is a content subset of `main` is deleted, and `main` is
the only ref that survives.** The procedure is ADR-0304's, applied to
deletion rather than closure:

1. **Fetch first.** The answer is a function of `origin/main`'s current tree,
   not of the branch's parent.
2. **Require the preconditions** that make deletion safe: no **open** PR whose
   head is the branch, and no **active** board task or worktree depending on it.
3. **Apply the content test.** Classify every branch-unique path
   `SAME`/`DIFFER`/`ABSENT`, and run the decisive test-inventory check: every
   `it()`/`describe()` title in the branch must exist on `main`, and `main`'s
   count must be `>=` the branch's. A branch carrying a live assertion, route,
   schema field or fixture `main` lacks is **not** a subset and is **not**
   deleted — it is routed back through the normal green-PR path.
4. **Record the tip SHAs before deleting** so the deletion is reversible by SHA.
5. **Delete every subset branch** (`git push origin --delete <branch>`), leaving
   `main`. A branch is not preserved merely because it is _ahead_ of `main` or
   _has no merged PR_; both are artifacts of squash-merge and are explicitly
   **not** evidence of missing work.

Deletion is reserved for a branch that **passes** step 3. A branch that fails it
is preserved and handed to the lane that owns it.

## Consequences

- The repository's branch list is `main` alone; the open-PR column and the
  branch column now reflect only real pending work.
- **No work is lost.** The content test proved every deleted branch a subset of
  `main`; the ADR records that carry their pre-renumber names are the only paths
  `main` does not have, and their decisions are present on `main` under
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md)'s renumbering.
- **The deletion is reversible by SHA.** The 29 tips were recorded immediately
  before deletion (2026-10-23): `OP-84-feature-notification-type-schema`
  `22239e5`, `OP-85-task-auth-coverage-red-specs` `920e856`,
  `OP-85-task-better-auth-red-specs` `1feb81a`,
  `OP-85-task-production-trusted-client-ip-required` `0a58cde`,
  `OP-85-task-red-pins` `f9b3333`, `OP-86-task-auth-guards-gap-pins` `baae85f`,
  `OP-86-task-auth-guards-red` `d64e031`,
  `OP-87-task-internal-hmac-cron-green` `535c464`,
  `OP-87-task-internal-hmac-cron-red` `0c70e59`,
  `OP-88-followup-outbox-hardening` `60abd3a`,
  `OP-88-task-domain-events-outbox-red` `35331d1`,
  `OP-89-task-identity-indexes-red` `9586392`,
  `OP-89-task-identity-lifecycle-hooks-followup-pins` `adc7369`,
  `OP-89-task-identity-lifecycle-hooks-followup-red` `281f1c2`,
  `OP-89-task-identity-lifecycle-hooks-red` `b1b2ac2`,
  `OP-90-task-get-patch-me-red` `4a0e08e`,
  `OP-92-task-followup-drift-hardening-red` `7767751`,
  `OP-93-task-channel-resolution-and-template-renderer-green` `2bca932`,
  `OP-93-task-channel-resolution-and-template-renderer-red` `81c40e4`,
  `OP-94-task-fanout-cron-route-red` `81402e1`,
  `OP-94-task-fanout-mobile-skip-channel-pin` `c2e254d`,
  `OP-94-task-notification-fan-out-red` `855c7be`,
  `OP-95-task-otp-copy-fallback-phone-red` `0d0c02c`,
  `OP-95-task-otp-delivery-through-notification-service-red` `aa0f9b3`,
  `OP-96-task-digest-retry-quiet-hours-crons-red` `df6f486`,
  `OP-97-task-feed-pin-followups-test` `6e36953`,
  `OP-97-task-in-app-feed-read-state-red` `97257f5`,
  `OP-101-task-workflow-shell-safety-red` `7fe7fb3`,
  `OP-101-task-workflow-shell-safety-refname-red` `bf7c3aa`.
  Any of them can be restored with
  `git push origin <sha>:refs/heads/<branch>`.
- **`main` is not regressed.** No commit was added to `main` by this cleanup;
  the only change this record's PR makes is this ADR and its ledger row.
- **The rule generalises ADR-0304.** Closure (a PR) and deletion (a ref) are now
  the two terminal dispositions for a superseded lane artifact, and both are
  gated on the same content test.

## Alternatives

- **Keep the branches.** Rejected: they are superseded snapshots, they clutter
  the branch list and the open-PR surface, and the owner asked for `main` alone.
  Their decisions are on `main`; nothing is preserved by the ref.
- **Archive the branches under `archive/*` instead of deleting.** Considered and
  rejected for this repository: it does not deliver the requested end state
  (`main` only) and the tip SHAs already provide SHA-level recoverability, which
  is the property an archive tag would add.
- **Delete on ancestry (`git branch -r --merged`) or on "has a merged PR".**
  Rejected: both are blind to squash merges. Every surviving branch is _ahead_
  of `main` and none has a merged PR, yet all are subsets — ancestry would delete
  nothing and "merged PR" would delete nothing either, while a genuinely
  stranded branch would be indistinguishable under either test. Only the content
  test decides.
- **Force-push `main` or rewrite refs.** Out of scope and rejected: the cleanup
  deletes refs, it does not rewrite `main`'s history.
