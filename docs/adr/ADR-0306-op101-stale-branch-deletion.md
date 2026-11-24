# ADR-0306 — A stale branch whose content is a subset of `main` is deleted; `main` is the only surviving ref

- **Status:** Accepted · **Date:** 2026-10-23
- **Amended:** 2026-11-24 — §Amendment (card `t_456b59dc`): PR-head recoverability as a second deletion
  ground, and step 3's per-file count replaced by whole-tree title presence.
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

   **Amended 2026-11-24:** the count clause in this item is superseded — a split
   of a spec file on `main` must not read as lost work; use whole-tree title
   presence instead (see §Amendment A2 below).

4. **Record the tip SHAs before deleting** so the deletion is reversible by SHA.
5. **Delete every subset branch** (`git push origin --delete <branch>`), leaving
   `main`. A branch is not preserved merely because it is _ahead_ of `main` or
   _has no merged PR_; both are artifacts of squash-merge and are explicitly
   **not** evidence of missing work.

   **Amended 2026-11-24:** a branch is also deletable when it fails step 3 but
   its tip is pinned by a surviving `refs/pull/<n>/head` ref and the gap it
   asserts is owned by a card (see §Amendment A1 below).

Deletion is reserved for a branch that **passes** step 3. A branch that fails it
is preserved and handed to the lane that owns it.

## Amendment — 2026-11-24 (card `t_456b59dc`)

The decisions above are unchanged. This section records two corrections found when the sweep of
2026-11-24 deleted the last four non-subset branches: a second, independent ground for deletion, and the
replacement of step 3's mechanical form because it reads a **split** of a test file as lost work.

### A1 — A surviving PR head ref is a sufficient recovery ground

Step 3 still decides when a branch's **content** is already on `main`. A1 covers the case where it is
not: the content may be off `main` and still be durably recoverable, because GitHub keeps
`refs/pull/<n>/head` after the pull request closes and after the head branch is deleted.

**Rule.** A branch is deletable when its content is a subset of `main` (steps 3–4, as amended by A2)
**or** all three of the following hold:

1. its tip SHA is pinned by a surviving `refs/pull/<n>/head` ref, SHA-for-SHA;
2. that pull request is `CLOSED` with `mergedAt: null` — not `OPEN`, not `MERGED`; and
3. the gap the branch's content asserts is owned by a board card that writes from `origin/main`, so no
   card and no worktree depends on the ref existing.

Recovery is `git push origin <sha>:refs/heads/<branch>`; no archive ref or tag is needed.

**Evidence (2026-11-24, `origin/main` `8ada9d7d`).** All 95 branch tips recorded by the sweep were
reachable through a `refs/pull/*/head` ref — 95/95, 0 unrestorable — so the 91 branches deleted under
step 3 were recoverable too, on the same ground. The last four failed step 3 and were deleted under A1:

| branch                                     | tip SHA                                    | PR head ref          | PR state         | owning card  |
| ------------------------------------------ | ------------------------------------------ | -------------------- | ---------------- | ------------ |
| `OP-101-task-tenant-members-green-restore` | `d5be9af49bb175ae4e19bd996272423d47f74bb4` | `refs/pull/272/head` | CLOSED, unmerged | `t_788e4b9a` |
| `OP-101-task-tenant-members-pins`          | `9d1f943bd1fb318ab85165ede6ba1debe3eee4da` | `refs/pull/269/head` | CLOSED, unmerged | `t_788e4b9a` |
| `OP-102-task-addons-conditional-get`       | `f3769b76646b45c67a38a81a1e8bc50a58bad374` | `refs/pull/278/head` | CLOSED, unmerged | `t_e3951910` |
| `OP-132-task-confirm-tx-failure-pin`       | `e7c4406875a16c26b8ffd017696a26ee4dbbd048` | `refs/pull/575/head` | CLOSED, unmerged | `t_d152cac9` |

