# ADR-0112 — OP-94 fan-out follow-up: review sign-off of the pre-selection `mobile` skip-channel seam pin (RED)

- **Status:** Accepted · **Date:** 2026-10-20 · **Author:** `openpic-webapp-reviewer`
- **Card:** `t_9e63f809` (OP-94 fan-out follow-up RED, attempt 2) · **Verdict:** **APPROVED WITH FINDINGS** — no changes requested
- **Reviewed:** branch `OP-94-task-fanout-mobile-skip-channel-seam`, head `6296d25`, base `origin/main` @ `229a64c`; draft PR #210 ([review summary](https://github.com/yahodu/openpic-webapp/pull/210#issuecomment-6289188546); the Low inline comment sits at `fan-out.test.ts:334`)
- **Relates to:** [ADR-0094](ADR-0094-op94-fan-out-polish.md) (the polish under pin), [ADR-0095](ADR-0095-op94-fan-out-polish-review-signoff.md) (the finding `mobile-skip-channel-unpinned`), [ADR-0111](ADR-0111-op94-mobile-skip-channel-pin-via-test-seam.md) (the seam decision — this lane's RED record), [ADR-0085](ADR-0085-op93-channel-resolution-and-template-renderer-red.md) / [ADR-0090](ADR-0090-op94-notification-fan-out-red.md) (resolver + fan-out contracts)

## Context

This ADR records only the **review** of the OP-94 fan-out mobile skip-channel RED. The decision
itself — export `groupChannel` as an owner-authorised test seam and pin the `mobile` fallback
through it — is recorded in this lane's RED record, committed on the branch as
`ADR-0110-op94-mobile-skip-channel-pin-via-test-seam.md` and renumbered to **`ADR-0111`** by the
GREEN card `t_b9bb5e0a` (the OP-89 residual-citation follow-up, PR #209, claimed `0110` on
`origin/main` first). Nothing here restates or contradicts that decision; the sections below are
the delta this sign-off adds.

The RED under review is unusual and its sign-off has to say so plainly: **no behavioural bug is
being pinned**. `groupChannel` is already correct; the RED is the _missing `export`_ on a total,
side-effect-free helper that a later edit could silently regress back to `"sms"` with every suite
still green.

## Decision

### 1. Verdict: APPROVED WITH FINDINGS (RED only)

The pin is accepted as-is and **no changes were requested on PR #210**. The RED must not be
merged — it is intentionally red and is turned green by the GREEN card `t_b9bb5e0a` on the same
branch. The verdict is "with findings" only because one Low documentation marker is owed, and that
marker is owed _at the moment the `export` is added_, i.e. by that GREEN card, not here.

### 2. Evidence — re-run by the reviewer, not taken from the handoff

| Check                                                         | Result                                                                                                                                                   |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused spec `--project unit …/notifications/fan-out.test.ts` | **8 failed / 15 passed (23)** — every failure names the missing seam                                                                                     |
| Full `unit` project                                           | **1460 passed / 8 failed**, all 8 in that one file — no collateral red                                                                                   |
| GREEN probe (added only `export`, then reverted)              | **23/23 passed**                                                                                                                                         |
| Regression probe (`?? "sms"`, then reverted)                  | exactly **2** failures, both `expected 'sms' to be 'whatsapp'`                                                                                           |
| `tsc` (root + contracts + web), `eslint`, `prettier --check`  | clean; no new disable                                                                                                                                    |
| Diff scope — `git diff --name-status 229a64c 6296d25`         | 3 files only: `fan-out.test.ts` (M), `ADR-0110-…-test-seam.md` (A), `docs/adr/README.md` (M) — **no production file, no fixture/mock, no eslint config** |
| `groupChannel` at `6296d25` (`fan-out.ts:681`)                | `function groupChannel(…)` — **no `export`**, confirming the RED is exactly the missing keyword                                                          |
| Tree after the probes                                         | `git status` clean, no probe residue                                                                                                                     |

The RED is _legible_, which is the property a pin of a missing export usually loses: a bare named
import of a missing export aborts module instantiation and would report all 15 pre-existing U1–U3
tests as failed, hiding the real message. The typed accessor plus the named contract error keep the
failure pointed at the eight intended cases. The two probes bound the pin from both sides — it goes
green with the export alone, and it bites on exactly the pre-PR-#190 `"sms"` fallback and nothing
else.

### 3. Findings

- **Low — `groupChannel` is exported without an `@internal` marker.** The seam decision says the
  helper is internal by contract (only tests may import it), but nothing in the code says so, so a
  future consumer can import it as ordinary public API. Recommendation: mark it
  `/** … @internal Test seam only (ADR-0111) — consumers must use runNotificationFanOut/resolveChannel. */`
  when the GREEN card adds the `export`, and mirror it in the spec docstring. Docs-only; the pinned
  signature and behaviour are unchanged. **→ routed to GREEN card `t_b9bb5e0a`; not a change request
  on the RED.**
- **Informational — this is a unit pin of a _defensively unreachable_ branch.** The persisted-row
  assertion the original card sketched is impossible without a data-contract change:
  `channelGroupSchema` rejects an enabled `mobile` group with no `candidates`, and `loadTypeRow`
  fails closed to zero recipients, so no such row can be stored (attempt 1 produced **0** dispatch
  rows, and the card's STOP clause was invoked). The exported pure selector is therefore the correct
  minimal seam, and the _reachable_ analogue — a pre-selection mobile skip on a group that declares
  `candidates` recording `candidates[0]` — stays covered by the integration spec. Accepted; no
  action.
- **Informational — test quality of the accessor.** The
  `typeof fanOutModule & { readonly groupChannel?: GroupChannelSeam }` accessor is the right call:
  it keeps the RED legible and keeps `tsc` honest, because once the GREEN export lands a mismatched
  signature makes the intersection assertion fail to compile. The schema-invalid fixture is
  deliberate and documented — acceptable for a defensive-branch unit pin.

Honesty audit at the reviewed head: clean. No fixture-specific hardcoding, no test-environment
conditionals, no `@ts-ignore`, no swallowed assertions, and no production or fixture edit smuggled
into a test PR.

### 4. Merge posture

PR #210 stays a **draft**. The GREEN card `t_b9bb5e0a` adds the one-word `export` plus the
`@internal` marker on the same branch, turns the suite green, and then PR #210 carries **both**
commits and squash-merges once `CI` is green on the exact head SHA. At review time GitHub reported
PR #210 as `mergeStateStatus: DIRTY` against `main`, so that branch must first merge the current
`origin/main` and reconcile its `docs/adr/README.md` table — a known cross-lane hotspot whose
formatting is re-padded by whichever of the two lane PRs lands second.

## Consequences

- Number `0112` is consumed by this sign-off. It was resolved as the **lowest number free against
  `origin/main` `3f46950` that is not reserved by this lane** — `0111` is this lane's RED record — and
  re-checked against every local and `origin` ref immediately before committing: no ref carried
  `ADR-0111`/`ADR-0112`. `0131`/`0132` (the open OP-97 red branch) and `0135`/`0136` (the OP-97 GREEN
  worktree) remain reserved for those lanes; `main`'s table is contiguous through `0110` and resumes
  at `0118`.
- This is a docs-only record: no production, test, fixture or configuration file is touched, so no
  suite's observable behaviour changes.
- The `docs/adr/README.md` edit is a single inserted row plus one appended lane-note paragraph. That
  file is a cross-lane hotspot; the second of the two lane PRs to land will have to re-pad the table.

## Alternatives considered

- **Record this sign-off as a section inside `ADR-0111`.** Rejected: `0111` lives on the RED/GREEN
  branch and lands with PR #210, which is a draft and currently `DIRTY`; the sign-off must not be
  hostage to that PR's merge order, and every prior sign-off in this lane family (ADR-0095, 0097,
  0101, 0104, 0107, 0109) is recorded as its own file.
- **Take `0111` for the sign-off (the card's original title).** Rejected: `0111` is this lane's RED
  record by binding allocation; using it twice would collide within the lane at PR #210's merge.
- **Wait for PR #210 to merge before recording the sign-off.** Rejected: it would leave the review
  verdict unrecorded behind an unrelated draft PR, and that verdict is what the GREEN card acts on.
- **Request the `@internal` marker on the RED instead.** Rejected: the marker belongs with the
  `export` that the GREEN card adds; requesting it here would hold up a correct RED over a
  documentation line that cannot yet exist in its intended form.
