# ADR-0304 — A stale draft RED PR is reconciled against `main` and closed, never merged

- **Status:** Accepted · **Date:** 2026-10-23
- **Card:** board cleanup — reconcile the eight open draft RED PRs against `main` (`t_e43b1ff0`, dashboard-created)
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (per-lane ADR-number ranges — the reason the stale branches' ADR ids no longer match the numbers on `main`), [ADR-0120](ADR-0120-op96-digest-retry-quiet-hours-crons-red.md) / [ADR-0131](ADR-0131-op97-in-app-feed-read-state-unread-count-red.md) / [ADR-0096](ADR-0096-op95-otp-delivery-through-notification-service-red.md) / [ADR-0085](ADR-0085-op93-channel-resolution-and-template-renderer-red.md) / [ADR-0052](ADR-0052-op90-me-projection-red.md) / [ADR-0045](ADR-0045-op89-followup-red-idempotency-2fa-transition-and-surface-seams.md) (the same RED lanes, as renumbered and landed on `main`)
- **Schema:** n/a · **Contract:** n/a (process only; no application code)

## Context

Eight PRs from the September–October RED lanes sat open as **drafts** against
`main`, all `mergeable: CONFLICTING`:

| PR  | Lane  | Head branch                                                | ADR ids cited      |
| --- | ----- | ---------------------------------------------------------- | ------------------ |
| 160 | OP-89 | `OP-89-task-identity-lifecycle-hooks-red`                  | 0038 · 0039 · 0040 |
| 163 | OP-89 | `OP-89-task-identity-lifecycle-hooks-followup-red`         | 0043 · 0044        |
| 170 | OP-89 | `OP-89-task-identity-lifecycle-hooks-followup-pins`        | 0050 · 0051        |
| 164 | OP-90 | `OP-90-task-get-patch-me-red`                              | 0044 · 0045 · 0047 |
| 185 | OP-93 | `OP-93-task-channel-resolution-and-template-renderer-red`  | 0078 · 0079 · 0080 |
| 191 | OP-95 | `OP-95-task-otp-delivery-through-notification-service-red` | 0094 · 0095        |
| 200 | OP-96 | `OP-96-task-digest-retry-quiet-hours-crons-red`            | 0100 – 0105        |
| 215 | OP-97 | `OP-97-task-in-app-feed-read-state-unread-count-red`       | 0131 · 0132        |

Each was the **RED half** of a TDD lane. In the meantime every lane's GREEN
landed on `main` through a _different_, later PR — the RED content was merged (or
superseded by an equivalent-plus-more version) as part of the GREEN PR, and
[ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) later **renumbered**
each lane's ADRs into its reserved range. The stale drafts were therefore not
"unmerged features" at all: they were snapshots of work that `main` had already
passed.

The trap is that the recorded facts point the wrong way. Every head branch is
still _ahead_ of the merge-base, `git merge-base --is-ancestor <head> main`
returns **false** for all eight (squash merges never preserve ancestry), and the
PRs still show a real diff. A reviewer who trusts "there are 8 open PRs, some may
need merging" can therefore merge one and **regress `main`** to an older,
conflicting copy of a test file — exactly the outcome the card warned against
("don't merge what's already there in the repo").

## Decision

**A stale draft RED PR is closed, never merged, once its content is shown to be a
subset of `main`.** Reconciliation is a _content_ comparison, not an ancestry
one, and it has a fixed procedure:

1. **Resolve the PR against a fresh `origin/main`.** Fetch first; the answer is a
   function of main's current tree, not of the branch's parent.
2. **Classify every changed path** as `SAME` (byte-identical to `main`), `DIFFER`
   (present but diverged) or `ABSENT` (not on `main`), reading the blobs from
   `origin/main:<path>` and `refs/pull/<n>/head:<path>`. Compare **whole
   paths**, not shell-word-split lists — filenames in this repo contain spaces
   (`docs/API Contract.md`), and a naive `for f in $(gh pr diff --name-only)`
   reports them as false `ABSENT`s.
3. **For a `DIFFER` file, decide direction by set difference**, not by line
   count alone: the lines present in the PR but absent from `main` must be
   _replaced_ lines (an older import, an older fixture clock, an older JSDoc) or
   _expanded-away_ fragments — never a live assertion `main` lacks. The decisive
   check is the **test inventory**: every `it()`/`describe()` title in the PR
   must exist in `main`, and `main`'s `it()` count must be `>=` the PR's.
4. **If the PR is a subset, close it with a superseded-by-`main` comment that
   states the evidence** (the `SAME`/`DIFFER` classification, the title-set and
   count check, and the merged PR/commit that delivered the lane). **Do not
   merge, rebase or re-open.** Reopening re-creates the same trap for the next
   reader.
5. **A number in the PR's ADR ids is not evidence of missing work.** After
   ADR-0300 the same lane's ids on `main` are the _renumbered_ ones; a PR citing
   `ADR-0043` and `main` carrying the same decision as `ADR-0045` is reconciled,
   not divergent.

Merging is reserved for a PR that fails step 3 — i.e. one that carries a live
assertion, a route, a schema field or a fixture that `main` does **not** already
have.

## Reconciliation of the eight (evidence)

Resolved against `origin/main` @ `b2d5143`. For each PR: every `it()`/`describe()`
title is present on `main`, and `main`'s `it()` count is `>=` the PR's.

| PR  | `it()` PR → `main` | PR-only lines (direction)                                                                                                                    | Delivered on `main` by                                                                                                                                             |
| --- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 160 | 38 → 51            | the pre-`fixtureInstant` clock + a wide `mongodb` import (replaced by the [ADR-0148](ADR-0148-integration-fixture-clock-anchor.md) anchor)   | OP-89 lane, [ADR-0041](ADR-0041-op89-identity-lifecycle-hooks-green.md) …                                                                                          |
| 163 | 30 → 34            | `ADR-0043`-suffixed `describe` titles, renumbered to `ADR-0045` on `main`                                                                    | OP-89 follow-up, [ADR-0045](ADR-0045-op89-followup-red-idempotency-2fa-transition-and-surface-seams.md) / [ADR-0046](ADR-0046-op89-followup-red-review-signoff.md) |
| 170 | 31 → 34            | the same two renamed `describe`s                                                                                                             | OP-89 follow-up pins, [ADR-0062](ADR-0062-op89-followup-green-coverage-pins.md)                                                                                    |
| 164 | 24 → 25            | one "Deliberate non-assertions" comment line                                                                                                 | `feat(me)` OP-90 (#168), [ADR-0052](ADR-0052-op90-me-projection-red.md)                                                                                            |
| 185 | 27 → 27            | `ADR-0078` citations in JSDoc, renumbered to `ADR-0085` on `main`                                                                            | OP-93 lane, [ADR-0088](ADR-0088-op93-channel-resolution-and-template-renderer-green.md)                                                                            |
| 191 | 9 → 12             | `ADR-0094` citations, renumbered to `ADR-0096`                                                                                               | OP-95 GREEN (#199), [ADR-0098](ADR-0098-op95-otp-delivery-through-notification-service-green.md)                                                                   |
| 200 | 21 → 21            | the pre-anchor `2026-03-01` fixture instants + `ADR-0100` citations, renumbered to `ADR-0120`                                                | OP-96 lane (#216, #225 … #249), [ADR-0126](ADR-0126-op96-digest-retry-quiet-hours-crons-green.md)                                                                  |
| 215 | 51 → 54            | the pre-F1 per-row `insertFeedRow` seed loop in I4 (replaced by the bulk `insertFeedRows` + explicit timeout on `main`), `ADR-0131` citation | OP-97 GREEN (#233, #249), [ADR-0180](ADR-0180-op97-in-app-feed-read-state-unread-count-green.md)                                                                   |

All eight were **closed** with a superseded-by-`main` comment carrying this
evidence. None was merged. No commit was added to `main` by the merge of any of
them.

## Consequences

- `main` cannot be regressed by a stale draft: the reconciliation is a content
  check, so a PR that is _behind_ `main` but not _ancestral_ to it is closed, not
  fast-forwarded over the trunk.
- The open-PR column now reflects real pending work. Eight `CONFLICTING` drafts
  that no longer correspond to any unfinished behaviour stop consuming review and
  rebase attention.
- The rule is safe against the two false signals that made the drafts look
  pending: **squash-merge invisibility** (ancestry) and **ADR renumbering**
  (a cited id that no longer matches). Both are explicitly checked, not assumed.
- A future stale draft is closed by the same five-step procedure; the procedure,
  not the eight specific PRs, is the decision.
- Reopening a closed superseded PR is _not_ the way to recover its content: the
  content is on `main`, as the step-3 inventory shows. If a specific assertion is
  ever found to be genuinely absent, the correct response is a fresh RED pin, not
  a merge of the stale branch.

## Alternatives

- **Merge the PRs after rebasing them onto `main`.** Rejected: every one is a
  subset of `main`, so a rebase resolves the conflict by _deleting_ `main`'s newer
  version in favour of the older one (e.g. PR #215's sequential `insertFeedRow`
  loop over PR #233's bulk seed, PR #160's hardcoded clock over the ADR-0148
  anchor). A clean-looking rebase is exactly the regression this record prevents.
- **Trust `git merge-base --is-ancestor`.** Rejected: it returns false for every
  squash-merged lane, so it would report all eight as unmerged and merge all
  eight. Ancestry cannot answer "is this content already on the trunk?".
- **Leave the drafts open as a historical record.** Rejected: they are
  indistinguishable from real pending work (they show a live diff and
  `CONFLICTING`) and the board's open-PR column is a work signal; the git history
  and the closed-PR comment thread already preserve the record.
- **Delete the head branches.** Rejected: closing is reversible and keeps the
  branch blob available for the step-2/3 comparison; deleting the branch throws
  away the only artifact the reconciliation cites.

## Review sign-off — 2026-10-23 (card `t_e43b1ff0`, round 1 · artifact lens)

The round-1 (**artifact-lens**) review of the reconciliation card (`t_e43b1ff0`,
dashboard-created; PR [#259](https://github.com/yahodu/openpic-webapp/pull/259))
returned **APPROVED WITH FINDINGS**, zero changes requested, zero reviewer edits
to the deliverable:

- **Merged, and reviewed what landed.** PR #259 `MERGED` at
  `2026-10-23T06:30:23Z`, merge commit `f148dc7` (squash); local `main` ==
  `origin/main` == `f148dc7` at review time, and
  `git merge-base --is-ancestor f148dc7 origin/main` holds.
- **The eight drafts closed, none merged.** `gh pr list --state open` → `[]`;
  #160, #163, #170, #164, #185, #191, #200, #215 are each `state=CLOSED`,
  `mergedAt=null`, `mergeCommit=null`, closed `06:20:39Z`–`06:20:58Z`, each
  carrying a superseded-by-`main` close comment with its evidence. No commit was
  added to `main` by any of them.
- **The subset verdict reproduced independently** over every test file each head
  changes, against `origin/main`: the only differences are ADR-0300
  renumberings — never a dropped assertion. PR #200's added ADR files
  `0100`–`0105` map to `main`'s `0120`–`0125` with byte-identical suffixes;
  #163/#170's two `describe()` titles citing `ADR-0043 §3` exist on `main` as
  `ADR-0045 §3`; #215's `I4: …idx_user_unread` exists on `main` (formatted as a
  multi-line `it(` call); #163's `ADR-0043` file vs `main`'s `ADR-0045` differs
  only in the H1 number. Merging any of the eight would have regressed `main` to
  a pre-GREEN copy.
- **This ADR and the ledger landed intact.** `docs/adr/ADR-0304-…md` present on
  `main` (128 lines); the board-wide `Next free` cell advanced `0304` → `0305`;
  the index row for `0304` was added; no number outside `0300`–`0319` was
  touched.
- **Findings routed (not defects in this deliverable):** High → `t_2d14ac1f`
  (orchestrator): four heads never ran `CI`/`PR Checks` and read green; High →
  `t_c69ee0f5` (orchestrator): the decomposer's rows are missing from the board
  DB while a duplicate card ran the same goal.
- **Info (no card):** step 3's title criterion reads verbatim-strict but is in
  practice _verbatim modulo the ADR-number suffix_ (step 5 and the evidence table
  already resolve this), and a regex-based title check additionally
  false-negatives on multi-line `it(` calls. `docs/adr/README.md` remains a
  standing serialization hotspot (8/8 closed PRs + #259 touched it).
- **Caveat:** equivalence was verified at file / module / title level, not
  pin-by-pin semantics.
- Review comment: PR #259
  [`#issuecomment-6359007435`](https://github.com/yahodu/openpic-webapp/pull/259#issuecomment-6359007435).