After the deletion `git ls-remote --heads origin` carried `main` plus the live open-PR branch only
(`OP-101-task-tenant-members-residual-pins`, PR #866); the four tips above still resolved from their
`refs/pull/*/head` refs at the same SHAs. The three owning cards write their pins from `origin/main`, so
none needed the branch to exist.

### A2 — The decisive metric is whole-tree title presence, not a per-file count

Step 3's accepted mechanical form — every `it()`/`describe()` title exists on `main` **and** `main`'s
count is `>=` the branch's, compared per file — is not stable under a spec split. When `main` splits one
spec into several files (ADR-0843 split `internal-worker-endpoints.test.ts`; the ADR-link assertions were
split out of `adr-numbering.test.ts` into `adr-record-links.test.ts`), the branch's monolith legitimately
holds more titles at that path than `main` does, while holding none that `main` lacks.

**Rule.** A branch is a title-level subset when every `it()`/`describe()`/`test()` title in the branch's
whole test tree, whitespace-normalised, occurs somewhere in `main`'s whole test tree, and every non-ADR
path the branch adds is present on `main`. **Do not compare per-file counts.** A title absent from the
whole tree is the only title-level evidence of lost work; a per-file shortfall is not.

**Evidence (2026-11-24, `origin/main` `8ada9d7d`).** A same-line title extraction over the 95 recorded
tips classified 67 clean under both metrics, **12 that fail the per-file count and pass whole-tree
presence**, 11 that fail both, and 5 that fail only whole-tree presence. The 12 are split artifacts and
every one is a branch that was already deleted under step 3:

| file                                                              | branch copies                             | `main`                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/test/integration/internal-worker-endpoints.test.ts` | 7 tips, 1 926–2 706 lines, 35–46 titles   | 1 436 lines, 24 titles; split into `internal-worker-batch-heartbeat.test.ts` (245), `internal-worker-derivative.test.ts` (334), `internal-worker-report-limits.test.ts` (289) in the same directory plus `apps/web/src/test/helpers/internal-worker-harness.ts` (699) |
| `apps/web/src/test/unit/adr-numbering.test.ts`                    | 5 tips, 3 435–4 802 lines, 119–160 titles | 398 lines; the ADR-link assertions live in `apps/web/src/test/unit/adr-record-links.test.ts` (872)                                                                                                                                                                    |

Proof that nothing was lost: the title
`sweeps docs/adr/ADR-*.md records and never docs/adr/README.md` is **absent** from `main`'s
`adr-numbering.test.ts` and present verbatim at
`apps/web/src/test/unit/adr-record-links.test.ts:795`.

Read literally on this head, the old criterion would have flagged those 12 already-deleted branches as
non-subsets — i.e. it would have reported lost work that is on `main`.

**Known limit of the metric.** Title extraction is a lower bound: a same-line extractor finds one absent
title on each of the four A1 branches where a line-tolerant scan finds 15, 15, 8 and 2. A whole-tree
_pass_ is therefore only as strong as the extractor, so the exported-symbol check and the
no-absent-non-ADR-path check remain independent gates and are not replaced by this metric.

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

## Review sign-off — 2026-10-23 (card t_c362aaf8, round 1 · artifact lens)

The round-1 (**artifact-lens**) review of the stale-branch deletion
(`t_c362aaf8`, dashboard-created; PR
[#265](https://github.com/yahodu/openpic-webapp/pull/265)) returned **APPROVED
WITH FINDINGS**, zero changes requested, zero reviewer edits to the
deliverable:

- **Merged, and reviewed what landed.** PR #265 `MERGED` at
  `2026-10-23T11:40:21Z`, merge commit `050dae8`; reviewed head `7d9788c`;
  `git merge-base --is-ancestor 050dae8 origin/main` holds and
  `git diff 7d9788c 050dae8` is empty, so the reviewed tree is the landed tree.
  `gh pr checks 265` all pass — `ci`, `unit_test`, `test_coverage`, `lint`,
  `audit`, `audit-dev`, `secret-scan`, `env-changes`, `validate-branch-name`,
  `validate-pr-title`, `CodeQL`, `Analyze ×2`, `Assert CI evidence for the
pushed head`; local `main` == `origin/main` == `050dae8`.
- **The acceptance criterion reproduced.** `gh api …/branches` → 1 entry,
  `main`; `git ls-remote --heads origin` → one ref, `refs/heads/main`;
  `gh pr list --state open` → 0. The board DB held no non-terminal task other
  than the review card itself, so no live work depended on a deleted ref.
- **The content test reproduced independently** over all 29 recorded tip SHAs
  (objects still present locally): every branch-unique path `ABSENT` from
  `main` is a renumbered `docs/adr/ADR-*.md` record or the
  `docs/API Contract.md` space-in-filename artifact ⇒ **no branch carries a
  code file `main` lacks**. At the assertion level a newline-tolerant
  `it()`/`describe()`/`test()` title extraction finds **7** branch-only titles
  across 4 branches, each present on `main` under a renumbered citation —
  `TRUSTED_CLIENT_IP_HEADER` `ADR-0031`→`0032`; `index spec pins — OP-89
identity lifecycle` and `OP-89 new-device read cap` `ADR-0046`→`0050`;
  `section 4-6 surface seam — createIdentityLifecycleSeams` and `section 2
surface — the contact-verified Better Auth adapter` `ADR-0043 §3`→`0045 §3` —
  and `main` carries more titles than the branch in every case (48→52, 20→20,
  33→47, 41/43→47). The subset conclusion holds.
- **Preconditions reproduced.** 24 of the 29 recorded branches carry a CLOSED
  never-merged PR and 5 carry none, matching §Evidence.
- **Findings (Info-only, none blocking):** §Evidence's "exactly **one**"
  branch-only assertion line understates the inventory (7 titles, all
  renumbering duplicates; the subset verdict is unaffected) — recorded here
  because this ADR is merged and therefore frozen; the card title's **31**
  branches vs the repo's 30 is reconciled by PR
  [#264](https://github.com/yahodu/openpic-webapp/pull/264)'s head branch
  `OP-101-task-stale-draft-pr-review-signoff`, which merged at
  `2026-10-23T11:29:57Z` — the same second this card was created — and was
  auto-deleted on merge, so the requester's snapshot counted it; and
  `docs/adr/README.md` remains a standing serialization hotspot.
- **Caveat:** equivalence was verified at path / module / title level, not
  pin-by-pin semantics.
- Review comment: PR #265
  [`#issuecomment-6364107789`](https://github.com/yahodu/openpic-webapp/pull/265#issuecomment-6364107789).
